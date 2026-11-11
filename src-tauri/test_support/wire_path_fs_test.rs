//! Real-filesystem regressions for names that are not valid UTF-8 (#1592,
//! ADR 0031).
//!
//! Every test lists a temp directory through the production listing, hands
//! the exact wire path it published to a production plan or worker entry
//! point, and asserts on the bytes left on disk. `bad\xff.txt` always has a
//! look-alike sibling `bad\u{FFFD}.txt`: the lossy spelling of the raw name.
//! Before the wire format both listed as the same string, so an operation on
//! the listed raw entry either missed or hit the look-alike.
use super::{
    admission, archive_plan, batch::BatchPlan, copy_session, dir_listing, entry_execution,
    entry_plan::EntryPlan, freedesktop_trash, move_session::MoveWork, permanent_delete,
};
use crate::{error::AppError, renderer_owner::Owner, wire_path};
use std::{
    ffi::OsStr,
    fs,
    future::Future,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// `bad\xff.txt`: 0xFF is never valid UTF-8, so it travels as U+EFFF.
const RAW: &[u8] = b"bad\xff.txt";
const RAW_WIRE: &str = "bad\u{EFFF}.txt";
const LOOKALIKE: &str = "bad\u{FFFD}.txt";

fn block<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn raw(name: &[u8]) -> &OsStr {
    OsStr::from_bytes(name)
}

fn wire(path: &Path) -> String {
    wire_path::encode_path(path).into_owned()
}

fn runtime(storage: &Path) -> admission::Runtime {
    admission::Runtime::new(storage.join("recovery"))
}

struct Fixture {
    _scratch: tempfile::TempDir,
    storage: PathBuf,
    dir: PathBuf,
}

impl Fixture {
    /// A directory holding the raw file and its look-alike, plus storage for
    /// recovery records and a private trash outside that directory.
    fn new() -> Self {
        let scratch = tempfile::tempdir().unwrap();
        let storage = scratch.path().join("storage");
        let dir = scratch.path().join("work");
        fs::create_dir_all(&storage).unwrap();
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join(raw(RAW)), b"raw bytes").unwrap();
        fs::write(dir.join(LOOKALIKE), b"bystander").unwrap();
        Self {
            _scratch: scratch,
            storage,
            dir,
        }
    }

    fn raw_path(&self) -> PathBuf {
        self.dir.join(raw(RAW))
    }

    fn lookalike_path(&self) -> PathBuf {
        self.dir.join(LOOKALIKE)
    }

    /// The wire path the listing published for `name`, found by its wire
    /// name rather than by decoding (the listing itself is under test).
    fn listed(&self, dir: &Path, name: &str) -> String {
        listing(dir)
            .into_iter()
            .find(|(listed, _)| listed == name)
            .unwrap_or_else(|| panic!("{name:?} not listed in {dir:?}"))
            .1
    }

    fn assert_bystander_intact(&self) {
        assert_eq!(fs::read(self.lookalike_path()).unwrap(), b"bystander");
    }
}

/// `(name, path)` of every entry the production listing returns for `dir`.
fn listing(dir: &Path) -> Vec<(String, String)> {
    let mut entries: Vec<_> = block(dir_listing::read_directory(wire(dir)))
        .unwrap()
        .entries
        .iter()
        .map(|entry| (entry.name.clone(), entry.path.clone()))
        .collect();
    entries.sort();
    entries
}

fn names(dir: &Path) -> Vec<Vec<u8>> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().as_bytes().to_vec())
        .collect();
    names.sort();
    names
}

#[test]
fn a_raw_name_and_its_lossy_look_alike_list_as_distinct_wire_paths() {
    let fixture = Fixture::new();
    let dir = wire(&fixture.dir);
    assert_eq!(
        listing(&fixture.dir),
        vec![
            (RAW_WIRE.to_owned(), format!("{dir}/{RAW_WIRE}")),
            (LOOKALIKE.to_owned(), format!("{dir}/{LOOKALIKE}")),
        ]
    );
}

