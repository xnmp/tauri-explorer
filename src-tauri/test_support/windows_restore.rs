use super::{classify_completion, CompletionEvidence, ItemCompletion, RestoreOutcome};
use std::path::PathBuf;

fn evidence(item: ItemCompletion) -> CompletionEvidence {
    CompletionEvidence {
        item,
        rejected_transfer_flags: None,
        perform_error: None,
        aborted: Ok(false),
    }
}

fn exact() -> ItemCompletion {
    ItemCompletion::One {
        hresult: 0,
        actual_path: Ok(PathBuf::from("C:/restored/item.txt")),
        requested_matches_actual: true,
    }
}

#[test]
fn exact_item_callback_is_authoritative_over_global_operation_status() {
    let outcome = classify_completion(CompletionEvidence {
        item: exact(),
        rejected_transfer_flags: None,
        perform_error: Some("operation-level failure".into()),
        aborted: Ok(true),
    });

    assert_eq!(outcome, RestoreOutcome::Exact);
}

#[test]
fn mismatched_destination_reports_actual_path_without_claiming_the_cause() {
    let actual = PathBuf::from("C:/restored/item (2).txt");
    let outcome = classify_completion(evidence(ItemCompletion::One {
        hresult: 0,
        actual_path: Ok(actual.clone()),
        requested_matches_actual: false,
    }));

    let RestoreOutcome::Uncertain(message) = outcome else {
        panic!("a restore to a different path must not be recorded as exact");
    };
    assert!(message.contains(&actual.display().to_string()));
    assert!(message.contains("instead of the requested path"));
    assert!(message.contains("inspect this location"));
}

#[test]
fn shell_success_status_that_can_mean_skipped_is_not_a_completion() {
    // COPYENGINE_S_USER_IGNORED is non-negative, but no move is proven.
    let outcome = classify_completion(evidence(ItemCompletion::One {
        hresult: 0x0027_0005,
        actual_path: Ok(PathBuf::from("C:/restored/item.txt")),
        requested_matches_actual: true,
    }));

    let RestoreOutcome::Uncertain(message) = outcome else {
        panic!("a skipped Shell status must remain uncertain");
    };
    assert!(message.contains("0x00270005"));
}

#[test]
fn failed_item_hresult_is_uncertain_even_when_shell_returns_a_path() {
    let outcome = classify_completion(evidence(ItemCompletion::One {
        hresult: 0x8027_0001u32 as i32,
        actual_path: Ok(PathBuf::from("C:/restored/item.txt")),
        requested_matches_actual: true,
    }));

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("0x80270001")));
}

#[test]
fn missing_actual_shell_item_cannot_confirm_success() {
    let outcome = classify_completion(evidence(ItemCompletion::One {
        hresult: 0,
        actual_path: Err("null created item".into()),
        requested_matches_actual: false,
    }));

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("null created item")));
}

#[test]
fn missing_callback_is_uncertain_despite_clean_global_status() {
    let outcome = classify_completion(evidence(ItemCompletion::Missing));

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("did not report an item completion")));
}

#[test]
fn duplicate_callback_is_uncertain() {
    let outcome = classify_completion(evidence(ItemCompletion::Duplicate));

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("more than one completion")));
}

#[test]
fn callback_for_another_shell_item_cannot_confirm_the_restore() {
    let outcome = classify_completion(evidence(ItemCompletion::InvalidSource(
        "different source".into(),
    )));

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("queued Recycle Bin item")
            && message.contains("different source")));
}

#[test]
fn aborted_query_failure_is_preserved_in_uncertain_diagnostics() {
    let outcome = classify_completion(CompletionEvidence {
        item: ItemCompletion::Missing,
        rejected_transfer_flags: None,
        perform_error: Some("perform failed".into()),
        aborted: Err("abort query failed".into()),
    });

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("perform failed") && message.contains("abort query failed")));
}

