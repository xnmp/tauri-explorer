//! One worker with progress owned by its asynchronous supervisor.
//! A worker panic cannot erase already settled sibling effects.
mod model;
pub(in crate::files) mod receipts;
use super::trash_artifact::TrashSuccess;
use crate::error::AppError;
pub(crate) use model::BatchPlan;
pub use model::{FileBatchOutcome, FileFailure};
use receipts::{ItemState, Receipts};
use std::sync::{Arc, Mutex};

/// Conservative directory invalidations retained outside the filesystem worker.
/// Register before a syscall so unwinding cannot erase a possible side effect.
#[derive(Clone, Default)]
pub(crate) struct DirectoryEffects(Arc<Mutex<DirectoryEffectState>>);

#[derive(Default)]
struct DirectoryEffectState {
    paths: std::collections::HashSet<String>,
    bytes: usize,
}

impl DirectoryEffects {
    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn before_create(&self, directory: &std::path::Path) -> Result<(), AppError> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        for path in directory.parent().into_iter().chain(Some(directory)) {
            let path = path.to_string_lossy();
            if state.paths.contains(path.as_ref()) {
                continue;
            }
            // Auxiliary paths can amplify a deeply nested batch. Stop before
            // the next syscall rather than dropping invalidations or growing
            // retained memory without a bound.
            if state.paths.len() >= 32_768 || path.len() > 8 * 1024 * 1024 - state.bytes {
                return Err(AppError::Other(
                    "Restore directory reconciliation exceeds its path count or size limit".into(),
                ));
            }
            state.bytes += path.len();
            state.paths.insert(path.into_owned());
        }
        Ok(())
    }

    fn take(&self) -> Vec<String> {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let mut paths: Vec<_> = std::mem::take(&mut state.paths).into_iter().collect();
        state.bytes = 0;
        paths.sort_unstable();
        paths
    }
}

#[derive(Clone)]
struct Ledger {
    paths: Arc<Vec<String>>,
    states: Receipts<TrashSuccess>,
    directories: DirectoryEffects,
}

impl Ledger {
    fn new(plan: BatchPlan) -> Self {
        Self {
            states: Receipts::new(plan.paths.len()),
            paths: Arc::new(plan.paths),
            directories: DirectoryEffects::default(),
        }
    }

    fn execute(
        &self,
        mut operation: impl FnMut(&str, &DirectoryEffects) -> Result<TrashSuccess, AppError>,
    ) {
        // Transient receipt storage only. Native history independently budgets
        // its complete grouped action and both partial-settlement positions.
        let mut artifact_bytes = 0usize;
        for (index, path) in self.paths.iter().enumerate() {
            self.states.begin(index);
            // Do not hold the ledger lock across a syscall or error formatting.
            let state = match operation(path, &self.directories) {
                Ok(mut success) => {
                    if let Some(artifact) = &success.artifact {
                        let bytes = artifact.retained_bytes() + path.len();
                        if bytes > 32 * 1024 * 1024 - artifact_bytes {
                            success.artifact = None;
                            let message = "Deletion completed, but its recovery identity exceeds the batch memory budget; Undo is unavailable for this item";
                            success.warning = Some(match success.warning {
                                Some(warning) => format!("{warning}; {message}"),
                                None => message.into(),
                            });
                        } else {
                            artifact_bytes += bytes;
                        }
                    }
                    if let Some(publication) = &success.publication {
                        let bytes = publication.retained_bytes() + path.len();
                        if bytes > 32 * 1024 * 1024 - artifact_bytes {
                            success.publication = None;
                            let message = "Restoration completed, but its native publication exceeds the batch memory budget; the next Undo is unavailable for this item";
                            success.warning = Some(match success.warning {
                                Some(warning) => format!("{warning}; {message}"),
                                None => message.into(),
                            });
                        } else {
                            artifact_bytes += bytes;
                        }
                    }
                    ItemState::Succeeded(success)
                }
                Err(error @ (AppError::WorkerFailed(_) | AppError::MutationUncertain(_))) => {
                    ItemState::Uncertain(error.to_string())
                }
                Err(error) => ItemState::Failed(error.to_string()),
            };
            let stop = matches!(state, ItemState::Uncertain(_));
            self.states.complete(index, state);
            if stop {
                break;
            }
        }
    }