#[test]
fn renaming_a_listed_raw_entry_renames_only_it_and_undo_redo_keep_its_bytes() {
    let fixture = Fixture::new();
    let listed = fixture.listed(&fixture.dir, RAW_WIRE);
    let runtime = runtime(&fixture.storage);
    let outcome = block(entry_execution::execute(
        EntryPlan::rename(listed.clone(), "renamed.txt".into()).unwrap(),
        &runtime,
    ));
    let receipt = outcome.completion.result.as_ref().unwrap();
    assert_eq!(receipt.path, format!("{}/renamed.txt", wire(&fixture.dir)));
    assert!(!fixture.raw_path().exists());
    assert_eq!(
        fs::read(fixture.dir.join("renamed.txt")).unwrap(),
        b"raw bytes"
    );
    fixture.assert_bystander_intact();

    // History records the wire names exactly as `file_mutation` does.
    let (old_name, new_name) = outcome.rename.clone().unwrap();
    assert_eq!(old_name, RAW_WIRE);
    let action = crate::file_history::Action::Rename {
        path: wire(&outcome.target),
        old_name,
        new_name,
    };
    let redo = block(crate::file_history::execute_natively_for_test(
        action,
        runtime.clone(),
        true,
    ))
    .unwrap()
    .expect("undo records its redo");
    assert_eq!(fs::read(fixture.raw_path()).unwrap(), b"raw bytes");
    assert!(!fixture.dir.join("renamed.txt").exists());
    fixture.assert_bystander_intact();

    block(crate::file_history::execute_natively_for_test(
        redo, runtime, false,
    ))
    .unwrap();
    assert!(!fixture.raw_path().exists());
    assert_eq!(
        fs::read(fixture.dir.join("renamed.txt")).unwrap(),
        b"raw bytes"
    );
    fixture.assert_bystander_intact();
}

#[test]
fn renaming_to_an_escaped_name_creates_exactly_those_bytes() {
    let fixture = Fixture::new();
    let plain = fixture.dir.join("plain.txt");
    fs::write(&plain, b"plain").unwrap();
    let outcome = block(entry_execution::execute(
        EntryPlan::rename(wire(&plain), "new\u{EFFE}.txt".into()).unwrap(),
        &runtime(&fixture.storage),
    ));
    outcome.completion.result.unwrap();
    assert_eq!(
        fs::read(fixture.dir.join(raw(b"new\xfe.txt"))).unwrap(),
        b"plain"
    );
    assert!(!fixture.dir.join("new\u{EFFE}.txt").exists());
}

#[test]
fn trashing_a_listed_raw_entry_trashes_only_it() {
    let fixture = Fixture::new();
    let listed = fixture.listed(&fixture.dir, RAW_WIRE);
    let plan = BatchPlan::new(vec![listed.clone()]).unwrap();
    let data_home = fixture.storage.join("data");
    let context = freedesktop_trash::Context::for_data_home(data_home.clone()).unwrap();
    let mut selection = context.prepare_selection(Arc::new(plan.paths)).unwrap();
    selection.execute_next(&listed).unwrap();
    assert!(!fixture.raw_path().exists());
    fixture.assert_bystander_intact();
    // The trash keeps the raw bytes as its name prefix and percent-encodes
    // them in the original location it records.
    let trashed = data_home.join("Trash/files");
    let [name] = &names(&trashed)[..] else {
        panic!("one trashed entry expected")
    };
    assert!(name.starts_with(RAW), "{name:?}");
    assert_eq!(fs::read(trashed.join(raw(name))).unwrap(), b"raw bytes");
    let info = fs::read_dir(data_home.join("Trash/info"))
        .unwrap()
        .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>();
    assert!(
        matches!(&info[..], [info] if info.contains("/work/bad%FF.txt\n")),
        "{info:?}"
    );
}

#[test]
fn permanently_deleting_a_listed_raw_entry_removes_only_it() {
    let fixture = Fixture::new();
    let listed = fixture.listed(&fixture.dir, RAW_WIRE);
    let plan = BatchPlan::new(vec![listed.clone()]).unwrap();
    let mut selection = permanent_delete::prepare_selection(Arc::new(plan.paths)).unwrap();
    selection.execute_next(&listed).unwrap();
    assert!(!fixture.raw_path().exists());
    fixture.assert_bystander_intact();
}

/// Drive a copy-shaped session, answering each conflict with `skip` and
/// recording every conflict's file name.
fn drive(
    request: copy_session::Request,
    work: impl copy_session::Work,
) -> (copy_session::Outcome, Vec<(String, String)>) {
    let owner = Owner::default();
    let control = Arc::new(copy_session::Control::new(owner.clone()));
    let conflicts = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&conflicts);
    let replies = Arc::clone(&control);
    let outcome = block(copy_session::run(request, control, work, move |event| {
        if let copy_session::Event::Conflict {
            item,
            ref nonce,
            ref conflict,
        } = event
        {
            recorded
                .lock()
                .unwrap()
                .push((conflict.file_name.clone(), conflict.source_path.clone()));
            let skip = copy_session::Decision {
                choice: copy_session::Choice::Skip,
                apply_to_all: false,
            };
            replies.resolve(&owner, item, nonce, skip).unwrap();
        }
        true
    }));
    let conflicts = conflicts.lock().unwrap().clone();
    (outcome, conflicts)
}

fn copy_work(storage: &Path) -> copy_session::NativeWork {
    copy_session::NativeWork {
        app: None,
        job_id: 1_592,
        runtime: runtime(storage),
    }
}

