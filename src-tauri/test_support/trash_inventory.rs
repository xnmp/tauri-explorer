//! Real-filesystem Trash view outcomes on Linux (#863): items deleted through
//! the application's trash are listed with their origin and restored exactly,
//! and every refusal leaves the item recoverable in the trash.
use super::*;
use crate::files::{
    freedesktop_trash::{
        inventory::{scan_sources, Source},
        Context,
    },
    recovery::Runtime,
};
use std::{
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::PathBuf,
};

struct Fixture {
    scratch: tempfile::TempDir,
    context: Context,
    runtime: Runtime,
}

impl Fixture {
    fn new() -> Self {
        let scratch = tempfile::tempdir().unwrap();
        let context = Context::for_data_home(scratch.path().join("data")).unwrap();
        let runtime = Runtime::new(scratch.path().join("recovery"));
        Self {
            scratch,
            context,
            runtime,
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.scratch.path().join(relative)
    }

    fn create(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.path(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn trash(&mut self, path: &Path) {
        self.context.trash(path).expect("trash through the app");
        assert!(!path.exists());
    }

    fn trash_root(&self) -> PathBuf {
        self.path("data/Trash")
    }

    fn list(&self) -> TrashListing {
        self.list_with(&[])
    }

    fn list_with(&self, mounted: &[Source]) -> TrashListing {
        let mut sources = vec![Source {
            root: self.trash_root(),
            topdir: None,
        }];
        sources.extend_from_slice(mounted);
        let mut inventory = Inventory::default();
        scan_sources(&sources, &mut inventory);
        publish(inventory)
    }

    fn id_for(&self, listing: &TrashListing, original: &Path) -> String {
        listing
            .entries
            .iter()
            .find(|entry| entry.original_path.as_deref() == original.to_str())
            .unwrap_or_else(|| panic!("{} is not listed: {listing:?}", original.display()))
            .id
            .clone()
    }

    fn restore(&self, ids: Vec<String>) -> FileBatchOutcome {
        tauri::async_runtime::block_on(restore(ids, &self.runtime)).expect("restore batch")
    }

    fn trash_counts(&self) -> (usize, usize) {
        let count = |name| fs::read_dir(self.trash_root().join(name)).unwrap().count();
        (count("files"), count("info"))
    }
}

fn failure<'a>(outcome: &'a FileBatchOutcome, path: &Path) -> &'a str {
    &outcome
        .failed
        .iter()
        .find(|failure| failure.path == path.to_str().unwrap())
        .unwrap_or_else(|| panic!("no failure for {}: {outcome:?}", path.display()))
        .error
}

// One test owns the process-wide listing registry; parallel tests would race
// its replacement on every listing.
#[test]
fn trash_view_restores_exact_items_and_never_overwrites() {
    let mut fixture = Fixture::new();

    // Same-named items from different folders keep separate identities and
    // restore byte-for-byte to their own recorded destinations.
    let alpha = fixture.create("a/report.txt", b"alpha \x00\xff bytes");
    let beta = fixture.create("b/report.txt", b"beta");
    fixture.trash(&alpha);
    fixture.trash(&beta);
    let listing = fixture.list();
    assert!(listing.issues.is_empty(), "{:?}", listing.issues);
    assert_eq!(listing.entries.len(), 2);
    for entry in &listing.entries {
        assert_eq!(entry.name, "report.txt");
        assert_eq!(entry.kind, "file");
        assert!(entry.deleted_at.is_some());
    }
    let (alpha_id, beta_id) = (
        fixture.id_for(&listing, &alpha),
        fixture.id_for(&listing, &beta),
    );
    assert_ne!(alpha_id, beta_id);
    let outcome = fixture.restore(vec![alpha_id, beta_id]);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(outcome.succeeded.len(), 2);
    assert_eq!(fs::read(&alpha).unwrap(), b"alpha \x00\xff bytes");
    assert_eq!(fs::read(&beta).unwrap(), b"beta");
    assert_eq!(
        fixture.trash_counts(),
        (0, 0),
        "payload and metadata are removed"
    );
    assert!(fixture.list().entries.is_empty());

    // An occupied destination is refused and the trashed copy survives.
    let occupied = fixture.create("c/notes.txt", b"trashed");
    fixture.trash(&occupied);
    let id = fixture.id_for(&fixture.list(), &occupied);
    fs::write(&occupied, b"newer file").unwrap();
    let outcome = fixture.restore(vec![id.clone()]);
    assert!(failure(&outcome, &occupied).contains("already exists"));
    assert!(outcome.succeeded.is_empty());
    assert_eq!(fs::read(&occupied).unwrap(), b"newer file");
    assert_eq!(fixture.trash_counts(), (1, 1));
    fs::remove_file(&occupied).unwrap();
    let outcome = fixture.restore(vec![id]);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&occupied).unwrap(), b"trashed");

    // A missing original folder is reported, not silently recreated.
    let orphan = fixture.create("gone/child.txt", b"child");
    fixture.trash(&orphan);
    fs::remove_dir(fixture.path("gone")).unwrap();
    let id = fixture.id_for(&fixture.list(), &orphan);
    let outcome = fixture.restore(vec![id]);
    assert!(failure(&outcome, &orphan).contains("no longer exists"));
    assert!(!fixture.path("gone").exists());
    assert_eq!(fixture.trash_counts(), (1, 1));
    fs::create_dir(fixture.path("gone")).unwrap();

    // A payload changed after listing is refused by the exact engine.
    let changed = fixture.create("d/changed.txt", b"original");
    fixture.trash(&changed);
    let listing = fixture.list();
    let id = fixture.id_for(&listing, &changed);
    let payload = fs::read_dir(fixture.trash_root().join("files"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("changed.txt")
        })
        .unwrap();
    fs::write(&payload, b"tampered after listing").unwrap();
    let outcome = fixture.restore(vec![id]);
    assert!(
        failure(&outcome, &changed).contains("changed"),
        "{outcome:?}"
    );
    assert!(!changed.exists());
    assert!(payload.exists(), "the trash item stays recoverable");

    // A folder whose name is not UTF-8 is still the item's real destination.
    let folder = fixture
        .scratch
        .path()
        .join(std::ffi::OsStr::from_bytes(b"caf\xe9"));
    fs::create_dir(&folder).unwrap();
    let native = folder.join("menu.txt");
    fs::write(&native, b"native bytes").unwrap();
    fixture.trash(&native);
    let listing = fixture.list();
    let id = listing
        .entries
        .iter()
        .find(|entry| entry.name == "menu.txt")
        .unwrap()
        .id
        .clone();
    let outcome = fixture.restore(vec![id]);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&native).unwrap(), b"native bytes");

    // Mounted-volume trash records are relative to the volume's top folder.
    let top = fixture.path("volume");
    let mounted = top.join(".Trash-1000");
    for directory in [&mounted, &mounted.join("info"), &mounted.join("files")] {
        fs::create_dir_all(directory).unwrap();
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::create_dir_all(top.join("photos")).unwrap();
    fs::write(mounted.join("files/beach.jpg"), b"jpeg bytes").unwrap();
    fs::write(
        mounted.join("info/beach.jpg.trashinfo"),
        "[Trash Info]\nPath=photos/beach.jpg\nDeletionDate=2026-01-02T03:04:05\n",
    )
    .unwrap();
    let source = Source {
        root: mounted.clone(),
        topdir: Some(top.clone()),
    };
    let listing = fixture.list_with(std::slice::from_ref(&source));
    let destination = top.join("photos/beach.jpg");
    let id = fixture.id_for(&listing, &destination);
    let outcome = fixture.restore(vec![id]);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&destination).unwrap(), b"jpeg bytes");
    assert_eq!(fs::read_dir(mounted.join("files")).unwrap().count(), 0);
    assert_eq!(fs::read_dir(mounted.join("info")).unwrap().count(), 0);

    // Stale or unknown IDs are refused without effects.
    let outcome = fixture.restore(vec!["not-a-listed-id".into()]);
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0]
        .error
        .contains("no longer in the trash list"));
}

#[test]
fn duplicate_destinations_in_one_selection_restore_only_once() {
    let artifact = Arc::new(TrashArtifact::WindowsShell {
        parsing_name_utf16: vec![1],
    });
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch
        .path()
        .join("same.txt")
        .to_string_lossy()
        .into_owned();
    let restorable = Restorable {
        key: target.clone(),
        destination: PathBuf::from(&target),
        artifact,
    };
    let registry = Registry::from([
        ("dup-1".into(), Some(restorable.clone())),
        ("dup-2".into(), Some(restorable)),
    ]);
    let (requests, failures) = plan_restore_in(&registry, &["dup-1".into(), "dup-2".into()]);
    assert_eq!(requests.len(), 1);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].error.contains("Another selected item"));
}