    /// Setup is read-only, and its captures must be inert when discarded
    /// before execution. Once setup returns, context and operation cleanup are
    /// part of execution and a panic must preserve the settled item receipts.
    fn execute_with_setup<C>(
        &self,
        setup: impl FnOnce() -> Result<C, AppError>,
        operation: impl FnMut(&mut C, &str, &DirectoryEffects) -> Result<TrashSuccess, AppError>,
    ) -> Result<Option<String>, AppError> {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut setup_complete = false;
        let result = catch_unwind(AssertUnwindSafe(|| {
            // Move both captures inside the unwind boundary: cleanup must
            // finish before the supervisor receives a terminal result.
            let mut operation = operation;
            let mut context = setup()?;
            setup_complete = true;
            self.execute(|path, effects| operation(&mut context, path, effects));
            Ok::<(), AppError>(())
        }));
        match result {
            Ok(Ok(())) => Ok(None),
            Ok(Err(error)) => Err(AppError::Other(format!(
                "File batch setup failed before execution: {error}"
            ))),
            Err(panic) if setup_complete => Ok(Some(panic_message(panic))),
            Err(panic) => Err(AppError::Other(format!(
                "File batch setup failed before execution: {}",
                panic_message(panic)
            ))),
        }
    }

    fn settle(self, worker_error: Option<String>) -> FileBatchOutcome {
        let states = self.states.take();
        let mut outcome = model::settle(Arc::unwrap_or_clone(self.paths), states, worker_error);
        outcome.refresh_dirs = self.directories.take();
        outcome
    }
}

pub(crate) async fn run(
    plan: BatchPlan,
    mut operation: impl FnMut(&str) -> Result<(), AppError> + Send + 'static,
) -> FileBatchOutcome {
    run_with_effects(plan, move |path, _| operation(path)).await
}

pub(crate) async fn run_with_effects(
    plan: BatchPlan,
    mut operation: impl FnMut(&str, &DirectoryEffects) -> Result<(), AppError> + Send + 'static,
) -> FileBatchOutcome {
    run_with_receipts(plan, move |path, effects| {
        operation(path, effects).map(|()| TrashSuccess::default())
    })
    .await
}

pub(crate) async fn run_with_receipts(
    plan: BatchPlan,
    operation: impl FnMut(&str, &DirectoryEffects) -> Result<TrashSuccess, AppError> + Send + 'static,
) -> FileBatchOutcome {
    run_with_receipts_owned((), plan, operation).await
}

/// The owner follows the actual worker, including destruction of operation
/// captures. It is not retained only by the cancellable async waiter.
pub(super) async fn run_with_receipts_owned<O: Send + 'static>(
    owner: O,
    plan: BatchPlan,
    operation: impl FnMut(&str, &DirectoryEffects) -> Result<TrashSuccess, AppError> + Send + 'static,
) -> FileBatchOutcome {
    let ledger = Ledger::new(plan);
    let worker_ledger = ledger.clone();
    let job = super::worker::Job::new(owner, move || worker_ledger.execute(operation));
    let worker = tauri::async_runtime::spawn_blocking(move || job.run());
    ledger.settle(worker.await.err().map(|error| error.to_string()))
}

