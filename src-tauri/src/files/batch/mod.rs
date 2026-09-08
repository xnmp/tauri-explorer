//! One blocking worker with progress owned by its asynchronous supervisor.
//! A worker panic cannot erase already settled sibling effects.
mod model;
use crate::error::AppError;
pub(crate) use model::BatchPlan;
use model::ItemState;
pub use model::{FileBatchOutcome, FileFailure};
use std::sync::{Arc, Mutex};

pub(crate) async fn run(
    plan: BatchPlan,
    mut operation: impl FnMut(&str) -> Result<(), AppError> + Send + 'static,
) -> FileBatchOutcome {
    let states = Arc::new(Mutex::new(vec![ItemState::Unstarted; plan.paths.len()]));
    let paths = Arc::new(plan.paths);
    let worker_paths = Arc::clone(&paths);
    let worker_states = Arc::clone(&states);
    let worker = tauri::async_runtime::spawn_blocking(move || {
        for (index, path) in worker_paths.iter().enumerate() {
            worker_states
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
            worker_states
                .lock()
                .unwrap_or_else(|error| error.into_inner())[index] = state;
            if stop {
                break;
            }
        }
    });
    let error = worker.await.err().map(|error| error.to_string());
    let states = std::mem::take(&mut *states.lock().unwrap_or_else(|error| error.into_inner()));
    model::settle(Arc::unwrap_or_clone(paths), states, error)
}

#[cfg(test)]
#[path = "../../../test_support/file_batch_worker.rs"]
mod tests;
