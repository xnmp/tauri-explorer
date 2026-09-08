//! Trash operations publish confirmed outcomes per path, even on partial failure.
use super::batch::{self, BatchPlan};
pub use super::batch::{FileBatchOutcome, FileFailure};
use crate::error::AppError;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use std::collections::HashSet;
#[cfg(not(target_os = "macos"))]
use std::collections::{hash_map::Entry, HashMap};
use std::path::{Path, PathBuf};

/// UNC locations have no Recycle Bin. Other paths use the platform trash API.
fn trash_or_remove(path: &Path) -> Result<(), AppError> {
    if super::is_network_share(path) {
        return super::file_ops::remove_entry_at(path)
            .map_err(|error| AppError::MutationUncertain(error.to_string()));
    }
    trash::delete(path).map_err(|error| {
        AppError::MutationUncertain(format!("Moving item to trash did not finish: {error}"))
    })
}

fn trash_path(path: &str) -> Result<(), AppError> {
    let pathbuf = PathBuf::from(path);
    // lstat preserves broken symlinks and reports actual permission/IO errors.
    std::fs::symlink_metadata(&pathbuf)?;
    trash_or_remove(&pathbuf)
}

#[cfg(not(target_os = "windows"))]
pub async fn move_to_trash(path: String) -> Result<(), AppError> {
    super::run_blocking(move || trash_path(&path)).await
}

#[cfg(target_os = "windows")]
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
        batch::run_dedicated(
            plan,
            super::windows_restore::StaApartment::new,
            |_, path| trash_path(path),
        )
        .await
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(batch::run(plan, trash_path).await)
    }
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

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn restore_item(item: trash::TrashItem) -> Result<(), AppError> {
    trash::os_limited::restore_all([item]).map_err(|error| {
        AppError::MutationUncertain(format!("Restoring from trash did not finish: {error}"))
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn index_restore_items(paths: &[String]) -> Result<HashMap<PathBuf, trash::TrashItem>, AppError> {
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
}

#[cfg(target_os = "windows")]
fn index_restore_items(paths: &[String]) -> Result<HashMap<PathBuf, trash::TrashItem>, AppError> {
    use super::windows_restore::WindowsPathKey;
    use std::cmp::Ordering;

    // The Shell records its canonical spelling while history retains the
    // caller's spelling. Pre-encode once, then use the same Windows ordinal
    // comparison as the completion adapter in O((N + M) log N) comparisons.
    let mut requested: Vec<_> = paths
        .iter()
        .map(|path| {
            let path = PathBuf::from(path);
            (WindowsPathKey::new(&path), path)
        })
        .collect();
    let mut comparison_error = None;
    requested.sort_unstable_by(|(left, _), (right, _)| {
        left.compare(right).unwrap_or_else(|error| {
            comparison_error = Some(error);
            Ordering::Equal
        })
    });
    if let Some(error) = comparison_error.take() {
        return Err(error);
    }
    for pair in requested.windows(2) {
        if pair[0].0.compare(&pair[1].0)? == Ordering::Equal {
            return Err(AppError::InvalidPath(
                "Restore batch contains multiple Windows spellings of the same path".into(),
            ));
        }
    }

    let items = trash::os_limited::list()
        .map_err(|error| AppError::Other(format!("Failed to list trash: {error}")))?;
    let mut newest: HashMap<PathBuf, trash::TrashItem> = HashMap::new();
    for item in items {
        let key = WindowsPathKey::new(&item.original_path());
        let index = requested.binary_search_by(|(requested, _)| {
            requested.compare(&key).unwrap_or_else(|error| {
                comparison_error = Some(error);
                Ordering::Equal
            })
        });
        // Sorting/searching cannot express a fallible comparator. Discard the
        // result on API failure; setup has not executed any restore yet.
        if let Some(error) = comparison_error.take() {
            return Err(error);
        }
        let Ok(index) = index else {
            continue;
        };
        match newest.entry(requested[index].1.clone()) {
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
}

#[cfg(not(target_os = "macos"))]
fn take_restore_item(
    newest: &mut HashMap<PathBuf, trash::TrashItem>,
    path: &str,
) -> Result<trash::TrashItem, AppError> {
    newest
        .remove(Path::new(path))
        .ok_or_else(|| AppError::NotFound(format!("No matching trash item: {path}")))
}

#[cfg(target_os = "windows")]
pub(crate) async fn restore_from_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    let plan = BatchPlan::new(paths).map_err(AppError::InvalidPath)?;
    if plan.paths.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    let requested = plan.paths.clone();
    batch::run_dedicated(
        plan,
        move || {
            // A fresh thread avoids inheriting an incompatible COM apartment from
            // another blocking-pool operation. Initialize before enumerating trash.
            let apartment = super::windows_restore::StaApartment::new()?;
            let newest = index_restore_items(&requested)?;
            Ok((apartment, newest))
        },
        |(apartment, newest), path| {
            super::windows_restore::restore_item(apartment, take_restore_item(newest, path)?)
        },
    )
    .await
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) async fn restore_from_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    let plan = BatchPlan::new(paths).map_err(AppError::InvalidPath)?;
    if plan.paths.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    let requested = plan.paths.clone();
    let mut newest = super::run_blocking(move || index_restore_items(&requested)).await?;
    Ok(batch::run(plan, move |path| {
        restore_item(take_restore_item(&mut newest, path)?)
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

#[cfg(all(test, target_os = "windows"))]
#[path = "../../test_support/windows_restore_index.rs"]
mod windows_index_tests;
