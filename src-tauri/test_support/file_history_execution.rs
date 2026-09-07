use super::{execute, OperationError, Operations};
use crate::{
    file_history::model::{Action, Direction},
    files::trash::{FileBatchOutcome, FileFailure},
};
use std::{collections::VecDeque, future::Future, path::PathBuf, sync::Mutex};

#[derive(Clone, Debug, PartialEq)]
enum Call {
    Rename(String, String),
    Move(String, String),
    Trash(String),
    TrashMany(Vec<String>),
    Restore(Vec<String>),
}

enum Reply {
    Unit(Result<(), String>),
    Move(Result<Option<String>, String>),
    Batch(Result<FileBatchOutcome, String>),
}

#[derive(Default)]
struct FakeOperations {
    calls: Mutex<Vec<Call>>,
    replies: Mutex<VecDeque<Reply>>,
}

impl FakeOperations {
    fn new(replies: impl IntoIterator<Item = Reply>) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into_iter().collect()),
        }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("read operation calls").clone()
    }

    fn unit(&self, call: Call) -> Result<(), String> {
        self.calls.lock().expect("record operation call").push(call);
        match self
            .replies
            .lock()
            .expect("read operation reply")
            .pop_front()
        {
            Some(Reply::Unit(result)) => result,
            Some(Reply::Move(_)) => panic!("unit operation received a move reply"),
            Some(Reply::Batch(_)) => panic!("unit operation received a batch reply"),
            None => panic!("unexpected unit operation"),
        }
    }

    fn move_entry(&self, call: Call) -> Result<Option<String>, String> {
        self.calls.lock().expect("record operation call").push(call);
        match self
            .replies
            .lock()
            .expect("read operation reply")
            .pop_front()
        {
            Some(Reply::Move(result)) => result,
            Some(Reply::Unit(_)) => panic!("move operation received a unit reply"),
            Some(Reply::Batch(_)) => panic!("move operation received a batch reply"),
            None => panic!("unexpected move operation"),
        }
    }

    fn batch(&self, call: Call) -> Result<FileBatchOutcome, String> {
        self.calls.lock().expect("record operation call").push(call);
        match self
            .replies
            .lock()
            .expect("read operation reply")
            .pop_front()
        {
            Some(Reply::Batch(result)) => result,
            Some(Reply::Unit(_)) => panic!("batch operation received a unit reply"),
            Some(Reply::Move(_)) => panic!("batch operation received a move reply"),
            None => panic!("unexpected batch operation"),
        }
    }
}

impl Operations for FakeOperations {
    async fn rename(&self, path: String, name: String) -> Result<(), OperationError> {
        self.unit(Call::Rename(path, name))
            .map_err(OperationError::from)
    }

    async fn move_entry(
        &self,
        path: String,
        destination: String,
    ) -> Result<Option<String>, OperationError> {
        self.move_entry(Call::Move(path, destination))
            .map_err(OperationError::from)
    }

    async fn trash(&self, path: String) -> Result<(), OperationError> {
        self.unit(Call::Trash(path)).map_err(OperationError::from)
    }

    async fn trash_many(&self, paths: Vec<String>) -> Result<FileBatchOutcome, OperationError> {
        self.batch(Call::TrashMany(paths))
            .map_err(OperationError::from)
    }

    async fn restore(&self, paths: Vec<String>) -> Result<FileBatchOutcome, OperationError> {
        self.batch(Call::Restore(paths))
            .map_err(OperationError::from)
    }
}

fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build executor test runtime")
        .block_on(future)
}

