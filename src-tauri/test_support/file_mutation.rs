use super::{delete_outcome, entry_outcome, outcome, AppError, EntryPlan, ForwardEffect};
use crate::{
    file_history::Action,
    files::{batch, file_ops, mutation::FileMutationReceipt, run_blocking},
};
use std::fs;

fn native(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(target_os = "linux")]
#[test]
fn real_replacement_cleanup_warning_retains_the_exact_forward_inverse_and_refresh() {
    struct CopyContext {
        runtime: crate::files::recovery::Runtime,
        storage: std::path::PathBuf,
        source: std::path::PathBuf,
        target: std::path::PathBuf,
    }
    impl CopyContext {
        fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
            let mut progress = crate::progress::ProgressTracker::new(
                None,
                "copy-progress",
                "Copy cancelled",
                0,
                0,
                None,
            );
            self.runtime.replace_copy(
                self.storage.clone(),
                &self.source,
                &self.target,
                &mut progress,
            )
        }
    }
    impl Drop for CopyContext {
        fn drop(&mut self) {
            panic!("post-result copy context cleanup failed");
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    fs::write(&source, "new bytes").unwrap();
    fs::write(&target, "old bytes").unwrap();
    let storage = directory.path().join("recovery");
    let runtime = crate::files::recovery::Runtime::default();
    let directories = vec![native(directory.path())];
    let settled = tauri::async_runtime::block_on(async {
        let completion = crate::files::run_blocking_context(
            CopyContext {
                runtime: runtime.clone(),
                storage: storage.clone(),
                source,
                target: target.clone(),
            },
            CopyContext::execute,
        )
        .await;
        super::copy_outcome(directories.clone(), completion).await
    });
    assert!(settled
        .warning
        .unwrap()
        .contains("post-result copy context cleanup failed"));
    assert_eq!(settled.affected, directories);
    let receipt = settled.result.unwrap();
    let ForwardEffect::Changed(Some(Action::Replacement {
        path,
        recovery: Some(inverse),
    })) = settled.effect
    else {
        panic!("cleanup warning lost the native inverse")
    };
    assert_eq!(path, receipt.path);
    assert_eq!(inverse, receipt.replacement.unwrap().history);
    assert_eq!(fs::read(&target).unwrap(), b"new bytes");
    tauri::async_runtime::block_on(runtime.execute_history(
        storage,
        inverse,
        crate::files::recovery::ReplacementDirection::Restore,
    ))
    .unwrap();
    assert_eq!(fs::read(target).unwrap(), b"old bytes");
}

#[test]
fn ordinary_copy_cleanup_warning_is_visible_without_replacement_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("copied");
    fs::write(&target, "copied bytes").unwrap();
    let outcome = tauri::async_runtime::block_on(super::copy_outcome(
        vec![native(directory.path())],
        crate::files::WorkerCompletion {
            result: Ok(FileMutationReceipt::committed(&target)),
            warning: Some("worker cleanup warning".into()),
        },
    ));
    assert_eq!(outcome.warning.as_deref(), Some("worker cleanup warning"));
    assert!(outcome.result.is_ok());
    assert!(matches!(outcome.effect, ForwardEffect::Changed(None)));
}

#[test]
fn same_name_rename_has_no_history_or_refresh_effect() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("report.txt");
    fs::write(&path, "retained bytes").unwrap();
    let result = tauri::async_runtime::block_on(entry_outcome(
        EntryPlan::rename(native(&path), "report.txt".into()).unwrap(),
    ));
    assert_eq!(result.result.unwrap().path, path.to_string_lossy());
    assert_eq!(fs::read_to_string(path).unwrap(), "retained bytes");
    assert!(matches!(result.effect, ForwardEffect::Unchanged));
    assert!(result.affected.is_empty());
}

