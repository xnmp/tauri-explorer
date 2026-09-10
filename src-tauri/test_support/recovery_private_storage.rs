use super::*;
use std::{ffi::OsStr, fs, io::Write};

fn private_directory() -> (tempfile::TempDir, Directory) {
    let temporary = tempfile::tempdir().unwrap();
    let parent = Directory::open(temporary.path()).unwrap();
    let directory = parent.create_directory(OsStr::new("private")).unwrap();
    (temporary, directory)
}

#[test]
fn evidence_validation_uses_the_retained_file_after_name_replacement() {
    let (temporary, directory) = private_directory();
    validate_directory(&directory).unwrap();
    let mut file = directory.create_file(OsStr::new("intent")).unwrap();
    file.write_all(b"retained evidence").unwrap();
    let original = temporary.path().join("private/intent");
    let retained = temporary.path().join("private/held");
    fs::rename(&original, &retained).unwrap();
    fs::write(&original, b"replacement").unwrap();

    assert_eq!(validate_file(&file).unwrap().len(), 17);
    assert_eq!(fs::read(retained).unwrap(), b"retained evidence");
    assert_eq!(fs::read(original).unwrap(), b"replacement");
    assert!(validate_file(&directory.file).is_err());
}

#[test]
fn linked_or_retired_evidence_cannot_pass_private_storage_validation() {
    let (temporary, directory) = private_directory();
    let mut file = directory.create_file(OsStr::new("intent")).unwrap();
    file.write_all(b"preserve").unwrap();
    let original = temporary.path().join("private/intent");
    let alias = temporary.path().join("alias");
    validate_file(&file).unwrap();

    fs::hard_link(&original, &alias).unwrap();
    assert!(validate_file(&file).is_err());
    assert_eq!(fs::read(&alias).unwrap(), b"preserve");
    fs::remove_file(&alias).unwrap();
    validate_file(&file).unwrap();

    fs::remove_file(&original).unwrap();
    assert!(validate_file(&file).is_err());
}

#[test]
fn retired_directory_is_not_valid_private_storage() {
    let (temporary, directory) = private_directory();
    validate_directory(&directory).unwrap();
    fs::remove_dir(temporary.path().join("private")).unwrap();
    assert!(validate_directory(&directory).is_err());
}

#[cfg(windows)]
#[test]
fn inherited_child_cannot_substitute_for_explicit_private_evidence() {
    let (temporary, directory) = private_directory();
    let path = temporary.path().join("private/inherited");
    fs::write(&path, b"ordinary inherited child").unwrap();
    let inherited = fs::File::open(&path).unwrap();
    validate_directory(&directory).unwrap();
    assert!(validate_file(&inherited).is_err());
    assert_eq!(fs::read(path).unwrap(), b"ordinary inherited child");
}

#[cfg(unix)]
#[test]
fn widened_permissions_are_rejected_without_modifying_evidence() {
    use std::os::unix::fs::PermissionsExt;
    let (temporary, directory) = private_directory();
    let mut file = directory.create_file(OsStr::new("intent")).unwrap();
    file.write_all(b"preserve").unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o640))
        .unwrap();
    assert!(validate_file(&file).is_err());
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    validate_file(&file).unwrap();

    directory
        .file
        .set_permissions(fs::Permissions::from_mode(0o755))
        .unwrap();
    assert!(validate_directory(&directory).is_err());
    directory
        .file
        .set_permissions(fs::Permissions::from_mode(0o700))
        .unwrap();
    validate_directory(&directory).unwrap();
    assert_eq!(
        fs::read(temporary.path().join("private/intent")).unwrap(),
        b"preserve"
    );
}
