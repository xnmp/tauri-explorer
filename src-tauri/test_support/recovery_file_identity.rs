use super::of_file;
use std::fs::{self, File};

#[test]
fn independent_opens_and_hardlinks_identify_the_same_live_object() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original");
    let alias = root.path().join("alias");
    fs::write(&original, b"original bytes").unwrap();
    fs::hard_link(&original, &alias).unwrap();
    let first = of_file(&File::open(&original).unwrap()).unwrap();
    assert_eq!(first, of_file(&File::open(&original).unwrap()).unwrap());
    assert_eq!(first, of_file(&File::open(&alias).unwrap()).unwrap());
    let other = root.path().join("other");
    fs::write(&other, b"original bytes").unwrap();
    let second = of_file(&File::open(other).unwrap()).unwrap();
    assert_ne!(first, second, "equal bytes do not imply identical objects");
    assert!(first.same_volume(second));
}

#[test]
fn captured_handle_never_switches_to_a_replacement_at_the_original_path() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("original");
    let renamed = root.path().join("renamed");
    fs::write(&path, b"retained bytes").unwrap();
    let opened = File::open(&path).unwrap();
    let identity = of_file(&opened).unwrap();
    fs::rename(&path, &renamed).unwrap();
    fs::write(&path, b"replacement bytes").unwrap();
    assert_eq!(of_file(&opened).unwrap(), identity);
    assert_eq!(of_file(&File::open(&renamed).unwrap()).unwrap(), identity);
    assert_ne!(of_file(&File::open(&path).unwrap()).unwrap(), identity);
    assert_eq!(fs::read(renamed).unwrap(), b"retained bytes");
    assert_eq!(fs::read(path).unwrap(), b"replacement bytes");
}

#[cfg(unix)]
#[test]
fn no_follow_metadata_distinguishes_a_symlink_from_its_target() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let link = root.path().join("link");
    fs::write(&target, b"target").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let target_id = of_file(&File::open(&target).unwrap()).unwrap();
    assert_ne!(
        super::from_metadata(&fs::symlink_metadata(&link).unwrap()),
        target_id
    );
    assert_eq!(
        super::from_metadata(&fs::metadata(&link).unwrap()),
        target_id
    );
}

#[cfg(windows)]
#[test]
fn a_character_device_cannot_supply_recovery_file_identity() {
    let device = File::open("NUL").unwrap();
    assert!(of_file(&device).is_err());
}

#[cfg(windows)]
#[test]
fn ntfs_case_variants_keep_the_same_physical_identity() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mixed-case-identity.txt");
    fs::write(&path, b"identity").unwrap();
    let variant = std::path::PathBuf::from(path.to_string_lossy().to_uppercase());
    assert_ne!(variant, path);
    assert_eq!(
        of_file(&File::open(&path).unwrap()).unwrap(),
        of_file(&File::open(&variant).unwrap()).unwrap()
    );
}

#[cfg(windows)]
#[test]
#[ignore = "dedicated Windows runner enables NTFS 8.3 generation for this case"]
fn ntfs_short_name_alias_keeps_physical_identity() {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::PathBuf};
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetShortPathNameW};

    let root = tempfile::tempdir().unwrap();
    let long = root.path().join("long physical identity filename.txt");
    fs::write(&long, b"identity").unwrap();
    let wide: Vec<u16> = OsStr::new(&long).encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and remains live for both synchronous calls.
    let needed = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), None) };
    assert!(
        needed > 0,
        "GetShortPathNameW failed: {}",
        std::io::Error::last_os_error()
    );
    let mut output = vec![0u16; needed as usize];
    // SAFETY: the output buffer has the size requested by the first call.
    let written = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut output)) };
    assert!(written > 0 && written < needed);
    let short = PathBuf::from(String::from_utf16(&output[..written as usize]).unwrap());
    assert_ne!(
        short.file_name(),
        long.file_name(),
        "8.3 evidence must use a distinct fixture filename alias on {}",
        root.path().display()
    );
    assert_eq!(
        of_file(&File::open(&long).unwrap()).unwrap(),
        of_file(&File::open(&short).unwrap()).unwrap()
    );
}

#[cfg(windows)]
#[test]
fn ntfs_hardlink_alias_keeps_physical_identity() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("physical-original.txt");
    let alias = root.path().join("physical-hardlink.txt");
    fs::write(&original, b"identity").unwrap();
    fs::hard_link(&original, &alias).unwrap();
    assert_eq!(
        of_file(&File::open(&original).unwrap()).unwrap(),
        of_file(&File::open(&alias).unwrap()).unwrap()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn descriptor_relative_versions_agree_with_no_follow_metadata() {
    use crate::files::native_directory::Directory;
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("file"), b"payload").unwrap();
    fs::create_dir(root.path().join("directory")).unwrap();
    std::os::unix::fs::symlink("missing", root.path().join("dangling")).unwrap();
    let parent = Directory::open(root.path()).unwrap();
    for name in ["file", "directory", "dangling"] {
        let metadata = fs::symlink_metadata(root.path().join(name)).unwrap();
        let observed = super::version_at(&parent, std::ffi::OsStr::new(name)).unwrap();
        assert_eq!(observed, super::version_from_metadata(&metadata).unwrap());
    }
}
