//! Inverse execution with injected file operations and explicit partial progress.
use super::model::{Action, Direction, Execution, Recovery};
use crate::files::trash::FileBatchOutcome;
use crate::files::trash_artifact::RestoreRequest;
use std::{collections::HashSet, future::Future, path::Path, pin::Pin};

#[derive(Debug)]
pub enum OperationError {
    Unchanged(String),
    Uncertain(String),
}
impl From<String> for OperationError {
    fn from(error: String) -> Self {
        Self::Unchanged(error)
    }
}

pub trait Operations: Sync {
    fn rename(
        &self,
        path: String,
        name: String,
    ) -> impl Future<Output = Result<(), OperationError>> + Send;
    fn move_entry(
        &self,
        path: String,
        destination: String,
    ) -> impl Future<Output = Result<Option<String>, OperationError>> + Send;
    fn trash_many(
        &self,
        paths: Vec<String>,
    ) -> impl Future<Output = Result<FileBatchOutcome, OperationError>> + Send;
    fn restore(
        &self,
        requests: Vec<RestoreRequest>,
    ) -> impl Future<Output = Result<FileBatchOutcome, OperationError>> + Send;
}

pub async fn execute(
    action: Action,
    operations: &impl Operations,
    direction: Direction,
) -> Execution {
    let result = execute_inner(action, operations, direction).await;
    super::retention::settlement(result, direction)
}

fn execute_inner<'a, O: Operations>(
    action: Action,
    operations: &'a O,
    direction: Direction,
) -> Pin<Box<dyn Future<Output = Execution> + Send + 'a>> {
    Box::pin(async move {
        if let Action::Batch { actions, label } = action {
            return execute_batch(actions, label, operations, direction).await;
        }

        match &action {
            Action::Rename {
                path,
                old_name,
                new_name,
            } => {
                let request = match direction {
                    Direction::Undo => Ok((path.clone(), old_name.clone())),
                    Direction::Redo => {
                        parent(path).map(|parent| (join(&parent, old_name), new_name.clone()))
                    }
                };
                match request {
                    Ok((path, name)) => {
                        settled(action.clone(), operations.rename(path, name).await, true)
                    }
                    Err(error) => failed(action, error),
                }
            }
            Action::Move {
                dest_path,
                original_dir,
                ..
            } => {
                let request = match direction {
                    Direction::Undo => Ok((dest_path.clone(), original_dir.clone())),
                    Direction::Redo => file_name(dest_path).and_then(|name| {
                        parent(dest_path)
                            .map(|destination| (join(original_dir, &name), destination))
                    }),
                };
                match request {
                    Ok((path, destination)) => match operations.move_entry(path, destination).await
                    {
                        Ok(Some(recovery)) => Execution {
                            // The destination committed and the source may
                            // be partially removed. Retrying this Move, or
                            // offering its opposite, can destroy surviving data.
                            completed: Some(action),
                            uncertain: None,
                            opposite: None,
                            remaining: None,
                            error: Some(recovery),
                            ..Execution::default()
                        },
                        Ok(None) => settled(action, Ok(()), true),
                        Err(error) => failed(action, error),
                    },
                    Err(error) => failed(action, error),
                }
            }
            Action::Copy {
                copied_path,
                restore_supported,
                recovery,
                ..
            } => {
                let result = match (direction, recovery) {
                    (Direction::Undo, Recovery::Capture) => {
                        operations.trash_many(vec![copied_path.clone()]).await
                    }
                    (Direction::Redo, Recovery::Restore(artifact)) if *restore_supported => {
                        operations
                            .restore(vec![RestoreRequest {
                                path: copied_path.clone(),
                                artifact: artifact.clone(),
                            }])
                            .await
                    }
                    (Direction::Redo, _) if !restore_supported => Err(OperationError::Unchanged(
                        "Cannot redo copy because restoring this item is unsupported".into(),
                    )),
                    _ => Err(OperationError::Unchanged(
                        "Copy history has no exact recovery identity for this direction".into(),
                    )),
                };
                match result {
                    Ok(outcome) => settled_copy(action, outcome, direction),
                    Err(error) => failed(action, error),
                }
            }
            Action::Delete {
                paths, recovery, ..
            } => {
                let result = match (direction, recovery) {
                    (Direction::Undo, Recovery::Restore(artifacts)) => {
                        let requests = paths
                            .iter()
                            .map(|path| {
                                artifacts
                                    .get(path)
                                    .map(|artifact| RestoreRequest {
                                        path: path.clone(),
                                        artifact: artifact.clone(),
                                    })
                                    .ok_or_else(|| {
                                        OperationError::Unchanged(format!(
                                            "No exact recovery identity for {path}"
                                        ))
                                    })
                            })
                            .collect::<Result<Vec<_>, _>>();
                        match requests {
                            Ok(requests) => operations.restore(requests).await,
                            Err(error) => Err(error),
                        }
                    }
                    (Direction::Redo, Recovery::Capture) => {
                        operations.trash_many(paths.clone()).await
                    }
                    _ => Err(OperationError::Unchanged(
                        "Delete history has no exact recovery identity for this direction".into(),
                    )),
                };
                match result {
                    Ok(outcome) => settled_delete(action, outcome, direction),
                    Err(error) => failed(action, error),
                }
            }
            Action::Batch { .. } => unreachable!("batch actions execute before leaf dispatch"),
        }
    })
}