fn path(relative: &str) -> String {
    let mut path = if cfg!(windows) {
        PathBuf::from(r"C:\")
    } else {
        PathBuf::from("/")
    };
    path.extend(relative.split('/'));
    path.to_string_lossy().into_owned()
}

fn rename(name: &str) -> Action {
    Action::Rename {
        path: path(&format!("work/{name}-new.txt")),
        old_name: format!("{name}-old.txt"),
        new_name: format!("{name}-new.txt"),
    }
}

fn batch_outcome(succeeded: Vec<String>, failed: Vec<(String, &str)>) -> FileBatchOutcome {
    FileBatchOutcome {
        succeeded,
        failed: failed
            .into_iter()
            .map(|(path, error)| FileFailure {
                path,
                error: error.into(),
            })
            .collect(),
    }
}

#[test]
fn rename_and_move_use_the_current_directional_paths() {
    let rename_action = Action::Rename {
        path: path("renames/new.txt"),
        old_name: "old.txt".into(),
        new_name: "new.txt".into(),
    };
    let move_action = Action::Move {
        source_path: path("from/original.txt"),
        dest_path: path("to/landed.txt"),
        original_dir: path("from"),
    };
    let operations = FakeOperations::new([
        Reply::Unit(Ok(())),
        Reply::Unit(Ok(())),
        Reply::Move(Ok(None)),
        Reply::Move(Ok(None)),
    ]);

    let rename_undo = run(execute(rename_action.clone(), &operations, Direction::Undo));
    let rename_redo = run(execute(rename_action.clone(), &operations, Direction::Redo));
    let move_undo = run(execute(move_action.clone(), &operations, Direction::Undo));
    let move_redo = run(execute(move_action.clone(), &operations, Direction::Redo));

    assert_eq!(rename_undo.completed, Some(rename_action.clone()));
    assert_eq!(rename_undo.opposite, Some(rename_action.clone()));
    assert_eq!(rename_redo.completed, Some(rename_action.clone()));
    assert_eq!(rename_redo.opposite, Some(rename_action));
    assert_eq!(move_undo.completed, Some(move_action.clone()));
    assert_eq!(move_undo.opposite, Some(move_action.clone()));
    assert_eq!(move_redo.completed, Some(move_action.clone()));
    assert_eq!(move_redo.opposite, Some(move_action));
    assert_eq!(
        operations.calls(),
        vec![
            Call::Rename(path("renames/new.txt"), "old.txt".into()),
            Call::Rename(path("renames/old.txt"), "new.txt".into()),
            Call::Move(path("to/landed.txt"), path("from")),
            Call::Move(path("from/landed.txt"), path("to")),
        ]
    );
}

#[test]
fn a_move_with_cleanup_recovery_is_completed_without_an_opposite_or_retry() {
    let action = Action::Move {
        source_path: path("from/original.txt"),
        dest_path: path("to/landed.txt"),
        original_dir: path("from"),
    };
    let recovery = "Files were copied, but source cleanup did not finish";
    let operations = FakeOperations::new([Reply::Move(Ok(Some(recovery.into())))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.completed, Some(action));
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, None);
    assert_eq!(result.error.as_deref(), Some(recovery));
    assert_eq!(
        operations.calls(),
        vec![Call::Move(path("to/landed.txt"), path("from"))],
    );
}

#[test]
fn a_batch_stops_after_a_recovered_move_without_retrying_its_committed_effect() {
    let never_attempted = rename("never-attempted");
    let recovered_move = Action::Move {
        source_path: path("from/original.txt"),
        dest_path: path("to/landed.txt"),
        original_dir: path("from"),
    };
    let completed_last = rename("completed-last");
    let action = Action::Batch {
        actions: vec![
            never_attempted.clone(),
            recovered_move.clone(),
            completed_last.clone(),
        ],
        label: "mixed move recovery".into(),
    };
    let recovery = "destination committed; source cleanup incomplete";
    let operations =
        FakeOperations::new([Reply::Unit(Ok(())), Reply::Move(Ok(Some(recovery.into())))]);

    let result = run(execute(action, &operations, Direction::Undo));

    assert_eq!(
        operations.calls(),
        vec![
            Call::Rename(
                path("work/completed-last-new.txt"),
                "completed-last-old.txt".into(),
            ),
            Call::Move(path("to/landed.txt"), path("from")),
        ],
    );
    assert_eq!(
        result.completed,
        Some(Action::Batch {
            actions: vec![recovered_move, completed_last.clone()],
            label: "mixed move recovery".into(),
        }),
    );
    assert_eq!(
        result.opposite,
        Some(Action::Batch {
            actions: vec![completed_last],
            label: "mixed move recovery".into(),
        }),
    );
    assert_eq!(
        result.remaining,
        Some(Action::Batch {
            actions: vec![never_attempted],
            label: "mixed move recovery".into(),
        }),
    );
    assert_eq!(result.error.as_deref(), Some(recovery));
}

#[test]
fn a_failed_leaf_remains_retryable_without_an_opposite() {
    let action = rename("blocked");
    let operations = FakeOperations::new([Reply::Unit(Err("destination exists".into()))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.completed, None);
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, Some(action));
    assert_eq!(result.error.as_deref(), Some("destination exists"));
}

#[test]
fn delete_partitions_receipts_in_original_action_order() {
    let first = path("delete/first.txt");
    let second = path("delete/second.txt");
    let third = path("delete/third.txt");
    let parent_dir = path("delete");
    let action = Action::Delete {
        paths: vec![first.clone(), second.clone(), third.clone()],
        parent_dir: parent_dir.clone(),
    };
    let operations = FakeOperations::new([Reply::Batch(Ok(batch_outcome(
        vec![third.clone(), first.clone()],
        vec![(second.clone(), "missing from trash")],
    )))]);

    let result = run(execute(action, &operations, Direction::Undo));
    let completed = Action::Delete {
        paths: vec![first.clone(), third.clone()],
        parent_dir: parent_dir.clone(),
    };

    assert_eq!(result.completed, Some(completed.clone()));
    assert_eq!(result.opposite, Some(completed));
    assert_eq!(
        result.remaining,
        Some(Action::Delete {
            paths: vec![second.clone()],
            parent_dir,
        })
    );
    assert_eq!(
        result.error.as_deref(),
        Some(format!("{second}: missing from trash").as_str())
    );
    assert_eq!(
        operations.calls(),
        vec![Call::Restore(vec![first, second, third])]
    );
}

#[test]
fn delete_redo_uses_bulk_trash_and_retains_an_outer_failure() {
    let first = path("redo/first.txt");
    let second = path("redo/second.txt");
    let action = Action::Delete {
        paths: vec![first.clone(), second.clone()],
        parent_dir: path("redo"),
    };
    let operations = FakeOperations::new([Reply::Batch(Err("trash transport stopped".into()))]);

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(result.completed, None);
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, Some(action));
    assert_eq!(result.error.as_deref(), Some("trash transport stopped"));
    assert_eq!(
        operations.calls(),
        vec![Call::TrashMany(vec![first, second])]
    );
}

