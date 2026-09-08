//! One worker with progress owned by its asynchronous supervisor.
//! A worker panic cannot erase already settled sibling effects.
mod model;
use crate::error::AppError;
pub(crate) use model::BatchPlan;
use model::ItemState;
pub use model::{FileBatchOutcome, FileFailure};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Ledger {
    paths: Arc<Vec<String>>,
    states: Arc<Mutex<Vec<ItemState>>>,
}

impl Ledger {
    fn new(plan: BatchPlan) -> Self {
        Self {
            states: Arc::new(Mutex::new(vec![ItemState::Unstarted; plan.paths.len()])),
            paths: Arc::new(plan.paths),
        }
    }

    fn execute(&self, mut operation: impl FnMut(&str) -> Result<(), AppError>) {
        for (index, path) in self.paths.iter().enumerate() {
            self.states
                .lock()
                .unwrap_or_else(|error| error.into_inner())[index] = ItemState::Active;
            // Do not hold the ledger lock across a syscall or error formatting.
            let state = match operation(path) {
                Ok(()) => ItemState::Succeeded,
                Err(error @ (AppError::WorkerFailed(_) | AppError::MutationUncertain(_))) => {
                    ItemState::Uncertain(error.to_string())
                }
                Err(error) => ItemState::Failed(error.to_string()),
            };
            let stop = matches!(state, ItemState::Uncertain(_));
            self.states
                .lock()
                .unwrap_or_else(|error| error.into_inner())[index] = state;
            if stop {
                break;
            }
        }
    }

    fn settle(self, worker_error: Option<String>) -> FileBatchOutcome {
        let states = std::mem::take(
            &mut *self
                .states
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        model::settle(Arc::unwrap_or_clone(self.paths), states, worker_error)
    }
}

pub(crate) async fn run(
    plan: BatchPlan,
    operation: impl FnMut(&str) -> Result<(), AppError> + Send + 'static,
) -> FileBatchOutcome {
    let ledger = Ledger::new(plan);
    let worker_ledger = ledger.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || worker_ledger.execute(operation));
    ledger.settle(worker.await.err().map(|error| error.to_string()))
}

/// Thread-affine batch resources are constructed and dropped on one fresh
/// thread. Setup must not mutate files: failure before execution is unchanged.
/// No COM object crosses the channel and no async/pool thread blocks on join.
/// After thread spawn, dropping the waiter does not abandon accepted work.
/// Callers own the continuation while it is queued for a worker permit.
#[cfg(any(target_os = "windows", test))]
pub(crate) async fn run_dedicated<C: 'static>(
    plan: BatchPlan,
    setup: impl FnOnce() -> Result<C, AppError> + Send + 'static,
    mut operation: impl FnMut(&mut C, &str) -> Result<(), AppError> + Send + 'static,
) -> Result<FileBatchOutcome, AppError> {
    use std::panic::{catch_unwind, AssertUnwindSafe};
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
    std::thread::Builder::new()
        .name("file-shell".into())
        .spawn(move || {
            // Keep the slot with accepted work even if its waiter disappears.
            let _permit = permit;
            let completion = match catch_unwind(AssertUnwindSafe(setup)) {
                Ok(Ok(context)) => {
                    // Own context within the unwind boundary so its destructor
                    // also runs here before publishing the terminal outcome.
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        let mut context = context;
                        worker_ledger.execute(|path| operation(&mut context, path));
                    }));
                    Ok(result.err().map(panic_message))
                }
                Ok(Err(error)) => Err(AppError::Other(format!(
                    "File batch setup failed before execution: {error}"
                ))),
                Err(panic) => Err(AppError::Other(format!(
                    "File batch setup failed before execution: {}",
                    panic_message(panic)
                ))),
            };
            drop(worker_ledger);
            let _ = send.send(completion);
        })?;
    let worker_error = match receive.await {
        Ok(completion) => completion?,
        Err(error) => Some(format!("File worker did not report completion: {error}")),
    };
    Ok(ledger.settle(worker_error))
}

#[cfg(any(target_os = "windows", test))]
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