async fn execute_batch<O: Operations>(
    actions: Vec<Action>,
    label: String,
    operations: &O,
    direction: Direction,
) -> Execution {
    let mut completed = vec![None; actions.len()];
    let mut opposite = vec![None; actions.len()];
    let mut uncertain = vec![None; actions.len()];
    let mut remaining = actions.iter().cloned().map(Some).collect::<Vec<_>>();
    let indices = match direction {
        Direction::Undo => (0..actions.len()).rev().collect::<Vec<_>>(),
        Direction::Redo => (0..actions.len()).collect::<Vec<_>>(),
    };
    let mut error = None;
    let mut refresh_dirs = std::collections::BTreeSet::new();

    for index in indices {
        let result = execute_inner(actions[index].clone(), operations, direction).await;
        completed[index] = result.completed;
        uncertain[index] = result.uncertain;
        opposite[index] = result.opposite;
        remaining[index] = result.remaining;
        refresh_dirs.extend(result.refresh_dirs);
        if result.error.is_some() {
            error = result.error;
            break;
        }
    }

    Execution {
        completed: batch_action(completed, &label),
        uncertain: batch_action(uncertain, &label),
        opposite: batch_action(opposite, &label),
        remaining: batch_action(remaining, &label),
        error,
        refresh_dirs: refresh_dirs.into_iter().collect(),
    }
}

fn settled(action: Action, result: Result<(), OperationError>, has_opposite: bool) -> Execution {
    match result {
        Ok(()) => Execution {
            completed: Some(action.clone()),
            opposite: has_opposite.then_some(action),
            ..Execution::default()
        },
        Err(error) => failed(action, error),
    }
}

fn settled_copy(action: Action, outcome: FileBatchOutcome, direction: Direction) -> Execution {
    let Action::Copy {
        copied_path,
        parent_dir,
        restore_supported,
        ..
    } = &action
    else {
        unreachable!("copy settlement requires a copy action");
    };
    let mut error = batch_error(&outcome);
    if !outcome.succeeded.contains(copied_path) {
        let message = error.unwrap_or_else(|| "File operation did not complete".into());
        let failure = if outcome
            .uncertain
            .iter()
            .any(|failure| &failure.path == copied_path)
        {
            OperationError::Uncertain(message)
        } else {
            OperationError::Unchanged(message)
        };
        return Execution {
            refresh_dirs: outcome.refresh_dirs,
            ..failed(action, failure)
        };
    }
    let recovery = match direction {
        Direction::Redo => Some(Recovery::Capture),
        Direction::Undo if !restore_supported => None,
        Direction::Undo => match outcome.artifacts.get(copied_path) {
            Some(artifact) => Some(Recovery::Restore(artifact.clone())),
            None => {
                error = with_warning(error, "Copy was removed, but its exact trash identity is unavailable; Redo is unavailable");
                None
            }
        },
    };
    let opposite = recovery.map(|recovery| Action::Copy {
        copied_path: copied_path.clone(),
        parent_dir: parent_dir.clone(),
        restore_supported: *restore_supported,
        recovery,
    });
    Execution {
        completed: Some(action),
        opposite,
        error,
        refresh_dirs: outcome.refresh_dirs,
        ..Execution::default()
    }
}

