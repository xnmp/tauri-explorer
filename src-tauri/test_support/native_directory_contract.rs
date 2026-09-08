use super::Directory;
use std::{ffi::OsStr, fs, io::Write};

#[test]
fn creates_are_exclusive_and_existence_does_not_replace_type_validation() {
    let root = tempfile::tempdir().unwrap();
    let directory = Directory::open(root.path()).unwrap();
    assert!(!directory.entry_exists(OsStr::new("payload")).unwrap());
    directory
        .create_file(OsStr::new("payload"))
        .unwrap()
        .write_all(b"original")
        .unwrap();
    assert!(directory.entry_exists(OsStr::new("payload")).unwrap());
    assert!(directory.create_file(OsStr::new("payload")).is_err());
    assert!(directory.create_directory(OsStr::new("payload")).is_err());
    directory.create_directory(OsStr::new("child")).unwrap();
    assert!(directory.entry_exists(OsStr::new("child")).unwrap());
    assert!(directory.create_file(OsStr::new("child")).is_err());
    assert!(directory.create_directory(OsStr::new("child")).is_err());
    assert_eq!(fs::read(root.path().join("payload")).unwrap(), b"original");
}

#[test]
fn independent_enumerations_retain_the_anchor_after_its_name_is_replaced() {
    let root = tempfile::tempdir().unwrap();
    let parent = Directory::open(root.path()).unwrap();
    let child = parent.create_directory(OsStr::new("child")).unwrap();
    assert!(child.metadata().unwrap().is_dir());
    child
        .create_file(OsStr::new("payload"))
        .unwrap()
        .write_all(b"retained")
        .unwrap();
    fs::rename(root.path().join("child"), root.path().join("held")).unwrap();
    fs::create_dir(root.path().join("child")).unwrap();
    fs::write(root.path().join("child/replacement"), b"replacement").unwrap();
    std::thread::scope(|scope| {
        let first = scope.spawn(|| child.names(1).unwrap());
        let second = scope.spawn(|| child.names(1).unwrap());
        assert_eq!(first.join().unwrap(), vec![OsStr::new("payload")]);
        assert_eq!(second.join().unwrap(), vec![OsStr::new("payload")]);
    });
    assert!(child.names(0).is_err());
    child
        .rename_to(OsStr::new("payload"), &parent, OsStr::new("restored"))
        .unwrap();
    assert!(child.names(0).unwrap().is_empty());
    assert_eq!(fs::read(root.path().join("restored")).unwrap(), b"retained");
    assert_eq!(
        fs::read(root.path().join("child/replacement")).unwrap(),
        b"replacement"
    );
}

#[test]
fn failed_rename_and_wrong_removal_kind_preserve_entries() {
    let root = tempfile::tempdir().unwrap();
    let directory = Directory::open(root.path()).unwrap();
    for name in ["source", "target"] {
        directory
            .create_file(OsStr::new(name))
            .unwrap()
            .write_all(name.as_bytes())
            .unwrap();
    }
    let child = directory.create_directory(OsStr::new("child")).unwrap();
    child.create_file(OsStr::new("content")).unwrap();
    assert!(directory
        .rename_to(OsStr::new("source"), &directory, OsStr::new("target"))
        .is_err());
    assert!(directory.unlink(OsStr::new("source"), true).is_err());
    assert!(directory.unlink(OsStr::new("child"), false).is_err());
    assert!(directory.unlink(OsStr::new("child"), true).is_err());
    assert_eq!(fs::read(root.path().join("source")).unwrap(), b"source");
    assert_eq!(fs::read(root.path().join("target")).unwrap(), b"target");
    child.unlink(OsStr::new("content"), false).unwrap();
    drop(child);
    directory.unlink(OsStr::new("child"), true).unwrap();
    directory.unlink(OsStr::new("source"), false).unwrap();
    assert!(!directory.entry_exists(OsStr::new("child")).unwrap());
    assert!(!directory.entry_exists(OsStr::new("source")).unwrap());
}

#[test]
fn relative_operations_reject_non_component_names_without_effects() {
    let root = tempfile::tempdir().unwrap();
    let directory = Directory::open(root.path()).unwrap();
    let oversized = "x".repeat(128 * 1024);
    let mut invalid_names = vec!["", ".", "..", "a/b", "/outside", "a\0b", &oversized];
    if cfg!(windows) {
        invalid_names.extend(["a\\b", "a:stream", "\\outside"]);
    }
    for name in invalid_names {
        let name = OsStr::new(name);
        assert!(directory.create_file(name).is_err());
        assert!(directory.create_directory(name).is_err());
        assert!(directory.open_file(name).is_err());
        assert!(directory.open_existing(name).is_err());
        assert!(directory.entry_exists(name).is_err());
        assert!(directory.unlink(name, false).is_err());
    }
    assert!(directory.names(0).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_dangling_symlink_is_an_existing_entry_and_is_never_followed() {
    let root = tempfile::tempdir().unwrap();
    let directory = Directory::open(root.path()).unwrap();
    std::os::unix::fs::symlink("missing", root.path().join("link")).unwrap();
    assert!(directory.entry_exists(OsStr::new("link")).unwrap());
    assert!(directory.open_file(OsStr::new("link")).is_err());
    directory.unlink(OsStr::new("link"), false).unwrap();
    assert!(!directory.entry_exists(OsStr::new("link")).unwrap());
    assert!(!root.path().join("missing").exists());
}

#[cfg(windows)]
#[test]
fn windows_volume_name_limit_is_enforced_and_durability_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let directory = Directory::open(root.path()).unwrap();
    let maximum = directory.name_max().unwrap();
    assert!((1..=32_767).contains(&maximum));
    let accepted = "a".repeat(maximum);
    directory.create_file(OsStr::new(&accepted)).unwrap();
    assert!(directory.entry_exists(OsStr::new(&accepted)).unwrap());
    let oversized = "b".repeat(maximum + 1);
    assert!(directory.create_file(OsStr::new(&oversized)).is_err());
    assert_eq!(directory.names(1).unwrap(), vec![OsStr::new(&accepted)]);
    assert_eq!(
        directory.sync().unwrap_err().kind(),
        std::io::ErrorKind::Unsupported
    );
}
