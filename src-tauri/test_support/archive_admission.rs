//! Real-filesystem archive admission contracts (#686).
//!
//! These prove the three properties the migration claims: an archive cannot
//! begin while another managed operation owns an overlapping path, an archive
//! that has begun excludes such an operation, and its ownership is bounded —
//! released on completion, cancellation, renderer detach and even when the
//! blocking work leaves partial output behind.
#![cfg(target_os = "linux")]
use super::*;
use crate::files::recovery::{Access, MutationAdmission, ResourceRequest, Runtime, Scope};
use crate::renderer_owner::Owner;
use std::io::Write as _;

fn claim(path: &Path, access: Access) -> Vec<ResourceRequest> {
    vec![ResourceRequest {
        path: path.to_owned(),
        access,
        scope: Scope::Subtree,
    }]
}

struct Fixture {
    _directory: tempfile::TempDir,
    _storage_root: tempfile::TempDir,
    base: PathBuf,
    storage: PathBuf,
    runtime: Runtime,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    // Recovery storage is application-local, never inside the user directory
    // being operated on: an extract-here claim covers its whole destination
    // subtree, and the recovery root is a permanently protected resource.
    let storage_root = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let storage = storage_root.path().canonicalize().unwrap().join("recovery");
    Fixture {
        _directory: directory,
        _storage_root: storage_root,
        base,
        storage,
        runtime: Runtime::default(),
    }
}

impl Fixture {
    fn request(&self, requests: Vec<ResourceRequest>) -> Result<MutationAdmission, AppError> {
        tauri::async_runtime::block_on(self.runtime.admit(self.storage.clone(), requests))
    }

    /// A separate managed operation holding `path`, as a move or copy session
    /// would while relocating into the same directory. This goes through the
    /// exact production admission entry point, not a test-only shortcut.
    fn competitor(&self, path: &Path, access: Access) -> MutationAdmission {
        self.request(claim(path, access)).unwrap()
    }

    fn admit(&self, plan: &ArchivePlan) -> Result<MutationAdmission, AppError> {
        self.request(plan.resources())
    }

    fn refusal(&self, plan: &ArchivePlan) -> AppError {
        match self.admit(plan) {
            Ok(_) => panic!("an overlapping archive operation must be refused"),
            Err(error) => error,
        }
    }

    fn claims(&self, path: &Path, access: Access) -> bool {
        match self.request(claim(path, access)) {
            Ok(admission) => {
                admission.finish().unwrap();
                true
            }
            Err(_) => false,
        }
    }

    fn zip_of(&self, name: &str) -> (PathBuf, String) {
        let source = self.base.join(name);
        fs::create_dir(&source).unwrap();
        fs::write(source.join("payload.txt"), b"payload").unwrap();
        let zip = compress_to_zip_sync(None, vec![source.to_string_lossy().into_owned()], None)
            .expect("fixture archive");
        (source, zip)
    }
}

fn compress_plan(sources: &[PathBuf], output: PathBuf) -> ArchivePlan {
    CompressRequest::new(
        sources
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    )
    .unwrap()
    .plan(output)
}

fn extract_here_plan(archive: &Path) -> ArchivePlan {
    ExtractRequest::new(archive.to_string_lossy().into_owned())
        .unwrap()
        .here()
}

#[test]
fn an_owned_destination_excludes_an_extraction_into_it() {
    let fixture = fixture();
    let (_source, zip) = fixture.zip_of("payload");
    let plan = extract_here_plan(Path::new(&zip));
    // A move session owns a file in the directory the archive would extract
    // into. Extract-here writes names the archive chooses, so it must wait.
    let held = fixture.competitor(&fixture.base.join("landing.txt"), Access::Write);

    let error = fixture.refusal(&plan);
    assert!(
        error.to_string().contains("owns these files"),
        "unexpected refusal: {error}"
    );

    held.finish().unwrap();
    let admission = match fixture.admit(&plan) {
        Ok(admission) => admission,
        Err(error) => panic!("released ownership must admit the archive: {error}"),
    };
    admission.finish().unwrap();
}