#[test]
fn case_only_rename_records_the_actual_committed_path() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("report.txt");
    let target = root.path().join("Report.txt");
    fs::write(&source, "retained bytes").unwrap();
    let directories = vec![root.path().to_string_lossy().into_owned()];
    let result = tauri::async_runtime::block_on(entry_outcome(
        EntryPlan::rename(native(&source), "Report.txt".into()).unwrap(),
    ));
    assert_eq!(result.result.unwrap().path, target.to_string_lossy());
    assert_eq!(fs::read_to_string(target).unwrap(), "retained bytes");
    assert!(
        matches!(result.effect, ForwardEffect::Changed(Some(super::Action::Rename { old_name, new_name, .. })) if old_name == "report.txt" && new_name == "Report.txt")
    );
    assert_eq!(result.affected, directories);
}

#[test]
fn same_name_rename_still_rejects_a_missing_source() {
    let root = tempfile::tempdir().unwrap();
    let result = tauri::async_runtime::block_on(entry_outcome(
        EntryPlan::rename(
            native(&root.path().join("missing.txt")),
            "missing.txt".into(),
        )
        .unwrap(),
    ));
    assert!(matches!(result.result, Err(AppError::NotFound(_))));
    assert!(matches!(result.effect, ForwardEffect::Unchanged));
    assert!(result.affected.is_empty());
}

#[test]
fn blocking_worker_panic_after_a_write_requires_history_invalidation_and_reconciliation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("committed.txt");
    let worker_path = path.clone();
    let directories = vec![root.path().to_string_lossy().into_owned()];
    let result = tauri::async_runtime::block_on(outcome(
        directories.clone(),
        run_blocking(move || -> Result<FileMutationReceipt, AppError> {
            fs::write(worker_path, "committed before worker failure")?;
            panic!("injected post-effect worker panic");
        }),
        |_| ForwardEffect::Changed(None),
    ));
    assert!(result.result.is_err());
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "committed before worker failure"
    );
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, directories);
}

#[test]
fn create_without_an_inverse_still_invalidates_redo_and_reconciles() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().to_string_lossy().into_owned();
    let result = tauri::async_runtime::block_on(entry_outcome(
        EntryPlan::create_empty_file(directory.clone(), "new.txt".into()).unwrap(),
    ));
    assert!(result.result.is_ok());
    assert_eq!(fs::read(root.path().join("new.txt")).unwrap(), b"");
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, vec![directory]);
}

#[test]
fn planned_creates_publish_their_exact_paths_and_contents() {
    let root = tempfile::tempdir().unwrap();
    let parent = native(root.path());
    let text = "large UTF-8 payload: 日本語\n".repeat(40_000);
    let plans = [
        (
            "directory",
            EntryPlan::create_directory(parent.clone(), "directory".into()).unwrap(),
        ),
        (
            "empty.txt",
            EntryPlan::create_empty_file(parent.clone(), "empty.txt".into()).unwrap(),
        ),
        (
            "text.txt",
            EntryPlan::write_text(native(&root.path().join("text.txt")), text.clone()),
        ),
    ];
    assert_eq!(
        fs::read_dir(root.path()).unwrap().count(),
        0,
        "planning must not create entries"
    );
    for (name, plan) in plans {
        let target = root.path().join(name);
        let result = tauri::async_runtime::block_on(entry_outcome(plan));
        assert_eq!(result.result.unwrap().path, native(&target));
        assert_eq!(result.affected, std::slice::from_ref(&parent));
        assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    }
    assert!(root.path().join("directory").is_dir());
    assert_eq!(fs::read(root.path().join("empty.txt")).unwrap(), b"");
    assert_eq!(
        fs::read_to_string(root.path().join("text.txt")).unwrap(),
        text
    );
    assert_eq!(
        fs::read_dir(root.path()).unwrap().count(),
        3,
        "text staging must leave no auxiliary entry after success"
    );
}

