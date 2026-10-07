//! Durable history shared by ordinary and portal processes.
use crate::error::AppError;
mod model;
mod store;
use model::{Mutation, Seed, Snapshot};
async fn access(seed: Option<Seed>, operation: Option<Mutation>) -> Result<Snapshot, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = dirs::data_local_dir()
            .ok_or_else(|| AppError::Other("No history data directory".into()))?
            .join("tauri-explorer");
        std::fs::create_dir_all(&directory).map_err(AppError::Io)?;
        let path = directory.join("history.sqlite");
        store::access(&path, seed, operation).map_err(AppError::Other)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}
#[tauri::command]
pub async fn shared_history_read(seed: Seed) -> Result<Snapshot, AppError> {
    access(Some(seed), None).await
}
#[tauri::command]
pub async fn shared_history_mutate(operation: Mutation) -> Result<(), AppError> {
    access(None, Some(operation)).await.map(|_| ())
}

#[cfg(test)]
#[path = "../../test_support/shared_history.rs"]
mod tests;