#[test]
fn overwrite_or_directory_merge_transfer_flags_are_rejected() {
    let outcome = classify_completion(CompletionEvidence {
        item: exact(),
        rejected_transfer_flags: Some(0x0000_0002),
        perform_error: Some("vetoed".into()),
        aborted: Ok(true),
    });

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("overwrite or directory-merge")
            && message.contains("0x00000002")));
}

#[cfg(target_os = "windows")]
mod native {
    use crate::{
        error::AppError,
        files::{
            trash::restore_from_trash,
            windows_restore::{restore_item, restore_item_before_perform, StaApartment},
        },
    };
    use std::{
        fs,
        os::windows::fs::{symlink_dir, symlink_file},
        path::Path,
        thread,
    };

    fn find_item(path: &Path) -> trash::TrashItem {
        trash::os_limited::list()
            .expect("list Recycle Bin")
            .into_iter()
            .filter(|item| item.original_path() == path)
            .max_by_key(|item| item.time_deleted)
            .expect("trashed fixture")
    }

    #[test]
    fn real_file_restore_preserves_exact_contents() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("exact.txt");
            fs::write(&path, b"exact restored bytes").expect("write fixture");
            trash::delete(&path).expect("trash fixture");

            restore_item(&apartment, find_item(&path)).expect("restore fixture");

