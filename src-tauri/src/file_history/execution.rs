//! Inverse execution with injected file operations and explicit partial progress.
use super::model::{Action, Direction, Execution, Recovery};
use super::plan::{Plan, Prepared, Request};
use crate::diagnostics::Warnings;
use crate::files::trash::FileBatchOutcome;
use crate::files::trash_artifact::RestoreRequest;
use std::{collections::HashSet, future::Future, pin::Pin};

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

pub(crate) struct MoveResult {
    pub result: Result<Option<String>, OperationError>,
    pub warning: Option<String>,
    pub affected: Vec<String>,
}

pub(crate) trait Operations: Sync {
    fn trash_publication(
        &self,
        _publication: std::sync::Arc<crate::files::mutation::PublishedEntry>,
    ) -> impl Future<Output = Result<FileBatchOutcome, OperationError>> + Send {
        async {
            Err(OperationError::Unchanged(
                "Verified copy removal is unavailable on this host".into(),
            ))
        }
    }
    fn replacement(
        &self,
        _history: crate::files::recovery::ReplacementHistory,
        _direction: crate::files::recovery::ReplacementDirection,
    ) -> impl Future<Output = Result<crate::files::recovery::ReplacementOutcome, OperationError>> + Send
    {
        async {
            Err(OperationError::Unchanged(
                "Replacement history is unavailable on this host".into(),
            ))
        }
    }
    fn rename(
        &self,
        path: String,
        name: String,
    ) -> impl Future<Output = Result<(), OperationError>> + Send;
    fn move_entry(
        &self,
        path: String,
        destination: String,
    ) -> impl Future<Output = MoveResult> + Send;
    fn trash_many(
        &self,
        paths: Vec<String>,
    ) -> impl Future<Output = Result<FileBatchOutcome, OperationError>> + Send;
    fn restore(
        &self,
        requests: Vec<RestoreRequest>,
    ) -> impl Future<Output = Result<FileBatchOutcome, OperationError>> + Send;
}

#[cfg(test)]
pub async fn execute(
    action: Action,
    operations: &impl Operations,
    direction: Direction,
) -> Execution {
    execute_prepared(Prepared::new(action, direction), operations).await
}

pub(super) async fn execute_prepared(
    prepared: Prepared,
    operations: &impl Operations,
) -> Execution {
    let (direction, plan) = prepared.into_parts();
    let result = execute_plan(plan, operations, direction).await;
    super::retention::settlement(result, direction)
}

fn execute_plan<'a, O: Operations>(
    plan: Plan,
    operations: &'a O,
    direction: Direction,
) -> Pin<Box<dyn Future<Output = Execution> + Send + 'a>> {
    Box::pin(async move {
        let (action, request) = match plan {
            Plan::Batch { children, label } => {
                return execute_batch(children, label, operations, direction).await
            }
            Plan::Leaf { action, request } => (action, request),
        };
        let request = match request {
            Ok(request) => request,
            Err(error) => return failed(action, error),
        };
        match request {
            Request::Replacement { history, direction } => {
                match operations.replacement(history, direction).await {
                    Ok(outcome) => {
                        let Action::Replacement { path, .. } = &action else {
                            unreachable!("replacement request must retain its native action");
                        };
                        Execution {
                            // A consumed durable record has no opposite: never
                            // offer a Redo whose evidence no longer exists.
                            opposite: outcome.reapplicable.then(|| Action::Replacement {
                                path: path.clone(),
                                recovery: Some(outcome.history),
                            }),
                            completed: Some(action),
                            warnings: outcome.warning.into_iter().collect::<Warnings>().into_vec(),
                            ..Execution::default()
                        }
                    }
                    Err(error) => failed(action, error),
                }
            }
            Request::Rename { path, name } => {
                settled(action, operations.rename(path, name).await, true)
            }
            Request::Move { path, destination } => {
                let outcome = operations.move_entry(path, destination).await;
                let mut execution = match outcome.result {
                    Ok(Some(recovery)) => Execution {
                        // Destination committed; source cleanup is uncertain. Neither
                        // retry nor an opposite can safely assume intact source data.
                        completed: Some(action),
                        error: Some(recovery),
                        ..Execution::default()
                    },
                    Ok(None) => settled(action, Ok(()), true),
                    Err(error) => failed(action, error),
                };
                execution.refresh_dirs = outcome.affected;
                execution.warnings = outcome.warning.into_iter().collect::<Warnings>().into_vec();
                execution
            }
            Request::Trash(paths) => {
                let result = operations.trash_many(paths).await;
                settled_batch(action, result, direction)
            }
            Request::TrashPublication(publication) => {
                let result = operations.trash_publication(publication).await;
                settled_batch(action, result, direction)
            }
            Request::Restore(requests) => {
                let result = operations.restore(requests).await;
                settled_batch(action, result, direction)
            }
        }
    })
}

