//! Trash operations publish confirmed outcomes per path, even on partial failure.
use crate::error::AppError;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct FileFailure {
    path: String,
    error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct FileBatchOutcome {
    succeeded: Vec<String>,
    failed: Vec<FileFailure>,
}

impl FileBatchOutcome {
    fn collect(
        paths: Vec<String>,
        mut operation: impl FnMut(&str) -> Result<(), AppError>,
    ) -> Self {
        let mut outcome = Self::default();
        let mut visited = HashSet::with_capacity(paths.len());
        for path in paths {
            if !visited.insert(path.clone()) {
                continue;
            }
            match operation(&path) {
                Ok(()) => outcome.succeeded.push(path),
                Err(error) => outcome.failed.push(FileFailure {
                    path,
                    error: error.to_string(),
                }),
            }
        }
        outcome
    }
}

/// UNC locations have no Recycle Bin. Other paths use the platform trash API.
pub(crate) fn trash_or_remove(path: &Path) -> Result<(), AppError> {
    let text = path.to_string_lossy();
    if text.starts_with("\\\\") || text.starts_with("//") {
        return super::file_ops::remove_entry_at(path);
    }
    trash::delete(path)
        .map_err(|error| AppError::Other(format!("Failed to move to trash: {error}")))
}

fn trash_path(path: &str) -> Result<(), AppError> {
    let pathbuf = PathBuf::from(path);
    // lstat preserves broken symlinks and reports actual permission/IO errors.
    std::fs::symlink_metadata(&pathbuf)?;
    trash_or_remove(&pathbuf)
}

#[tauri::command]
pub async fn move_to_trash(path: String) -> Result<(), AppError> {
    super::run_blocking(move || trash_path(&path)).await
}

#[tauri::command]
pub async fn move_multiple_to_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    super::run_blocking(move || Ok(FileBatchOutcome::collect(paths, trash_path))).await
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
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let payload = trashed_payload(&item)?;
    let original = item.original_path();
    let native_path = |path: &Path| {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| AppError::InvalidPath("Path contains a NUL byte".into()))
    };
    let source = native_path(&payload)?;
    let destination = native_path(&original)?;
    std::fs::create_dir_all(&item.original_parent)?;
    // Atomically refuse every existing target, including broken symlinks and
    // empty directories. A check followed by rename can overwrite a racing
    // creation; reserving a placeholder can strand it when the move fails.
    // SAFETY: both C strings remain alive and NUL-terminated for this call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // The payload is already restored. Metadata cleanup cannot turn that
    // durable success into a failed inverse that history would retry.
    if let Err(error) = std::fs::remove_file(&item.id) {
        log::warn!("Restored trash item but could not remove its metadata: {error}");
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn restore_item(item: trash::TrashItem) -> Result<(), AppError> {
    trash::os_limited::restore_all([item])
        .map_err(|error| AppError::Other(format!("Failed to restore from trash: {error}")))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn restore_from_trash(paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    super::run_blocking(move || {
        use std::collections::{hash_map::Entry, HashMap};
        if paths.is_empty() {
            return Ok(FileBatchOutcome::default());
        }
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
        Ok(FileBatchOutcome::collect(paths, |path| {
            let item = newest
                .remove(Path::new(path))
                .ok_or_else(|| AppError::NotFound(format!("No matching trash item: {path}")))?;
            restore_item(item)
        }))
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn restore_from_trash(_paths: Vec<String>) -> Result<FileBatchOutcome, AppError> {
    Err(AppError::Other(
        "Cannot undo delete on macOS — use Finder to restore from Trash".to_string(),
    ))
}

#[cfg(test)]
#[path = "../../test_support/file_batch_outcomes.rs"]
mod file_batch_outcomes;