#[test]
fn copy_undo_completes_without_manufacturing_unsupported_redo() {
    let copied_path = path("network/copied.txt");
    let action = Action::Copy {
        copied_path: copied_path.clone(),
        parent_dir: path("network"),
        restore_supported: false,
    };
    let operations = FakeOperations::new([Reply::Unit(Ok(()))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.completed, Some(action));
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, None);
    assert_eq!(result.error, None);
    assert_eq!(operations.calls(), vec![Call::Trash(copied_path)]);
}

#[test]
fn recoverable_copy_undo_records_the_same_action_for_redo() {
    let copied_path = path("local/copied.txt");
    let action = Action::Copy {
        copied_path: copied_path.clone(),
        parent_dir: path("local"),
        restore_supported: true,
    };
    let operations = FakeOperations::new([Reply::Unit(Ok(()))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.completed, Some(action.clone()));
    assert_eq!(result.opposite, Some(action));
    assert_eq!(result.remaining, None);
    assert_eq!(result.error, None);
    assert_eq!(operations.calls(), vec![Call::Trash(copied_path)]);
}

#[test]
fn unsupported_copy_redo_fails_before_calling_the_restore_port() {
    let action = Action::Copy {
        copied_path: path("network/copied.txt"),
        parent_dir: path("network"),
        restore_supported: false,
    };
    let operations = FakeOperations::default();

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(result.completed, None);
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, Some(action));
    assert_eq!(
        result.error.as_deref(),
        Some("Cannot redo copy because restoring this item is unsupported")
    );
    assert!(operations.calls().is_empty());
}

