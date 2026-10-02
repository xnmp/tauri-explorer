//! Trash operations publish confirmed outcomes per path, even on partial failure.
use super::admission::Runtime;
use super::batch::{self, BatchPlan};
pub use super::batch::{FileBatchOutcome, FileFailure};
use super::mutation::PublishedEntry;
use super::trash_artifact::RestoreRequest;
#[cfg(target_os = "windows")]
use super::trash_artifact::TrashSuccess;
use crate::error::AppError;
#[cfg(not(target_os = "linux"))]
use std::path::Path;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use std::path::PathBuf;
use std::sync::Arc;

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
                        publication: None,
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
        batch::run_with_setup_owned(
            (),
            plan,
            |paths| super::freedesktop_trash::Context::new()?.prepare_selection(paths),
            |selection, path, _| selection.execute_next(path),
        )
        .await
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        Ok(batch::run(plan, trash_path).await)
    }
}

/// Forward deletion and trash Redo. Linux holds whole-selection admission
/// until the actual batch worker and its captures finish; renderer retirement
/// does not abandon native-owned work.
pub(crate) async fn delete(
    plan: BatchPlan,
    runtime: &Runtime,
    permanent: bool,
) -> Result<FileBatchOutcome, AppError> {
    #[cfg(target_os = "linux")]
    {
        let paths = Arc::new(plan.paths.clone());
        if permanent {
            // Claims, physical parents and staging names come from one fenced
            // observation; execution binds each receipt to its prepared item.
            return run_prepared(
                plan,
                runtime,
                move || {
                    super::permanent_delete::prepare_selection(Arc::clone(&paths))
                        .map(|selection| selection.into_admission())
                },
                |selection, path, _| selection.execute_next(path),
            )
            .await;
        }
        run_prepared(
            plan,
            runtime,
            move || {
                super::freedesktop_trash::Context::new()?
                    .prepare_selection(Arc::clone(&paths))
                    .map(|selection| selection.into_admission())
            },
            |selection, path, _| selection.execute_next(path),
        )
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = runtime;
        if permanent {
            Ok(
                batch::run_with_receipts(plan, |path, _| {
                    super::file_ops::delete_path_receipt(path)
                })
                .await,
            )
        } else {
            run_batch(plan).await
        }
    }
}

impl super::admission::Settle for Result<FileBatchOutcome, AppError> {
    fn refused(error: AppError) -> Self {
        Err(error)
    }

    // Only a completed batch holds an admission to retire.
    fn unretired(&mut self, error: AppError) {
        if let Ok(result) = self {
            let cleanup = format!("File operation finished, but ownership cleanup failed: {error}");
            result.worker_error = Some(match result.worker_error.take() {
                Some(previous) => format!("{previous}; {cleanup}"),
                None => cleanup,
            });
        }
    }
}

#[cfg(target_os = "linux")]
async fn run_prepared<T: Send + 'static>(
    plan: BatchPlan,
    runtime: &Runtime,
    prepare: impl FnMut() -> Result<(T, Vec<super::recovery::resources::Resource>), AppError>
        + Send
        + 'static,
    mut execute: impl FnMut(
            &mut T,
            &str,
            &batch::DirectoryEffects,
        ) -> Result<super::trash_artifact::TrashSuccess, AppError>
        + Send
        + 'static,
) -> Result<FileBatchOutcome, AppError> {
    if plan.paths.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    super::admission::admitted_prepared(runtime, prepare, |mut prepared, owner| async move {
        Ok(
            batch::run_with_receipts_owned(owner, plan, move |path, effects| {
                execute(&mut prepared, path, effects)
            })
            .await,
        )
    })
    .await
}

fn restore_plan(requests: &[RestoreRequest]) -> Result<BatchPlan, AppError> {
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
    Ok(plan)
}

/// Trash only the exact native object published by an ordinary copy. This
/// inverse is native-owned: callers provide neither a path-only fallback nor a
/// replacement identity reconstructed from presentation metadata.
pub(crate) async fn trash_publication(
    publication: Arc<PublishedEntry>,
    runtime: &Runtime,
) -> Result<FileBatchOutcome, AppError> {
    let paths = Arc::new(vec![publication.path.to_string_lossy().into_owned()]);
    let plan = BatchPlan::new(paths.as_ref().clone()).map_err(AppError::InvalidPath)?;
    #[cfg(target_os = "linux")]
    {
        run_prepared(
            plan,
            runtime,
            move || {
                super::freedesktop_trash::Context::new()?
                    .prepare_publication(Arc::clone(&paths), Arc::clone(&publication))
                    .map(|selection| selection.into_admission())
            },
            |selection, path, _| selection.execute_next(path),
        )
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (publication, plan, runtime);
        Err(AppError::Other(
            "Exact ordinary-copy Undo is unsupported on this platform".into(),
        ))
    }
}

/// Restore only artifacts captured by an accepted native deletion. No inventory
/// or timestamp lookup participates in an inverse.
pub(crate) async fn restore(
    requests: Vec<RestoreRequest>,
    runtime: &Runtime,
) -> Result<FileBatchOutcome, AppError> {
    #[cfg(target_os = "linux")]
    {
        let plan = restore_plan(&requests)?;
        run_prepared(
            plan,
            runtime,
            move || super::freedesktop_trash::restoration::prepare(&requests),
            |selection, path, effects| selection.execute_next(path, effects),
        )
        .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = runtime;
        restore_entries(requests).await
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) async fn restore_entries(
    requests: Vec<RestoreRequest>,
) -> Result<FileBatchOutcome, AppError> {
    let plan = restore_plan(&requests)?;
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
    #[cfg(not(target_os = "windows"))]
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