#[test]
fn a_collision_after_planning_preserves_bytes_and_creates_no_history_effect() {
    for kind in ["directory", "empty", "text", "rename"] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::write(&source, b"source bytes").unwrap();
        let plan = match kind {
            "directory" => {
                EntryPlan::create_directory(native(root.path()), "target".into()).unwrap()
            }
            "empty" => EntryPlan::create_empty_file(native(root.path()), "target".into()).unwrap(),
            "text" => EntryPlan::write_text(native(&target), "new bytes".into()),
            _ => EntryPlan::rename(native(&source), "target".into()).unwrap(),
        };
        fs::write(&target, b"arrived after planning").unwrap();
        let result = tauri::async_runtime::block_on(entry_outcome(plan));
        assert!(
            matches!(result.result, Err(AppError::AlreadyExists(_))),
            "{kind}"
        );
        assert!(matches!(result.effect, ForwardEffect::Unchanged));
        assert!(result.affected.is_empty());
        assert_eq!(fs::read(source).unwrap(), b"source bytes");
        assert_eq!(fs::read(target).unwrap(), b"arrived after planning");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    }
}

#[cfg(unix)]
#[test]
fn planned_symlink_refreshes_its_parent_and_preserves_target_and_collisions() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("source/target.txt");
    let link = root.path().join("destination/link");
    fs::create_dir(root.path().join("source")).unwrap();
    fs::create_dir(root.path().join("destination")).unwrap();
    fs::write(&target, b"linked bytes").unwrap();
    let plan = EntryPlan::symlink(native(&target), native(&link));
    assert!(!link.exists());
    let result = tauri::async_runtime::block_on(entry_outcome(plan));
    assert_eq!(result.result.unwrap().path, native(&link));
    assert_eq!(result.affected, [native(link.parent().unwrap())]);
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(fs::read_link(&link).unwrap(), target);
    assert_eq!(fs::read(&link).unwrap(), b"linked bytes");

    let result = tauri::async_runtime::block_on(entry_outcome(EntryPlan::symlink(
        native(&target),
        native(&link),
    )));
    assert!(matches!(result.result, Err(AppError::AlreadyExists(_))));
    assert!(matches!(result.effect, ForwardEffect::Unchanged));
    assert!(result.affected.is_empty());
    assert_eq!(fs::read(&target).unwrap(), b"linked bytes");
    assert_eq!(fs::read_link(&link).unwrap(), target);
}

#[test]
fn delete_batch_groups_exact_receipts_by_parent_in_input_order() {
    use crate::{file_history::Recovery, files::trash_artifact::TrashArtifact};
    use std::{collections::BTreeMap, sync::Arc};
    let root = tempfile::tempdir().unwrap();
    let first_parent = native(&root.path().join("first-parent"));
    let second_parent = native(&root.path().join("second-parent"));
    let first = native(&root.path().join("first-parent/first.txt"));
    let second = native(&root.path().join("second-parent/second.txt"));
    let third = native(&root.path().join("first-parent/third.txt"));
    let paths = vec![first.clone(), second.clone(), third.clone()];
    let artifacts: BTreeMap<_, _> = paths
        .iter()
        .map(|path| {
            (
                path.clone(),
                Arc::new(TrashArtifact::WindowsShell {
                    parsing_name_utf16: format!("opaque identity for {path}")
                        .encode_utf16()
                        .collect(),
                }),
            )
        })
        .collect();
    let result = delete_outcome(
        batch::FileBatchOutcome {
            succeeded: paths.clone(),
            artifacts: artifacts.clone(),
            ..Default::default()
        },
        false,
    );
    assert_eq!(result.result.as_ref().unwrap().succeeded, paths);
    assert_eq!(
        result.affected,
        vec![first_parent.clone(), second_parent.clone()]
    );
    assert_eq!(
        match result.effect {
            ForwardEffect::Changed(Some(action)) => action,
            _ => panic!("confirmed receipts require an inverse"),
        },
        Action::Batch {
            actions: vec![
                Action::Delete {
                    paths: vec![first.clone(), third.clone()],
                    parent_dir: first_parent,
                    recovery: Recovery::Restore(Arc::new(BTreeMap::from([
                        (first.clone(), artifacts[&first].clone()),
                        (third.clone(), artifacts[&third].clone()),
                    ]))),
                },
                Action::Delete {
                    paths: vec![second.clone()],
                    parent_dir: second_parent,
                    recovery: Recovery::Restore(Arc::new(BTreeMap::from([(
                        second.clone(),
                        artifacts[&second].clone()
                    )]))),
                },
            ],
            label: "Delete".into(),
        }
    );
}