/// One pooled job owns read-only setup, execution, and all capture/context
/// destruction. The context stays on that worker and need not be Send. Use a
/// dedicated worker instead when the context requires a fresh OS thread. Setup
/// receives the ledger's immutable paths, so a prepared context can preserve
/// request identity without cloning every path or inventing its own ordering.
pub(super) async fn run_with_setup_owned<O: Send + 'static, C: 'static>(
    owner: O,
    plan: BatchPlan,
    setup: impl FnOnce(Arc<Vec<String>>) -> Result<C, AppError> + Send + 'static,
    operation: impl FnMut(&mut C, &str, &DirectoryEffects) -> Result<TrashSuccess, AppError>
        + Send
        + 'static,
) -> Result<FileBatchOutcome, AppError> {
    let ledger = Ledger::new(plan);
    let worker_ledger = ledger.clone();
    let job = super::worker::Job::new(owner, move || {
        let paths = Arc::clone(&worker_ledger.paths);
        worker_ledger.execute_with_setup(move || setup(paths), operation)
    });
    let worker = tauri::async_runtime::spawn_blocking(move || job.run());
    let worker_error = match worker.await {
        Ok(completion) => completion?,
        Err(error) => Some(format!("File worker did not report completion: {error}")),
    };
    Ok(ledger.settle(worker_error))
}

/// Thread-affine batch resources are constructed and dropped on one fresh
/// thread. Setup must not mutate files: failure before execution is unchanged.
/// Setup/operation captures must also be inert when dropped before any item
/// starts. Once execution begins, cleanup remains part of the owned worker.
/// No COM object crosses the channel and no async/pool thread blocks on join.
/// After thread spawn, dropping the waiter does not abandon accepted work.
/// Callers own the continuation while it is queued for a worker permit.
#[cfg(any(target_os = "windows", test))]
pub(crate) async fn run_dedicated<C: 'static>(
    plan: BatchPlan,
    setup: impl FnOnce() -> Result<C, AppError> + Send + 'static,
    mut operation: impl FnMut(&mut C, &str) -> Result<(), AppError> + Send + 'static,
) -> Result<FileBatchOutcome, AppError> {
    run_dedicated_receipts(plan, setup, move |context, path| {
        operation(context, path).map(|()| TrashSuccess::default())
    })
    .await
}

#[cfg(any(target_os = "windows", test))]
pub(crate) async fn run_dedicated_receipts<C: 'static>(
    plan: BatchPlan,
    setup: impl FnOnce() -> Result<C, AppError> + Send + 'static,
    operation: impl FnMut(&mut C, &str) -> Result<TrashSuccess, AppError> + Send + 'static,
) -> Result<FileBatchOutcome, AppError> {
    run_dedicated_receipts_owned((), plan, setup, operation).await
}

#[cfg(any(target_os = "windows", test))]
pub(super) async fn run_dedicated_receipts_owned<O: Send + 'static, C: 'static>(
    owner: O,
    plan: BatchPlan,
    setup: impl FnOnce() -> Result<C, AppError> + Send + 'static,
    operation: impl FnMut(&mut C, &str) -> Result<TrashSuccess, AppError> + Send + 'static,
) -> Result<FileBatchOutcome, AppError> {
    // Bundle captures before the permit wait as well: cancelling queued work
    // destroys its setup/operation state before releasing external ownership.
    let job = super::worker::Job::new(owner, (setup, operation));
    // Shell work includes forward deletions and SCM trash as well as the one
    // admitted inverse. Bound actual OS threads independently of those owners.
    static WORKERS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let permit = WORKERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| AppError::Other(format!("File worker admission failed: {error}")))?;
    let ledger = Ledger::new(plan);
    let worker_ledger = ledger.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    // Both the permit and external owner survive setup, effects, and cleanup.
    // A failed spawn drops the same job in work-before-owner order.
    let job = super::worker::Job::new(permit, move || {
        job.run_with(|(setup, mut operation)| {
            let completion = worker_ledger
                .execute_with_setup(setup, move |context, path, _| operation(context, path));
            drop(worker_ledger);
            completion
        })
    });
    std::thread::Builder::new()
        .name("file-shell".into())
        .spawn(move || {
            let completion = job.run();
            let _ = send.send(completion);
        })?;
    let worker_error = match receive.await {
        Ok(completion) => completion?,
        Err(error) => Some(format!("File worker did not report completion: {error}")),
    };
    Ok(ledger.settle(worker_error))
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else {
        "File worker panicked".into()
    }
}

#[cfg(test)]
#[path = "../../../test_support/file_batch_worker.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../test_support/file_batch_dedicated.rs"]
mod dedicated_tests;
