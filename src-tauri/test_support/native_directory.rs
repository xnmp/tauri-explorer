use super::*;
use std::os::unix::fs::{symlink, MetadataExt};

#[cfg(target_os = "linux")]
#[test]
fn mount_identity_uses_the_retained_directory_instead_of_its_proc_symlink() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    let expected = crate::files::trash_mounts::mount_id(temporary.path()).unwrap();
    assert_eq!(directory.mount_id().unwrap(), expected);
    let original = temporary.path().join("original");
    std::fs::create_dir(&original).unwrap();
    let retained = Directory::open(&original).unwrap();
    std::fs::rename(&original, temporary.path().join("moved")).unwrap();
    symlink("/proc", &original).unwrap();
    assert_eq!(retained.mount_id().unwrap(), expected);
}

#[test]
fn enumeration_is_repeatable_bounded_and_lossless() {
    let temporary = tempfile::tempdir().unwrap();
    let name = OsString::from_vec(b"native-\xff".to_vec());
    std::fs::write(temporary.path().join(&name), b"bytes").unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    assert_eq!(directory.names(1).unwrap(), vec![name.clone()]);
    assert_eq!(directory.names(1).unwrap(), vec![name]);
    assert!(directory.names(0).is_err());
    std::fs::write(temporary.path().join("extra"), b"bytes").unwrap();
    assert!(directory.names(1).is_err());
    assert_eq!(directory.names(2).unwrap().len(), 2);
}

#[test]
fn retained_directory_handle_survives_namespace_replacement() {
    let temporary = tempfile::tempdir().unwrap();
    let parent = Directory::open(temporary.path()).unwrap();
    let original = parent.create_directory(OsStr::new("original")).unwrap();
    std::fs::write(temporary.path().join("original/payload"), b"original").unwrap();
    let identity = original.stat(OsStr::new("payload")).unwrap();
    std::fs::rename(
        temporary.path().join("original"),
        temporary.path().join("retained"),
    )
    .unwrap();
    std::fs::create_dir(temporary.path().join("original")).unwrap();
    std::fs::write(temporary.path().join("original/payload"), b"replacement").unwrap();
    assert_eq!(
        original.stat(OsStr::new("payload")).unwrap().st_ino,
        identity.st_ino
    );
    original
        .rename_to(OsStr::new("payload"), &parent, OsStr::new("restored"))
        .unwrap();
    assert_eq!(
        std::fs::read(temporary.path().join("restored")).unwrap(),
        b"original"
    );
    assert_eq!(
        std::fs::read(temporary.path().join("original/payload")).unwrap(),
        b"replacement"
    );
}

#[test]
fn exclusive_publication_preserves_occupied_target() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    std::fs::write(temporary.path().join("source"), b"source").unwrap();
    std::fs::write(temporary.path().join("target"), b"target").unwrap();
    assert!(directory
        .rename_to(OsStr::new("source"), &directory, OsStr::new("target"))
        .is_err());
    assert_eq!(
        std::fs::read(temporary.path().join("source")).unwrap(),
        b"source"
    );
    assert_eq!(
        std::fs::read(temporary.path().join("target")).unwrap(),
        b"target"
    );
}

#[test]
fn private_children_are_exclusive_and_symlinks_are_never_followed() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    let child = directory.create_directory(OsStr::new("private")).unwrap();
    assert_eq!(child.metadata().unwrap().mode() & 0o777, 0o700);
    assert!(directory.create_directory(OsStr::new("private")).is_err());
    symlink("private", temporary.path().join("link")).unwrap();
    assert!(directory.open_existing(OsStr::new("link")).is_err());
    assert!(directory.open_file(OsStr::new("link")).is_err());
    assert_eq!(
        directory.stat(OsStr::new("link")).unwrap().st_mode & libc::S_IFMT,
        libc::S_IFLNK
    );
    directory.unlink(OsStr::new("link"), false).unwrap();
    assert!(temporary.path().join("private").is_dir());
}

#[test]
fn streaming_enumerations_have_independent_offsets_and_survive_parent_rename() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("source");
    std::fs::create_dir(&path).unwrap();
    for name in ["a", "b", "c"] {
        std::fs::write(path.join(name), name).unwrap();
    }
    let directory = Directory::open(&path).unwrap();
    let mut first = directory.entries().unwrap();
    let head = first.next().unwrap().unwrap();
    std::fs::rename(&path, temporary.path().join("held")).unwrap();
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("replacement"), b"new occupant").unwrap();
    let mut names = vec![head];
    names.extend(first.collect::<std::io::Result<Vec<_>>>().unwrap());
    names.sort();
    assert_eq!(names, ["a", "b", "c"].map(std::ffi::OsString::from));
    let mut second = directory
        .entries()
        .unwrap()
        .collect::<std::io::Result<Vec<_>>>()
        .unwrap();
    second.sort();
    assert_eq!(second, names);
    assert!(directory.names(2).is_err());
}

#[test]
fn anchored_links_preserve_literal_text_and_reject_truncation_or_replacement() {
    use std::os::unix::ffi::OsStringExt;
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    let target = std::ffi::OsString::from_vec(b"../missing-\xff".to_vec());
    directory
        .create_symlink(OsStr::new("link"), &target)
        .unwrap();
    assert_eq!(directory.read_link(OsStr::new("link"), 12).unwrap(), target);
    assert!(directory.read_link(OsStr::new("link"), 11).is_err());
    assert!(directory.read_link(OsStr::new("link"), 0).is_err());
    assert!(directory.read_link(OsStr::new("link"), usize::MAX).is_err());
    assert!(directory
        .create_symlink(OsStr::new("link"), OsStr::new("other"))
        .is_err());
    assert_eq!(
        std::fs::read_link(temporary.path().join("link"))
            .unwrap()
            .as_os_str(),
        target
    );
    assert!(directory
        .create_symlink(OsStr::new("../outside"), &target)
        .is_err());
    let long = "x".repeat(512);
    directory
        .create_symlink(OsStr::new("long"), OsStr::new(&long))
        .unwrap();
    assert_eq!(
        directory.read_link(OsStr::new("long"), 512).unwrap(),
        OsStr::new(&long)
    );
    assert!(directory.read_link(OsStr::new("long"), 511).is_err());
}
