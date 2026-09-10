use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

fn fixture() -> (tempfile::TempDir, Directory) {
    let temporary = tempfile::tempdir().unwrap();
    let parent = Directory::open(&fs::canonicalize(temporary.path()).unwrap()).unwrap();
    fs::create_dir(temporary.path().join("payload")).unwrap();
    fs::write(temporary.path().join("payload/child"), b"retained contents").unwrap();
    fs::set_permissions(
        temporary.path().join("payload"),
        fs::Permissions::from_mode(0o0),
    )
    .unwrap();
    (temporary, parent)
}

fn mode(path: &std::path::Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

#[test]
fn directory_permission_pin_survives_name_replacement_without_touching_new_occupant() {
    let (temporary, parent) = fixture();
    let pin = parent.open_for_permissions(OsStr::new("payload")).unwrap();
    let identity = pin.metadata().unwrap();
    assert_eq!(identity.permissions().mode() & 0o7777, 0);
    fs::rename(
        temporary.path().join("payload"),
        temporary.path().join("held"),
    )
    .unwrap();
    fs::create_dir(temporary.path().join("payload")).unwrap();
    fs::set_permissions(
        temporary.path().join("payload"),
        fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    pin.set_mode(0o700).unwrap();
    let readable = pin.open_readable().unwrap();
    readable.sync().unwrap();
    assert_eq!(mode(&temporary.path().join("held")), 0o700);
    assert_eq!(mode(&temporary.path().join("payload")), 0o500);
    use std::io::Read;
    let mut bytes = Vec::new();
    readable
        .open_file(OsStr::new("child"))
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"retained contents");
}

#[test]
fn directory_permission_access_rejects_symlinks_and_invalid_modes() {
    let (temporary, parent) = fixture();
    std::os::unix::fs::symlink("payload", temporary.path().join("link")).unwrap();
    assert!(parent.open_for_permissions(OsStr::new("link")).is_err());
    assert!(parent
        .open_for_permissions(OsStr::new("../payload"))
        .is_err());
    let pin = parent.open_for_permissions(OsStr::new("payload")).unwrap();
    assert!(pin.set_mode(0o100700).is_err());
    assert_eq!(mode(&temporary.path().join("payload")), 0);
    pin.set_mode(0o700).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn procfs_fallback_changes_the_pinned_directory_after_its_name_was_replaced() {
    let (temporary, parent) = fixture();
    let pin = parent.open_for_permissions(OsStr::new("payload")).unwrap();
    fs::rename(
        temporary.path().join("payload"),
        temporary.path().join("held"),
    )
    .unwrap();
    fs::create_dir(temporary.path().join("payload")).unwrap();
    fs::set_permissions(
        temporary.path().join("payload"),
        fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    pin.set_mode_via_procfs(0o700).unwrap();
    pin.open_readable().unwrap().sync().unwrap();
    assert_eq!(mode(&temporary.path().join("held")), 0o700);
    assert_eq!(mode(&temporary.path().join("payload")), 0o500);
}

#[cfg(target_os = "linux")]
#[test]
fn descriptor_fallback_rejects_an_ordinary_directory_without_changing_permissions() {
    let (temporary, parent) = fixture();
    let pin = parent.open_for_permissions(OsStr::new("payload")).unwrap();
    assert!(pin.set_mode_via_descriptors(&parent, 0o700).is_err());
    assert_eq!(mode(&temporary.path().join("payload")), 0);
    pin.set_mode(0o700).unwrap();
}