#[test]
fn deleted_item_without_an_exact_receipt_is_not_retryable_or_undoable() {
    let root = tempfile::tempdir().unwrap();
    let path = native(&root.path().join("deleted.txt"));
    let result = delete_outcome(
        batch::FileBatchOutcome {
            succeeded: vec![path.clone()],
            ..Default::default()
        },
        false,
    );
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, [native(root.path())]);
    let outcome = result.result.unwrap();
    assert_eq!(outcome.succeeded, [path]);
    assert!(outcome.failed.is_empty());
    if !cfg!(target_os = "macos") {
        assert!(outcome.error().unwrap().contains("Undo is unavailable"));
    }
}

#[test]
fn committed_delete_warning_reaches_the_caller_without_becoming_retryable() {
    let root = tempfile::tempdir().unwrap();
    let path = native(&root.path().join("deleted.txt"));
    let warning = "Permanently deleted from a network share; Undo is unavailable";
    let result = delete_outcome(
        batch::FileBatchOutcome {
            succeeded: vec![path.clone()],
            warnings: vec![batch::FileFailure {
                path: path.clone(),
                error: warning.into(),
            }],
            ..Default::default()
        },
        false,
    );
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    let outcome = result.result.unwrap();
    assert_eq!(outcome.succeeded, [path]);
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
    assert_eq!(outcome.warnings.len(), 1);
    assert!(outcome.error().unwrap().contains(warning));
}

#[test]
fn failed_items_followed_by_cleanup_panic_invalidate_redo_and_refresh_their_parents() {
    struct Cleanup(std::path::PathBuf);
    impl Cleanup {
        fn refuse(&self, _: &str) -> Result<(), AppError> {
            Err(AppError::PermissionDenied("operation refused".into()))
        }
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            fs::write(&self.0, b"cleanup changed the file").unwrap();
            panic!("cleanup failed after its effect");
        }
    }
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("entry");
    fs::write(&file, b"original").unwrap();
    let cleanup = Cleanup(file.clone());
    let batch = tauri::async_runtime::block_on(batch::run(
        batch::BatchPlan::new(vec![native(&file)]).unwrap(),
        move |path| cleanup.refuse(path),
    ));
    assert!(batch.succeeded.is_empty());
    assert_eq!(batch.failed[0].path, native(&file));
    assert!(batch.error().unwrap().contains("cleanup failed"));
    let result = delete_outcome(batch, false);
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, [native(root.path())]);
    assert_eq!(fs::read(file).unwrap(), b"cleanup changed the file");
}

#[test]
fn uncertain_delete_reconciles_only_its_parent_and_leaves_later_work_unstarted() {
    let root = tempfile::tempdir().unwrap();
    let failed_parent = root.path().join("failed-parent");
    let uncertain_parent = root.path().join("uncertain-parent");
    let unstarted_parent = root.path().join("unstarted-parent");
    for directory in [&failed_parent, &uncertain_parent, &unstarted_parent] {
        fs::create_dir_all(directory).unwrap();
    }
    let failed = failed_parent.join("failed.txt");
    let uncertain = uncertain_parent.join("uncertain.txt");
    let unstarted = unstarted_parent.join("unstarted.txt");
    for path in [&failed, &uncertain, &unstarted] {
        fs::write(path, "retained unless attempted").unwrap();
    }
    let failed_path = native(&failed);
    let uncertain_path = native(&uncertain);
    let unstarted_path = native(&unstarted);
    let worker_failed = failed_path.clone();
    let worker_uncertain = uncertain_path.clone();
    let outcome = tauri::async_runtime::block_on(batch::run(
        batch::BatchPlan::new(vec![
            failed_path.clone(),
            uncertain_path.clone(),
            unstarted_path.clone(),
        ])
        .unwrap(),
        move |path| {
            if path == worker_failed {
                return Err(AppError::PermissionDenied("injected refusal".into()));
            }
            file_ops::delete_path(path)?;
            if path == worker_uncertain {
                return Err(AppError::MutationUncertain(
                    "injected post-delete uncertainty".into(),
                ));
            }
            Ok(())
        },
    ));
    let result = delete_outcome(outcome, false);
    let receipt = result.result.as_ref().unwrap();

    assert_eq!(receipt.failed.len(), 1);
    assert_eq!(receipt.failed[0].path, failed_path);
    assert_eq!(receipt.uncertain.len(), 1);
    assert_eq!(receipt.uncertain[0].path, uncertain_path);
    assert_eq!(receipt.unstarted, vec![unstarted_path]);
    assert!(failed.exists());
    assert!(!uncertain.exists());
    assert!(unstarted.exists());
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, vec![native(&uncertain_parent)]);
}