fn settled_delete(action: Action, outcome: FileBatchOutcome, direction: Direction) -> Execution {
    let Action::Delete {
        paths,
        parent_dir,
        recovery,
    } = action
    else {
        unreachable!("delete settlement requires a delete action");
    };
    let mut error = batch_error(&outcome);
    let succeeded = outcome.succeeded.into_iter().collect::<HashSet<_>>();
    let uncertain = outcome
        .uncertain
        .into_iter()
        .map(|failure| failure.path)
        .collect::<HashSet<_>>();
    let uncertain_paths: Vec<_> = paths
        .iter()
        .filter(|path| uncertain.contains(*path))
        .cloned()
        .collect();
    let completed_paths: Vec<_> = paths
        .iter()
        .filter(|path| succeeded.contains(*path))
        .cloned()
        .collect();
    let remaining_paths: Vec<_> = paths
        .into_iter()
        .filter(|path| !succeeded.contains(path) && !uncertain.contains(path))
        .collect();
    let subset =
        |paths: Vec<String>, phase: &Recovery<std::sync::Arc<super::model::RestoreArtifacts>>| {
            (!paths.is_empty()).then(|| Action::Delete {
                recovery: phase.subset(&paths),
                paths,
                parent_dir: parent_dir.clone(),
            })
        };
    let opposite = match direction {
        Direction::Undo => subset(completed_paths.clone(), &Recovery::Capture),
        Direction::Redo => {
            let recoverable: Vec<_> = completed_paths
                .iter()
                .filter(|path| outcome.artifacts.contains_key(*path))
                .cloned()
                .collect();
            if recoverable.len() != completed_paths.len() {
                error = with_warning(error, "Deletion completed, but some exact recovery identities are unavailable; Undo is unavailable for those items");
            }
            subset(
                recoverable,
                &Recovery::Restore(std::sync::Arc::new(outcome.artifacts)),
            )
        }
    };
    if !remaining_paths.is_empty() && error.is_none() {
        error = Some("Some files were not processed".into());
    }
    Execution {
        completed: subset(completed_paths, &recovery),
        uncertain: subset(uncertain_paths, &recovery),
        remaining: subset(remaining_paths, &recovery),
        opposite,
        error,
        refresh_dirs: outcome.refresh_dirs,
    }
}

fn with_warning(error: Option<String>, warning: &str) -> Option<String> {
    Some(match error {
        Some(error) => format!("{error}; {warning}"),
        None => warning.into(),
    })
}

fn failed(action: Action, error: impl Into<OperationError>) -> Execution {
    match error.into() {
        OperationError::Unchanged(error) => Execution {
            remaining: Some(action), error: Some(error), ..Execution::default()
        },
        OperationError::Uncertain(error) => Execution {
            uncertain: Some(action),
            error: Some(format!("The file operation may have completed. Inspect the affected files before continuing: {error}")),
            ..Execution::default()
        },
    }
}

fn batch_action(actions: Vec<Option<Action>>, label: &str) -> Option<Action> {
    let actions = actions.into_iter().flatten().collect::<Vec<_>>();
    (!actions.is_empty()).then(|| Action::Batch {
        actions,
        label: label.into(),
    })
}

fn batch_error(outcome: &FileBatchOutcome) -> Option<String> {
    outcome.error()
}

fn parent(path: &str) -> Result<String, String> {
    Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid file history path: {path}"))
}

fn file_name(path: &str) -> Result<String, String> {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| format!("Invalid file history path: {path}"))
}

fn join(parent: &str, name: &str) -> String {
    Path::new(parent).join(name).to_string_lossy().into_owned()
}

#[cfg(test)]
#[path = "../../test_support/file_history_execution.rs"]
mod tests;