#[test]
fn recoverable_copy_redo_requires_its_exact_restore_receipt() {
    let copied_path = path("local/copied.txt");
    let action = Action::Copy {
        copied_path: copied_path.clone(),
        parent_dir: path("local"),
        restore_supported: true,
    };
    let operations = FakeOperations::new([Reply::Batch(Ok(batch_outcome(
        Vec::new(),
        vec![(copied_path.clone(), "payload missing")],
    )))]);

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(result.completed, None);
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, Some(action));
    assert_eq!(
        result.error.as_deref(),
        Some(format!("{copied_path}: payload missing").as_str())
    );
    assert_eq!(operations.calls(), vec![Call::Restore(vec![copied_path])]);
}

#[test]
fn batch_invalidation_keeps_completed_one_way_copy_out_of_redo() {
    let rename = rename("recoverable");
    let copied_path = path("network/one-way.txt");
    let copy = Action::Copy {
        copied_path: copied_path.clone(),
        parent_dir: path("network"),
        restore_supported: false,
    };
    let action = Action::Batch {
        actions: vec![rename.clone(), copy.clone()],
        label: "mixed capability".into(),
    };
    let operations = FakeOperations::new([Reply::Unit(Ok(())), Reply::Unit(Ok(()))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(
        operations.calls(),
        vec![
            Call::Trash(copied_path),
            Call::Rename(
                path("work/recoverable-new.txt"),
                "recoverable-old.txt".into()
            ),
        ]
    );
    assert_eq!(result.completed, Some(action));
    assert_eq!(
        result.opposite,
        Some(Action::Batch {
            actions: vec![rename],
            label: "mixed capability".into(),
        })
    );
    assert_eq!(result.remaining, None);
    assert_eq!(result.error, None);
}

#[test]
fn nested_batch_undo_reverses_calls_and_preserves_unfinished_original_order() {
    let first = rename("first");
    let second = rename("second");
    let third = rename("third");
    let last = rename("last");
    let nested = Action::Batch {
        actions: vec![second.clone(), third.clone()],
        label: "nested".into(),
    };
    let action = Action::Batch {
        actions: vec![first.clone(), nested.clone(), last.clone()],
        label: "outer".into(),
    };
    let operations = FakeOperations::new([
        Reply::Unit(Ok(())),
        Reply::Unit(Err("third is blocked".into())),
    ]);

    let result = run(execute(action, &operations, Direction::Undo));

    assert_eq!(
        operations.calls(),
        vec![
            Call::Rename(path("work/last-new.txt"), "last-old.txt".into()),
            Call::Rename(path("work/third-new.txt"), "third-old.txt".into()),
        ]
    );
    assert_eq!(
        result.completed,
        Some(Action::Batch {
            actions: vec![last.clone()],
            label: "outer".into(),
        })
    );
    assert_eq!(
        result.opposite,
        Some(Action::Batch {
            actions: vec![last],
            label: "outer".into(),
        })
    );
    assert_eq!(
        result.remaining,
        Some(Action::Batch {
            actions: vec![first, nested],
            label: "outer".into(),
        })
    );
    assert_eq!(result.error.as_deref(), Some("third is blocked"));
}

#[test]
fn nested_batch_redo_runs_forward_and_keeps_nested_shape() {
    let first = rename("first");
    let second = rename("second");
    let third = rename("third");
    let last = rename("last");
    let action = Action::Batch {
        actions: vec![
            first.clone(),
            Action::Batch {
                actions: vec![second.clone(), third.clone()],
                label: "nested".into(),
            },
            last.clone(),
        ],
        label: "outer".into(),
    };
    let operations = FakeOperations::new((0..4).map(|_| Reply::Unit(Ok(()))));

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(
        operations.calls(),
        vec![
            Call::Rename(path("work/first-old.txt"), "first-new.txt".into()),
            Call::Rename(path("work/second-old.txt"), "second-new.txt".into()),
            Call::Rename(path("work/third-old.txt"), "third-new.txt".into()),
            Call::Rename(path("work/last-old.txt"), "last-new.txt".into()),
        ]
    );
    assert_eq!(result.completed, Some(action.clone()));
    assert_eq!(result.opposite, Some(action));
    assert_eq!(result.remaining, None);
    assert_eq!(result.error, None);
}
