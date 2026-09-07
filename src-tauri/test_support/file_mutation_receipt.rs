use super::FileMutationReceipt;
use crate::error::AppError;
use crate::files::{
    file_ops::{
        create_directory, create_empty_file, create_symlink, move_entry, rename_entry,
        write_text_file,
    },
    FileEntry, FileKind,
};
use std::{fs, path::Path};

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn require_entry(receipt: FileMutationReceipt, expected_path: &Path) -> FileEntry {
    let expected = path_string(expected_path);
    assert_eq!(receipt.path, expected);
    let entry = receipt.entry.expect("successful metadata inspection should provide an entry");
    assert_eq!(entry.path, expected);
    entry
}

#[test]
fn committed_mutation_survives_a_failed_optional_inspection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("committed.txt");
    fs::write(&path, "durable contents").unwrap();

    let receipt = FileMutationReceipt::inspect(&path, |_| {
        Err(AppError::Other("injected metadata inspection failure".into()))
    });

    assert_eq!(receipt.path, path_string(&path));
    assert!(receipt.entry.is_none());
    assert_eq!(fs::read_to_string(path).unwrap(), "durable contents");
}

#[test]
fn committed_receipt_contains_the_normal_file_snapshot_shape() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("snapshot.txt");
    fs::write(&path, "snapshot").unwrap();

    let entry = require_entry(FileMutationReceipt::committed(&path), &path);

    assert_eq!(entry.name, "snapshot.txt");
    assert!(matches!(entry.kind, FileKind::File));
    assert_eq!(entry.size, 8);
    assert!(!entry.is_symlink);
    assert_eq!(entry.symlink_target, None);
}

#[test]
fn create_directory_file_and_rename_commands_return_committed_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let parent = path_string(dir.path());

    let created_dir = dir.path().join("created-dir");
    let directory = tauri::async_runtime::block_on(create_directory(
        parent.clone(),
        "created-dir".into(),
    ))
    .unwrap();
    let directory_entry = require_entry(directory, &created_dir);
    assert!(matches!(directory_entry.kind, FileKind::Directory));
    assert_eq!(directory_entry.is_empty, Some(true));

    let original = dir.path().join("original.txt");
    let file = tauri::async_runtime::block_on(create_empty_file(
        parent,
        "original.txt".into(),
    ))
    .unwrap();
    let file_entry = require_entry(file, &original);
    assert!(matches!(file_entry.kind, FileKind::File));
    assert_eq!(file_entry.size, 0);

    let renamed = dir.path().join("renamed.txt");
    let receipt = tauri::async_runtime::block_on(rename_entry(
        path_string(&original),
        "renamed.txt".into(),
    ))
    .unwrap();
    assert_eq!(require_entry(receipt, &renamed).name, "renamed.txt");
    assert!(!original.exists());
    assert!(renamed.is_file());
}

#[test]
fn move_and_write_commands_return_paths_for_their_actual_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let move_source_dir = dir.path().join("move-source");
    let move_destination_dir = dir.path().join("move-destination");
    fs::create_dir_all(&move_source_dir).unwrap();
    fs::create_dir_all(&move_destination_dir).unwrap();
    let move_source = move_source_dir.join("move.txt");
    fs::write(&move_source, "moved contents").unwrap();
    let moved_path = move_destination_dir.join("move.txt");

    let moved = tauri::async_runtime::block_on(move_entry(
        path_string(&move_source),
        path_string(&move_destination_dir),
        None,
    ))
    .unwrap();
    let moved_entry = require_entry(moved, &moved_path);
    assert_eq!(moved_entry.size, 14);
    assert!(!move_source.exists());
    assert_eq!(fs::read_to_string(&moved_path).unwrap(), "moved contents");

    let written_path = dir.path().join("written.txt");
    let written = tauri::async_runtime::block_on(write_text_file(
        path_string(&written_path),
        "written contents".into(),
    ))
    .unwrap();
    let written_entry = require_entry(written, &written_path);
    assert_eq!(written_entry.size, 16);
    assert_eq!(fs::read_to_string(written_path).unwrap(), "written contents");
}

#[cfg(unix)]
#[test]
fn symlink_command_returns_the_link_path_and_link_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target.txt");
    let link = dir.path().join("target-link");
    fs::write(&target, "target contents").unwrap();

    let receipt = tauri::async_runtime::block_on(create_symlink(
        path_string(&target),
        path_string(&link),
    ))
    .unwrap();
    let entry = require_entry(receipt, &link);

    assert!(entry.is_symlink);
    assert!(matches!(entry.kind, FileKind::File));
    assert_eq!(entry.symlink_target, Some(path_string(&target)));
    assert_eq!(fs::read_to_string(link).unwrap(), "target contents");
}
