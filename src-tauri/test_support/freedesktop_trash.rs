use super::*;
use std::{
    fs,
    os::unix::{ffi::OsStrExt, fs::symlink, fs::PermissionsExt},
};

fn fixture() -> (tempfile::TempDir, Context, PathBuf) {
    let scratch = tempfile::tempdir().expect("scratch directory");
    let source = scratch.path().join("source");
    fs::create_dir(&source).expect("source directory");
    let context = Context {
        mounts: MountSnapshot::read().expect("mount snapshot"),
        data_home: scratch.path().join("data"),
    };
    (scratch, context, source)
}

fn request(path: &Path, success: &TrashSuccess) -> RestoreRequest {
    RestoreRequest {
        path: path.to_string_lossy().into_owned(),
        artifact: success.artifact.clone().expect("recoverable artifact"),
    }
}

fn artifact_paths(success: &TrashSuccess) -> (PathBuf, PathBuf) {
    let TrashArtifact::Freedesktop { root, name, .. } =
        success.artifact.as_ref().expect("artifact").as_ref()
    else {
        panic!("Freedesktop artifact");
    };
    (
        root.join("files").join(name),
        root.join("info").join({
            let mut info = name.clone();
            info.push(OsStr::from_bytes(INFO_SUFFIX));
            info
        }),
    )
}

#[test]
fn two_deletions_of_one_path_restore_their_exact_payloads() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("same.txt");
    fs::write(&path, b"first").expect("first file");
    let first = context.trash(&path).expect("trash first");
    fs::write(&path, b"second").expect("second file");
    let second = context.trash(&path).expect("trash second");

    let (first_payload, first_info) = artifact_paths(&first);
    let (second_payload, second_info) = artifact_paths(&second);
    assert_ne!(first_payload, second_payload);
    assert_eq!(fs::read(&first_payload).expect("first payload"), b"first");
    assert_eq!(
        fs::read(&second_payload).expect("second payload"),
        b"second"
    );
    assert!(first_info.is_file() && second_info.is_file());
    assert!(first_info
        .parent()
        .unwrap()
        .read_dir()
        .unwrap()
        .all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .as_os_str()
                .as_bytes()
                .ends_with(b".tmp")
        }));

    restore(&request(&path, &first), &batch::DirectoryEffects::default())
        .expect("restore first receipt");
    assert_eq!(fs::read(&path).expect("restored first"), b"first");
    fs::remove_file(&path).expect("clear first");
    restore(
        &request(&path, &second),
        &batch::DirectoryEffects::default(),
    )
    .expect("restore second receipt");
    assert_eq!(fs::read(&path).expect("restored second"), b"second");
}

