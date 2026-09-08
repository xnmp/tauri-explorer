use super::{execute, OperationError, Operations};
use crate::{
    file_history::model::{Action, Direction, Recovery, RestoreArtifacts},
    files::trash::{FileBatchOutcome, FileFailure},
    files::trash_artifact::{RestoreRequest, TrashArtifact},
};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, PartialEq)]
enum Call {
    Rename(String, String),
    Move(String, String),
    TrashMany(Vec<String>),
    Restore(Vec<(String, String)>),
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

    async fn trash_many(&self, paths: Vec<String>) -> Result<FileBatchOutcome, OperationError> {
        self.batch(Call::TrashMany(paths))
            .map_err(OperationError::from)
    }

    async fn restore(
        &self,
        requests: Vec<RestoreRequest>,
    ) -> Result<FileBatchOutcome, OperationError> {
        self.batch(Call::Restore(
            requests
                .into_iter()
                .map(|request| (request.path, artifact_id(&request.artifact)))
                .collect(),
        ))
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

fn artifact(id: &str) -> Arc<TrashArtifact> {
    Arc::new(TrashArtifact::WindowsShell {
        parsing_name_utf16: id.encode_utf16().collect(),
    })
}

fn artifact_id(artifact: &TrashArtifact) -> String {
    match artifact {
        TrashArtifact::WindowsShell { parsing_name_utf16 } => {
            String::from_utf16(parsing_name_utf16).expect("fixture artifact is valid UTF-16")
        }
        TrashArtifact::Freedesktop { name, .. } => name.to_string_lossy().into_owned(),
    }
}

fn artifacts(
    entries: impl IntoIterator<Item = (String, Arc<TrashArtifact>)>,
) -> Arc<RestoreArtifacts> {
    Arc::new(entries.into_iter().collect::<BTreeMap<_, _>>())
}

fn copy_action(
    copied_path: String,
    parent_dir: String,
    restore_supported: bool,
    recovery: Recovery<Arc<TrashArtifact>>,
) -> Action {
    Action::Copy {
        copied_path,
        parent_dir,
        restore_supported,
        recovery,
    }
}

fn delete_action(
    paths: Vec<String>,
    parent_dir: String,
    recovery: Recovery<Arc<RestoreArtifacts>>,
) -> Action {
    Action::Delete {
        paths,
        parent_dir,
        recovery,
    }
}

fn batch_outcome(succeeded: Vec<String>, failed: Vec<(String, &str)>) -> FileBatchOutcome {
    batch_outcome_with_refresh(succeeded, failed, Vec::new())
}

fn batch_outcome_with_refresh(
    succeeded: Vec<String>,
    failed: Vec<(String, &str)>,
    refresh_dirs: Vec<String>,
) -> FileBatchOutcome {
    FileBatchOutcome {
        artifacts: BTreeMap::new(),
        warnings: Vec::new(),
        uncertain: Vec::new(),
        unstarted: Vec::new(),
        refresh_dirs,
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

fn assert_refresh_dirs(actual: &[String], expected: &[String]) {
    assert_eq!(actual.len(), expected.len());
    let actual = actual.iter().collect::<HashSet<_>>();
    let expected = expected.iter().collect::<HashSet<_>>();
    assert_eq!(actual, expected);
}

#[test]
fn redo_warns_and_retains_a_fitting_inverse_when_receipts_expand_history_memory() {
    let parent = path(&format!("work/{}", "d".repeat(2000)));
    let paths = [format!("{parent}/first"), format!("{parent}/second")];
    let artifacts = paths
        .iter()
        .map(|path| {
            (
                path.clone(),
                Arc::new(TrashArtifact::WindowsShell {
                    parsing_name_utf16: vec![65; (16 * 1024 * 1024 - 4000) / 2],
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    // The filesystem receipt batch fits its transient budget, but a complete
    // history entry additionally owns grouped paths, map keys and containers.
    assert!(
        artifacts
            .iter()
            .map(|(path, artifact)| path.len() + artifact.retained_bytes())
            .sum::<usize>()
            < 32 * 1024 * 1024
    );
    let operations = FakeOperations::new([Reply::Batch(Ok(FileBatchOutcome {
        succeeded: paths.to_vec(),
        artifacts,
        ..Default::default()
    }))]);
    let action = delete_action(paths.to_vec(), parent, Recovery::Capture);
    let result = run(execute(action, &operations, Direction::Redo));

    assert!(result
        .error
        .as_deref()
        .is_some_and(|warning| warning.contains("memory budget")));
    assert!(
        result.remaining.is_none(),
        "completed deletion cannot be retried"
    );
    let Some(Action::Delete {
        paths: retained, ..
    }) = result.opposite
    else {
        panic!("retain fitting recovery");
    };
    assert_eq!(retained, [paths[0].clone()]);
    assert!(
        matches!(result.completed, Some(Action::Delete { paths: completed, .. }) if completed == paths)
    );
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
fn delete_undo_restores_exact_artifacts_and_partitions_in_original_order() {
    let first = path("delete/first.txt");
    let second = path("delete/second.txt");
    let third = path("delete/third.txt");
    let parent = path("delete");
    let first_artifact = artifact("artifact-first");
    let second_artifact = artifact("artifact-second");
    let third_artifact = artifact("artifact-third");
    let action = delete_action(
        vec![first.clone(), second.clone(), third.clone()],
        parent.clone(),
        Recovery::Restore(artifacts([
            (first.clone(), first_artifact),
            (second.clone(), second_artifact),
            (third.clone(), third_artifact),
        ])),
    );
    let operations = FakeOperations::new([Reply::Batch(Ok(batch_outcome(
        vec![third.clone(), first.clone()],
        vec![(second.clone(), "missing from trash")],
    )))]);

    let result = run(execute(action, &operations, Direction::Undo));

    assert_eq!(
        operations.calls(),
        vec![Call::Restore(vec![
            (first.clone(), "artifact-first".into()),
            (second.clone(), "artifact-second".into()),
            (third.clone(), "artifact-third".into()),
        ])]
    );
    assert_eq!(
        result.completed,
        Some(delete_action(
            vec![first.clone(), third.clone()],
            parent.clone(),
            Recovery::Restore(artifacts([
                (first.clone(), artifact("artifact-first")),
                (third.clone(), artifact("artifact-third")),
            ])),
        ))
    );
    assert_eq!(
        result.opposite,
        Some(delete_action(
            vec![first.clone(), third.clone()],
            parent.clone(),
            Recovery::Capture,
        ))
    );
    assert_eq!(
        result.remaining,
        Some(delete_action(
            vec![second.clone()],
            parent,
            Recovery::Restore(artifacts([(second.clone(), artifact("artifact-second"))])),
        ))
    );
    assert_eq!(
        result.error.as_deref(),
        Some(format!("{second}: missing from trash").as_str())
    );
}

#[test]
fn same_original_path_uses_the_artifact_owned_by_this_history_leaf() {
    let copied_path = path("same/path.txt");
    let own_artifact = artifact("history-owned-artifact");
    let unrelated = artifact("newer-unrelated-artifact");
    let action = copy_action(
        copied_path.clone(),
        path("same"),
        true,
        Recovery::Restore(own_artifact),
    );
    let operations = FakeOperations::new([Reply::Batch(Ok(batch_outcome(
        vec![copied_path.clone()],
        Vec::new(),
    )))]);

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(
        operations.calls(),
        vec![Call::Restore(vec![(
            copied_path.clone(),
            "history-owned-artifact".into(),
        )])],
        "the unrelated newer artifact must never be selected"
    );
    assert_ne!(artifact_id(&unrelated), "history-owned-artifact");
    assert_eq!(result.completed, Some(action));
    assert_eq!(
        result.opposite,
        Some(copy_action(
            copied_path,
            path("same"),
            true,
            Recovery::Capture,
        ))
    );
}

#[test]
fn copy_undo_captures_a_fresh_receipt_for_each_redo_cycle() {
    let copied_path = path("local/copied.txt");
    let initial = copy_action(copied_path.clone(), path("local"), true, Recovery::Capture);
    let first_artifact = artifact("first-trash-artifact");
    let second_artifact = artifact("second-trash-artifact");
    let mut first_outcome = batch_outcome(vec![copied_path.clone()], Vec::new());
    first_outcome
        .artifacts
        .insert(copied_path.clone(), first_artifact);
    let restore_outcome = batch_outcome(vec![copied_path.clone()], Vec::new());
    let mut second_outcome = batch_outcome(vec![copied_path.clone()], Vec::new());
    second_outcome
        .artifacts
        .insert(copied_path.clone(), second_artifact);
    let operations = FakeOperations::new([
        Reply::Batch(Ok(first_outcome)),
        Reply::Batch(Ok(restore_outcome)),
        Reply::Batch(Ok(second_outcome)),
    ]);

    let first_undo = run(execute(initial.clone(), &operations, Direction::Undo));
    let first_redo_action = first_undo.opposite.expect("first Undo creates Redo");
    let redo = run(execute(first_redo_action, &operations, Direction::Redo));
    let second_undo_action = redo.opposite.expect("Redo creates a fresh Undo capture");
    let second_undo = run(execute(second_undo_action, &operations, Direction::Undo));

    assert_eq!(first_undo.completed, Some(initial));
    assert!(matches!(
        second_undo.opposite,
        Some(Action::Copy {
            recovery: Recovery::Restore(ref receipt),
            ..
        }) if artifact_id(receipt) == "second-trash-artifact"
    ));
    assert_eq!(
        operations.calls(),
        vec![
            Call::TrashMany(vec![copied_path.clone()]),
            Call::Restore(vec![(copied_path.clone(), "first-trash-artifact".into())]),
            Call::TrashMany(vec![copied_path]),
        ]
    );
}

#[test]
fn confirmed_copy_removal_without_a_receipt_is_consumed_without_redo() {
    let copied_path = path("local/no-receipt.txt");
    let action = copy_action(copied_path.clone(), path("local"), true, Recovery::Capture);
    let mut outcome = batch_outcome(vec![copied_path.clone()], Vec::new());
    outcome.warnings.push(FileFailure {
        path: copied_path.clone(),
        error: "receipt capture failed".into(),
    });
    let operations = FakeOperations::new([Reply::Batch(Ok(outcome))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.completed, Some(action));
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, None);
    let error = result.error.expect("lost recovery identity is visible");
    assert!(error.contains("receipt capture failed"));
    assert!(error.contains("Redo is unavailable"));
    assert_eq!(operations.calls(), vec![Call::TrashMany(vec![copied_path])]);
}

#[test]
fn wrong_copy_phase_fails_before_calling_a_filesystem_port() {
    let copied_path = path("local/copied.txt");
    let operations = FakeOperations::default();
    let undo_with_restore = copy_action(
        copied_path.clone(),
        path("local"),
        true,
        Recovery::Restore(artifact("already-trashed")),
    );
    let redo_with_capture = copy_action(copied_path, path("local"), true, Recovery::Capture);

    let undo = run(execute(
        undo_with_restore.clone(),
        &operations,
        Direction::Undo,
    ));
    let redo = run(execute(
        redo_with_capture.clone(),
        &operations,
        Direction::Redo,
    ));

    assert_eq!(undo.remaining, Some(undo_with_restore));
    assert_eq!(redo.remaining, Some(redo_with_capture));
    assert!(undo.error.unwrap().contains("exact recovery identity"));
    assert!(redo.error.unwrap().contains("exact recovery identity"));
    assert!(operations.calls().is_empty());
}

#[test]
fn missing_delete_artifact_fails_the_whole_restore_before_port_dispatch() {
    let first = path("delete/first.txt");
    let missing = path("delete/missing.txt");
    let action = delete_action(
        vec![first.clone(), missing.clone()],
        path("delete"),
        Recovery::Restore(artifacts([(first, artifact("first-artifact"))])),
    );
    let operations = FakeOperations::default();

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.remaining, Some(action));
    assert_eq!(result.completed, None);
    assert_eq!(result.opposite, None);
    assert!(result.error.unwrap().contains(&missing));
    assert!(operations.calls().is_empty());
}

#[test]
fn delete_redo_partitions_fresh_artifacts_and_consumes_uncertainty() {
    let succeeded = path("delete/succeeded.txt");
    let no_receipt = path("delete/no-receipt.txt");
    let failed = path("delete/failed.txt");
    let uncertain = path("delete/uncertain.txt");
    let unstarted = path("delete/unstarted.txt");
    let parent = path("delete");
    let action = delete_action(
        vec![
            succeeded.clone(),
            no_receipt.clone(),
            failed.clone(),
            uncertain.clone(),
            unstarted.clone(),
        ],
        parent.clone(),
        Recovery::Capture,
    );
    let mut outcome = batch_outcome(
        vec![no_receipt.clone(), succeeded.clone()],
        vec![(failed.clone(), "permission denied")],
    );
    outcome
        .artifacts
        .insert(succeeded.clone(), artifact("fresh-succeeded"));
    outcome.uncertain.push(FileFailure {
        path: uncertain.clone(),
        error: "worker exited".into(),
    });
    outcome.unstarted.push(unstarted.clone());
    let operations = FakeOperations::new([Reply::Batch(Ok(outcome))]);

    let result = run(execute(action, &operations, Direction::Redo));

    assert_eq!(
        operations.calls(),
        vec![Call::TrashMany(vec![
            succeeded.clone(),
            no_receipt.clone(),
            failed.clone(),
            uncertain.clone(),
            unstarted.clone(),
        ])]
    );
    assert_eq!(
        result.opposite,
        Some(delete_action(
            vec![succeeded.clone()],
            parent.clone(),
            Recovery::Restore(artifacts([(
                succeeded.clone(),
                artifact("fresh-succeeded"),
            )])),
        ))
    );
    assert_eq!(
        result.completed,
        Some(delete_action(
            vec![succeeded.clone(), no_receipt.clone()],
            parent.clone(),
            Recovery::Capture,
        ))
    );
    assert_eq!(
        result.uncertain,
        Some(delete_action(
            vec![uncertain],
            parent.clone(),
            Recovery::Capture,
        ))
    );
    assert_eq!(
        result.remaining,
        Some(delete_action(
            vec![failed, unstarted],
            parent,
            Recovery::Capture,
        ))
    );
    let error = result
        .error
        .expect("partial result reports every limitation");
    assert!(error.contains("permission denied"));
    assert!(error.contains("outcome is uncertain"));
    assert!(error.contains("not started"));
    assert!(error.contains("Undo is unavailable"));
}

#[test]
fn delete_redo_transport_failure_retains_capture_phase() {
    let first = path("redo/first.txt");
    let second = path("redo/second.txt");
    let action = delete_action(
        vec![first.clone(), second.clone()],
        path("redo"),
        Recovery::Capture,
    );
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
fn unsupported_copy_undo_completes_without_manufacturing_redo() {
    let copied_path = path("network/copied.txt");
    let action = copy_action(
        copied_path.clone(),
        path("network"),
        false,
        Recovery::Capture,
    );
    let operations = FakeOperations::new([Reply::Batch(Ok(batch_outcome(
        vec![copied_path.clone()],
        Vec::new(),
    )))]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(result.completed, Some(action));
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, None);
    assert_eq!(result.error, None);
    assert_eq!(operations.calls(), vec![Call::TrashMany(vec![copied_path])]);
}

#[test]
fn unsupported_copy_redo_fails_before_restore_dispatch() {
    let action = copy_action(
        path("network/copied.txt"),
        path("network"),
        false,
        Recovery::Restore(artifact("unused")),
    );
    let operations = FakeOperations::default();

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(result.remaining, Some(action));
    assert_eq!(
        result.error.as_deref(),
        Some("Cannot redo copy because restoring this item is unsupported")
    );
    assert!(operations.calls().is_empty());
}

#[test]
fn copy_redo_preserves_refresh_effects_on_success_and_failure() {
    let succeeded_path = path("restore/success/copied.txt");
    let failed_path = path("restore/failure/copied.txt");
    let succeeded = copy_action(
        succeeded_path.clone(),
        path("restore/success"),
        true,
        Recovery::Restore(artifact("success-artifact")),
    );
    let failed = copy_action(
        failed_path.clone(),
        path("restore/failure"),
        true,
        Recovery::Restore(artifact("failure-artifact")),
    );
    let success_refresh = vec![path("restore"), path("restore/success")];
    let failure_refresh = vec![path("restore/failure")];
    let operations = FakeOperations::new([
        Reply::Batch(Ok(batch_outcome_with_refresh(
            vec![succeeded_path.clone()],
            Vec::new(),
            success_refresh.clone(),
        ))),
        Reply::Batch(Ok(batch_outcome_with_refresh(
            Vec::new(),
            vec![(failed_path.clone(), "payload missing")],
            failure_refresh.clone(),
        ))),
    ]);

    let success = run(execute(succeeded.clone(), &operations, Direction::Redo));
    let failure = run(execute(failed.clone(), &operations, Direction::Redo));

    assert_eq!(success.completed, Some(succeeded));
    assert_eq!(
        success.opposite,
        Some(copy_action(
            succeeded_path.clone(),
            path("restore/success"),
            true,
            Recovery::Capture,
        ))
    );
    assert_refresh_dirs(&success.refresh_dirs, &success_refresh);
    assert_eq!(failure.remaining, Some(failed));
    assert_refresh_dirs(&failure.refresh_dirs, &failure_refresh);
    assert_eq!(
        operations.calls(),
        vec![
            Call::Restore(vec![(succeeded_path, "success-artifact".into())]),
            Call::Restore(vec![(failed_path, "failure-artifact".into())]),
        ]
    );
}

#[test]
fn nested_batch_retains_refresh_effects_and_exact_restore_requests_when_stopped() {
    let restored_path = path("nested/first/restored.txt");
    let blocked_path = path("nested/blocked/missing.txt");
    let restored = copy_action(
        restored_path.clone(),
        path("nested/first"),
        true,
        Recovery::Restore(artifact("nested-first")),
    );
    let blocked = copy_action(
        blocked_path.clone(),
        path("nested/blocked"),
        true,
        Recovery::Restore(artifact("nested-blocked")),
    );
    let nested_later = rename("nested-later");
    let nested = Action::Batch {
        actions: vec![blocked.clone(), nested_later],
        label: "nested restore".into(),
    };
    let outer_later = rename("outer-later");
    let action = Action::Batch {
        actions: vec![restored.clone(), nested.clone(), outer_later.clone()],
        label: "outer restore".into(),
    };
    let first_refresh = path("nested/first");
    let blocked_refresh = path("nested/blocked");
    let operations = FakeOperations::new([
        Reply::Batch(Ok(batch_outcome_with_refresh(
            vec![restored_path.clone()],
            Vec::new(),
            vec![first_refresh.clone()],
        ))),
        Reply::Batch(Ok(batch_outcome_with_refresh(
            Vec::new(),
            vec![(blocked_path.clone(), "restore blocked")],
            vec![blocked_refresh.clone()],
        ))),
    ]);

    let result = run(execute(action, &operations, Direction::Redo));

    assert_eq!(
        result.completed,
        Some(Action::Batch {
            actions: vec![restored.clone()],
            label: "outer restore".into(),
        })
    );
    assert_eq!(
        result.opposite,
        Some(Action::Batch {
            actions: vec![copy_action(
                restored_path.clone(),
                path("nested/first"),
                true,
                Recovery::Capture,
            )],
            label: "outer restore".into(),
        })
    );
    assert_eq!(
        result.remaining,
        Some(Action::Batch {
            actions: vec![nested, outer_later],
            label: "outer restore".into(),
        })
    );
    assert_refresh_dirs(&result.refresh_dirs, &[first_refresh, blocked_refresh]);
    assert_eq!(
        operations.calls(),
        vec![
            Call::Restore(vec![(restored_path, "nested-first".into())]),
            Call::Restore(vec![(blocked_path, "nested-blocked".into())]),
        ]
    );
}

#[test]
fn uncertain_copy_restore_is_consumed_without_inverse_or_retry() {
    let copied_path = path("local/uncertain-copy.txt");
    let action = copy_action(
        copied_path.clone(),
        path("local"),
        true,
        Recovery::Restore(artifact("uncertain-artifact")),
    );
    let mut outcome = batch_outcome(Vec::new(), Vec::new());
    outcome.uncertain.push(FileFailure {
        path: copied_path.clone(),
        error: "restore worker exited".into(),
    });
    let operations = FakeOperations::new([Reply::Batch(Ok(outcome))]);

    let result = run(execute(action.clone(), &operations, Direction::Redo));

    assert_eq!(result.completed, None);
    assert_eq!(result.uncertain, Some(action));
    assert_eq!(result.opposite, None);
    assert_eq!(result.remaining, None);
    assert!(result.error.unwrap().contains("may have completed"));
    assert_eq!(
        operations.calls(),
        vec![Call::Restore(vec![(
            copied_path,
            "uncertain-artifact".into()
        )])]
    );
}

#[test]
fn mixed_batch_keeps_recoverable_rename_when_one_way_copy_is_removed() {
    let rename = rename("recoverable");
    let copied_path = path("network/one-way.txt");
    let copy = copy_action(
        copied_path.clone(),
        path("network"),
        false,
        Recovery::Capture,
    );
    let action = Action::Batch {
        actions: vec![rename.clone(), copy.clone()],
        label: "mixed capability".into(),
    };
    let operations = FakeOperations::new([
        Reply::Batch(Ok(batch_outcome(vec![copied_path.clone()], Vec::new()))),
        Reply::Unit(Ok(())),
    ]);

    let result = run(execute(action.clone(), &operations, Direction::Undo));

    assert_eq!(
        operations.calls(),
        vec![
            Call::TrashMany(vec![copied_path]),
            Call::Rename(
                path("work/recoverable-new.txt"),
                "recoverable-old.txt".into(),
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
