use super::{delete_outcome, outcome, rename_effect, AppError, ForwardEffect};
use crate::{
    file_history::Action,
    files::{batch, file_ops, mutation::FileMutationReceipt, run_blocking},
};
use std::fs;

fn native(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn same_name_rename_has_no_history_or_refresh_effect() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("report.txt");
    fs::write(&path, "retained bytes").unwrap();
    let result = tauri::async_runtime::block_on(outcome(
        vec![root.path().to_string_lossy().into_owned()],
        file_ops::rename_entry(path.to_string_lossy().into_owned(), "report.txt".into()),
        |receipt| rename_effect(receipt, "report.txt".into(), "report.txt".into()),
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
    let result = tauri::async_runtime::block_on(outcome(
        directories.clone(),
        file_ops::rename_entry(source.to_string_lossy().into_owned(), "Report.txt".into()),
        |receipt| rename_effect(receipt, "report.txt".into(), "Report.txt".into()),
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
    let result = tauri::async_runtime::block_on(outcome(
        vec![root.path().to_string_lossy().into_owned()],
        file_ops::rename_entry(
            root.path()
                .join("missing.txt")
                .to_string_lossy()
                .into_owned(),
            "missing.txt".into(),
        ),
        |receipt| rename_effect(receipt, "missing.txt".into(), "missing.txt".into()),
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
    let result = tauri::async_runtime::block_on(outcome(
        vec![directory.clone()],
        file_ops::create_empty_file(directory.clone(), "new.txt".into()),
        |_| ForwardEffect::Changed(None),
    ));
    assert!(result.result.is_ok());
    assert_eq!(fs::read(root.path().join("new.txt")).unwrap(), b"");
    assert!(matches!(result.effect, ForwardEffect::Changed(None)));
    assert_eq!(result.affected, vec![directory]);
}

#[test]
fn delete_batch_groups_confirmed_successes_by_parent_in_input_order() {
    let root = tempfile::tempdir().unwrap();
    let first_parent = root.path().join("first-parent");
    let second_parent = root.path().join("second-parent");
    fs::create_dir_all(&first_parent).unwrap();
    fs::create_dir_all(&second_parent).unwrap();
    let first = first_parent.join("first.txt");
    let second = second_parent.join("second.txt");
    let third = first_parent.join("third.txt");
    for path in [&first, &second, &third] {
        fs::write(path, "delete me").unwrap();
    }
    let paths = vec![native(&first), native(&second), native(&third)];
    let result = tauri::async_runtime::block_on(async {
        let outcome = batch::run(
            batch::BatchPlan::new(paths.clone()).unwrap(),
            file_ops::delete_path,
        )
        .await;
        delete_outcome(outcome, false)
    });

    assert_eq!(result.result.as_ref().unwrap().succeeded, paths);
    assert!(!first.exists());
    assert!(!second.exists());
    assert!(!third.exists());
    assert_eq!(
        result.affected,
        vec![native(&first_parent), native(&second_parent)],
    );
    assert_eq!(
        match result.effect {
            ForwardEffect::Changed(Some(action)) => action,
            _ => panic!("confirmed trashable deletions require one inverse"),
        },
        Action::Batch {
            actions: vec![
                Action::Delete {
                    paths: vec![native(&first), native(&third)],
                    parent_dir: native(&first_parent),
                },
                Action::Delete {
                    paths: vec![native(&second)],
                    parent_dir: native(&second_parent),
                },
            ],
            label: "Delete".into(),
        },
    );
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
