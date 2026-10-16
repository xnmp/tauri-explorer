//! Tauri Explorer's own deletion records (#863): the macOS Trash view lists
//! and restores through them. These run the portable logic on any Unix with
//! a fixture trash folder standing in for `~/.Trash`.
use super::*;
use crate::files::trash_inventory::recorded_inventory;
use std::fs;

struct Fixture {
    scratch: tempfile::TempDir,
    store: Store,
}

impl Fixture {
    fn new() -> Self {
        let scratch = tempfile::tempdir().unwrap();
        fs::create_dir(scratch.path().join("Trash")).unwrap();
        let store = Store::at(scratch.path().join("records/trash-origins.json"));
        Self { scratch, store }
    }

    fn trash_dir(&self) -> PathBuf {
        self.scratch.path().join("Trash")
    }

    /// Trash like the system does: a same-named item already there makes it
    /// pick another name.
    fn trash(&self, path: &Path, landed_as: &str) {
        let landed = self.trash_dir().join(landed_as);
        trash_recorded(path, &self.trash_dir(), &self.store, |source| {
            fs::rename(source, &landed).map_err(Into::into)
        })
        .unwrap();
    }

    fn record_for(&self, original: &Path) -> Record {
        self.store
            .load()
            .into_iter()
            .find(|record| record.original == original)
            .unwrap_or_else(|| panic!("no record for {}", original.display()))
    }
}

#[test]
fn a_recorded_item_is_listed_with_its_origin_and_restores_exact_bytes() {
    let fixture = Fixture::new();
    let folder = fixture.scratch.path().join("docs");
    fs::create_dir(&folder).unwrap();
    let original = folder.join("report.txt");
    fs::write(&original, b"recorded \x00 bytes").unwrap();
    fs::write(fixture.trash_dir().join("unrelated.txt"), b"x").unwrap();
    fixture.trash(&original, "report 2.txt");

    let records = fixture.store.load();
    let inventory = recorded_inventory(&fixture.trash_dir(), &records);
    let listed = inventory
        .items
        .iter()
        .find(|item| item.entry.original_path.is_some())
        .unwrap();
    assert_eq!(listed.entry.name, "report.txt");
    assert_eq!(
        listed.entry.original_path.as_deref(),
        Some(original.to_str().unwrap())
    );
    assert!(listed.entry.deleted_at.is_some());
    let restorable = listed.restore.as_ref().unwrap();
    assert_eq!(restorable.destination, original);
    let unrecorded = inventory
        .items
        .iter()
        .find(|item| item.entry.name == "unrelated.txt")
        .unwrap();
    assert!(unrecorded.restore.is_none() && unrecorded.entry.original_path.is_none());

    let record = restorable.artifact.as_recorded().unwrap();
    restore(&record, &fixture.store).unwrap();
    assert_eq!(fs::read(&original).unwrap(), b"recorded \x00 bytes");
    assert!(!fixture.trash_dir().join("report 2.txt").exists());
    assert!(fixture.store.load().is_empty(), "the record is removed");
}

#[test]
fn restore_refuses_collisions_missing_folders_and_replaced_items() {
    let fixture = Fixture::new();
    let folder = fixture.scratch.path().join("docs");
    fs::create_dir(&folder).unwrap();
    let original = folder.join("notes.txt");
    fs::write(&original, b"trashed").unwrap();
    fixture.trash(&original, "notes.txt");
    let record = fixture.record_for(&original);
    let trashed = fixture.trash_dir().join("notes.txt");

    fs::write(&original, b"newer").unwrap();
    let error = restore(&record, &fixture.store).unwrap_err();
    assert!(error.to_string().contains("already exists"), "{error}");
    assert_eq!(fs::read(&original).unwrap(), b"newer");
    assert_eq!(fs::read(&trashed).unwrap(), b"trashed");

    fs::remove_file(&original).unwrap();
    fs::remove_dir(&folder).unwrap();
    let error = restore(&record, &fixture.store).unwrap_err();
    assert!(error.to_string().contains("no longer exists"), "{error}");
    assert!(!folder.exists(), "a missing folder is not recreated");
    assert!(trashed.exists());

    fs::create_dir(&folder).unwrap();
    fs::remove_file(&trashed).unwrap();
    fs::write(&trashed, b"another item, same name").unwrap();
    let error = restore(&record, &fixture.store).unwrap_err();
    assert!(error.to_string().contains("changed"), "{error}");
    assert!(!original.exists());
}

#[test]
fn an_item_deleted_through_a_symlinked_folder_restores_to_the_real_folder() {
    let fixture = Fixture::new();
    let real = fixture.scratch.path().join("private-docs");
    fs::create_dir(&real).unwrap();
    let link = fixture.scratch.path().join("docs-link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    fs::write(real.join("linked.txt"), b"through a link").unwrap();
    fixture.trash(&link.join("linked.txt"), "linked.txt");

    let record = fixture.record_for(&fs::canonicalize(&real).unwrap().join("linked.txt"));
    restore(&record, &fixture.store).unwrap();
    assert_eq!(
        fs::read(real.join("linked.txt")).unwrap(),
        b"through a link"
    );
}

#[test]
fn an_item_that_cannot_be_found_after_trashing_is_still_trashed() {
    let fixture = Fixture::new();
    let original = fixture.scratch.path().join("elsewhere.txt");
    fs::write(&original, b"x").unwrap();
    let outside = fixture.scratch.path().join("other-volume-trash");
    fs::create_dir(&outside).unwrap();
    let landed = outside.join("elsewhere.txt");
    trash_recorded(&original, &fixture.trash_dir(), &fixture.store, |source| {
        fs::rename(source, &landed).map_err(Into::into)
    })
    .unwrap();
    assert!(landed.exists());
    assert!(fixture.store.load().is_empty());
}
