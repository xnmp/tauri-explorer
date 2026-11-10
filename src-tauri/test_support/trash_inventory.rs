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

/// Real-filesystem tests own the process-wide listing registry one at a time;
/// parallel tests would race its replacement on every listing.
static REGISTRY_OWNER: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn own_registry() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_OWNER
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// Restore-to keys name the resolved target; match the refusal by its name.
fn failure_named<'a>(outcome: &'a FileBatchOutcome, name: &str) -> &'a str {
    &outcome
        .failed
        .iter()
        .find(|failure| Path::new(&failure.path).file_name() == Some(name.as_ref()))
        .unwrap_or_else(|| panic!("no failure for {name}: {outcome:?}"))
        .error
}

impl Fixture {
    fn restore_to(&self, ids: Vec<String>, destination: &Path) -> FileBatchOutcome {
        tauri::async_runtime::block_on(restore_to(ids, destination.to_owned(), &self.runtime))
            .expect("restore-to batch")
    }
}

/// Dragging Trash entries onto a folder restores them there (#1554): the
/// renderer names opaque IDs plus a folder, never a trash payload path, and
/// every refusal leaves the item recoverable in the trash.
#[test]
fn trash_view_restores_dropped_items_into_a_chosen_folder() {
    let _owner = own_registry();
    let mut fixture = Fixture::new();
    let drop = fixture.path("drop");
    fs::create_dir(&drop).unwrap();

    // Files and folders land in the destination byte-for-byte, even when
    // their original folder no longer exists, and leave the trash.
    let report = fixture.create("a/report.txt", b"report \x00\xff");
    let child = fixture.create("b/album/child.txt", b"child");
    let album = child.parent().unwrap().to_owned();
    fixture.trash(&report);
    fixture.trash(&album);
    fs::remove_dir(fixture.path("a")).unwrap();
    let listing = fixture.list();
    let ids = vec![
        fixture.id_for(&listing, &report),
        fixture.id_for(&listing, &album),
    ];
    let outcome = fixture.restore_to(ids, &drop);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(outcome.succeeded.len(), 2);
    assert!(outcome
        .succeeded
        .iter()
        .all(|key| Path::new(key).parent() == Some(fs::canonicalize(&drop).unwrap().as_path())));
    assert_eq!(
        fs::read(drop.join("report.txt")).unwrap(),
        b"report \x00\xff"
    );
    assert_eq!(fs::read(drop.join("album/child.txt")).unwrap(), b"child");
    assert!(
        !fixture.path("a").exists(),
        "no original folder is recreated"
    );
    assert!(!album.exists());
    assert_eq!(fixture.trash_counts(), (0, 0));

    // An occupied name is refused before any effect; nothing is replaced.
    let notes = fixture.create("c/notes.txt", b"trashed");
    fixture.trash(&notes);
    fs::write(drop.join("notes.txt"), b"already here").unwrap();
    let id = fixture.id_for(&fixture.list(), &notes);
    let outcome = fixture.restore_to(vec![id.clone()], &drop);
    assert!(failure_named(&outcome, "notes.txt").contains("already exists"));
    assert!(outcome.succeeded.is_empty());
    assert_eq!(fs::read(drop.join("notes.txt")).unwrap(), b"already here");
    assert_eq!(fixture.trash_counts(), (1, 1));

    // Same-named items from different folders cannot both take one name.
    let first = fixture.create("p/same.txt", b"first");
    let second = fixture.create("q/same.txt", b"second");
    fixture.trash(&first);
    fixture.trash(&second);
    let listing = fixture.list();
    let pair = vec![
        fixture.id_for(&listing, &first),
        fixture.id_for(&listing, &second),
    ];
    let outcome = fixture.restore_to(pair, &drop);
    assert_eq!(outcome.succeeded.len(), 1, "{outcome:?}");
    assert!(failure_named(&outcome, "same.txt").contains("Another selected item"));
    assert_eq!(fs::read(drop.join("same.txt")).unwrap(), b"first");
    assert_eq!(fixture.trash_counts(), (2, 2), "notes and second remain");

    // Destinations that are not existing absolute folders refuse every ID.
    let id = fixture.id_for(&fixture.list(), &notes);
    for (destination, expected) in [
        (fixture.path("missing"), "no longer exists"),
        (drop.join("same.txt"), "not a folder"),
        (
            PathBuf::from("relative/folder"),
            "not a folder on this computer",
        ),
    ] {
        let outcome = fixture.restore_to(vec![id.clone()], &destination);
        assert!(outcome.succeeded.is_empty());
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].path, id);
        assert!(
            outcome.failed[0].error.contains(expected),
            "{destination:?}: {outcome:?}"
        );
    }

    // The trash itself is never a destination: the payload would lose its record.
    let outcome = fixture.restore_to(vec![id.clone()], &fixture.trash_root().join("files"));
    assert!(failure_named(&outcome, "notes.txt").contains("into the Trash itself"));
    assert_eq!(fixture.trash_counts(), (2, 2));

    // Stale IDs are refused without effects.
    let outcome = fixture.restore_to(vec!["not-a-listed-id".into()], &drop);
    assert!(outcome.failed[0]
        .error
        .contains("no longer in the trash list"));

    // A symlinked destination publishes into the folder it resolves to.
    let real = fixture.path("real");
    fs::create_dir(&real).unwrap();
    let link = fixture.path("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let outcome = fixture.restore_to(vec![id], &link);
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(real.join("notes.txt")).unwrap(), b"trashed");
    assert_eq!(fixture.trash_counts(), (1, 1));

    // A payload changed after listing is still refused by the exact engine.
    let id = fixture.id_for(&fixture.list(), &second);
    let payload = fs::read_dir(fixture.trash_root().join("files"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .next()
        .unwrap();
    fs::write(&payload, b"tampered after listing").unwrap();
    let outcome = fixture.restore_to(vec![id], &real);
    assert!(
        failure_named(&outcome, "same.txt").contains("changed"),
        "{outcome:?}"
    );
    assert!(!real.join("same.txt").exists());
    assert!(payload.exists(), "the trash item stays recoverable");
}

/// The Freedesktop engine restores by one same-filesystem rename and never
/// copies (ADR 0019): another filesystem is refused before any effect.
#[test]
fn trash_view_refuses_restoring_into_another_filesystem() {
    use std::os::unix::fs::MetadataExt;
    let _owner = own_registry();
    let mut fixture = Fixture::new();
    let Ok(other) = tempfile::tempdir_in("/dev/shm") else {
        return;
    };
    let device = |path: &Path| fs::metadata(path).unwrap().dev();
    if device(other.path()) == device(fixture.scratch.path()) {
        return; // No second filesystem is available on this host.
    }
    let item = fixture.create("e/far.txt", b"far");
    fixture.trash(&item);
    let id = fixture.id_for(&fixture.list(), &item);
    let outcome = fixture.restore_to(vec![id], other.path());
    assert!(failure_named(&outcome, "far.txt").contains("different drive"));
    assert!(!other.path().join("far.txt").exists());
    assert_eq!(fixture.trash_counts(), (1, 1));
}

#[test]
fn trash_view_restores_exact_items_and_never_overwrites() {
    let _owner = own_registry();
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

    // Permanent deletion reports opaque IDs and cleans payload plus metadata,
    // even when the original folder no longer exists.
    let doomed = fixture.create("delete-gone/doomed.txt", b"delete me");
    fixture.trash(&doomed);
    fs::remove_dir(fixture.path("delete-gone")).unwrap();
    let id = fixture.id_for(&fixture.list(), &doomed);
    let outcome = tauri::async_runtime::block_on(delete(
        vec![id.clone(), "unknown".into()],
        &fixture.runtime,
    ))
    .unwrap();
    assert_eq!(outcome.succeeded, vec![id]);
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(outcome.failed[0].path, "unknown");
    assert!(!fixture.path("delete-gone").exists());
    assert!(!fixture
        .list()
        .entries
        .iter()
        .any(|entry| entry.name == "doomed.txt"));
    assert!(!fs::read_dir(fixture.trash_root().join("info"))
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("doomed.txt")));

    // Deleting a symlink removes the link only.
    let target = fixture.create("survivor.txt", b"keep me");
    let link = fixture.path("doomed-link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    fixture.trash(&link);
    let id = fixture.id_for(&fixture.list(), &link);
    let outcome =
        tauri::async_runtime::block_on(delete(vec![id.clone()], &fixture.runtime)).unwrap();
    assert_eq!(outcome.succeeded, vec![id]);
    assert_eq!(fs::read(&target).unwrap(), b"keep me");

    // Replacements must survive both before and after another listing.
    let original = fixture.create("replace.txt", b"old");
    fixture.trash(&original);
    let id = fixture.id_for(&fixture.list(), &original);
    let payload = fs::read_dir(fixture.trash_root().join("files"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("replace.txt")
        })
        .unwrap();
    fs::rename(&payload, fixture.path("held-old")).unwrap();
    fs::write(&payload, b"replacement").unwrap();
    let outcome =
        tauri::async_runtime::block_on(delete(vec![id.clone()], &fixture.runtime)).unwrap();
    assert!(outcome.succeeded.is_empty(), "{outcome:?}");
    assert_eq!(outcome.failed[0].path, id);
    assert_eq!(fs::read(&payload).unwrap(), b"replacement");
    fixture.list();
    let outcome = tauri::async_runtime::block_on(delete(vec![id], &fixture.runtime)).unwrap();
    assert!(outcome.succeeded.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&payload).unwrap(), b"replacement");

    // Changed or missing metadata prevents payload deletion; selecting another
    // valid sibling in the same batch still deletes that sibling.
    let changed_meta = fixture.create("metadata.txt", b"metadata survivor");
    fixture.trash(&changed_meta);
    let sibling = fixture.create("sibling.txt", b"valid sibling");
    fixture.trash(&sibling);
    let listing = fixture.list();
    let id = fixture.id_for(&listing, &changed_meta);
    let sibling_id = fixture.id_for(&listing, &sibling);
    let metadata = fs::read_dir(fixture.trash_root().join("info"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("metadata.txt")
        })
        .unwrap();
    let bytes = fs::read(&metadata).unwrap();
    fs::rename(&metadata, fixture.path("old-metadata")).unwrap();
    fs::write(&metadata, &bytes).unwrap();
    let outcome = tauri::async_runtime::block_on(delete(
        vec![id.clone(), sibling_id.clone()],
        &fixture.runtime,
    ))
    .unwrap();
    assert_eq!(outcome.succeeded, vec![sibling_id]);
    assert_eq!(outcome.failed[0].path, id);
    assert!(metadata.exists());
    assert!(fs::read_dir(fixture.trash_root().join("files"))
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("metadata.txt")));

    // Recovery reservations for either metadata or layout exclude deletion.
    let reserved = fixture.create("reserved.txt", b"reserved bytes");
    fixture.trash(&reserved);
    let id = fixture.id_for(&fixture.list(), &reserved);
    let metadata = fs::read_dir(fixture.trash_root().join("info"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("reserved.txt")
        })
        .unwrap();
    for path in [metadata.clone(), fixture.trash_root()] {
        let held = tauri::async_runtime::block_on(fixture.runtime.admit(vec![
            crate::files::recovery::ResourceRequest {
                path,
                access: crate::files::recovery::Access::Write,
                scope: crate::files::recovery::Scope::Subtree,
            },
        ]))
        .unwrap();
        let result = tauri::async_runtime::block_on(delete(vec![id.clone()], &fixture.runtime));
        assert!(
            result.is_err(),
            "deletion must respect recovery claims: {result:?}"
        );
        assert!(metadata.exists());
        held.finish().unwrap();
    }
    let outcome = tauri::async_runtime::block_on(delete(vec![id], &fixture.runtime)).unwrap();
    assert_eq!(outcome.succeeded.len(), 1);
    assert!(!metadata.exists());

    // macOS can delete items without an origin record; native names need not
    // be valid UTF-8 and broken symlinks must not be followed.
    let native_root = fixture.path("native-trash");
    fs::create_dir(&native_root).unwrap();
    let unrecorded = native_root.join(std::ffi::OsStr::from_bytes(b"native-\xff"));
    std::os::unix::fs::symlink(fixture.path("missing-target"), &unrecorded).unwrap();
    let listing = publish(recorded_inventory(&native_root, &[]));
    assert!(listing.entries[0].original_path.is_none());
    let id = listing.entries[0].id.clone();
    let outcome =
        tauri::async_runtime::block_on(delete(vec![id.clone()], &fixture.runtime)).unwrap();
    assert_eq!(outcome.succeeded, vec![id]);
    assert!(fs::symlink_metadata(&unrecorded).is_err());

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
        (
            "dup-1".into(),
            Registered {
                restore: Some(restorable.clone()),
                native_deletion: None,
            },
        ),
        (
            "dup-2".into(),
            Registered {
                restore: Some(restorable),
                native_deletion: None,
            },
        ),
    ]);
    let (requests, failures) = plan_restore_in(&registry, &["dup-1".into(), "dup-2".into()]);
    assert_eq!(requests.len(), 1);
    assert_eq!(failures.len(), 1);
    assert!(failures[0].error.contains("Another selected item"));
}