#[test]
fn copying_a_listed_raw_entry_keeps_its_bytes_and_conflicts_with_its_exact_name() {
    let fixture = Fixture::new();
    let listed = fixture.listed(&fixture.dir, RAW_WIRE);
    let destination = fixture.storage.join("copies");
    fs::create_dir(&destination).unwrap();
    let request = || copy_session::Request::new(vec![listed.clone()], wire(&destination)).unwrap();

    let (outcome, conflicts) = drive(request(), copy_work(&fixture.storage));
    assert!(conflicts.is_empty());
    assert!(
        matches!(&outcome.items[..], [copy_session::ItemOutcome::Succeeded { receipt }]
            if receipt.path == format!("{}/{RAW_WIRE}", wire(&destination))),
        "{outcome:?}"
    );
    assert_eq!(names(&destination), vec![RAW.to_vec()]);
    assert_eq!(fs::read(destination.join(raw(RAW))).unwrap(), b"raw bytes");
    assert_eq!(fs::read(fixture.raw_path()).unwrap(), b"raw bytes");

    // A second copy collides with the exact raw name, not the look-alike
    // (which is absent from the destination). The prompt shows display text.
    let (outcome, conflicts) = drive(request(), copy_work(&fixture.storage));
    assert_eq!(conflicts, vec![(LOOKALIKE.to_owned(), listed.clone())]);
    assert!(matches!(
        &outcome.items[..],
        [copy_session::ItemOutcome::Skipped]
    ));
    assert_eq!(names(&destination), vec![RAW.to_vec()]);
}

#[test]
fn moving_a_listed_raw_entry_keeps_its_bytes() {
    let fixture = Fixture::new();
    let listed = fixture.listed(&fixture.dir, RAW_WIRE);
    let destination = fixture.storage.join("moved");
    fs::create_dir(&destination).unwrap();
    let (outcome, conflicts) = drive(
        copy_session::Request::new(vec![listed], wire(&destination)).unwrap(),
        MoveWork {
            job_id: 1_592,
            runtime: runtime(&fixture.storage),
        },
    );
    assert!(conflicts.is_empty());
    assert!(
        matches!(
            &outcome.items[..],
            [copy_session::ItemOutcome::Succeeded { .. }]
        ),
        "{outcome:?}"
    );
    assert!(!fixture.raw_path().exists());
    assert_eq!(fs::read(destination.join(raw(RAW))).unwrap(), b"raw bytes");
    fixture.assert_bystander_intact();
}

#[test]
fn creating_and_listing_inside_a_raw_directory_uses_its_exact_bytes() {
    let fixture = Fixture::new();
    let native_dir = fixture.dir.join(raw(b"dir\xfe"));
    fs::create_dir(&native_dir).unwrap();
    let dir = fixture.listed(&fixture.dir, "dir\u{EFFE}");
    let runtime = runtime(&fixture.storage);
    for plan in [
        EntryPlan::create_empty_file(dir.clone(), "inner.txt".into()).unwrap(),
        EntryPlan::create_directory(dir.clone(), "sub\u{EFFD}".into()).unwrap(),
    ] {
        block(entry_execution::execute(plan, &runtime))
            .completion
            .result
            .unwrap();
    }
    assert_eq!(
        names(&native_dir),
        vec![b"inner.txt".to_vec(), b"sub\xfd".to_vec()]
    );
    assert_eq!(
        listing(&native_dir),
        vec![
            ("inner.txt".to_owned(), format!("{dir}/inner.txt")),
            ("sub\u{EFFD}".to_owned(), format!("{dir}/sub\u{EFFD}")),
        ]
    );
}

#[test]
fn a_non_canonical_wire_path_is_refused_before_any_effect() {
    let fixture = Fixture::new();
    let accented = fixture.dir.join("badé.txt");
    fs::write(&accented, b"accented").unwrap();
    // "é" is valid UTF-8 (C3 A9); escaping its bytes is not canonical.
    let escaped = format!("{}/bad\u{EFC3}\u{EFA9}.txt", wire(&fixture.dir));
    let rename = EntryPlan::rename(escaped.clone(), "renamed.txt".into());
    assert!(matches!(rename, Err(AppError::InvalidPath(_))));
    assert!(BatchPlan::new(vec![escaped.clone()]).is_err());
    assert!(copy_session::Request::new(vec![escaped], wire(&fixture.storage)).is_err());
    assert_eq!(fs::read(&accented).unwrap(), b"accented");
}

fn assert_unsupported<T>(result: Result<T, AppError>) {
    match result {
        Err(AppError::InvalidPath(message)) => {
            assert_eq!(message, wire_path::UNSUPPORTED_ENCODING)
        }
        Err(other) => panic!("expected the escaped-name refusal, got {other:?}"),
        Ok(_) => panic!("expected the escaped-name refusal, got success"),
    }
}

