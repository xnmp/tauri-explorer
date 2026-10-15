//! Real Trash view outcomes on Windows and macOS (#863). Each test uses a
//! uniquely named disposable file and owns the listing registry alone.
use super::*;
use std::fs;

#[cfg(target_os = "windows")]
#[test]
fn recycle_bin_listing_restores_exact_bytes_and_refuses_collisions() {
    use crate::files::{
        admission::Runtime,
        windows_restore::{delete_item, StaApartment, WindowsPathKey},
    };
    use std::cmp::Ordering;

    let directory = tempfile::tempdir().expect("fixture directory");
    let path = directory
        .path()
        .join(format!("trash-view-863-{}.txt", std::process::id()));
    fs::write(&path, b"exact recycled bytes").expect("write fixture");
    let recycled = path.clone();
    std::thread::spawn(move || {
        let apartment = StaApartment::new().expect("STA");
        delete_item(&apartment, &recycled).expect("recycle fixture");
    })
    .join()
    .expect("recycle thread");
    assert!(!path.exists());

    // The Shell may report expanded 8.3 ancestors; compare native identities.
    let expected = WindowsPathKey::new(
        &fs::canonicalize(directory.path())
            .expect("fixture parent")
            .join(path.file_name().expect("fixture leaf")),
    );
    let listing = publish(windows_inventory());
    let entry = listing
        .entries
        .iter()
        .find(|entry| {
            entry.original_path.as_deref().is_some_and(|original| {
                WindowsPathKey::new(Path::new(original))
                    .compare(&expected)
                    .is_ok_and(|ordering| ordering == Ordering::Equal)
            })
        })
        .unwrap_or_else(|| panic!("recycled fixture is not listed: {listing:?}"))
        .clone();
    assert_eq!(entry.kind, "file");
    assert!(entry.deleted_at.is_some());
    let runtime = Runtime::new(directory.path().join("recovery"));

    fs::write(&path, b"newer file").expect("occupy destination");
    let outcome = tauri::async_runtime::block_on(restore(vec![entry.id.clone()], &runtime))
        .expect("restore batch");
    assert!(outcome.succeeded.is_empty(), "{outcome:?}");
    assert!(outcome.failed[0].error.contains("already exists"));
    assert_eq!(fs::read(&path).expect("occupant"), b"newer file");

    fs::remove_file(&path).expect("clear destination");
    let outcome =
        tauri::async_runtime::block_on(restore(vec![entry.id], &runtime)).expect("restore batch");
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&path).expect("restored"), b"exact recycled bytes");
}

#[cfg(target_os = "macos")]
#[test]
fn macos_trash_lists_items_without_inventing_a_restore_destination() {
    let Some(root) = dirs::home_dir().map(|home| home.join(".Trash")) else {
        return;
    };
    let name = format!("trash-view-863-{}.txt", std::process::id());
    let payload = root.join(&name);
    if fs::write(&payload, b"disposable").is_err() {
        // Without Full Disk Access the listing must say how to grant it.
        let listing = publish(macos_inventory());
        assert!(
            listing.issues.iter().all(|issue| !issue.error.is_empty()),
            "{listing:?}"
        );
        return;
    }
    let listing = publish(macos_inventory());
    let _ = fs::remove_file(&payload);
    if let Some(issue) = listing.issues.first() {
        assert!(issue.error.contains("Full Disk Access"), "{listing:?}");
        return;
    }
    let entry = listing
        .entries
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("disposable item is not listed: {listing:?}"));
    assert_eq!(entry.original_path, None);
    assert_eq!(entry.size, 10);
    let (requests, failures) = plan_restore(&[entry.id.clone()]);
    assert!(requests.is_empty());
    assert!(failures[0].error.contains("original location"));
}
