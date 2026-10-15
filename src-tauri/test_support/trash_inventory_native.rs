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

/// Records a real move to `~/.Trash` the way the app's deletion does, lists
/// the real Trash and restores through the Trash view. NSFileManager trashes
/// here because Finder automation needs a user-granted permission.
#[cfg(target_os = "macos")]
#[test]
fn macos_trash_restores_an_item_the_app_recorded() {
    use crate::{
        error::AppError,
        files::{admission::Runtime, trash_origins},
    };
    use trash::macos::{DeleteMethod, TrashContextExtMacos};

    let directory = tempfile::tempdir().expect("fixture directory");
    // Canonical so the recorded original matches the restore destination.
    let parent = fs::canonicalize(directory.path()).expect("fixture parent");
    let path = parent.join(format!("trash-view-863-{}.txt", std::process::id()));
    fs::write(&path, b"exact trashed bytes").expect("write fixture");
    let mut context = trash::TrashContext::default();
    context.set_delete_method(DeleteMethod::NsFileManager);
    let store = trash_origins::Store::default_location().expect("record store");
    let home_trash = dirs::home_dir().expect("home").join(".Trash");
    trash_origins::trash_recorded(&path, &home_trash, &store, |source| {
        context
            .delete(source)
            .map_err(|error| AppError::Other(error.to_string()))
    })
    .expect("trash fixture");
    assert!(!path.exists());

    let listing = publish(macos_inventory());
    let entry = listing
        .entries
        .iter()
        .find(|entry| entry.original_path.as_deref() == path.to_str())
        .unwrap_or_else(|| panic!("trashed fixture is not listed with its origin: {listing:?}"))
        .clone();
    assert!(entry.deleted_at.is_some());
    let outcome = tauri::async_runtime::block_on(restore(
        vec![entry.id],
        &Runtime::new(directory.path().join("recovery")),
    ))
    .expect("restore batch");
    assert!(outcome.failed.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&path).expect("restored"), b"exact trashed bytes");
}
