use super::{run, BatchPlan};
use crate::error::AppError;
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn plan(paths: &[&Path]) -> BatchPlan {
    BatchPlan::new(paths.iter().map(|path| path_string(path)).collect()).unwrap()
}

#[test]
fn worker_panic_preserves_settled_effects_and_marks_only_the_active_item_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let active = dir.path().join("active.txt");
    let unstarted = dir.path().join("unstarted.txt");
    fs::write(&first, b"first bytes").unwrap();
    fs::write(&active, b"active bytes").unwrap();
    fs::write(&unstarted, b"unstarted bytes").unwrap();
    let first_path = path_string(&first);
    let active_path = path_string(&active);

    let outcome =
        tauri::async_runtime::block_on(run(plan(&[&first, &active, &unstarted]), move |path| {
            fs::remove_file(path)?;
            if path == active_path {
                panic!("injected worker panic after active mutation");
            }
            assert_eq!(path, first_path);
            Ok(())
        }));

    assert_eq!(outcome.succeeded, [path_string(&first)]);
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.uncertain.len(), 1);
    assert_eq!(outcome.uncertain[0].path, path_string(&active));
    assert!(outcome.uncertain[0].error.contains("injected worker panic"));
    assert_eq!(outcome.unstarted, [path_string(&unstarted)]);
    assert_eq!(
        outcome.affected_paths().cloned().collect::<Vec<_>>(),
        [path_string(&first), path_string(&active)]
    );
    assert!(!first.exists());
    assert!(!active.exists());
    assert_eq!(fs::read(&unstarted).unwrap(), b"unstarted bytes");
}

#[test]
fn ordinary_preflight_failure_does_not_prevent_later_items_from_committing() {
    let dir = tempfile::tempdir().unwrap();
    let rejected = dir.path().join("rejected.txt");
    let later = dir.path().join("later.txt");
    fs::write(&rejected, b"unchanged bytes").unwrap();
    fs::write(&later, b"later bytes").unwrap();
    let rejected_path = path_string(&rejected);

    let outcome = tauri::async_runtime::block_on(run(plan(&[&rejected, &later]), move |path| {
        if path == rejected_path {
            return Err(AppError::AlreadyExists(path.into()));
        }
        fs::remove_file(path)?;
        Ok(())
    }));

    assert_eq!(outcome.succeeded, [path_string(&later)]);
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(outcome.failed[0].path, path_string(&rejected));
    assert!(outcome.failed[0].error.contains("already exists"));
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
    assert_eq!(fs::read(&rejected).unwrap(), b"unchanged bytes");
    assert!(!later.exists());
}

#[test]
fn typed_uncertainty_stops_after_the_partial_effect_and_preserves_exact_sibling_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let active = dir.path().join("active");
    let removed = active.join("removed.txt");
    let retained = active.join("retained.txt");
    let unstarted = dir.path().join("unstarted.txt");
    fs::create_dir(&active).unwrap();
    fs::write(&removed, b"remove me").unwrap();
    fs::write(&retained, b"retain these exact bytes").unwrap();
    fs::write(&unstarted, b"never touched").unwrap();
    let active_path = path_string(&active);

    let outcome = tauri::async_runtime::block_on(run(plan(&[&active, &unstarted]), move |path| {
        if path == active_path {
            fs::remove_file(Path::new(path).join("removed.txt"))?;
            return Err(AppError::MutationUncertain(
                "directory removal stopped after one child".into(),
            ));
        }
        fs::remove_file(path)?;
        Ok(())
    }));

    assert!(outcome.succeeded.is_empty());
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.uncertain.len(), 1);
    assert_eq!(outcome.uncertain[0].path, path_string(&active));
    assert_eq!(outcome.unstarted, [path_string(&unstarted)]);
    assert!(!removed.exists());
    assert_eq!(fs::read(&retained).unwrap(), b"retain these exact bytes");
    assert_eq!(fs::read(&unstarted).unwrap(), b"never touched");
}