#[test]
fn an_owned_source_excludes_compressing_it() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    let plan = compress_plan(std::slice::from_ref(&source), fixture.base.join("docs.zip"));

    let held = fixture.competitor(&source, Access::Write);
    assert!(
        fixture.admit(&plan).is_err(),
        "a source being relocated must not be read into an archive"
    );
    held.finish().unwrap();
    match fixture.admit(&plan) {
        Ok(admission) => admission.finish().unwrap(),
        Err(error) => panic!("released ownership must admit the archive: {error}"),
    }
}

#[test]
fn an_admitted_archive_excludes_a_competing_operation_on_its_output() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    let output = fixture.base.join("docs.zip");
    let admission = fixture
        .admit(&compress_plan(&[source], output.clone()))
        .unwrap();

    // Exclusion runs in both directions: a move onto the archive's chosen
    // output name is refused while the archive owns it.
    assert!(!fixture.claims(&output, Access::Write));
    // A read of an unrelated sibling is not blocked.
    assert!(fixture.claims(&fixture.base.join("unrelated"), Access::Read));

    admission.finish().unwrap();
    assert!(fixture.claims(&output, Access::Write));
}

#[test]
fn a_compress_releases_its_claim_after_the_work_completes() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("a.txt"), b"a").unwrap();
    let output = fixture.base.join("docs.zip");
    let plan = compress_plan(&[source], output.clone());

    let admission = fixture.admit(&plan).unwrap();
    let plan = plan
        .resolve(admission.paths().map(Path::to_path_buf))
        .unwrap();
    let (result, touched) = run_plan(&plan, None, 0, &AtomicBool::new(false));
    assert_eq!(result.unwrap(), output.to_string_lossy());
    assert!(!touched);
    assert!(output.exists());
    admission.finish().unwrap();

    assert!(fixture.claims(&output, Access::Write));
}

#[test]
fn a_cancelled_compress_releases_its_claim_and_removes_its_partial_output() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("big.bin"), vec![7u8; 3 * 1024 * 1024]).unwrap();
    let output = fixture.base.join("docs.zip");
    let plan = compress_plan(&[source], output.clone());

    let admission = fixture.admit(&plan).unwrap();
    let plan = plan
        .resolve(admission.paths().map(Path::to_path_buf))
        .unwrap();
    let (result, touched) = run_plan(&plan, None, 0, &AtomicBool::new(true));
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert!(!touched, "the partial archive was removed");
    assert!(!output.exists());

    admission.finish().unwrap();
    assert!(fixture.claims(&output, Access::Write));
}

#[test]
fn a_retired_renderer_cancels_the_job_and_releases_its_claim() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("big.bin"), vec![9u8; 8 * 1024 * 1024]).unwrap();
    let output = fixture.base.join("docs.zip");
    let plan = compress_plan(&[source], output.clone());

    let admission = fixture.admit(&plan).unwrap();
    let plan = plan
        .resolve(admission.paths().map(Path::to_path_buf))
        .unwrap();

    let owner = Owner::default();
    let outcome = tauri::async_runtime::block_on(async {
        let supervisor = owner.clone();
        // Retire the renderer as the blocking worker starts: the supervisor
        // must stop the job rather than leave it writing into a dead window's
        // directory.
        tauri::async_runtime::spawn(async move {
            supervisor.retire();
        });
        execute(plan, None, Some(686_001), owner).await
    });

    // Either the worker finished first or it was cancelled; both must settle.
    match &outcome.result {
        Ok(path) => assert_eq!(path, &output.to_string_lossy().into_owned()),
        Err(error) => {
            assert!(error.to_string().contains("cancelled"), "{error}");
            assert!(!output.exists(), "a cancelled compress removes its output");
        }
    }

    admission.finish().unwrap();
    assert!(fixture.claims(&output, Access::Write));
}

