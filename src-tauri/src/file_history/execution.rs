//! Inverse execution with injected file operations and explicit partial progress.
use super::model::{Action, Direction, Execution};
use crate::files::trash::FileBatchOutcome;
use std::{collections::HashSet, future::Future, path::Path, pin::Pin};

pub trait Operations: Sync {
    fn rename(&self, path: String, name: String)
        -> impl Future<Output = Result<(), String>> + Send;
    fn move_entry(
        &self,
        path: String,
        destination: String,
    ) -> impl Future<Output = Result<Option<String>, String>> + Send;
    fn trash(&self, path: String) -> impl Future<Output = Result<(), String>> + Send;
    fn trash_many(
        &self,
        paths: Vec<String>,
    ) -> impl Future<Output = Result<FileBatchOutcome, String>> + Send;
    fn restore(
        &self,
        paths: Vec<String>,
    ) -> impl Future<Output = Result<FileBatchOutcome, String>> + Send;
}

pub async fn execute(
    action: Action,
    operations: &impl Operations,
    direction: Direction,
) -> Execution {
    execute_inner(action, operations, direction).await
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
                    Ok((path, destination)) => match operations.move_entry(path, destination).await {
                        Ok(Some(recovery)) => Execution {
                            // The destination committed and the source may
                            // be partially removed. Retrying this Move, or
                            // offering its opposite, can destroy surviving data.
                            completed: Some(action),
                            opposite: None,
                            remaining: None,
                            error: Some(recovery),
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
                ..
            } => match direction {
                Direction::Undo => settled(
                    action.clone(),
                    operations.trash(copied_path.clone()).await,
                    *restore_supported,
                ),
                Direction::Redo if !restore_supported => failed(
                    action,
                    "Cannot redo copy because restoring this item is unsupported".into(),
                ),
                Direction::Redo => match operations.restore(vec![copied_path.clone()]).await {
                    Ok(outcome) if outcome.succeeded.iter().any(|path| path == copied_path) => {
                        settled(action, Ok(()), true)
                    }
                    Ok(outcome) => failed(
                        action,
                        batch_error(&outcome).unwrap_or_else(|| "File was not restored".into()),
                    ),
                    Err(error) => failed(action, error),
                },
            },
            Action::Delete { paths, .. } => {
                let result = match direction {
                    Direction::Undo => operations.restore(paths.clone()).await,
                    Direction::Redo => operations.trash_many(paths.clone()).await,
                };
                match result {
                    Ok(outcome) => settled_delete(action, outcome),
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
    let mut remaining = actions.iter().cloned().map(Some).collect::<Vec<_>>();
    let indices = match direction {
        Direction::Undo => (0..actions.len()).rev().collect::<Vec<_>>(),
        Direction::Redo => (0..actions.len()).collect::<Vec<_>>(),
    };
    let mut error = None;

    for index in indices {
        let result = execute_inner(actions[index].clone(), operations, direction).await;
        completed[index] = result.completed;
        opposite[index] = result.opposite;
        remaining[index] = result.remaining;
        if result.error.is_some() {
            error = result.error;
            break;
        }
    }

    Execution {
        completed: batch_action(completed, &label),
        opposite: batch_action(opposite, &label),
        remaining: batch_action(remaining, &label),
        error,
    }
}

fn settled(action: Action, result: Result<(), String>, has_opposite: bool) -> Execution {
    match result {
        Ok(()) => Execution {
            completed: Some(action.clone()),
            opposite: has_opposite.then_some(action),
            ..Execution::default()
        },
        Err(error) => failed(action, error),
    }
}

fn settled_delete(action: Action, outcome: FileBatchOutcome) -> Execution {
    let Action::Delete { paths, parent_dir } = action else {
        unreachable!("delete settlement requires a delete action");
    };
    let error = batch_error(&outcome);
    let succeeded = outcome.succeeded.into_iter().collect::<HashSet<_>>();
    let completed_paths = paths
        .iter()
        .filter(|path| succeeded.contains(*path))
        .cloned()
        .collect::<Vec<_>>();
    let remaining_paths = paths
        .into_iter()
        .filter(|path| !succeeded.contains(path))
        .collect::<Vec<_>>();
    let has_remaining = !remaining_paths.is_empty();
    let completed = (!completed_paths.is_empty()).then(|| Action::Delete {
        paths: completed_paths,
        parent_dir: parent_dir.clone(),
    });

    Execution {
        opposite: completed.clone(),
        completed,
        remaining: (!remaining_paths.is_empty()).then_some(Action::Delete {
            paths: remaining_paths,
            parent_dir,
        }),
        error: error.or_else(|| has_remaining.then(|| "Some files were not processed".into())),
    }
}

fn failed(action: Action, error: String) -> Execution {
    Execution {
        remaining: Some(action),
        error: Some(error),
        ..Execution::default()
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
    (!outcome.failed.is_empty()).then(|| {
        outcome
            .failed
            .iter()
            .map(|failure| format!("{}: {}", failure.path, failure.error))
            .collect::<Vec<_>>()
            .join("; ")
    })
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