#[test]
fn permanent_delete_reconciles_success_without_creating_an_inverse() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("permanent.txt");
    fs::write(&path, "delete permanently").unwrap();
    let path_string = native(&path);
    let result = tauri::async_runtime::block_on(async {
        let outcome = batch::run(
            batch::BatchPlan::new(vec![path_string.clone()]).unwrap(),
            file_ops::delete_path,
        )
        .await;
        delete_outcome(outcome, true)
    });

    assert_eq!(result.result.as_ref().unwrap().succeeded, vec![path_string]);
    assert!(!path.exists());
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, vec![native(root.path())]);
}

#[test]
fn wholly_failed_delete_batch_is_unchanged_and_publishes_no_refresh() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing.txt");
    let missing_path = native(&missing);
    let result = tauri::async_runtime::block_on(async {
        let outcome = batch::run(
            batch::BatchPlan::new(vec![missing_path.clone()]).unwrap(),
            file_ops::delete_path,
        )
        .await;
        delete_outcome(outcome, false)
    });

    let receipt = result.result.as_ref().unwrap();
    assert!(receipt.succeeded.is_empty());
    assert_eq!(receipt.failed.len(), 1);
    assert_eq!(receipt.failed[0].path, missing_path);
    assert!(matches!(result.effect, ForwardEffect::Unchanged));
    assert!(result.affected.is_empty());
}

#[cfg(target_os = "linux")]
mod recovery_admission {
    use super::*;
    use crate::file_mutation::{entry_outcome_owned, entry_with_recovery, settle_entry};
    use crate::files::recovery::{Access, ResourceRequest, Runtime, Scope};
    use std::path::{Path, PathBuf};

    fn writing(path: &Path) -> Vec<ResourceRequest> {
        vec![ResourceRequest {
            path: path.to_owned(),
            access: Access::Write,
            scope: Scope::Subtree,
        }]
    }