#[test]
fn a_cleanup_failure_warns_without_discarding_the_committed_result() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    let plan = compress_plan(&[source], fixture.base.join("docs.zip"));
    let admission = fixture.admit(&plan).unwrap();
    // An outstanding worker context makes retirement fail, exactly as it does
    // when a blocking worker outlives its supervisor.
    let outstanding = admission.context();

    let outcome = tauri::async_runtime::block_on(settle(
        MutationOutcome {
            result: Ok("/tmp/docs.zip".to_owned()),
            effect: ForwardEffect::Changed(None),
            warning: None,
            affected: vec!["/tmp".to_owned()],
        },
        admission,
    ));
    assert_eq!(outcome.result.unwrap(), "/tmp/docs.zip");
    assert!(outcome
        .warning
        .unwrap()
        .contains("ownership record could not be retired"));
    drop(outstanding);
}

#[test]
fn a_failed_extract_here_publishes_the_directory_it_already_wrote_into() {
    let fixture = fixture();
    let (_source, zip) = fixture.zip_of("payload");
    let landing = fixture.base.join("payload-copy");
    fs::create_dir(&landing).unwrap();
    fs::copy(&zip, landing.join("pack.zip")).unwrap();
    // Occupy one of the archive's entries so the pre-scan refuses.
    fs::create_dir(landing.join("payload")).unwrap();
    fs::write(landing.join("payload/payload.txt"), b"mine").unwrap();

    let plan = extract_here_plan(&landing.join("pack.zip"));
    let admission = fixture.admit(&plan).unwrap();
    let plan = plan
        .resolve(admission.paths().map(Path::to_path_buf))
        .unwrap();
    let (result, touched) = run_plan(&plan, None, 0, &AtomicBool::new(false));
    assert!(result.is_err());
    // Extract-here never removes its destination, so its directory must be
    // published even on failure; the occupant is untouched.
    assert!(touched);
    assert_eq!(
        fs::read(landing.join("payload/payload.txt")).unwrap(),
        b"mine"
    );
    admission.finish().unwrap();
}

#[test]
fn a_name_taken_after_selection_is_never_truncated_or_removed() {
    let fixture = fixture();
    let source = fixture.base.join("docs");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("a.txt"), b"a").unwrap();
    let output = fixture.base.join("docs.zip");
    let plan = compress_plan(&[source], output.clone());

    // An unmanaged writer takes the selected name between selection and work.
    let mut occupant = fs::File::create(&output).unwrap();
    occupant.write_all(b"someone else's file").unwrap();
    drop(occupant);

    let (result, touched) = run_plan(&plan, None, 0, &AtomicBool::new(false));
    assert!(result.is_err(), "an occupied output must fail closed");
    assert!(!touched);
    assert_eq!(fs::read(&output).unwrap(), b"someone else's file");
}

#[test]
fn an_extraction_folder_taken_after_selection_is_never_merged_into_or_deleted() {
    let fixture = fixture();
    let (_source, zip) = fixture.zip_of("payload");
    let landing = fixture.base.join("landing");
    fs::create_dir(&landing).unwrap();
    let archive = landing.join("pack.zip");
    fs::copy(&zip, &archive).unwrap();
    let request = ExtractRequest::new(archive.to_string_lossy().into_owned()).unwrap();
    let output = landing.join(request.folder_name());
    let plan = request.into_folder(output.clone());

    fs::create_dir(&output).unwrap();
    fs::write(output.join("keep.txt"), b"keep").unwrap();

    let (result, touched) = run_plan(&plan, None, 0, &AtomicBool::new(false));
    assert!(result.is_err(), "an occupied destination must fail closed");
    assert!(!touched);
    assert_eq!(fs::read(output.join("keep.txt")).unwrap(), b"keep");
}