#[test]
fn directories_and_broken_relative_symlinks_round_trip_without_following() {
    let (_scratch, mut context, source) = fixture();
    let directory = source.join("tree");
    fs::create_dir(&directory).expect("tree");
    fs::write(directory.join("child"), b"tree bytes").expect("child");
    let directory_receipt = context.trash(&directory).expect("trash directory");
    restore(
        &request(&directory, &directory_receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect("restore directory");
    assert_eq!(fs::read(directory.join("child")).unwrap(), b"tree bytes");

    let link = source.join("broken-link");
    symlink("relative/missing", &link).expect("relative broken symlink");
    let link_receipt = context.trash(&link).expect("trash symlink itself");
    assert!(!link.try_exists().expect("source lookup"));
    restore(
        &request(&link, &link_receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect("restore symlink");
    assert_eq!(fs::read_link(&link).unwrap(), Path::new("relative/missing"));
}

#[test]
fn changed_metadata_is_not_used_to_restore_a_payload() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("metadata.txt");
    fs::write(&path, b"payload").unwrap();
    let receipt = context.trash(&path).unwrap();
    let (payload, info) = artifact_paths(&receipt);
    fs::write(&info, b"[Trash Info]\nPath=/forged\n").unwrap();

    let error = restore(
        &request(&path, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect_err("changed metadata must fail closed");
    assert!(matches!(error, AppError::Other(_)));
    assert!(!path.exists());
    assert_eq!(fs::read(payload).unwrap(), b"payload");
}

#[test]
fn replaced_payload_is_not_moved_to_the_original_path() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("payload.txt");
    fs::write(&path, b"original").unwrap();
    let receipt = context.trash(&path).unwrap();
    let (payload, _info) = artifact_paths(&receipt);
    let displaced = payload.with_extension("saved");
    fs::rename(&payload, &displaced).unwrap();
    fs::write(&payload, b"replacement").unwrap();

    let error = restore(
        &request(&path, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect_err("replaced payload must fail closed");
    assert!(matches!(error, AppError::Other(_)));
    assert!(!path.exists());
    assert_eq!(fs::read(payload).unwrap(), b"replacement");
    assert_eq!(fs::read(displaced).unwrap(), b"original");
}

#[test]
fn restore_does_not_repair_or_trust_a_substituted_legacy_trash_tree() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("substituted-root.txt");
    fs::write(&path, b"original payload").unwrap();
    let receipt = context.trash(&path).unwrap();
    let TrashArtifact::Freedesktop { root, name, .. } = receipt.artifact.as_deref().unwrap() else {
        panic!("Freedesktop receipt");
    };
    let root = root.clone();
    let name = name.clone();
    let displaced = root.with_extension("original");
    fs::rename(&root, &displaced).unwrap();
    let info = root.join("info");
    let files = root.join("files");
    fs::create_dir_all(&info).unwrap();
    fs::create_dir(&files).unwrap();
    for directory in [&root, &info, &files] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let error = restore(
        &request(&path, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect_err("substituted trash root must fail closed");

    assert!(matches!(error, AppError::PermissionDenied(_)));
    assert!(!path.exists());
    assert_eq!(
        fs::read(displaced.join("files").join(name)).unwrap(),
        b"original payload"
    );
    for directory in [&root, &info, &files] {
        assert_eq!(fs::metadata(directory).unwrap().mode() & 0o777, 0o755);
    }
}

#[test]
fn occupied_restore_target_preserves_target_and_trashed_payload() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("occupied.txt");
    fs::write(&path, b"trashed").unwrap();
    let receipt = context.trash(&path).unwrap();
    let (payload, info) = artifact_paths(&receipt);
    fs::write(&path, b"new occupant").unwrap();

    let error = restore(
        &request(&path, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect_err("restore collision");
    assert!(matches!(error, AppError::AlreadyExists(_)));
    assert_eq!(fs::read(&path).unwrap(), b"new occupant");
    assert_eq!(fs::read(payload).unwrap(), b"trashed");
    assert!(info.exists());
}

#[test]
fn post_commit_sync_failure_returns_artifact_and_warning() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("sync.txt");
    fs::write(&path, b"committed").unwrap();
    let receipt = context
        .trash_with_post_commit(&path, |_, _, _| {
            Err(io::Error::other("injected directory sync failure"))
        })
        .expect("committed trash result");

    assert!(!path.exists());
    assert!(receipt.artifact.is_some());
    assert!(receipt
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("injected directory sync failure")));
    restore(
        &request(&path, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect("warning receipt remains recoverable");
    assert_eq!(fs::read(path).unwrap(), b"committed");
}

#[test]
fn rename_error_after_verified_move_is_a_committed_recoverable_warning() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("reported-error.txt");
    fs::write(&path, b"retained").unwrap();
    let mut random = random_bytes;
    let receipt = context
        .trash_with(
            &path,
            &mut random,
            |source, source_name, files, target_name| {
                rename_noreplace_at(source, source_name, files, target_name)?;
                Err(io::Error::from_raw_os_error(libc::EIO))
            },
            |source, files, info| {
                source
                    .sync()
                    .and_then(|_| files.sync())
                    .and_then(|_| info.sync())
            },
        )
        .expect("verified committed move");

    assert!(!path.exists());
    assert!(receipt.artifact.is_some());
    assert!(receipt
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("rename reported an error")));
    restore(
        &request(&path, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect("exact receipt remains restorable");
    assert_eq!(fs::read(path).unwrap(), b"retained");
}

#[test]
fn rename_error_with_verified_source_is_unchanged_and_cleans_metadata() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("unchanged.txt");
    fs::write(&path, b"still here").unwrap();
    let mut random = random_bytes;
    let error = context
        .trash_with(
            &path,
            &mut random,
            |_, _, _, _| Err(io::Error::from_raw_os_error(libc::EIO)),
            |_, _, _| Ok(()),
        )
        .expect_err("verified unchanged error");

    assert!(matches!(error, AppError::Io(_)));
    assert_eq!(fs::read(&path).unwrap(), b"still here");
    let info = context.data_home.join("Trash/info");
    assert!(fs::read_dir(info).unwrap().next().is_none());
}

#[test]
fn rename_error_with_unresolved_effect_retains_interoperable_metadata() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("uncertain.txt");
    let displaced_name = OsString::from("uncertain.displaced");
    fs::write(&path, b"inspect me").unwrap();
    let mut random = random_bytes;
    let error = context
        .trash_with(
            &path,
            &mut random,
            |source, source_name, _, _| {
                rename_noreplace_at(source, source_name, source, &displaced_name)?;
                Err(io::Error::from_raw_os_error(libc::EIO))
            },
            |_, _, _| Ok(()),
        )
        .expect_err("unresolved outcome");

    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert!(!path.exists());
    assert_eq!(
        fs::read(source.join("uncertain.displaced")).unwrap(),
        b"inspect me"
    );
    let metadata: Vec<_> = fs::read_dir(context.data_home.join("Trash/info"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(metadata.len(), 1);
    assert!(metadata[0].as_os_str().as_bytes().ends_with(INFO_SUFFIX));
}

#[test]
fn successful_rename_of_a_substituted_source_is_uncertain_and_retained() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("substituted.txt");
    let saved_name = OsString::from("substituted.saved");
    fs::write(&path, b"captured original").unwrap();
    let mut random = random_bytes;
    let error = context
        .trash_with(
            &path,
            &mut random,
            |source, source_name, files, target_name| {
                rename_noreplace_at(source, source_name, source, &saved_name)?;
                let replacement = source.path()?.join(Path::new(source_name));
                fs::write(replacement, b"racing replacement")?;
                rename_noreplace_at(source, source_name, files, target_name)
            },
            |source, files, info| {
                source
                    .sync()
                    .and_then(|_| files.sync())
                    .and_then(|_| info.sync())
            },
        )
        .expect_err("substituted source is not a confirmed deletion");

    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert!(!path.exists());
    assert_eq!(
        fs::read(source.join(saved_name)).unwrap(),
        b"captured original"
    );
    let info: Vec<_> = fs::read_dir(context.data_home.join("Trash/info"))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let payload: Vec<_> = fs::read_dir(context.data_home.join("Trash/files"))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(info.len(), 1);
    assert_eq!(payload.len(), 1);
    assert_eq!(fs::read(payload[0].path()).unwrap(), b"racing replacement");
}

#[test]
fn payload_name_collision_is_preserved_and_retried_with_a_new_identity() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("collision.txt");
    fs::write(&path, b"new payload").unwrap();
    let directories = context.open_trash(&TrashLayout::Home).unwrap();
    let mut zero = |bytes: &mut [u8]| {
        bytes.fill(0);
        Ok(())
    };
    let occupied_name = candidate_name(
        path.file_name().unwrap(),
        directories.files.name_max().unwrap(),
        directories.info.name_max().unwrap() - INFO_SUFFIX.len(),
        &mut zero,
    )
    .unwrap();
    let occupied_payload = directories.root_path.join("files").join(&occupied_name);
    fs::write(&occupied_payload, b"existing payload").unwrap();
    drop(directories);

    let mut call = 0u8;
    let mut sequence = |bytes: &mut [u8]| {
        bytes.fill(call);
        call = call.wrapping_add(1);
        Ok(())
    };
    let receipt = context
        .trash_with(
            &path,
            &mut sequence,
            rename_noreplace_at,
            |source, files, info| {
                source
                    .sync()
                    .and_then(|_| files.sync())
                    .and_then(|_| info.sync())
            },
        )
        .expect("collision retry");
    let (new_payload, _new_info) = artifact_paths(&receipt);

    assert_ne!(new_payload, occupied_payload);
    assert_eq!(fs::read(occupied_payload).unwrap(), b"existing payload");
    assert_eq!(fs::read(new_payload).unwrap(), b"new payload");
    let mut occupied_info = occupied_name;
    occupied_info.push(OsStr::from_bytes(INFO_SUFFIX));
    assert!(!context
        .data_home
        .join("Trash/info")
        .join(occupied_info)
        .exists());
}

#[test]
fn unchanged_symlink_parent_spelling_can_restore_the_captured_path() {
    let (scratch, mut context, _source) = fixture();
    let real = scratch.path().join("real");
    fs::create_dir(&real).unwrap();
    let alias = scratch.path().join("alias");
    symlink(&real, &alias).unwrap();
    let requested = alias.join("aliased.txt");
    fs::write(&requested, b"through alias").unwrap();
    let receipt = context.trash(&requested).unwrap();

    restore(
        &request(&requested, &receipt),
        &batch::DirectoryEffects::default(),
    )
    .expect("unchanged alias resolves to captured parent");
    assert_eq!(
        fs::read(real.join("aliased.txt")).unwrap(),
        b"through alias"
    );
}

#[test]
fn restore_recreates_a_removed_parent_before_publishing_exact_payload() {
    let (_scratch, mut context, source) = fixture();
    let path = source.join("recreated.txt");
    fs::write(&path, b"recreated parent").unwrap();
    let receipt = context.trash(&path).unwrap();
    fs::remove_dir(&source).expect("remove empty original parent");
    let effects = batch::DirectoryEffects::default();

    restore(&request(&path, &receipt), &effects).expect("restore with missing parent");
    assert_eq!(fs::read(path).unwrap(), b"recreated parent");
}

#[test]
fn invalid_shared_trash_falls_back_to_private_top_directory_trash() {
    let scratch = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), scratch.path().join(".Trash")).unwrap();
    let mount = Mount {
        id: 1,
        parent_id: 1,
        root: PathBuf::from("/"),
        mount_point: scratch.path().to_owned(),
        filesystem: OsString::from("tmpfs"),
    };

    let directories = open_mounted_trash(&mount).expect("fallback trash");
    assert_eq!(
        directories.root_path,
        scratch
            .path()
            .join(format!(".Trash-{}", unsafe { libc::geteuid() }))
    );
}

#[test]
fn sticky_shared_trash_creates_private_uid_directory() {
    let scratch = tempfile::tempdir().unwrap();
    let shared = scratch.path().join(".Trash");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o1777)).unwrap();
    let mount = Mount {
        id: 1,
        parent_id: 1,
        root: PathBuf::from("/"),
        mount_point: scratch.path().to_owned(),
        filesystem: OsString::from("tmpfs"),
    };

    let directories = open_mounted_trash(&mount).expect("shared trash");
    assert_eq!(
        directories.root_path,
        shared.join(unsafe { libc::geteuid() }.to_string())
    );
    assert_eq!(
        fs::metadata(&directories.root_path).unwrap().mode() & 0o777,
        0o700
    );
}

#[test]
fn owned_legacy_trash_directories_are_restricted_before_use() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch
        .path()
        .join(format!(".Trash-{}", unsafe { libc::geteuid() }));
    let info = root.join("info");
    let files = root.join("files");
    fs::create_dir_all(&info).unwrap();
    fs::create_dir(&files).unwrap();
    for directory in [&root, &info, &files] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mount = Mount {
        id: 1,
        parent_id: 1,
        root: PathBuf::from("/"),
        mount_point: scratch.path().to_owned(),
        filesystem: OsString::from("tmpfs"),
    };

    open_mounted_trash(&mount).expect("compatible legacy trash");

    for directory in [&root, &info, &files] {
        assert_eq!(fs::metadata(directory).unwrap().mode() & 0o777, 0o700);
    }
}

#[test]
fn writable_legacy_trash_directory_is_not_adopted() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch
        .path()
        .join(format!(".Trash-{}", unsafe { libc::geteuid() }));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o770)).unwrap();
    let mount = Mount {
        id: 1,
        parent_id: 1,
        root: PathBuf::from("/"),
        mount_point: scratch.path().to_owned(),
        filesystem: OsString::from("tmpfs"),
    };

    let error = match open_mounted_trash(&mount) {
        Ok(_) => panic!("writable trash must be rejected"),
        Err(error) => error,
    };

    assert!(matches!(error, AppError::PermissionDenied(_)));
    assert_eq!(fs::metadata(root).unwrap().mode() & 0o777, 0o770);
}

