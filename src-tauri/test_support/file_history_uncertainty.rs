use super::{
    execution::{self, OperationError, Operations},
    execution_affected,
    model::{Action, Direction, Histories},
    operation_error, NativeOperations,
};
use crate::{
    error::AppError,
    files::{run_blocking, trash::FileBatchOutcome},
};
use std::{fs, path::Path};

#[test]
fn auxiliary_directory_effects_publish_without_completing_a_history_action() {
    let root = tempfile::tempdir().unwrap();
    let action = fixture(root.path(), "remaining");
    let parent = root.path().to_string_lossy().into_owned();
    let child = root.path().join("recreated").to_string_lossy().into_owned();
    let result = super::model::Execution {
        remaining: Some(action),
        refresh_dirs: vec![child.clone(), parent.clone(), child.clone()],
        error: Some("leaf was not restored".into()),
        ..super::model::Execution::default()
    };
    assert_eq!(execution_affected(&result), [parent, child]);
    assert!(result.completed.is_none());
    assert!(result.opposite.is_none());
}

struct PanicAfterRename;
impl Operations for PanicAfterRename {
    async fn rename(&self, path: String, name: String) -> Result<(), OperationError> {
        if !path.ends_with("panic-new.txt") {
            return NativeOperations.rename(path, name).await;
        }
        run_blocking(move || -> Result<(), AppError> {
            let source = Path::new(&path);
            fs::rename(source, source.parent().unwrap().join(name))?;
            panic!("injected inverse worker panic after committed rename");
        })
        .await
        .map_err(operation_error)
    }
    async fn move_entry(
        &self,
        path: String,
        destination: String,
    ) -> Result<Option<String>, OperationError> {
        NativeOperations.move_entry(path, destination).await
    }
    async fn trash(&self, path: String) -> Result<(), OperationError> {
        NativeOperations.trash(path).await
    }
    async fn trash_many(&self, paths: Vec<String>) -> Result<FileBatchOutcome, OperationError> {
        NativeOperations.trash_many(paths).await
    }
    async fn restore(&self, paths: Vec<String>) -> Result<FileBatchOutcome, OperationError> {
        NativeOperations.restore(paths).await
    }
}

fn fixture(root: &Path, stem: &str) -> Action {
    let directory = root.join(stem);
    fs::create_dir(&directory).unwrap();
    let path = directory.join(format!("{stem}-new.txt"));
    fs::write(&path, format!("{stem} bytes")).unwrap();
    Action::Rename {
        path: path.to_string_lossy().into_owned(),
        old_name: format!("{stem}-old.txt"),
        new_name: format!("{stem}-new.txt"),
    }
}

#[test]
fn worker_panic_after_inverse_commit_is_not_retryable_and_reconciles_its_parent() {
    let root = tempfile::tempdir().unwrap();
    let action = fixture(root.path(), "panic");
    let mut histories = Histories::default();
    histories.register(1);
    histories.push(1, Some(action.clone()), false).unwrap();
    let id = histories.summary(1).undo_id.unwrap();
    let reservation = histories.begin(1, Direction::Undo, id).unwrap();
    let result = tauri::async_runtime::block_on(execution::execute(
        action.clone(),
        &PanicAfterRename,
        Direction::Undo,
    ));
    assert_eq!(
        fs::read_to_string(root.path().join("panic/panic-old.txt")).unwrap(),
        "panic bytes"
    );
    assert!(!root.path().join("panic/panic-new.txt").exists());
    assert!(result.error.is_some());
    assert!(
        result.remaining.is_none(),
        "the uncertain inverse must not be offered for retry"
    );
    assert!(result.opposite.is_none());
    assert!(
        result.completed.is_none(),
        "uncertainty is not a confirmed effect"
    );
    assert_eq!(result.uncertain, Some(action));
    assert_eq!(
        execution_affected(&result),
        vec![root.path().join("panic").to_string_lossy().into_owned()]
    );
    histories.finish(reservation, &result);
    assert!(histories.summary(1).undo_id.is_none());
    assert!(histories.summary(1).redo_id.is_none());
    assert!(!histories.summary(1).busy);
    assert!(histories.begin(1, Direction::Undo, id).is_err());
}

#[test]
fn uncertain_batch_child_reconciles_while_known_and_unstarted_siblings_keep_their_contracts() {
    let root = tempfile::tempdir().unwrap();
    let untouched = fixture(root.path(), "untouched");
    let uncertain = fixture(root.path(), "panic");
    let completed = fixture(root.path(), "completed");
    let batch = |actions| Action::Batch {
        actions,
        label: "rename batch".into(),
    };
    let result = tauri::async_runtime::block_on(execution::execute(
        batch(vec![
            untouched.clone(),
            uncertain.clone(),
            completed.clone(),
        ]),
        &PanicAfterRename,
        Direction::Undo,
    ));
    assert_eq!(result.completed, Some(batch(vec![completed.clone()])));
    assert_eq!(result.opposite, Some(batch(vec![completed])));
    assert_eq!(result.uncertain, Some(batch(vec![uncertain])));
    assert_eq!(result.remaining, Some(batch(vec![untouched])));
    for stem in ["panic", "completed"] {
        assert_eq!(
            fs::read_to_string(root.path().join(stem).join(format!("{stem}-old.txt"))).unwrap(),
            format!("{stem} bytes")
        );
        assert!(!root
            .path()
            .join(stem)
            .join(format!("{stem}-new.txt"))
            .exists());
    }
    assert_eq!(
        fs::read_to_string(root.path().join("untouched/untouched-new.txt")).unwrap(),
        "untouched bytes"
    );
    assert!(!root.path().join("untouched/untouched-old.txt").exists());
    let mut affected = execution_affected(&result);
    affected.sort();
    assert_eq!(
        affected,
        vec![
            root.path().join("completed").to_string_lossy().into_owned(),
            root.path().join("panic").to_string_lossy().into_owned()
        ]
    );
}