#[test]
fn surfaces_without_phase_one_support_refuse_escaped_paths_before_effects() {
    let fixture = Fixture::new();
    let listed = fixture.listed(&fixture.dir, RAW_WIRE);
    let directory = fixture.dir.join(raw(b"out\xfe"));
    fs::create_dir(&directory).unwrap();
    let escaped_dir = wire(&directory);
    let before = names(&fixture.dir);

    assert_unsupported(archive_plan::CompressRequest::new(vec![listed.clone()]));
    assert_unsupported(archive_plan::ExtractRequest::new(listed.clone()));
    let copy_target = fixture.dir.join("copy.txt");
    assert_unsupported(block(super::video_info::save_file_copy(
        listed.clone(),
        wire(&copy_target),
    )));
    assert_unsupported(block(super::video_info::save_file_copy(
        wire(&fixture.lookalike_path()),
        format!("{escaped_dir}/copy.txt"),
    )));
    assert_unsupported(crate::plugin_job::validate_output_target(
        &escaped_dir,
        "out.png",
    ));
    assert_unsupported(crate::plugin_job::validate_output_target(
        &wire(&fixture.dir),
        "out\u{EFFE}.png",
    ));
    assert_unsupported(block(crate::wallpaper::set_as_wallpaper(listed.clone())));
    let crop: super::image_crop::SaveRequest = serde_json::from_value(serde_json::json!({
        "path": listed,
        "revision": {
            "digest": "0", "size": 9, "modifiedSeconds": 0, "modifiedNanos": 0,
            "identity": "0", "readonly": false
        },
        "rect": { "left": 0, "top": 0, "right": 1, "bottom": 1 },
        "viewport": { "width": 1, "height": 1 },
        "destination": { "kind": "replace" }
    }))
    .unwrap();
    assert_unsupported(super::image_crop::SavePlan::new(crop));

    assert_eq!(names(&fixture.dir), before);
    assert!(fs::read_dir(&directory).unwrap().next().is_none());
    assert_eq!(fs::read(fixture.raw_path()).unwrap(), b"raw bytes");
}

#[test]
fn mutating_git_commands_refuse_escaped_repo_relative_paths() {
    let fixture = Fixture::new();
    let repo = git2::Repository::init(&fixture.dir).unwrap();
    let repo_path = wire(&fixture.dir);
    let index_before = fs::read(repo.path().join("index")).ok();
    let escaped = vec![RAW_WIRE.to_owned()];
    assert_unsupported(block(crate::git::git_stage(
        repo_path.clone(),
        escaped.clone(),
    )));
    assert_unsupported(block(crate::git::git_unstage(
        repo_path.clone(),
        escaped.clone(),
    )));
    assert_unsupported(block(crate::git::git_discard(
        repo_path.clone(),
        escaped.clone(),
        None,
    )));
    assert_unsupported(block(crate::git::git_archive_untracked(
        repo_path.clone(),
        escaped,
    )));
    assert_unsupported(block(crate::git::git_add_to_gitignore(
        repo_path,
        RAW_WIRE.to_owned(),
    )));
    assert_eq!(fs::read(repo.path().join("index")).ok(), index_before);
    assert!(!fixture.dir.join(".gitignore").exists());
    assert!(!fixture.dir.join(".archive").exists());
    assert_eq!(fs::read(fixture.raw_path()).unwrap(), b"raw bytes");
    fixture.assert_bystander_intact();
}

/// Text-only surfaces decode a genuine U+EF80–U+EFFF name (whose wire form is
/// escaped too) and act on its exact native spelling, never the wire text.
#[test]
fn text_only_surfaces_accept_genuine_reserved_characters_at_their_native_names() {
    let fixture = Fixture::new();
    let source = fixture.dir.join("res\u{EF80}.txt");
    fs::write(&source, b"reserved").unwrap();
    let directory = fixture.dir.join("out\u{EFFF}");
    fs::create_dir(&directory).unwrap();
    let target = directory.join("copy\u{EF81}.txt");
    assert_ne!(wire(&source), source.to_str().unwrap());

    block(super::video_info::save_file_copy(
        wire(&source),
        wire(&target),
    ))
    .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"reserved");
    assert_eq!(names(&directory).len(), 1);

    let output = crate::plugin_job::validate_output_target(
        &wire(&directory),
        &wire_path::encode(std::ffi::OsStr::new("art\u{EF82}.png")),
    )
    .unwrap();
    assert_eq!(output, directory.join("art\u{EF82}.png"));
    assert_eq!(fs::read(fixture.raw_path()).unwrap(), b"raw bytes");
}
