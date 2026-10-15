//! Freedesktop trash enumeration: metadata parsing and per-source isolation.
use super::*;
use crate::files::trash_inventory::Inventory;
use std::{fs, os::unix::fs::PermissionsExt};

fn private_dir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

/// Hand-write one trash record, as another Freedesktop client would.
fn record(root: &Path, name: &str, info: &str, payload: Option<&[u8]>) {
    private_dir(&root.join("info"));
    private_dir(&root.join("files"));
    fs::write(root.join("info").join(format!("{name}.trashinfo")), info).unwrap();
    if let Some(payload) = payload {
        fs::write(root.join("files").join(name), payload).unwrap();
    }
}

#[test]
fn parses_percent_encoded_paths_and_local_deletion_dates() {
    let info = parse_trash_info(
        b"[Trash Info]\r\nPath=/home/user/My%20Docs/r%C3%A9sum%C3%A9.txt\r\nDeletionDate=2024-03-05T14:07:09\r\n",
    )
    .unwrap();
    assert_eq!(info.path, PathBuf::from("/home/user/My Docs/résumé.txt"));
    let deleted =
        chrono::DateTime::parse_from_rfc3339(info.deleted_at.as_deref().unwrap()).unwrap();
    assert_eq!(
        deleted.naive_local().to_string(),
        "2024-03-05 14:07:09",
        "the recorded local time is preserved"
    );
}

#[test]
fn rejects_metadata_without_a_usable_path() {
    for bytes in [
        &b"Path=/outside/group"[..],
        b"[Trash Info]\nDeletionDate=2024-03-05T14:07:09\n",
        b"[Trash Info]\nPath=/bad%zzescape\n",
        b"[Trash Info]\nPath=\n",
        b"[Other]\nPath=/elsewhere\n",
    ] {
        assert_eq!(
            parse_trash_info(bytes),
            None,
            "{:?}",
            String::from_utf8_lossy(bytes)
        );
    }
    let undated = parse_trash_info(b"[Trash Info]\nPath=/a/b\nDeletionDate=yesterday\n").unwrap();
    assert_eq!(
        undated.deleted_at, None,
        "a bad date keeps the item restorable"
    );
}

#[test]
fn scan_lists_valid_items_and_reports_malformed_records_separately() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("Trash");
    record(
        &root,
        "kept.txt",
        "[Trash Info]\nPath=/data/projects/kept.txt\nDeletionDate=2024-01-02T03:04:05\n",
        Some(b"kept bytes"),
    );
    record(&root, "broken.txt", "not trash metadata", Some(b"x"));
    record(
        &root,
        "orphan.txt",
        "[Trash Info]\nPath=/data/orphan.txt\n",
        None,
    );
    record(
        &root,
        "relative.txt",
        "[Trash Info]\nPath=relative.txt\n",
        Some(b"r"),
    );
    let mut inventory = Inventory::default();
    scan(
        &Source {
            root: root.clone(),
            topdir: None,
        },
        &mut inventory,
    );
    let names: Vec<_> = inventory
        .items
        .iter()
        .map(|item| &item.entry.name)
        .collect();
    assert_eq!(names, ["kept.txt"]);
    let entry = &inventory.items[0].entry;
    assert_eq!(
        entry.original_path.as_deref(),
        Some("/data/projects/kept.txt")
    );
    assert_eq!(entry.size, 10);
    assert_eq!(entry.kind, "file");
    assert!(entry.deleted_at.is_some());
    assert_eq!(inventory.issues.len(), 1, "{:?}", inventory.issues);
    assert!(
        inventory.issues[0]
            .error
            .starts_with("3 items could not be read"),
        "{:?}",
        inventory.issues
    );
}

#[test]
fn mounted_trash_paths_resolve_from_their_top_directory() {
    let scratch = tempfile::tempdir().unwrap();
    let topdir = scratch.path().join("volume");
    let root = topdir.join(".Trash-1000");
    record(
        &root,
        "photo.jpg",
        "[Trash Info]\nPath=pictures/photo.jpg\n",
        Some(b"jpeg"),
    );
    let mut inventory = Inventory::default();
    scan(
        &Source {
            root,
            topdir: Some(topdir.clone()),
        },
        &mut inventory,
    );
    assert_eq!(
        inventory.items[0].entry.original_path.as_deref(),
        Some(topdir.join("pictures/photo.jpg").to_str().unwrap())
    );
    let (key, artifact) = inventory.items[0].restore.as_ref().unwrap();
    assert_eq!(key, topdir.join("pictures/photo.jpg").to_str().unwrap());
    assert!(matches!(
        artifact.as_ref(),
        TrashArtifact::Freedesktop { .. }
    ));
}

#[test]
fn an_unreadable_source_does_not_hide_other_sources() {
    let scratch = tempfile::tempdir().unwrap();
    let good = scratch.path().join("good");
    let locked = scratch.path().join("locked");
    record(&good, "a.txt", "[Trash Info]\nPath=/x/a.txt\n", Some(b"a"));
    record(
        &locked,
        "b.txt",
        "[Trash Info]\nPath=/x/b.txt\n",
        Some(b"b"),
    );
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let readable_anyway = fs::read_dir(locked.join("info")).is_ok();
    let mut inventory = Inventory::default();
    scan_sources(
        &[
            Source {
                root: locked.clone(),
                topdir: None,
            },
            Source {
                root: scratch.path().join("missing"),
                topdir: None,
            },
            Source {
                root: good,
                topdir: None,
            },
        ],
        &mut inventory,
    );
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    if readable_anyway {
        return; // Privileged runners bypass directory permissions.
    }
    let names: Vec<_> = inventory
        .items
        .iter()
        .map(|item| &item.entry.name)
        .collect();
    assert_eq!(names, ["a.txt"]);
    assert_eq!(
        inventory.issues.len(),
        1,
        "a missing trash is empty, not an error"
    );
    assert_eq!(inventory.issues[0].source, locked.display().to_string());
}

#[test]
fn ids_are_stable_and_distinguish_same_named_items() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("Trash");
    record(
        &root,
        "notes.txt",
        "[Trash Info]\nPath=/one/notes.txt\n",
        Some(b"1"),
    );
    record(
        &root,
        "notes.txt.2",
        "[Trash Info]\nPath=/two/notes.txt\n",
        Some(b"2"),
    );
    let source = Source { root, topdir: None };
    let ids = || {
        let mut inventory = Inventory::default();
        scan(&source, &mut inventory);
        let mut ids: Vec<_> = inventory
            .items
            .iter()
            .map(|item| {
                (
                    item.entry.original_path.clone().unwrap(),
                    item.entry.id.clone(),
                )
            })
            .collect();
        ids.sort();
        ids
    };
    let first = ids();
    assert_eq!(first.len(), 2);
    assert_ne!(first[0].1, first[1].1);
    assert_eq!(first, ids(), "rescanning keeps each item's identity");
}