    #[test]
    fn creation_is_lazy_and_competing_entry_plans_leave_names_and_bytes_unchanged() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let storage = root.path().join("app-data/recovery");
            let runtime = Runtime::default();
            assert!(!storage.parent().unwrap().exists());
            for kind in ["directory", "empty", "text", "rename"] {
                let target = root.path().join(kind);
                let source = root.path().join(format!("{kind}-source"));
                fs::write(&source, b"original bytes").unwrap();
                let plan = || match kind {
                    "directory" => {
                        EntryPlan::create_directory(native(root.path()), kind.into()).unwrap()
                    }
                    "empty" => {
                        EntryPlan::create_empty_file(native(root.path()), kind.into()).unwrap()
                    }
                    "text" => EntryPlan::write_text(native(&target), "new bytes".into()),
                    _ => EntryPlan::rename(native(&source), kind.into()).unwrap(),
                };
                let held = runtime
                    .admit(storage.clone(), writing(&target))
                    .await
                    .unwrap();
                let refused = entry_with_recovery(plan(), runtime.clone(), storage.clone()).await;
                assert!(refused.result.is_err());
                assert!(matches!(refused.effect, ForwardEffect::Unchanged));
                assert!(refused.affected.is_empty());
                assert!(!target.exists());
                assert_eq!(fs::read(&source).unwrap(), b"original bytes");
                held.finish().unwrap();
                let completed = entry_with_recovery(plan(), runtime.clone(), storage.clone()).await;
                assert_eq!(completed.result.unwrap().path, native(&target));
                assert!(completed.warning.is_none());
                if kind == "directory" {
                    assert!(target.is_dir());
                } else {
                    assert_eq!(
                        fs::read(&target).unwrap(),
                        match kind {
                            "empty" => b"".as_slice(),
                            "text" => b"new bytes",
                            _ => b"original bytes",
                        }
                    );
                }
                runtime
                    .admit(storage.clone(), writing(&target))
                    .await
                    .unwrap()
                    .finish()
                    .unwrap();
            }
        });
    }

    #[test]
    fn rename_owns_source_descendants_without_blocking_unrelated_siblings() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let storage = root.path().join("recovery");
            let runtime = Runtime::default();
            let source = root.path().join("source");
            fs::create_dir(&source).unwrap();
            fs::write(source.join("child"), b"retained child").unwrap();
            let held = runtime
                .admit(storage.clone(), writing(&source.join("child")))
                .await
                .unwrap();
            let result = entry_with_recovery(
                EntryPlan::rename(native(&source), "moved".into()).unwrap(),
                runtime.clone(),
                storage.clone(),
            )
            .await;
            assert!(result.result.is_err());
            assert_eq!(fs::read(source.join("child")).unwrap(), b"retained child");
            let sibling = entry_with_recovery(
                EntryPlan::create_empty_file(native(root.path()), "sibling".into()).unwrap(),
                runtime,
                storage,
            )
            .await;
            assert_eq!(fs::read(sibling.result.unwrap().path).unwrap(), b"");
            held.finish().unwrap();
        });
    }

    #[test]
    fn symlink_admission_reads_the_target_and_writes_only_the_new_link_namespace() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let storage = root.path().join("recovery");
            let runtime = Runtime::default();
            let target = root.path().join("target");
            let link = root.path().join("link");
            fs::write(&target, b"target bytes").unwrap();
            let held = runtime
                .admit(storage.clone(), writing(&target))
                .await
                .unwrap();
            let plan = || EntryPlan::symlink(native(&target), native(&link));
            assert!(
                entry_with_recovery(plan(), runtime.clone(), storage.clone())
                    .await
                    .result
                    .is_err()
            );
            assert!(fs::symlink_metadata(&link).is_err());
            held.finish().unwrap();
            let read = runtime
                .admit(
                    storage.clone(),
                    vec![ResourceRequest {
                        path: target.clone(),
                        access: Access::Read,
                        scope: Scope::Entry,
                    }],
                )
                .await
                .unwrap();
            let result = entry_with_recovery(plan(), runtime.clone(), storage).await;
            assert!(result.result.is_ok());
            assert_eq!(fs::read_link(&link).unwrap(), target);
            assert_eq!(fs::read(&link).unwrap(), b"target bytes");
            read.finish().unwrap();
        });
    }

    #[test]
    fn an_admitted_entry_cannot_be_redirected_by_a_managed_parent_alias_replacement() {
        tauri::async_runtime::block_on(async {
            for kind in ["directory", "empty", "text", "rename", "symlink"] {
                let root = tempfile::tempdir().unwrap();
                let storage = root.path().join("recovery");
                let runtime = Runtime::default();
                let original = root.path().join("original");
                let other = root.path().join("other");
                let alias = root.path().join("alias");
                fs::create_dir(&original).unwrap();
                fs::create_dir(&other).unwrap();
                fs::write(original.join("source"), b"owned bytes").unwrap();
                fs::write(other.join("source"), b"unowned bytes").unwrap();
                std::os::unix::fs::symlink(&original, &alias).unwrap();
                let plan = match kind {
                    "directory" => {
                        EntryPlan::create_directory(native(&alias), "new".into()).unwrap()
                    }
                    "empty" => EntryPlan::create_empty_file(native(&alias), "new".into()).unwrap(),
                    "rename" => {
                        EntryPlan::rename(native(&alias.join("source")), "new".into()).unwrap()
                    }
                    "symlink" => EntryPlan::symlink(
                        native(&original.join("source")),
                        native(&alias.join("new")),
                    ),
                    _ => EntryPlan::write_text(native(&alias.join("new")), "owned bytes".into()),
                };
                let (plan, admission) =
                    crate::file_mutation::admit_entry(plan, runtime.clone(), storage.clone())
                        .await
                        .unwrap();
                let renamed = entry_with_recovery(
                    EntryPlan::rename(native(&alias), "old-alias".into()).unwrap(),
                    runtime.clone(),
                    storage.clone(),
                )
                .await;
                assert!(
                    renamed.result.is_err(),
                    "managed alias replacement must remain fenced"
                );
                // Also test an uncoordinated external writer: execution still
                // owns the captured destination rather than following this alias.
                fs::rename(&alias, root.path().join("old-alias")).unwrap();
                let replaced = entry_with_recovery(
                    EntryPlan::symlink(native(&other), native(&alias)),
                    runtime,
                    storage,
                )
                .await;
                assert!(
                    replaced.result.is_err(),
                    "the literal alias name remains reserved after removal"
                );
                std::os::unix::fs::symlink(&other, &alias).unwrap();
                let outcome = entry_outcome_owned(plan, admission.context()).await;
                let result = settle_entry(outcome, admission).await;
                assert_eq!(result.result.unwrap().path, native(&original.join("new")));
                assert!(result.affected.contains(&native(&alias)));
                assert!(result.affected.contains(&native(&original)));
                assert!(
                    !other.join("new").exists(),
                    "{kind}: the worker must not mutate the replacement target"
                );
                assert_eq!(fs::read(other.join("source")).unwrap(), b"unowned bytes");
                match kind {
                    "directory" => assert!(original.join("new").is_dir()),
                    "empty" => assert_eq!(fs::read(original.join("new")).unwrap(), b""),
                    "symlink" => assert_eq!(
                        fs::read_link(original.join("new")).unwrap(),
                        original.join("source")
                    ),
                    _ => assert_eq!(fs::read(original.join("new")).unwrap(), b"owned bytes"),
                }
            }
        });
    }

    #[test]
    fn symlink_target_alias_chains_remain_owned_until_literal_link_publication() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let original = root.path().join("original");
            fs::create_dir(&original).unwrap();
            fs::write(original.join("source"), b"owned source").unwrap();
            let inner = root.path().join("inner");
            let outer = root.path().join("outer");
            std::os::unix::fs::symlink("original", &inner).unwrap();
            std::os::unix::fs::symlink("inner", &outer).unwrap();
            let runtime = Runtime::default();
            let storage = root.path().join("recovery");
            let target = outer.join("source");
            let link = root.path().join("new-link");
            let (plan, admission) = crate::file_mutation::admit_entry(
                EntryPlan::symlink(native(&target), native(&link)),
                runtime.clone(),
                storage.clone(),
            )
            .await
            .unwrap();
            for alias in [&inner, &outer] {
                let changed = entry_with_recovery(
                    EntryPlan::rename(native(alias), "moved-alias".into()).unwrap(),
                    runtime.clone(),
                    storage.clone(),
                )
                .await;
                assert!(
                    changed.result.is_err(),
                    "every traversed alias must remain owned"
                );
                assert!(fs::symlink_metadata(alias)
                    .unwrap()
                    .file_type()
                    .is_symlink());
            }
            let outcome = entry_outcome_owned(plan, admission.context()).await;
            let result = settle_entry(outcome, admission).await;
            assert!(result.result.is_ok());
            assert_eq!(fs::read_link(&link).unwrap(), target);
            assert_eq!(fs::read(&link).unwrap(), b"owned source");
            assert!(entry_with_recovery(
                EntryPlan::rename(native(&inner), "moved-alias".into()).unwrap(),
                runtime,
                storage
            )
            .await
            .result
            .is_ok());
        });
    }

    #[test]
    fn stable_alias_presentation_keeps_selection_paths_but_history_owns_the_resolved_entry() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let original = root.path().join("original");
            let alias = root.path().join("alias");
            fs::create_dir(&original).unwrap();
            std::os::unix::fs::symlink(&original, &alias).unwrap();
            fs::write(original.join("before"), b"same bytes").unwrap();
            let result = entry_with_recovery(
                EntryPlan::rename(native(&alias.join("before")), "after".into()).unwrap(),
                Runtime::default(),
                root.path().join("recovery"),
            )
            .await;
            let receipt = result.result.unwrap();
            assert_eq!(receipt.path, native(&alias.join("after")));
            assert_eq!(receipt.entry.unwrap().path, receipt.path);
            let ForwardEffect::Changed(Some(Action::Rename { path, .. })) = result.effect else {
                panic!("rename history missing");
            };
            assert_eq!(path, native(&original.join("after")));
            assert_eq!(fs::read(alias.join("after")).unwrap(), b"same bytes");
        });
    }

    #[test]
    fn cleanup_failure_keeps_the_confirmed_receipt_and_history_effect() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let storage = root.path().join("recovery");
            let runtime = Runtime::default();
            let target = root.path().join("created");
            let plan = EntryPlan::write_text(native(&target), "confirmed bytes".into());
            let admission = runtime
                .admit(storage.clone(), plan.resources())
                .await
                .unwrap();
            let outcome = entry_outcome_owned(plan, admission.context()).await;
            // Real namespace substitution makes the coordinator reject settlement.
            fs::rename(storage.join("admission.lock"), storage.join("moved-gate")).unwrap();
            let result = settle_entry(outcome, admission).await;
            assert_eq!(result.result.unwrap().path, native(&target));
            assert_eq!(fs::read(&target).unwrap(), b"confirmed bytes");
            assert!(matches!(result.effect, ForwardEffect::Changed(None)));
            assert_eq!(result.affected, vec![native(root.path())]);
            assert!(result
                .warning
                .unwrap()
                .contains("ownership record could not be retired"));
            assert!(runtime.admit(storage, writing(&target)).await.is_err());
        });
    }

    #[test]
    fn independent_cold_runtimes_admit_siblings_without_losing_either_owner() {
        for _ in 0..16 {
            let root = tempfile::tempdir().unwrap();
            let storage = root.path().join("new-app-data/recovery");
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
            let workers: Vec<_> = (0..2)
                .map(|number| {
                    let storage = storage.clone();
                    let target = root.path().join(format!("entry-{number}"));
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        let runtime = Runtime::default();
                        barrier.wait();
                        tauri::async_runtime::block_on(runtime.admit(storage, writing(&target)))
                    })
                })
                .collect();
            barrier.wait();
            let held: Vec<_> = workers
                .into_iter()
                .map(|worker| worker.join().unwrap().unwrap())
                .collect();
            let competitor = Runtime::default();
            for number in 0..2 {
                assert!(tauri::async_runtime::block_on(competitor.admit(
                    storage.clone(),
                    writing(&root.path().join(format!("entry-{number}")))
                ))
                .is_err());
            }
            for admission in held {
                admission.finish().unwrap();
            }
        }
    }

    #[test]
    fn concurrent_first_admissions_share_initialization_and_keep_independent_claims() {
        let root = tempfile::tempdir().unwrap();
        let storage = root.path().join("app-data/recovery");
        let runtime = Runtime::default();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = (0..2)
            .map(|number| {
                let runtime = runtime.clone();
                let storage = storage.clone();
                let path = root.path().join(format!("file-{number}"));
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    tauri::async_runtime::block_on(runtime.admit(storage, writing(&path))).unwrap()
                })
            })
            .collect();
        barrier.wait();
        let held: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let competitor = Runtime::default();
        for number in 0..2 {
            let path: PathBuf = root.path().join(format!("file-{number}"));
            assert!(tauri::async_runtime::block_on(
                competitor.admit(storage.clone(), writing(&path))
            )
            .is_err());
            assert!(!path.exists());
        }
        for claim in held {
            claim.finish().unwrap();
        }
    }
}
