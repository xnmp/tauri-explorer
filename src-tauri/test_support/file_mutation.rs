use super::{outcome, rename_effect, AppError, ForwardEffect};
use crate::files::{file_ops, mutation::FileMutationReceipt, run_blocking};
use std::fs;

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
        matches!(result.effect, ForwardEffect::Committed(Some(super::Action::Rename { old_name, new_name, .. })) if old_name == "report.txt" && new_name == "Report.txt")
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
        |_| ForwardEffect::Committed(None),
    ));
    assert!(result.result.is_err());
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "committed before worker failure"
    );
    assert!(matches!(result.effect, ForwardEffect::Uncertain));
    assert_eq!(result.affected, directories);
}

#[test]
fn create_without_an_inverse_still_invalidates_redo_and_reconciles() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().to_string_lossy().into_owned();
    let result = tauri::async_runtime::block_on(outcome(
        vec![directory.clone()],
        file_ops::create_empty_file(directory.clone(), "new.txt".into()),
        |_| ForwardEffect::Committed(None),
    ));
    assert!(result.result.is_ok());
    assert_eq!(fs::read(root.path().join("new.txt")).unwrap(), b"");
    assert!(matches!(result.effect, ForwardEffect::Committed(None)));
    assert_eq!(result.affected, vec![directory]);
}
