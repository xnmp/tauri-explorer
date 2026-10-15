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
    let restore = inventory.items[0].restore.as_ref().unwrap();
    assert_eq!(
        restore.key,
        topdir.join("pictures/photo.jpg").to_str().unwrap()
    );
    assert_eq!(restore.destination, topdir.join("pictures/photo.jpg"));
    assert!(matches!(
        restore.artifact.as_ref(),
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

fn uid() -> u32 {
    unsafe { libc::geteuid() }
}

#[test]
fn mount_sources_follow_the_shared_and_per_user_trash_rules() {
    let scratch = tempfile::tempdir().unwrap();
    // A sticky shared .Trash with this user's directory, plus .Trash-$uid.
    let valid = scratch.path().join("valid");
    fs::create_dir_all(valid.join(".Trash").join(uid().to_string())).unwrap();
    fs::set_permissions(valid.join(".Trash"), fs::Permissions::from_mode(0o1777)).unwrap();
    fs::create_dir_all(valid.join(format!(".Trash-{}", uid()))).unwrap();
    let roots: Vec<_> = mount_sources(&valid)
        .into_iter()
        .map(|source| (source.root, source.topdir))
        .collect();
    assert_eq!(
        roots,
        [
            (
                valid.join(".Trash").join(uid().to_string()),
                Some(valid.clone())
            ),
            (valid.join(format!(".Trash-{}", uid())), Some(valid.clone())),
        ]
    );

    // A non-sticky shared .Trash and a symlinked one are not trusted.
    let unsafe_shared = scratch.path().join("unsafe");
    fs::create_dir_all(unsafe_shared.join(".Trash").join(uid().to_string())).unwrap();
    fs::set_permissions(
        unsafe_shared.join(".Trash"),
        fs::Permissions::from_mode(0o777),
    )
    .unwrap();
    assert!(mount_sources(&unsafe_shared).is_empty());
    let linked = scratch.path().join("linked");
    fs::create_dir(&linked).unwrap();
    std::os::unix::fs::symlink(valid.join(".Trash"), linked.join(".Trash")).unwrap();
    assert!(mount_sources(&linked).is_empty());
}

fn fixture_mount(id: u64, mount_point: &Path, filesystem: &str) -> Mount {
    Mount {
        id,
        parent_id: 1,
        root: PathBuf::from("/"),
        mount_point: mount_point.to_owned(),
        filesystem: filesystem.into(),
    }
}

#[test]
fn a_mount_that_does_not_answer_is_reported_without_hiding_other_volumes() {
    let scratch = tempfile::tempdir().unwrap();
    let fast = scratch.path().join("fast");
    let hung = scratch.path().join("hung");
    let proc_fs = scratch.path().join("proc");
    for top in [&fast, &hung, &proc_fs] {
        let root = top.join(format!(".Trash-{}", uid()));
        record(&root, "x.txt", "[Trash Info]\nPath=x.txt\n", Some(b"x"));
    }
    let mounts = MountSnapshot::from_mounts(vec![
        fixture_mount(2, &fast, "ext4"),
        fixture_mount(3, &hung, "nfs4"),
        fixture_mount(4, &proc_fs, "proc"),
    ]);
    let probed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen_probes = std::sync::Arc::clone(&probed);
    let hung_top = hung.clone();
    let mut inventory = Inventory::default();
    let started = Instant::now();
    scan_mounts(
        &mounts,
        Duration::from_millis(300),
        move |top| {
            seen_probes.lock().unwrap().push(top.to_owned());
            if top == hung_top {
                std::thread::sleep(Duration::from_secs(5));
            }
            scan_keyed(&mount_sources(top))
        },
        &mut HashSet::new(),
        &mut inventory,
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    let origins: Vec<_> = inventory
        .items
        .iter()
        .map(|item| item.entry.original_path.clone().unwrap())
        .collect();
    assert_eq!(origins, [fast.join("x.txt").to_string_lossy().into_owned()]);
    assert_eq!(inventory.issues.len(), 1, "{:?}", inventory.issues);
    assert_eq!(inventory.issues[0].source, hung.display().to_string());
    assert!(inventory.issues[0].error.contains("did not respond"));
    assert!(
        !probed.lock().unwrap().contains(&proc_fs),
        "pseudo filesystems are never probed"
    );
}

#[test]
fn a_trash_reached_through_two_paths_is_listed_once() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("Trash");
    record(&root, "a.txt", "[Trash Info]\nPath=/x/a.txt\n", Some(b"a"));
    let alias = scratch.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let mut inventory = Inventory::default();
    scan_sources(
        &[
            Source { root, topdir: None },
            Source {
                root: alias,
                topdir: None,
            },
        ],
        &mut inventory,
    );
    assert_eq!(inventory.items.len(), 1);
}