#[test]
fn legacy_permission_repair_never_grants_owner_write_access() {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("readonly-trash");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
    let directory = Directory::open(&root).unwrap();

    ensure_private(&directory).expect("owner read permission remains usable");

    assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o500);
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn generated_names_fit_both_directories_and_retain_source_bytes() {
    let source_bytes = [b'a'; 255];
    let source = OsStr::from_bytes(&source_bytes);
    let mut deterministic = |bytes: &mut [u8]| {
        bytes.fill(0xab);
        Ok(())
    };
    let name = candidate_name(source, 100, 90, &mut deterministic).unwrap();

    assert_eq!(name.as_bytes().len(), 90);
    assert!(name.as_bytes().starts_with(b"aaaa"));
    assert!(name
        .as_bytes()
        .ends_with(b"abababababababababababababababab"));
}

#[test]
fn non_normal_data_home_is_rejected_before_creating_any_directory() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source");
    fs::create_dir(&source).unwrap();
    let path = source.join("item");
    fs::write(&path, b"unchanged").unwrap();
    let missing = scratch.path().join("missing");
    let mut context = Context {
        mounts: MountSnapshot::read().unwrap(),
        data_home: missing.join("..").join("wanted"),
    };

    let error = context.trash(&path).expect_err("parent traversal rejected");
    assert!(matches!(error, AppError::InvalidPath(_)));
    assert_eq!(fs::read(path).unwrap(), b"unchanged");
    assert!(!missing.exists());
    assert!(!scratch.path().join("wanted").exists());
}
