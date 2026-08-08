use std::fs;

use tauri_explorer_lib::files::dir_listing::list_directory;
use tempfile::tempdir;

#[test]
fn listing_rejects_a_malformed_git_marker() {
    let root = tempdir().unwrap();
    let inbox = root.path().join("Inbox");
    fs::create_dir(&inbox).unwrap();
    fs::write(inbox.join(".git"), "not a gitdir file\n").unwrap();

    let runtime = tokio::runtime::Runtime::new().unwrap();
    let listing = runtime
        .block_on(list_directory(root.path().to_string_lossy().to_string()))
        .unwrap();
    let inbox = listing
        .entries
        .iter()
        .find(|entry| entry.name == "Inbox")
        .unwrap();

    assert!(!inbox.is_git_repo);
}
