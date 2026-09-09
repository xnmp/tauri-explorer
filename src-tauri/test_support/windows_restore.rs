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
fn exact_dont_process_children_with_matching_destination_is_exact() {
    assert_eq!(
        classify_completion(evidence(ItemCompletion::One {
            hresult: 0x0027_0008,
            actual_path: Ok(PathBuf::from("C:/restored/item.txt")),
            requested_matches_actual: true,
        })),
        RestoreOutcome::Exact
    );
}

#[test]
fn dont_process_children_without_exact_destination_remains_uncertain() {
    for item in [
        ItemCompletion::One {
            hresult: 0x0027_0008,
            actual_path: Ok(PathBuf::from("C:/restored/item (2).txt")),
            requested_matches_actual: false,
        },
        ItemCompletion::One {
            hresult: 0x0027_0008,
            actual_path: Err("null created item".into()),
            requested_matches_actual: false,
        },
    ] {
        assert!(matches!(
            classify_completion(evidence(item)),
            RestoreOutcome::Uncertain(_)
        ));
    }
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
fn arbitrary_nonnegative_status_with_matching_destination_is_not_exact() {
    let outcome = classify_completion(evidence(ItemCompletion::One {
        hresult: 0x0027_000B,
        actual_path: Ok(PathBuf::from("C:/restored/item.txt")),
        requested_matches_actual: true,
    }));

    assert!(matches!(outcome, RestoreOutcome::Uncertain(message)
        if message.contains("0x0027000B")));
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
            trash::restore_entries,
            trash_artifact::{RestoreRequest, TrashArtifact},
            windows_restore::{
                delete_item, restore_exact, restore_item, restore_item_before_perform,
                shell_filesystem_name, windows_leaf_eq, StaApartment, WindowsPathKey,
            },
        },
    };
    use std::{
        cmp::Ordering,
        ffi::OsStr,
        fs,
        os::windows::fs::{symlink_dir, symlink_file},
        path::Path,
        sync::Arc,
        thread,
    };

    #[test]
    fn shell_destination_leaf_uses_native_ordinal_identity() {
        assert!(windows_leaf_eq(
            OsStr::new("Restored-Élan.txt"),
            OsStr::new("restored-éLAN.TXT")
        ));
        assert!(windows_leaf_eq(
            OsStr::new("復元-資料.txt"),
            OsStr::new("復元-資料.txt")
        ));
        assert!(!windows_leaf_eq(
            OsStr::new("restored.txt"),
            OsStr::new("restored (2).txt")
        ));
    }

    fn find_item(path: &Path) -> trash::TrashItem {
        // GetTempPath may use 8.3 ancestors while Shell inventory expands them.
        // Resolve the surviving parent, keeping the deleted leaf (including a
        // symlink) untouched, then compare the supported native spellings.
        let expected_parent = fs::canonicalize(path.parent().expect("fixture parent"))
            .expect("resolve fixture parent");
        let expected = expected_parent.join(path.file_name().expect("fixture leaf"));
        let expected = WindowsPathKey::new(&expected);
        let items = trash::os_limited::list().expect("list Recycle Bin");
        let same_leaf: Vec<_> = items
            .iter()
            .filter(|item| item.original_path().file_name() == path.file_name())
            .map(|item| item.original_path())
            .collect();
        items
            .into_iter()
            .filter(|item| {
                WindowsPathKey::new(&item.original_path())
                    .compare(&expected)
                    .is_ok_and(|ordering| ordering == Ordering::Equal)
            })
            .max_by_key(|item| item.time_deleted)
            .unwrap_or_else(|| {
                panic!(
                    "trashed fixture missing: expected raw {path:?}, canonical parent {expected_parent:?}, same-leaf inventory originals {same_leaf:?}"
                )
            })
    }

    #[test]
    fn shell_source_names_use_native_separators_without_lossy_unicode_conversion() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf};
        let expected: Vec<u16> = "C:\\work\\file.txt\0".encode_utf16().collect();
        assert_eq!(
            shell_filesystem_name(Path::new("C:/work/file.txt")),
            expected
        );
        assert_eq!(
            shell_filesystem_name(Path::new(r"\\?\C:\work\file.txt")),
            expected
        );

        let mut units: Vec<u16> = "C:/work/".encode_utf16().collect();
        units.push(0xd800);
        let path = PathBuf::from(OsString::from_wide(&units));
        let mut expected: Vec<u16> = "C:\\work\\".encode_utf16().collect();
        expected.extend([0xd800, 0]);
        assert_eq!(shell_filesystem_name(&path), expected);
    }

    fn exact_request(
        path: &Path,
        success: crate::files::trash_artifact::TrashSuccess,
    ) -> RestoreRequest {
        let artifact = success.artifact.expect("exact Recycle Bin artifact");
        assert!(success.warning.is_none(), "exact recycling must not warn");
        assert!(matches!(artifact.as_ref(), TrashArtifact::WindowsShell {
            parsing_name_utf16
        } if !parsing_name_utf16.is_empty()));
        RestoreRequest {
            path: path.to_string_lossy().into_owned(),
            artifact,
        }
    }

    #[test]
    fn app_owned_delete_receipt_restores_exact_file_without_inventory() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("captured-exact.txt");
            fs::write(&path, b"captured exact bytes").expect("write fixture");

            let request = exact_request(
                &path,
                delete_item(&apartment, &path).expect("delete with receipt"),
            );
            assert!(!path.exists(), "source must be recycled");
            restore_exact(&apartment, &request).expect("restore captured item");

            assert_eq!(
                fs::read(&path).expect("restored file"),
                b"captured exact bytes"
            );
        })
        .join()
        .expect("delete/restore thread");
    }

    #[test]
    fn exact_receipt_restores_through_alternate_case_and_verbatim_requested_spelling() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            for verbatim in [false, true] {
                let original = directory
                    .path()
                    .join(format!("CapturedCase-{verbatim}.TXT"));
                let contents = format!("exact captured bytes {verbatim}");
                fs::write(&original, contents.as_bytes()).expect("write fixture");
                let success = delete_item(&apartment, &original).expect("delete with receipt");
                let spelling = original
                    .to_string_lossy()
                    .replace('/', "\\")
                    .to_ascii_lowercase();
                let plain = spelling.strip_prefix("\\\\?\\").unwrap_or(&spelling);
                let requested = if verbatim {
                    format!("\\\\?\\{plain}")
                } else {
                    plain.to_owned()
                };
                let mut request = exact_request(&original, success);
                request.path = requested;

                restore_exact(&apartment, &request).expect("restore exact captured item");
                assert_eq!(
                    fs::read(&original).expect("restored file"),
                    contents.as_bytes()
                );
            }
        })
        .join()
        .expect("delete/restore thread");
    }

    #[test]
    fn ordinal_keys_fold_unicode_case_without_aliasing_device_namespaces() {
        let compare = |left: &str, right: &str| {
            WindowsPathKey::new(Path::new(left))
                .compare(&WindowsPathKey::new(Path::new(right)))
                .expect("Windows ordinal comparison")
        };
        assert_eq!(
            compare(r"C:\Work\Ä.txt", r"\\?\c:\work\ä.TXT"),
            Ordering::Equal
        );
        assert!(WindowsPathKey::new(Path::new(r"\\?\UNC\server\share\item"))
            .compare(&WindowsPathKey::new(Path::new(r"UNC\server\share\item")))
            .is_err());
        assert!(WindowsPathKey::new(Path::new(r"\\?\Volume{1234}\item"))
            .compare(&WindowsPathKey::new(Path::new(r"Volume{1234}\item")))
            .is_err());
    }

    #[test]
    fn exact_locator_distinguishes_two_recycled_versions_of_the_same_path() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("same-path.txt");
            fs::write(&path, b"older bytes").expect("older fixture");
            let older = exact_request(
                &path,
                delete_item(&apartment, &path).expect("delete older version"),
            );
            fs::write(&path, b"newer bytes").expect("newer fixture");
            let newer = exact_request(
                &path,
                delete_item(&apartment, &path).expect("delete newer version"),
            );

            restore_exact(&apartment, &older).expect("restore exact older version");
            assert_eq!(fs::read(&path).expect("older restored"), b"older bytes");
            fs::remove_file(&path).expect("remove older restored version");
            restore_exact(&apartment, &newer).expect("restore exact newer version");
            assert_eq!(fs::read(&path).expect("newer restored"), b"newer bytes");
        })
        .join()
        .expect("delete/restore thread");
    }

    #[test]
    fn app_owned_receipts_restore_directories_and_relative_symlinks() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let tree = directory.path().join("captured-tree");
            let target = directory.path().join("target.txt");
            let link = directory.path().join("captured-link");
            fs::create_dir(&tree).expect("create tree");
            fs::write(tree.join("child.txt"), b"tree bytes").expect("tree child");
            fs::write(&target, b"target bytes").expect("target");
            symlink_file("target.txt", &link).expect("relative link");

            let tree_request =
                exact_request(&tree, delete_item(&apartment, &tree).expect("delete tree"));
            let link_request =
                exact_request(&link, delete_item(&apartment, &link).expect("delete link"));
            restore_exact(&apartment, &tree_request).expect("restore tree");
            restore_exact(&apartment, &link_request).expect("restore link");

            assert_eq!(
                fs::read(tree.join("child.txt")).expect("tree child"),
                b"tree bytes"
            );
            assert_eq!(
                fs::read_link(&link).expect("restored link"),
                Path::new("target.txt")
            );
            assert_eq!(fs::read(&target).expect("target intact"), b"target bytes");
        })
        .join()
        .expect("delete/restore thread");
    }

    #[test]
    fn exact_receipt_collision_keeps_existing_file_and_consumes_restore() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let path = directory.path().join("captured-collision.txt");
            fs::write(&path, b"trashed bytes").expect("write fixture");
            let request = exact_request(
                &path,
                delete_item(&apartment, &path).expect("delete with receipt"),
            );
            fs::write(&path, b"existing sentinel").expect("collision sentinel");

            let result = restore_exact(&apartment, &request);
            assert!(matches!(result, Err(AppError::MutationUncertain(_))));
            assert_eq!(fs::read(&path).expect("sentinel"), b"existing sentinel");
            let alternate = fs::read_dir(directory.path())
                .expect("list parent")
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|candidate| candidate != &path)
                .expect("alternate restored file");
            assert_eq!(fs::read(alternate).expect("alternate"), b"trashed bytes");
        })
        .join()
        .expect("delete/restore thread");
    }

    #[test]
    fn restore_exact_rejects_empty_or_non_windows_artifacts_before_shell_work() {
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let empty = RestoreRequest {
                path: r"C:\fixture\item.txt".into(),
                artifact: Arc::new(TrashArtifact::WindowsShell {
                    parsing_name_utf16: Vec::new(),
                }),
            };
            assert!(matches!(
                restore_exact(&apartment, &empty),
                Err(AppError::InvalidPath(_))
            ));

            let wrong_platform = RestoreRequest {
                path: r"C:\fixture\item.txt".into(),
                artifact: Arc::new(TrashArtifact::Freedesktop {
                    root: "root".into(),
                    name: "name".into(),
                    original_path: "original".into(),
                    metadata_digest: [0; 32],
                    metadata_identity: crate::files::trash_artifact::EntryIdentity {
                        device: 1,
                        inode: 2,
                        ctime_seconds: 3,
                        ctime_nanoseconds: 4,
                    },
                    payload_version: crate::files::entry_version::EntryVersion {
                        object: crate::files::object_id::ObjectId::windows(5, [6; 16]),
                        size: 1,
                        modified_seconds: 7,
                        modified_nanos: 8,
                        directory: false,
                        symlink: false,
                    },
                }),
            };
            assert!(matches!(
                restore_exact(&apartment, &wrong_platform),
                Err(AppError::InvalidPath(_))
            ));
        })
        .join()
        .expect("validation thread");
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
        thread::spawn(|| {
            let apartment = StaApartment::new().expect("STA");
            let directory = tempfile::tempdir().expect("fixture directory");
            let exact = directory.path().join("01-exact.txt");
            let collision = directory.path().join("02-collision.txt");
            let later = directory.path().join("03-later.txt");
            fs::write(&exact, b"exact bytes").expect("exact fixture");
            fs::write(&collision, b"collision bytes").expect("collision fixture");
            fs::write(&later, b"later bytes").expect("later fixture");
            let first_request = exact_request(
                &exact,
                delete_item(&apartment, &exact).expect("delete exact fixture"),
            );
            let collision_request = exact_request(
                &collision,
                delete_item(&apartment, &collision).expect("delete collision fixture"),
            );
            let later_request = exact_request(
                &later,
                delete_item(&apartment, &later).expect("delete later fixture"),
            );
            fs::write(&collision, b"existing sentinel").expect("collision sentinel");
            let exact_string = exact.to_string_lossy().into_owned();
            let collision_string = collision.to_string_lossy().into_owned();
            let later_string = later.to_string_lossy().into_owned();

            let outcome = tauri::async_runtime::block_on(restore_entries(vec![
                first_request,
                collision_request,
                later_request.clone(),
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

            let cleanup = tauri::async_runtime::block_on(restore_entries(vec![later_request]))
                .expect("restore unstarted cleanup item");
            assert_eq!(cleanup.succeeded, vec![later_string]);
            assert_eq!(fs::read(&later).expect("later cleanup"), b"later bytes");
        })
        .join()
        .expect("mixed restore thread");
    }
}
