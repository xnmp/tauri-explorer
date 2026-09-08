//! Trash operations publish confirmed outcomes per path, even on partial failure.
use super::batch::{self, BatchPlan};
pub use super::batch::{FileBatchOutcome, FileFailure};
use crate::error::AppError;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// UNC locations have no Recycle Bin. Other paths use the platform trash API.
pub(crate) fn trash_or_remove(path: &Path) -> Result<(), AppError> {
    if super::is_network_share(path) {
        return super::file_ops::remove_entry_at(path)
            .map_err(|error| AppError::MutationUncertain(error.to_string()));
    }
    trash::delete(path).map_err(|error| {
        AppError::MutationUncertain(format!("Moving item to trash did not finish: {error}"))
    })
}

pub(crate) fn trash_path(path: &str) -> Result<(), AppError> {
    let pathbuf = PathBuf::from(path);
    // lstat preserves broken symlinks and reports actual permission/IO errors.
    std::fs::symlink_metadata(&pathbuf)?;
    trash_or_remove(&pathbuf)
}

pub async fn move_to_trash(path: String) -> Result<(), AppError> {
    super::run_blocking(move || trash_path(&path)).await
}

pub async fn move_multiple_to_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    let plan = BatchPlan::new(paths).map_err(AppError::InvalidPath)?;
    Ok(batch::run(plan, trash_path).await)
}

#[cfg(target_os = "linux")]
fn trashed_payload(item: &trash::TrashItem) -> Result<PathBuf, AppError> {
    // Freedesktop TrashItem IDs are the absolute .trashinfo path. The payload
    // has the same stem under the sibling files directory (trash 5.x contract).
    let info = Path::new(&item.id);
    let root = info.parent().and_then(Path::parent);
    match (root, info.file_stem()) {
        (Some(root), Some(name)) => Ok(root.join("files").join(name)),
        _ => Err(AppError::InvalidPath("Invalid trash metadata path".into())),
    }
}

#[cfg(target_os = "linux")]
fn restore_item(item: trash::TrashItem) -> Result<(), AppError> {
    let payload = trashed_payload(&item)?;
    let original = item.original_path();
    std::fs::create_dir_all(&item.original_parent)?;
    // Atomically refuse every existing target, including broken symlinks and
    // empty directories. A check followed by rename can overwrite a racing
    // creation; reserving a placeholder can strand it when the move fails.
    super::publication::rename_noreplace(&payload, &original)?;
    // The payload is already restored. Metadata cleanup cannot turn that
    // durable success into a failed inverse that history would retry.
    if let Err(error) = std::fs::remove_file(&item.id) {
        log::warn!("Restored trash item but could not remove its metadata: {error}");
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn restore_item(item: trash::TrashItem) -> Result<(), AppError> {
    trash::os_limited::restore_all([item]).map_err(|error| {
        AppError::MutationUncertain(format!("Restoring from trash did not finish: {error}"))
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn restore_from_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    let plan = BatchPlan::new(paths).map_err(AppError::InvalidPath)?;
    if plan.paths.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    let paths = plan.paths.clone();
    let mut newest = super::run_blocking(move || {
        use std::collections::{hash_map::Entry, HashMap};
        let items = trash::os_limited::list()
            .map_err(|error| AppError::Other(format!("Failed to list trash: {error}")))?;
        // Index once; repeatedly filtering/sorting the entire bin for every
        // requested path scales poorly for large bins and multi-file undo.
        let requested: HashSet<&Path> = paths.iter().map(Path::new).collect();
        let mut newest: HashMap<PathBuf, trash::TrashItem> = HashMap::new();
        for item in items {
            let original = item.original_path();
            if !requested.contains(original.as_path()) {
                continue;
            }
            // A previously restored payload can leave metadata behind if
            // cleanup failed. Ignore only known-missing payloads; permission
            // and other IO errors must still reach the per-path receipt.
            // lstat intentionally retains broken symlinks as valid payloads.
            #[cfg(target_os = "linux")]
            if trashed_payload(&item).is_ok_and(|payload| {
                std::fs::symlink_metadata(payload)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) {
                continue;
            }
            match newest.entry(original) {
                Entry::Vacant(entry) => {
                    entry.insert(item);
                }
                Entry::Occupied(mut entry) if item.time_deleted > entry.get().time_deleted => {
                    entry.insert(item);
                }
                _ => {}
            }
        }
        Ok(newest)
    })
    .await?;
    Ok(batch::run(plan, move |path| {
        let item = newest
            .remove(Path::new(path))
            .ok_or_else(|| AppError::NotFound(format!("No matching trash item: {path}")))?;
        restore_item(item)
    })
    .await)
}

#[cfg(target_os = "macos")]
pub(crate) async fn restore_from_trash(_paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    Err(AppError::Other(
        "Cannot undo delete on macOS — use Finder to restore from Trash".to_string(),
    ))
}

#[cfg(test)]
#[path = "../../test_support/file_batch_outcomes.rs"]
mod file_batch_outcomes;
