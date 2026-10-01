use super::*;
use std::{
    ffi::{CString, OsStr},
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Path, PathBuf},
};

#[derive(Default)]
struct TestProgress<'a> {
    bytes: u64,
    files: Vec<PathBuf>,
    cancel_before_effect: bool,
    fail_after_first_advance: bool,
    after_first_advance: Option<Box<dyn FnMut() + 'a>>,
}

impl CopyProgress for TestProgress<'_> {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        if self.cancel_before_effect {
            return Err(AppError::Other("copy cancelled".into()));
        }
        Ok(())
    }

    fn advance(&mut self, bytes: u64, current_file: &Path) -> Result<(), AppError> {
        self.bytes += bytes;
        self.files.push(current_file.to_path_buf());
        if self.files.len() == 1 {
            if let Some(callback) = self.after_first_advance.as_mut() {
                callback();
            }
            if self.fail_after_first_advance {
                return Err(AppError::Other("copy cancelled".into()));
            }
        }
        Ok(())
    }
}

fn parents(root: &Path) -> (Directory, Directory) {
    fs::create_dir(root.join("source-parent")).unwrap();
    fs::create_dir(root.join("target-parent")).unwrap();
    (
        Directory::open(&root.join("source-parent")).unwrap(),
        Directory::open(&root.join("target-parent")).unwrap(),
    )
}

#[test]
fn regular_file_copy_preserves_bytes_mode_and_reports_the_observed_target() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source_path = temporary.path().join("source-parent/source");
    let target_path = temporary.path().join("target-parent/target");
    let bytes = vec![0x5a; COPY_BUFFER_BYTES + 17];
    fs::write(&source_path, &bytes).unwrap();
    fs::set_permissions(&source_path, fs::Permissions::from_mode(0o751)).unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let mut progress = TestProgress::default();

    let outcome = copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source_path,
        &expected,
        &mut progress,
    )
    .unwrap();

    assert_eq!(fs::read(&target_path).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&target_path).unwrap().permissions().mode() & 0o7777,
        0o751
    );
    assert_eq!(
        outcome.version,
        version_at(&target_parent, OsStr::new("target")).unwrap()
    );
    assert_eq!(outcome.final_mode, None);
    assert_eq!(progress.bytes, (COPY_BUFFER_BYTES + 17) as u64);
    assert!(progress.files.iter().all(|path| path == &source_path));
}

#[test]
fn directory_copy_preserves_nested_modes_and_literal_dangling_and_cycle_links() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/tree");
    fs::create_dir(&source).unwrap();
    fs::create_dir(source.join("nested")).unwrap();
    fs::write(source.join("nested/file"), b"nested bytes").unwrap();
    fs::set_permissions(
        source.join("nested/file"),
        fs::Permissions::from_mode(0o640),
    )
    .unwrap();
    std::os::unix::fs::symlink("missing-target", source.join("dangling")).unwrap();
    std::os::unix::fs::symlink(".", source.join("cycle")).unwrap();
    fs::set_permissions(source.join("nested"), fs::Permissions::from_mode(0o511)).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
    let expected = version_at(&source_parent, OsStr::new("tree")).unwrap();
    let mut progress = TestProgress::default();

    let outcome = copy_entry(
        &source_parent,
        OsStr::new("tree"),
        &target_parent,
        OsStr::new("tree-copy"),
        &source,
        &expected,
        &mut progress,
    )
    .unwrap();
    let target = temporary.path().join("target-parent/tree-copy");

    assert_eq!(
        fs::read(target.join("nested/file")).unwrap(),
        b"nested bytes"
    );
    assert_eq!(
        fs::metadata(target.join("nested/file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o640
    );
    assert_eq!(
        fs::metadata(target.join("nested"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o511
    );
    assert!(fs::symlink_metadata(target.join("dangling"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_link(target.join("dangling")).unwrap(),
        Path::new("missing-target")
    );
    assert_eq!(fs::read_link(target.join("cycle")).unwrap(), Path::new("."));
    assert_eq!(
        fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    assert_eq!(outcome.final_mode, Some(0o500));
    assert_eq!(
        outcome.version,
        version_at(&target_parent, OsStr::new("tree-copy")).unwrap()
    );
}

#[test]
fn cancellation_before_the_first_effect_leaves_the_target_absent() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    fs::write(&source, b"source remains").unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let mut progress = TestProgress {
        cancel_before_effect: true,
        ..TestProgress::default()
    };

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), b"source remains");
    assert!(!temporary.path().join("target-parent/target").exists());
}

#[test]
fn mid_copy_cancellation_retains_the_partial_private_output() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    let bytes = vec![0x39; COPY_BUFFER_BYTES * 2 + 9];
    fs::write(&source, &bytes).unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let mut progress = TestProgress {
        fail_after_first_advance: true,
        ..TestProgress::default()
    };

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    assert_eq!(
        fs::read(temporary.path().join("target-parent/target")).unwrap(),
        &bytes[..COPY_BUFFER_BYTES]
    );
}

#[test]
fn source_growth_during_copy_is_rejected_and_partial_output_is_retained() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    let original = vec![0x61; COPY_BUFFER_BYTES + 7];
    fs::write(&source, &original).unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let mutate = source.clone();
    let mut progress = TestProgress {
        after_first_advance: Some(Box::new(move || {
            use std::io::Write as _;
            fs::OpenOptions::new()
                .append(true)
                .open(&mutate)
                .unwrap()
                .write_all(b"growth")
                .unwrap();
        })),
        ..TestProgress::default()
    };

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(
        fs::metadata(&source).unwrap().len(),
        original.len() as u64 + 6
    );
    assert_eq!(
        fs::read(temporary.path().join("target-parent/target")).unwrap(),
        original
    );
}

#[test]
fn source_name_replacement_is_rejected_without_redirecting_the_open_reader() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    let held = temporary.path().join("source-parent/held");
    let original = vec![0x62; COPY_BUFFER_BYTES + 3];
    fs::write(&source, &original).unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let replace_source = source.clone();
    let replace_held = held.clone();
    let mut progress = TestProgress {
        after_first_advance: Some(Box::new(move || {
            fs::rename(&replace_source, &replace_held).unwrap();
            fs::write(&replace_source, b"replacement").unwrap();
        })),
        ..TestProgress::default()
    };

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), b"replacement");
    assert_eq!(fs::read(&held).unwrap(), original);
    assert_eq!(
        fs::read(temporary.path().join("target-parent/target")).unwrap(),
        original
    );
}