            assert_eq!(
                fs::read(&path).expect("restored file"),
                b"exact restored bytes"
            );
        })
        .join()
        .expect("restore thread");
    }

    #[test]
    fn real_nonempty_directory_restore_is_confirmed_exact() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("exact-tree");
            fs::create_dir(&path).expect("create source tree");
            fs::write(path.join("child.txt"), b"directory bytes").expect("write child");
            trash::delete(&path).expect("trash source tree");

            restore_item(&apartment, find_item(&path)).expect("restore source tree");

            assert_eq!(
                fs::read(path.join("child.txt")).expect("restored child"),
                b"directory bytes"
            );
        })
        .join()
        .expect("restore thread");
    }

    #[test]
    fn collision_keeps_existing_file_and_reports_restored_alternate() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("collision.txt");
            fs::write(&path, b"trashed bytes").expect("write fixture");
            trash::delete(&path).expect("trash fixture");
            let item = find_item(&path);

            let result = restore_item_before_perform(&apartment, item, |requested| {
                fs::write(requested, b"existing sentinel")?;
                Ok(())
            });

            let AppError::MutationUncertain(message) = result.expect_err("alternate restore")
            else {
                panic!("collision restore must be consumed without retry");
            };
            assert_eq!(fs::read(&path).expect("sentinel"), b"existing sentinel");
            let alternate = fs::read_dir(directory.path())
                .expect("list restored directory")
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|candidate| candidate != &path)
                .expect("alternate restored file");
            assert_eq!(fs::read(&alternate).expect("alternate"), b"trashed bytes");
            assert!(message.contains(&alternate.display().to_string()));
        })
        .join()
        .expect("restore thread");
    }

    #[test]
    fn collision_renames_directory_instead_of_merging_it() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("tree");
            fs::create_dir(&path).expect("create source tree");
            fs::write(path.join("restored.txt"), b"restored tree").expect("write source tree");
            trash::delete(&path).expect("trash source tree");
            let item = find_item(&path);

            let result = restore_item_before_perform(&apartment, item, |requested| {
                fs::create_dir(requested)?;
                fs::write(requested.join("sentinel.txt"), b"existing tree")?;
                Ok(())
            });

            assert!(matches!(result, Err(AppError::MutationUncertain(_))));
            assert_eq!(
                fs::read(path.join("sentinel.txt")).expect("sentinel"),
                b"existing tree"
            );
            assert!(!path.join("restored.txt").exists(), "trees must not merge");
            let alternate = fs::read_dir(directory.path())
                .expect("list parent")
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|candidate| candidate != &path)
                .expect("alternate restored tree");
            assert_eq!(
                fs::read(alternate.join("restored.txt")).expect("restored tree"),
                b"restored tree"
            );
        })
        .join()
        .expect("restore thread");
    }

    #[test]
    fn relative_file_and_directory_symlinks_restore_as_links() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let file_target = directory.path().join("file-target.txt");
            let directory_target = directory.path().join("directory-target");
            let file_link = directory.path().join("file-link");
            let directory_link = directory.path().join("directory-link");
            fs::write(&file_target, b"file target").expect("file target");
            fs::create_dir(&directory_target).expect("directory target");
            fs::write(directory_target.join("child.txt"), b"directory target")
                .expect("directory child");
            symlink_file("file-target.txt", &file_link).expect("relative file symlink");
            symlink_dir("directory-target", &directory_link).expect("relative directory symlink");

            trash::delete(&file_link).expect("trash file symlink");
            trash::delete(&directory_link).expect("trash directory symlink");
            restore_item(&apartment, find_item(&file_link)).expect("restore file symlink");
            restore_item(&apartment, find_item(&directory_link))
                .expect("restore directory symlink");

            assert_eq!(
                fs::read_link(&file_link).expect("file link"),
                Path::new("file-target.txt")
            );
            assert_eq!(
                fs::read_link(&directory_link).expect("directory link"),
                Path::new("directory-target")
            );
            assert_eq!(
                fs::read(&file_target).expect("file target intact"),
                b"file target"
            );
            assert_eq!(
                fs::read(directory_target.join("child.txt")).expect("directory target intact"),
                b"directory target"
            );
        })
        .join()
        .expect("restore thread");
    }

    #[test]
    fn mixed_batch_keeps_exact_success_and_stops_after_collision() {
        let directory = tempfile::tempdir().expect("fixture directory");
        let exact = directory.path().join("01-exact.txt");
        let collision = directory.path().join("02-collision.txt");
        let later = directory.path().join("03-later.txt");
        fs::write(&exact, b"exact bytes").expect("exact fixture");
        fs::write(&collision, b"collision bytes").expect("collision fixture");
        fs::write(&later, b"later bytes").expect("later fixture");
        trash::delete(&exact).expect("trash exact fixture");
        trash::delete(&collision).expect("trash collision fixture");
        trash::delete(&later).expect("trash later fixture");
        fs::write(&collision, b"existing sentinel").expect("collision sentinel");
        let exact_string = exact.to_string_lossy().into_owned();
        let collision_string = collision.to_string_lossy().into_owned();
        let later_string = later.to_string_lossy().into_owned();

        let outcome = tauri::async_runtime::block_on(restore_from_trash(vec![
            exact_string.clone(),
            collision_string.clone(),
            later_string.clone(),
        ]))
        .expect("restore batch");

        assert_eq!(outcome.succeeded, vec![exact_string]);
        assert!(outcome.failed.is_empty());
        assert_eq!(outcome.uncertain.len(), 1);
        assert_eq!(outcome.uncertain[0].path, collision_string);
        assert_eq!(outcome.unstarted, vec![later_string.clone()]);
        assert_eq!(fs::read(&exact).expect("exact restored"), b"exact bytes");
        assert_eq!(
            fs::read(&collision).expect("collision sentinel"),
            b"existing sentinel"
        );
        assert!(!later.exists(), "later item must remain unstarted in trash");

        let alternate = fs::read_dir(directory.path())
            .expect("list fixture parent")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|candidate| candidate != &exact && candidate != &collision)
            .expect("collision alternate");
        assert_eq!(
            fs::read(&alternate).expect("collision alternate"),
            b"collision bytes"
        );

        let cleanup = tauri::async_runtime::block_on(restore_from_trash(vec![later_string]))
            .expect("restore unstarted cleanup item");
        assert_eq!(cleanup.succeeded.len(), 1);
        assert_eq!(fs::read(&later).expect("later cleanup"), b"later bytes");
    }
}