#[test]
fn raw_count_limit_is_checked_before_duplicate_paths_are_removed() {
    let path = path_string(&std::env::temp_dir().join("batch-count-item"));
    assert!(BatchPlan::new(vec![path.clone(); 32_768]).is_ok());
    let error = BatchPlan::new(vec![path; 32_769])
        .err()
        .expect("raw count over the limit must be rejected");
    assert!(error.contains("count or size limit"));
}

#[test]
fn raw_byte_limit_is_checked_before_duplicate_paths_are_removed() {
    let prefix = format!(
        "{}{}",
        path_string(&std::env::temp_dir()),
        std::path::MAIN_SEPARATOR
    );
    let path = format!("{prefix}{}", "x".repeat(1024 - prefix.len()));
    assert_eq!(path.len(), 1024);
    assert!(BatchPlan::new(vec![path.clone(); 8_192]).is_ok());
    let error = BatchPlan::new(vec![path; 8_193])
        .err()
        .expect("raw bytes over the limit must be rejected");
    assert!(error.contains("count or size limit"));
}

#[test]
fn malformed_and_non_leaf_paths_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir
        .path()
        .ancestors()
        .find(|path| path.has_root() && path.parent().is_none())
        .unwrap();
    let separator = std::path::MAIN_SEPARATOR;
    let cases = [
        "relative.txt".to_string(),
        format!("{}\0bad", path_string(&dir.path().join("valid"))),
        path_string(root),
        format!(
            "{}{separator}safe{separator}..{separator}escape",
            dir.path().display()
        ),
    ];

    for malformed in cases {
        let error = BatchPlan::new(vec![malformed.clone()])
            .err()
            .unwrap_or_else(|| panic!("malformed path was admitted: {malformed:?}"));
        assert!(error.contains("absolute non-root paths"));
    }
}

#[test]
fn ancestor_and_descendant_are_rejected_before_any_operation_can_start() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("parent");
    let child = parent.join("child.txt");
    fs::create_dir(&parent).unwrap();
    fs::write(&child, b"untouched").unwrap();

    let admitted = BatchPlan::new(vec![path_string(&parent), path_string(&child)]);
    assert!(admitted
        .err()
        .unwrap()
        .contains("either a directory or its descendants"));
    assert_eq!(fs::read(child).unwrap(), b"untouched");
}

#[test]
fn exact_duplicates_are_removed_stably_before_execution() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    let first_path = path_string(&first);
    let second_path = path_string(&second);
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&calls);

    let outcome = tauri::async_runtime::block_on(run(
        BatchPlan::new(vec![
            first_path.clone(),
            second_path.clone(),
            first_path.clone(),
        ])
        .unwrap(),
        move |path| {
            observed.lock().unwrap().push(path.to_string());
            fs::remove_file(path)?;
            Ok(())
        },
    ));

    assert_eq!(
        *calls.lock().unwrap(),
        [first_path.clone(), second_path.clone()]
    );
    assert_eq!(outcome.succeeded, [first_path, second_path]);
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
}

#[test]
fn empty_batch_has_no_effects_or_outcome_partitions() {
    let calls = Arc::new(Mutex::new(0usize));
    let observed = Arc::clone(&calls);
    let outcome =
        tauri::async_runtime::block_on(run(BatchPlan::new(Vec::new()).unwrap(), move |_| {
            *observed.lock().unwrap() += 1;
            Ok(())
        }));

    assert_eq!(*calls.lock().unwrap(), 0);
    assert!(outcome.succeeded.is_empty());
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
    assert_eq!(outcome.error(), None);
}

#[test]
fn component_order_detects_ancestors_without_rejecting_similar_sibling_names() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let sibling = root.path().join("a-sibling");
    let child = a.join("child");
    assert!(BatchPlan::new(vec![
        path_string(&sibling),
        path_string(&child),
        path_string(&a)
    ])
    .is_err());
    assert!(BatchPlan::new(vec![path_string(&child), path_string(&sibling)]).is_ok());
    let deep = root.path().join("component/".repeat(10_000)).join("leaf");
    assert!(BatchPlan::new(vec![path_string(&deep), path_string(&deep.join("child"))]).is_err());
}