#[test]
fn target_name_replacement_is_not_adopted_as_the_copy_result() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    let target = temporary.path().join("target-parent/target");
    let displaced = temporary.path().join("target-parent/displaced");
    let original = vec![0x63; COPY_BUFFER_BYTES + 3];
    fs::write(&source, &original).unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let replace_target = target.clone();
    let replace_displaced = displaced.clone();
    let mut progress = TestProgress {
        after_first_advance: Some(Box::new(move || {
            fs::rename(&replace_target, &replace_displaced).unwrap();
            fs::write(&replace_target, b"racer").unwrap();
        })),
        ..TestProgress::default()
    };

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(fs::read(&target).unwrap(), b"racer");
    assert_eq!(fs::read(&displaced).unwrap(), original);
}

#[test]
fn symlink_replacement_during_progress_is_rejected_after_preserving_both_links() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    let target = temporary.path().join("target-parent/target");
    let displaced = temporary.path().join("target-parent/displaced");
    std::os::unix::fs::symlink("literal-source", &source).unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let replace_target = target.clone();
    let replace_displaced = displaced.clone();
    let mut progress = TestProgress {
        after_first_advance: Some(Box::new(move || {
            fs::rename(&replace_target, &replace_displaced).unwrap();
            std::os::unix::fs::symlink("racer", &replace_target).unwrap();
        })),
        ..TestProgress::default()
    };

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(fs::read_link(&target).unwrap(), Path::new("racer"));
    assert_eq!(
        fs::read_link(&displaced).unwrap(),
        Path::new("literal-source")
    );
}

#[test]
fn special_source_is_rejected_before_creating_a_target() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/fifo");
    let native = CString::new(source.as_os_str().as_bytes()).unwrap();
    // SAFETY: the absolute path is terminated and points into this test's directory.
    assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
    let expected = version_at(&source_parent, OsStr::new("fifo")).unwrap();
    let mut progress = TestProgress::default();

    assert!(matches!(
        copy_entry(
            &source_parent,
            OsStr::new("fifo"),
            &target_parent,
            OsStr::new("target"),
            &source,
            &expected,
            &mut progress,
        ),
        Err(AppError::InvalidPath(_))
    ));
    assert!(source.exists());
    assert!(!temporary.path().join("target-parent/target").exists());
}

#[test]
fn occupied_target_is_preserved() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/source");
    let target = temporary.path().join("target-parent/target");
    fs::write(&source, b"source").unwrap();
    fs::write(&target, b"occupied").unwrap();
    let expected = version_at(&source_parent, OsStr::new("source")).unwrap();
    let mut progress = TestProgress::default();

    assert!(copy_entry(
        &source_parent,
        OsStr::new("source"),
        &target_parent,
        OsStr::new("target"),
        &source,
        &expected,
        &mut progress,
    )
    .is_err());
    assert_eq!(fs::read(&source).unwrap(), b"source");
    assert_eq!(fs::read(&target).unwrap(), b"occupied");
}

#[test]
fn excessive_directory_depth_is_bounded_and_retains_created_private_ancestors() {
    let temporary = tempfile::tempdir().unwrap();
    let (source_parent, target_parent) = parents(temporary.path());
    let source = temporary.path().join("source-parent/tree");
    fs::create_dir(&source).unwrap();
    let mut leaf = source.clone();
    for _ in 0..MAX_DEPTH {
        leaf.push("d");
        fs::create_dir(&leaf).unwrap();
    }
    let expected = version_at(&source_parent, OsStr::new("tree")).unwrap();
    let mut progress = TestProgress::default();

    assert!(matches!(
        copy_entry(
            &source_parent,
            OsStr::new("tree"),
            &target_parent,
            OsStr::new("target"),
            &source,
            &expected,
            &mut progress,
        ),
        Err(AppError::InvalidPath(_))
    ));
    assert!(source.exists());
    assert!(temporary.path().join("target-parent/target").is_dir());
}