fn settled_batch(
    action: Action,
    result: Result<FileBatchOutcome, OperationError>,
    direction: Direction,
) -> Execution {
    match result {
        Err(error) => failed(action, error),
        Ok(outcome) => match action {
            Action::Copy { .. } => settled_copy(action, outcome, direction),
            Action::Delete { .. } => settled_delete(action, outcome, direction),
            _ => unreachable!("only copy/delete requests produce batch outcomes"),
        },
    }
}

async fn execute_batch<O: Operations>(
    mut children: Vec<Plan>,
    label: String,
    operations: &O,
    direction: Direction,
) -> Execution {
    if direction == Direction::Undo {
        children.reverse();
    }
    let mut results = Vec::with_capacity(children.len());
    let mut warnings = Warnings::default();
    let mut error = None;
    for child in children {
        let mut result = if error.is_none() {
            execute_plan(child, operations, direction).await
        } else {
            Execution {
                remaining: Some(child.into_action()),
                ..Execution::default()
            }
        };
        if result.error.is_some() {
            error = result.error.take();
        }
        warnings.extend(result.warnings.drain(..));
        results.push(result);
    }
    // Execution order may be reversed, but retained history always keeps the
    // original order. Move each action into its final partition without cloning
    // entire unstarted subtrees at every nesting level.
    if direction == Direction::Undo {
        results.reverse();
    }
    let mut completed = Vec::new();
    let mut uncertain = Vec::new();
    let mut opposite = Vec::new();
    let mut remaining = Vec::new();
    let mut refresh_dirs = std::collections::BTreeSet::new();
    for result in results {
        completed.push(result.completed);
        uncertain.push(result.uncertain);
        opposite.push(result.opposite);
        remaining.push(result.remaining);
        refresh_dirs.extend(result.refresh_dirs);
    }
    Execution {
        completed: batch_action(completed, &label),
        uncertain: batch_action(uncertain, &label),
        opposite: batch_action(opposite, &label),
        remaining: batch_action(remaining, &label),
        error,
        warnings: warnings.into_vec(),
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
        publication,
        ..
    } = &action
    else {
        unreachable!("copy settlement requires a copy action");
    };
    let error = batch_error(&outcome);
    let mut warnings: Warnings = outcome.warning_messages().collect();
    if !outcome.succeeded.contains(copied_path) {
        let message = error.unwrap_or_else(|| "File operation did not complete".into());
        let failure = if outcome.worker_error.is_some()
            || outcome
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
            warnings: warnings.into_vec(),
            ..failed(action, failure)
        };
    }
    let mut recovery = match direction {
        Direction::Redo => Some(Recovery::Capture),
        Direction::Undo if !restore_supported => None,
        Direction::Undo => match outcome.artifacts.get(copied_path) {
            Some(artifact) => Some(Recovery::Restore(artifact.clone())),
            None => {
                warnings.push("Copy was removed, but its exact trash identity is unavailable; Redo is unavailable");
                None
            }
        },
    };
    let publication = if direction == Direction::Redo && publication.is_some() {
        let restored = outcome
            .publications
            .get(copied_path)
            .filter(|entry| {
                entry.path == std::path::Path::new(copied_path)
                    && entry.path.parent() == Some(std::path::Path::new(parent_dir))
            })
            .cloned();
        if restored.is_none() {
            warnings.push("Copy was restored, but its native publication identity is unavailable; Undo is unavailable");
            recovery = None;
        }
        restored
    } else {
        publication.clone()
    };
    let opposite = recovery.map(|recovery| Action::Copy {
        copied_path: copied_path.clone(),
        parent_dir: parent_dir.clone(),
        publication,
        restore_supported: *restore_supported,
        recovery,
    });
    Execution {
        completed: Some(action),
        opposite,
        error,
        warnings: warnings.into_vec(),
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
    let mut warnings: Warnings = outcome.warning_messages().collect();
    let worker_uncertain = outcome.worker_error.is_some();
    let succeeded = outcome.succeeded.into_iter().collect::<HashSet<_>>();
    let uncertain = outcome
        .uncertain
        .into_iter()
        .map(|failure| failure.path)
        .collect::<HashSet<_>>();
    let uncertain_paths: Vec<_> = paths
        .iter()
        .filter(|path| uncertain.contains(*path) || worker_uncertain && !succeeded.contains(*path))
        .cloned()
        .collect();
    let completed_paths: Vec<_> = paths
        .iter()
        .filter(|path| succeeded.contains(*path))
        .cloned()
        .collect();
    let remaining_paths: Vec<_> = paths
        .into_iter()
        .filter(|path| !worker_uncertain && !succeeded.contains(path) && !uncertain.contains(path))
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
                warnings.push("Deletion completed, but some exact recovery identities are unavailable; Undo is unavailable for those items");
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
        warnings: warnings.into_vec(),
        refresh_dirs: outcome.refresh_dirs,
    }
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
    outcome.failure_message()
}

#[cfg(test)]
#[path = "../../test_support/file_history_execution.rs"]
mod tests;
