//! Trash operations publish confirmed outcomes per path, even on partial failure.
use super::batch::{self, BatchPlan};
pub use super::batch::{FileBatchOutcome, FileFailure};
use super::trash_artifact::RestoreRequest;
#[cfg(target_os = "windows")]
use super::trash_artifact::TrashSuccess;
use crate::error::AppError;
use std::path::Path;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use std::path::PathBuf;

/// UNC locations have no Recycle Bin. Other paths use the platform trash API.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn trash_or_remove(path: &Path) -> Result<(), AppError> {
    if super::is_network_share(path) {
        return super::file_ops::remove_entry_at(path)
            .map_err(|error| AppError::MutationUncertain(error.to_string()));
    }
    trash::delete(path).map_err(|error| {
        AppError::MutationUncertain(format!("Moving item to trash did not finish: {error}"))
    })
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn trash_path(path: &str) -> Result<(), AppError> {
    let pathbuf = PathBuf::from(path);
    // lstat preserves broken symlinks and reports actual permission/IO errors.
    std::fs::symlink_metadata(&pathbuf)?;
    trash_or_remove(&pathbuf)
}

#[cfg(test)]
pub async fn move_to_trash(path: String) -> Result<(), AppError> {
    let outcome = move_multiple_to_trash(vec![path]).await?;
    if let Some(failure) = outcome.uncertain.into_iter().next() {
        return Err(AppError::MutationUncertain(failure.error));
    }
    if let Some(failure) = outcome.failed.into_iter().next() {
        return Err(AppError::Other(failure.error));
    }
    if outcome.succeeded.len() == 1 {
        Ok(())
    } else {
        Err(AppError::Other("Trash operation was not started".into()))
    }
}

pub async fn move_multiple_to_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    let plan = BatchPlan::new(paths).map_err(AppError::InvalidPath)?;
    run_batch(plan).await
}

pub(crate) async fn run_batch(plan: BatchPlan) -> Result<FileBatchOutcome, AppError> {
    if plan.paths.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    #[cfg(target_os = "windows")]
    {
        batch::run_dedicated_receipts(
            plan,
            super::windows_restore::StaApartment::new,
            |apartment, path| {
                if super::is_network_share(Path::new(path)) {
                    super::file_ops::delete_path(path)?;
                    Ok(TrashSuccess {
                        artifact: None,
                        warning: Some("Permanently deleted from a network share, which has no Recycle Bin; Undo is unavailable for this item".into()),
                    })
                } else {
                    super::windows_restore::delete_item(apartment, Path::new(path))
                }
            },
        )
        .await
    }
    #[cfg(target_os = "linux")]
    {
        let mut context = super::run_blocking(super::freedesktop_trash::Context::new).await?;
        Ok(batch::run_with_receipts(plan, move |path, _| context.trash(Path::new(path))).await)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        Ok(batch::run(plan, trash_path).await)
    }
}

/// Restore only artifacts captured by an accepted native deletion. No inventory
/// or timestamp lookup participates in an inverse.
pub(crate) async fn restore_entries(
    requests: Vec<RestoreRequest>,
) -> Result<FileBatchOutcome, AppError> {
    let plan = BatchPlan::new(
        requests
            .iter()
            .map(|request| request.path.clone())
            .collect(),
    )
    .map_err(AppError::InvalidPath)?;
    if plan.paths.len() != requests.len() {
        return Err(AppError::InvalidPath(
            "A restore batch cannot assign multiple artifacts to one path".into(),
        ));
    }
    if plan.paths.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    let requests: std::collections::HashMap<_, _> = requests
        .into_iter()
        .map(|request| (request.path.clone(), request))
        .collect();
    #[cfg(target_os = "windows")]
    {
        batch::run_dedicated(
            plan,
            super::windows_restore::StaApartment::new,
            move |apartment, path| {
                super::windows_restore::restore_exact(apartment, &requests[path])
            },
        )
        .await
    }
    #[cfg(target_os = "linux")]
    {
        Ok(batch::run_with_effects(plan, move |path, effects| {
            super::freedesktop_trash::restore(&requests[path], effects)
        })
        .await)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (plan, requests);
        Err(AppError::Other(
            "Cannot restore trash on this platform".into(),
        ))
    }
}

#[cfg(test)]
#[path = "../../test_support/file_batch_outcomes.rs"]
mod file_batch_outcomes;
