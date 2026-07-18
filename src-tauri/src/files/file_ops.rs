//! File CRUD operations: create, rename, copy, move, delete, symlink, estimate, read/write text.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::{metadata_to_entry_probed, run_blocking, FileEntry, SizeEstimate};
use crate::error::AppError;
use crate::progress::ProgressTracker;
use crate::task_registry::TaskRegistry;
use log;

/// Cancellable copy jobs, keyed by client-generated job id so the frontend can
/// cancel a large copy mid-file while the `copy_entry` invoke is still pending.
static COPY_TASKS: TaskRegistry = TaskRegistry::new();

/// Chunk size for streaming file copies. 1 MiB balances syscall overhead
/// against how promptly a cancellation is observed mid-file.
const COPY_BUF_SIZE: usize = 1024 * 1024;

/// Check whether a path exists without following symlinks, so broken
/// symlinks are still treated as existing entries.
fn entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Validate a user-supplied entry name: must be non-empty and must not
/// contain path separators or traversal components.
fn validate_entry_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidPath("Name cannot be empty".to_string()));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(AppError::InvalidPath(format!(
            "Name cannot contain path separators: {}",
            name
        )));
    }
    if name == "." || name == ".." {
        return Err(AppError::InvalidPath(format!("Invalid name: {}", name)));
    }
    Ok(())
}

/// True when two paths refer to the same filesystem entry.
/// Uses canonicalization; falls back to comparing canonicalized parents and
/// exact file names for paths that can't be canonicalized (e.g. broken symlinks).
fn is_same_entry(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        return ca == cb;
    }
    match (a.parent(), b.parent()) {
        (Some(pa), Some(pb)) => match (fs::canonicalize(pa), fs::canonicalize(pb)) {
            (Ok(ca), Ok(cb)) => ca == cb && a.file_name() == b.file_name(),
            _ => false,
        },
        _ => false,
    }
}

/// Reject copying/moving a directory into itself or one of its descendants.
fn reject_dir_into_itself(source: &Path, dest_dir: &Path) -> Result<(), AppError> {
    if !source.is_dir() {
        return Ok(());
    }
    let dest_inside_source = match (fs::canonicalize(source), fs::canonicalize(dest_dir)) {
        (Ok(canon_src), Ok(canon_dest)) => canon_dest.starts_with(&canon_src),
        // Canonicalization can fail on exotic/virtual filesystems. Fall back
        // to the lexical relationship rather than skipping the guard — the
        // check matters most exactly when the paths are misbehaving.
        _ => dest_dir.starts_with(source),
    };
    if dest_inside_source {
        return Err(AppError::InvalidPath(format!(
            "Cannot copy or move a directory into itself: {}",
            source.display()
        )));
    }
    Ok(())
}

/// Generate a unique hidden staging path inside `dest_dir` for transactional
/// copy/move operations.
fn unique_staging_path(dest_dir: &Path, name: &str) -> PathBuf {
    let pid = std::process::id();
    for counter in 0u64.. {
        let candidate = dest_dir.join(format!(".{}.tmp.{}.{}", name, pid, counter));
        if !entry_exists(&candidate) {
            return candidate;
        }
    }
    unreachable!("exhausted staging path candidates")
}

/// Remove a file, directory tree, or symlink (the link itself, not its target).
pub(crate) fn remove_entry_at(path: &Path) -> Result<(), AppError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
    } else if meta.file_type().is_symlink() {
        #[cfg(windows)]
        fs::remove_file(path).or_else(|_| fs::remove_dir(path))?;
        #[cfg(not(windows))]
        fs::remove_file(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// Copy a file or a directory tree from `source` to `target`, streaming file
/// contents in chunks so a large copy reports byte progress and can be
/// cancelled mid-file via `tracker`. `target` must not exist yet.
///
/// Symlinks are recreated (not followed), matching [`estimate_path_size`]: this
/// keeps progress totals consistent and — crucially — prevents a symlink cycle
/// inside the tree from causing unbounded recursion.
fn copy_recursively(
    source: &Path,
    target: &Path,
    tracker: &mut ProgressTracker,
) -> Result<(), AppError> {
    let meta = fs::symlink_metadata(source)?;
    let file_type = meta.file_type();

    if file_type.is_symlink() {
        tracker.check_cancelled()?;
        let link_target = fs::read_link(source)?;
        recreate_symlink(&link_target, target, source)?;
        // Count the link itself, exactly as estimate_path_size does.
        tracker.advance(meta.len(), source)?;
    } else if file_type.is_dir() {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            tracker.check_cancelled()?;
            copy_recursively(&entry.path(), &target.join(entry.file_name()), tracker)?;
        }
        // Mirror the source directory's permissions onto the copy.
        if let Ok(perms) = fs::metadata(source).map(|m| m.permissions()) {
            let _ = fs::set_permissions(target, perms);
        }
    } else {
        copy_file_streamed(source, target, &meta, tracker)?;
    }
    Ok(())
}

/// Copy a single regular file in `COPY_BUF_SIZE` chunks, advancing `tracker`
/// (progress emit + cancel check) after each chunk. Preserves permissions.
fn copy_file_streamed(
    source: &Path,
    target: &Path,
    source_meta: &fs::Metadata,
    tracker: &mut ProgressTracker,
) -> Result<(), AppError> {
    let mut reader = fs::File::open(source)?;
    let mut writer = fs::File::create(target)?;
    let mut buf = vec![0u8; COPY_BUF_SIZE];
    loop {
        tracker.check_cancelled()?;
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        tracker.advance(n as u64, source)?;
    }
    writer.flush()?;
    // Preserve permission bits (e.g. +x), matching fs::copy semantics.
    let _ = fs::set_permissions(target, source_meta.permissions());
    Ok(())
}

/// Recreate a symlink at `link_path` pointing at `link_target`. `original` is
/// the source link, consulted on Windows to choose the dir/file variant.
fn recreate_symlink(link_target: &Path, link_path: &Path, original: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        let _ = original;
        std::os::unix::fs::symlink(link_target, link_path)?;
    }
    #[cfg(windows)]
    {
        // Choose the symlink kind from what the original resolves to; broken
        // links (metadata fails) fall back to a file symlink.
        let is_dir = fs::metadata(original).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            std::os::windows::fs::symlink_dir(link_target, link_path)?;
        } else {
            std::os::windows::fs::symlink_file(link_target, link_path)?;
        }
    }
    Ok(())
}

/// A tracker that emits nothing and can't be cancelled — for internal copies
/// (cross-device move, overwrite staging) that have no UI job attached.
fn detached_tracker<'a>() -> ProgressTracker<'a> {
    ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None)
}

/// Get the user's home directory.
#[tauri::command]
pub async fn get_home_directory() -> Result<String, AppError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppError::NotFound("Home directory not found".to_string()))
}

/// Create a new directory.
#[tauri::command]
pub async fn create_directory(parent_path: String, name: String) -> Result<FileEntry, AppError> {
    validate_entry_name(&name)?;

    run_blocking(move || {
        let parent = PathBuf::from(&parent_path);
        if !parent.exists() {
            return Err(AppError::NotFound(format!(
                "Parent directory does not exist: {}",
                parent_path
            )));
        }

        let new_path = parent.join(&name);
        if entry_exists(&new_path) {
            return Err(AppError::AlreadyExists(
                new_path.to_string_lossy().to_string(),
            ));
        }

        fs::create_dir(&new_path)?;
        log::info!("Created directory: {:?}", name);

        let metadata = fs::symlink_metadata(&new_path)?;
        Ok(metadata_to_entry_probed(&new_path, &metadata))
    })
    .await
}

/// Create a new empty file (touch). Fails if a file/dir already exists there.
#[tauri::command]
pub async fn create_empty_file(parent_path: String, name: String) -> Result<FileEntry, AppError> {
    validate_entry_name(&name)?;

    run_blocking(move || {
        let parent = PathBuf::from(&parent_path);
        if !parent.exists() {
            return Err(AppError::NotFound(format!(
                "Parent directory does not exist: {}",
                parent_path
            )));
        }

        let new_path = parent.join(&name);
        if entry_exists(&new_path) {
            return Err(AppError::AlreadyExists(
                new_path.to_string_lossy().to_string(),
            ));
        }

        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&new_path)?;
        log::info!("Created empty file: {:?}", name);

        let metadata = fs::symlink_metadata(&new_path)?;
        Ok(metadata_to_entry_probed(&new_path, &metadata))
    })
    .await
}

/// True when renaming only changes the filename's case and both paths refer
/// to the same entry. On case-insensitive filesystems the target appears to
/// exist even though it is the source itself; such renames must be allowed.
fn is_case_only_rename(source: &Path, target: &Path, new_name: &str) -> bool {
    let same_name_ci = source
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase() == new_name.to_lowercase())
        .unwrap_or(false);
    same_name_ci && is_same_entry(source, target)
}

/// Rename a file or directory.
#[tauri::command]
pub async fn rename_entry(path: String, new_name: String) -> Result<FileEntry, AppError> {
    validate_entry_name(&new_name)?;

    run_blocking(move || {
        let source = PathBuf::from(&path);
        if !entry_exists(&source) {
            return Err(AppError::NotFound(path.clone()));
        }

        let parent = source.parent().ok_or_else(|| {
            AppError::InvalidPath(format!("Cannot get parent directory of: {}", path))
        })?;

        let target = parent.join(&new_name);
        if entry_exists(&target) && !is_case_only_rename(&source, &target, &new_name) {
            return Err(AppError::AlreadyExists(
                target.to_string_lossy().to_string(),
            ));
        }

        fs::rename(&source, &target)?;

        let metadata = fs::symlink_metadata(&target)?;
        Ok(metadata_to_entry_probed(&target, &metadata))
    })
    .await
}

/// Generate a unique copy name like "name - Copy.ext" or "name - Copy (2).ext".
fn generate_copy_name(dest_dir: &Path, source_name: &str, is_directory: bool) -> PathBuf {
    // Only split off an extension when the dot isn't the leading character,
    // so dotfiles like ".bashrc" keep their full name as the base.
    let (base_name, extension) = if is_directory {
        (source_name.to_string(), String::new())
    } else if let Some(dot_pos) = source_name.rfind('.').filter(|&p| p > 0) {
        (
            source_name[..dot_pos].to_string(),
            source_name[dot_pos..].to_string(),
        )
    } else {
        (source_name.to_string(), String::new())
    };

    let copy_name = format!("{} - Copy{}", base_name, extension);
    let target = dest_dir.join(&copy_name);
    if !entry_exists(&target) {
        return target;
    }

    for counter in 2..=1000 {
        let copy_name = format!("{} - Copy ({}){}", base_name, counter, extension);
        let target = dest_dir.join(&copy_name);
        if !entry_exists(&target) {
            return target;
        }
    }

    // Last resort: pid-tagged names, re-checked for existence so we never
    // silently pick a name that's already taken.
    let pid = std::process::id();
    for counter in 0u64.. {
        let copy_name = format!("{} - Copy ({}-{}){}", base_name, pid, counter, extension);
        let target = dest_dir.join(&copy_name);
        if !entry_exists(&target) {
            return target;
        }
    }
    unreachable!("exhausted copy name candidates")
}

/// Copy a file or directory.
///
/// If overwrite is true and target exists, replaces the existing entry.
/// When `job_id` is supplied, the copy streams its bytes and emits
/// `copy-progress` events keyed by that id, and can be cancelled mid-file via
/// `cancel_copy` — so a multi-gigabyte single-file copy shows real progress and
/// stays interruptible instead of freezing the operation dialog at 0%.
#[tauri::command]
pub async fn copy_entry(
    app: tauri::AppHandle,
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
    job_id: Option<u64>,
) -> Result<FileEntry, AppError> {
    run_blocking(move || copy_entry_impl(Some(&app), source, dest_dir, overwrite, job_id)).await
}

/// Cancel a running copy job. The pending `copy_entry` call fails with
/// "Copy cancelled" and any partially-written copy is cleaned up.
#[tauri::command]
pub async fn cancel_copy(job_id: u64) {
    COPY_TASKS.cancel(job_id);
}

fn copy_entry_impl(
    app: Option<&tauri::AppHandle>,
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
    job_id: Option<u64>,
) -> Result<FileEntry, AppError> {
    let source_path = PathBuf::from(&source);
    let dest_dir_path = PathBuf::from(&dest_dir);

    if !entry_exists(&source_path) {
        return Err(AppError::NotFound(source.clone()));
    }

    if !dest_dir_path.exists() {
        return Err(AppError::NotFound(format!(
            "Destination directory does not exist: {}",
            dest_dir
        )));
    }

    let source_name = source_path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();

    reject_dir_into_itself(&source_path, &dest_dir_path)?;

    // Register cancellation + size the copy for progress only when a job id is
    // attached; a plain internal copy pays neither the walk nor event overhead.
    let cancelled = job_id.map(|id| COPY_TASKS.start_with_id(id));
    let total_bytes = if cancelled.is_some() {
        let mut fc = 0;
        let mut tb = 0;
        estimate_path_size(&source_path, &mut fc, &mut tb);
        tb
    } else {
        0
    };
    let mut tracker = ProgressTracker::new(
        // Suppress events when there's no job so a plain copy stays silent.
        if job_id.is_some() { app } else { None },
        "copy-progress",
        "Copy cancelled",
        job_id.unwrap_or(0),
        total_bytes,
        cancelled.as_deref(),
    );

    let result = copy_entry_inner(
        &source_path,
        &dest_dir_path,
        &source_name,
        overwrite,
        &source,
        &mut tracker,
    );

    if let Some(id) = job_id {
        COPY_TASKS.cleanup(id);
    }
    result
}

fn copy_entry_inner(
    source_path: &Path,
    dest_dir_path: &Path,
    source_name: &str,
    overwrite: Option<bool>,
    source: &str,
    tracker: &mut ProgressTracker,
) -> Result<FileEntry, AppError> {
    let mut target = dest_dir_path.join(source_name);

    if entry_exists(&target) {
        if overwrite.unwrap_or(false) {
            if is_same_entry(source_path, &target) {
                return Err(AppError::InvalidPath(format!(
                    "Source and destination are the same: {}",
                    source
                )));
            }
            return copy_entry_overwriting(
                source_path,
                dest_dir_path,
                &target,
                source_name,
                tracker,
            );
        } else {
            target = generate_copy_name(dest_dir_path, source_name, source_path.is_dir());
        }
    }

    // On failure or mid-file cancellation, don't leave a half-written copy
    // behind. `target` didn't exist before this call (existence was checked
    // above), so anything present now was created by us.
    if let Err(e) = copy_recursively(source_path, &target, tracker) {
        let _ = remove_entry_at(&target);
        return Err(e);
    }

    log::info!(
        "Copied entry (is_dir={}) overwrite={}",
        source_path.is_dir(),
        overwrite.unwrap_or(false)
    );
    let metadata = fs::symlink_metadata(&target)?;
    Ok(metadata_to_entry_probed(&target, &metadata))
}

/// Overwrite-copy transactionally: stage the copy under a temp name in the
/// destination dir, and only swap it into place (displacing the old target)
/// after the copy fully succeeded. The old target is removed last; on any
/// failure the old target is restored and the staging copy cleaned up.
fn copy_entry_overwriting(
    source: &Path,
    dest_dir: &Path,
    target: &Path,
    source_name: &str,
    tracker: &mut ProgressTracker,
) -> Result<FileEntry, AppError> {
    let staging = unique_staging_path(dest_dir, source_name);
    if let Err(e) = copy_recursively(source, &staging, tracker) {
        let _ = remove_entry_at(&staging);
        return Err(e);
    }

    let displaced = unique_staging_path(dest_dir, source_name);
    if let Err(e) = fs::rename(target, &displaced) {
        let _ = remove_entry_at(&staging);
        return Err(AppError::from(e));
    }
    if let Err(e) = fs::rename(&staging, target) {
        let _ = fs::rename(&displaced, target); // restore the old target
        let _ = remove_entry_at(&staging);
        return Err(AppError::from(e));
    }
    let _ = remove_entry_at(&displaced);

    log::info!("Copied entry over existing target (overwrite=true)");
    let metadata = fs::symlink_metadata(target)?;
    Ok(metadata_to_entry_probed(target, &metadata))
}

/// Move a file or directory.
/// If overwrite is true and target exists, replaces the existing entry.
#[tauri::command]
pub async fn move_entry(
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
) -> Result<FileEntry, AppError> {
    run_blocking(move || move_entry_impl(source, dest_dir, overwrite)).await
}

fn move_entry_impl(
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
) -> Result<FileEntry, AppError> {
    let source_path = PathBuf::from(&source);
    let dest_dir_path = PathBuf::from(&dest_dir);

    if !entry_exists(&source_path) {
        // Debug-format the raw string: multi-file DnD reports "path not
        // found" (#253) and any hidden characters (percent-encoding, CR/LF
        // from uri-list parsing) must be visible in the log.
        log::warn!("move_entry: source does not exist: {source:?} (dest_dir {dest_dir:?})");
        return Err(AppError::NotFound(source.clone()));
    }

    if !dest_dir_path.exists() {
        log::warn!("move_entry: dest dir does not exist: {dest_dir:?} (source {source:?})");
        return Err(AppError::NotFound(format!(
            "Destination directory does not exist: {}",
            dest_dir
        )));
    }

    let source_name = source_path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();

    reject_dir_into_itself(&source_path, &dest_dir_path)?;

    let target = dest_dir_path.join(&source_name);

    // If the target exists, displace it to a temp name (cheap same-dir rename)
    // instead of deleting it; it's only removed after the move succeeds.
    let mut displaced: Option<PathBuf> = None;
    if entry_exists(&target) {
        if !overwrite.unwrap_or(false) {
            return Err(AppError::AlreadyExists(
                target.to_string_lossy().to_string(),
            ));
        }
        if is_same_entry(&source_path, &target) {
            return Err(AppError::InvalidPath(format!(
                "Source and destination are the same: {}",
                source
            )));
        }
        let tmp = unique_staging_path(&dest_dir_path, &source_name);
        fs::rename(&target, &tmp)?;
        displaced = Some(tmp);
    }

    match perform_move(&source_path, &dest_dir_path, &target, &source_name) {
        Ok(()) => {
            if let Some(tmp) = displaced {
                let _ = remove_entry_at(&tmp);
            }
        }
        Err(e) => {
            // Restore the displaced target before reporting the error.
            if let Some(tmp) = displaced {
                let _ = fs::rename(&tmp, &target);
            }
            return Err(e);
        }
    }

    let metadata = fs::symlink_metadata(&target)?;
    Ok(metadata_to_entry_probed(&target, &metadata))
}

/// Move `source` to `target`: rename when possible, staged copy+delete for
/// cross-filesystem moves. `target` must not exist.
fn perform_move(
    source_path: &Path,
    dest_dir_path: &Path,
    target: &Path,
    source_name: &str,
) -> Result<(), AppError> {
    // Raw OS error for a cross-filesystem rename, as a fallback for platforms
    // where std hasn't categorized the code into `ErrorKind::CrossesDevices`.
    // Unix `EXDEV` = 18; Windows `ERROR_NOT_SAME_DEVICE` = 17. `raw_os_error()`
    // returns the Win32 code on Windows, NOT the CRT errno, so the constant
    // must be 17 there — comparing against `libc::EXDEV` would never match.
    #[cfg(unix)]
    const CROSS_DEVICE_ERRNO: i32 = libc::EXDEV;
    #[cfg(windows)]
    const CROSS_DEVICE_ERRNO: i32 = 17;
    #[cfg(not(any(unix, windows)))]
    const CROSS_DEVICE_ERRNO: i32 = -1;

    // Try a simple rename first (works if same filesystem)
    match fs::rename(source_path, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Only fall back to copy+delete for cross-filesystem moves.
            // Other errors (permission denied, etc.) should be returned immediately.
            // `CrossesDevices` (stable since Rust 1.85) is the portable signal;
            // the raw-errno check is a belt-and-suspenders fallback.
            let is_cross_device = e.kind() == std::io::ErrorKind::CrossesDevices
                || e.raw_os_error() == Some(CROSS_DEVICE_ERRNO);
            if !is_cross_device {
                log::warn!("Move failed (not cross-device): {}", e);
                return Err(AppError::Io(e));
            }
            log::info!("Cross-device move detected, falling back to copy+delete");
            // Stage the copy in the destination dir, swap it into place once
            // complete, and only then delete the source.
            let staging = unique_staging_path(dest_dir_path, source_name);
            if let Err(e) = copy_recursively(source_path, &staging, &mut detached_tracker()) {
                let _ = remove_entry_at(&staging);
                return Err(e);
            }
            if let Err(e) = fs::rename(&staging, target) {
                let _ = remove_entry_at(&staging);
                return Err(AppError::from(e));
            }
            remove_entry_at(source_path)?;
            Ok(())
        }
    }
}

/// Read a text file's contents with a size limit (default 1MB).
#[tauri::command]
pub async fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    run_blocking(move || read_text_file_impl(path, max_bytes)).await
}

fn read_text_file_impl(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    let file_path = PathBuf::from(&path);
    let limit = max_bytes.unwrap_or(1_048_576);

    let metadata = match fs::metadata(&file_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(AppError::NotFound(path)),
        Err(e) => return Err(AppError::from(e)),
    };

    // Reject non-regular files (directories, FIFOs, sockets, devices) up
    // front — opening a FIFO for reading would block forever.
    if !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "Not a regular file: {}",
            path
        )));
    }

    if metadata.len() > limit {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "File too large: {} bytes (limit: {})",
                metadata.len(),
                limit
            ),
        )));
    }

    // Read through a limited reader so a file that grows between the size
    // check and the read can't blow past the limit.
    let file = fs::File::open(&file_path)?;
    let mut content = Vec::with_capacity(metadata.len() as usize);
    file.take(limit.saturating_add(1))
        .read_to_end(&mut content)?;
    if content.len() as u64 > limit {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("File too large: exceeds limit of {} bytes", limit),
        )));
    }

    String::from_utf8(content).map_err(|_| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "File contains invalid UTF-8 (likely binary)",
        ))
    })
}

/// Read an image file and return it as a `data:` URI.
///
/// Fallback path for previewing images that the `asset:` protocol can't serve
/// — most notably files on virtual/cloud filesystems (Google Drive, OneDrive)
/// whose placeholder paths the asset server fails to stream. Reading the bytes
/// through a normal `fs` read forces the cloud client to hydrate the file, then
/// we hand the webview a self-contained data URI. Capped at `max_bytes` (default
/// 32 MB) so we don't base64 an enormous file into memory.
#[tauri::command]
pub async fn read_image_data_url(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    run_blocking(move || read_image_data_url_impl(path, max_bytes)).await
}

fn read_image_data_url_impl(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    use base64::Engine as _;

    let file_path = PathBuf::from(&path);
    let limit = max_bytes.unwrap_or(32 * 1024 * 1024);

    let metadata = match fs::metadata(&file_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(AppError::NotFound(path)),
        Err(e) => return Err(AppError::from(e)),
    };
    if !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "Not a regular file: {}",
            path
        )));
    }
    if metadata.len() > limit {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Image too large for preview: {} bytes (limit: {})",
                metadata.len(),
                limit
            ),
        )));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&file_path)?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)?;

    let mime = mime_for_extension(&file_path);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

/// Best-effort image MIME type from a file extension. Defaults to a generic
/// image type so the browser sniffs the actual format.
fn mime_for_extension(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Write text content to a new file.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<FileEntry, AppError> {
    run_blocking(move || {
        let file_path = PathBuf::from(&path);

        if entry_exists(&file_path) {
            return Err(AppError::AlreadyExists(path));
        }

        fs::write(&file_path, content.as_bytes())?;
        let metadata = fs::symlink_metadata(&file_path)?;
        Ok(metadata_to_entry_probed(&file_path, &metadata))
    })
    .await
}

/// Delete a file or directory permanently (not to trash).
#[tauri::command]
pub async fn delete_entry_permanent(path: String) -> Result<(), AppError> {
    run_blocking(move || {
        let file_path = PathBuf::from(&path);

        let meta =
            fs::symlink_metadata(&file_path).map_err(|_| AppError::NotFound(path.clone()))?;

        let is_dir = meta.is_dir();
        remove_entry_at(&file_path)?;

        log::info!("Permanently deleted entry (is_dir={})", is_dir);
        Ok(())
    })
    .await
}

/// Create a symbolic link.
#[tauri::command]
pub async fn create_symlink(target_path: String, link_path: String) -> Result<FileEntry, AppError> {
    run_blocking(move || {
        let target = PathBuf::from(&target_path);
        let link = PathBuf::from(&link_path);

        if !entry_exists(&target) {
            return Err(AppError::NotFound(target_path));
        }

        if entry_exists(&link) {
            return Err(AppError::AlreadyExists(link_path));
        }

        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link)?;

        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &link)?;
            } else {
                std::os::windows::fs::symlink_file(&target, &link)?;
            }
        }

        let metadata = fs::symlink_metadata(&link)?;
        Ok(metadata_to_entry_probed(&link, &metadata))
    })
    .await
}

/// Estimate total file count and size for a list of paths.
#[tauri::command]
pub async fn estimate_size(paths: Vec<String>) -> Result<SizeEstimate, AppError> {
    run_blocking(move || {
        let mut file_count: u64 = 0;
        let mut total_bytes: u64 = 0;

        for path_str in &paths {
            let path = PathBuf::from(path_str);
            if !entry_exists(&path) {
                return Err(AppError::NotFound(path_str.clone()));
            }
            estimate_path_size(&path, &mut file_count, &mut total_bytes);
        }

        Ok(SizeEstimate {
            file_count,
            total_bytes,
        })
    })
    .await
}

/// Batch-check which paths exist on the filesystem.
/// Uses lstat so broken symlinks still count as existing entries.
#[tauri::command]
pub async fn check_paths_exist(paths: Vec<String>) -> Vec<bool> {
    // lstat per path can stall on slow mounts; keep it off the async executor.
    let count = paths.len();
    run_blocking(move || Ok(paths.iter().map(|p| entry_exists(Path::new(p))).collect()))
        .await
        .unwrap_or_else(|_| vec![false; count])
}

/// Walk a path accumulating file count and byte size. Never follows
/// symlinks: a symlink counts as a single entry with the link's own size,
/// so cycles can't cause unbounded recursion.
fn estimate_path_size(path: &Path, file_count: &mut u64, total_bytes: &mut u64) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                estimate_path_size(&entry.path(), file_count, total_bytes);
            }
        }
    } else {
        // Regular files and symlinks (counted as the link itself).
        *file_count += 1;
        *total_bytes += metadata.len();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_create_directory() {
        let dir = tempdir().unwrap();
        let result = block_on(create_directory(
            dir.path().to_string_lossy().to_string(),
            "new_folder".to_string(),
        ))
        .unwrap();

        assert_eq!(result.name, "new_folder");
        assert!(matches!(result.kind, super::super::FileKind::Directory));
        assert!(dir.path().join("new_folder").exists());
    }

    #[test]
    fn test_create_empty_file() {
        let dir = tempdir().unwrap();
        let result = block_on(create_empty_file(
            dir.path().to_string_lossy().to_string(),
            "notes.txt".to_string(),
        ))
        .unwrap();

        assert_eq!(result.name, "notes.txt");
        assert!(matches!(result.kind, super::super::FileKind::File));
        let created = dir.path().join("notes.txt");
        assert!(created.exists());
        assert_eq!(std::fs::metadata(&created).unwrap().len(), 0);
    }

    #[test]
    fn test_create_empty_file_rejects_existing() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("dup.txt")).unwrap();

        let result = block_on(create_empty_file(
            dir.path().to_string_lossy().to_string(),
            "dup.txt".to_string(),
        ));

        assert!(matches!(result, Err(AppError::AlreadyExists(_))));
    }

    #[test]
    fn test_rename_entry() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("old_name.txt");
        File::create(&file_path).unwrap();

        let result = block_on(rename_entry(
            file_path.to_string_lossy().to_string(),
            "new_name.txt".to_string(),
        ))
        .unwrap();

        assert_eq!(result.name, "new_name.txt");
        assert!(!file_path.exists());
        assert!(dir.path().join("new_name.txt").exists());
    }

    // ----- Shared-fixture contract tests (#299) -----
    // Mirror `tests/contract/fs-ops.contract.test.ts` (mock side): both drive
    // the rename/delete scenarios from tests/contract/fixtures/fs_ops.json and
    // assert the same shape + semantics, so mock drift fails one side.

    fn fs_ops_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../tests/contract/fixtures/fs_ops.json"))
            .expect("fixture is valid JSON")
    }

    #[test]
    fn contract_rename_matches_fixture() {
        let fx = fs_ops_fixture();
        let original = fx["rename"]["original"].as_str().unwrap();
        let new_name = fx["rename"]["new_name"].as_str().unwrap();
        let expected_kind = fx["rename"]["expected_kind"].as_str().unwrap();

        let dir = tempdir().unwrap();
        let source = dir.path().join(original);
        fs::write(&source, "x").unwrap();

        let entry = block_on(rename_entry(
            source.to_string_lossy().to_string(),
            new_name.to_string(),
        ))
        .unwrap();

        // Shape: returned entry carries the new name, full new path, and kind.
        assert_eq!(entry.name, new_name);
        assert_eq!(
            entry.path,
            dir.path().join(new_name).to_string_lossy().to_string()
        );
        let kind = match serde_json::to_value(&entry.kind).unwrap() {
            serde_json::Value::String(s) => s,
            other => panic!("kind did not serialize to a string: {other:?}"),
        };
        assert_eq!(kind, expected_kind);

        // Semantics: old name gone, new name present.
        assert!(!source.exists());
        assert!(dir.path().join(new_name).exists());
    }

    #[test]
    fn contract_delete_matches_fixture() {
        let fx = fs_ops_fixture();
        let target = fx["delete"]["target"].as_str().unwrap();

        let dir = tempdir().unwrap();
        let victim = dir.path().join(target);
        fs::write(&victim, "x").unwrap();
        assert!(victim.exists());

        block_on(delete_entry_permanent(victim.to_string_lossy().to_string())).unwrap();

        assert!(!victim.exists(), "deleted entry must leave the directory");
    }

    #[test]
    fn test_generate_copy_name() {
        let dir = tempdir().unwrap();

        let name = generate_copy_name(dir.path(), "test.txt", false);
        assert_eq!(
            name.file_name().unwrap().to_str().unwrap(),
            "test - Copy.txt"
        );

        File::create(&name).unwrap();
        let name2 = generate_copy_name(dir.path(), "test.txt", false);
        assert_eq!(
            name2.file_name().unwrap().to_str().unwrap(),
            "test - Copy (2).txt"
        );
    }

    #[test]
    fn test_generate_copy_name_dotfile() {
        let dir = tempdir().unwrap();

        let name = generate_copy_name(dir.path(), ".bashrc", false);
        assert_eq!(
            name.file_name().unwrap().to_str().unwrap(),
            ".bashrc - Copy"
        );

        File::create(&name).unwrap();
        let name2 = generate_copy_name(dir.path(), ".bashrc", false);
        assert_eq!(
            name2.file_name().unwrap().to_str().unwrap(),
            ".bashrc - Copy (2)"
        );
    }

    #[test]
    fn test_validate_entry_name() {
        assert!(validate_entry_name("normal.txt").is_ok());
        assert!(validate_entry_name(".hidden").is_ok());
        assert!(validate_entry_name("with spaces and (parens)").is_ok());

        assert!(validate_entry_name("").is_err());
        assert!(validate_entry_name("a/b").is_err());
        assert!(validate_entry_name("a\\b").is_err());
        assert!(validate_entry_name("/abs").is_err());
        assert!(validate_entry_name("..").is_err());
        assert!(validate_entry_name(".").is_err());
        assert!(validate_entry_name("../escape").is_err());
    }

    #[test]
    fn test_create_directory_rejects_separators() {
        let dir = tempdir().unwrap();
        let result = block_on(create_directory(
            dir.path().to_string_lossy().to_string(),
            "../evil".to_string(),
        ));
        assert!(matches!(result, Err(AppError::InvalidPath(_))));
    }

    #[test]
    fn test_rename_entry_rejects_traversal() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("victim.txt");
        File::create(&file_path).unwrap();

        let result = block_on(rename_entry(
            file_path.to_string_lossy().to_string(),
            "sub/dir.txt".to_string(),
        ));
        assert!(matches!(result, Err(AppError::InvalidPath(_))));
        assert!(file_path.exists());
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Runtime::new().unwrap().block_on(f)
    }

    #[test]
    fn test_copy_entry_folder_with_files() {
        let dir = tempdir().unwrap();

        let source_dir = dir.path().join("my_folder");
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("file1.txt"), "hello").unwrap();
        fs::write(source_dir.join("file2.txt"), "world").unwrap();
        let sub = source_dir.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("nested.txt"), "nested content").unwrap();

        let dest_dir = dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        let result = copy_entry_impl(
            None,
            source_dir.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
            None,
            None,
        );

        assert!(result.is_ok(), "copy_entry failed: {:?}", result.err());
        let entry = result.unwrap();
        assert_eq!(entry.name, "my_folder");

        let copied = dest_dir.join("my_folder");
        assert!(copied.exists());
        assert!(copied.join("file1.txt").exists());
        assert!(copied.join("file2.txt").exists());
        assert!(copied.join("sub").exists());
        assert!(copied.join("sub/nested.txt").exists());
        assert_eq!(
            fs::read_to_string(copied.join("file1.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn test_copy_entry_folder_same_dir() {
        let dir = tempdir().unwrap();

        let source_dir = dir.path().join("my_folder");
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("file1.txt"), "hello").unwrap();

        let result = copy_entry_impl(
            None,
            source_dir.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
            None,
            None,
        );

        assert!(
            result.is_ok(),
            "copy_entry same dir failed: {:?}",
            result.err()
        );
        let entry = result.unwrap();
        assert_eq!(entry.name, "my_folder - Copy");

        let copied = dir.path().join("my_folder - Copy");
        assert!(copied.exists());
        assert!(copied.join("file1.txt").exists());
    }

    #[test]
    fn test_copy_entry_overwrite_same_path_preserves_source() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("precious.txt");
        fs::write(&file_path, "do not destroy").unwrap();

        // Copy into the file's own parent with overwrite=true: target == source.
        let result = copy_entry_impl(
            None,
            file_path.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
            Some(true),
            None,
        );

        assert!(result.is_err(), "expected same-path copy to error");
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "do not destroy");
    }

    #[test]
    fn test_move_entry_overwrite_same_path_preserves_source() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("precious.txt");
        fs::write(&file_path, "do not destroy").unwrap();

        let result = block_on(move_entry(
            file_path.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
            Some(true),
        ));

        assert!(result.is_err(), "expected same-path move to error");
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "do not destroy");
    }

    #[test]
    fn test_copy_entry_dir_into_own_subdir_rejected() {
        let dir = tempdir().unwrap();
        let source_dir = dir.path().join("outer");
        let inner = source_dir.join("inner");
        fs::create_dir_all(&inner).unwrap();

        let result = copy_entry_impl(
            None,
            source_dir.to_string_lossy().to_string(),
            inner.to_string_lossy().to_string(),
            None,
            None,
        );

        assert!(matches!(result, Err(AppError::InvalidPath(_))));
        assert!(source_dir.exists());
    }

    #[test]
    fn test_copy_entry_overwrite_replaces_target() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("src");
        let dst_dir = dir.path().join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("a.txt"), "new content").unwrap();
        fs::write(dst_dir.join("a.txt"), "old content").unwrap();

        let result = copy_entry_impl(
            None,
            src_dir.join("a.txt").to_string_lossy().to_string(),
            dst_dir.to_string_lossy().to_string(),
            Some(true),
            None,
        );

        assert!(result.is_ok(), "overwrite copy failed: {:?}", result.err());
        assert_eq!(
            fs::read_to_string(dst_dir.join("a.txt")).unwrap(),
            "new content"
        );
        // Source untouched, no staging leftovers.
        assert_eq!(
            fs::read_to_string(src_dir.join("a.txt")).unwrap(),
            "new content"
        );
        let leftovers: Vec<_> = fs::read_dir(&dst_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "staging leftovers: {:?}", leftovers);
    }

    #[test]
    fn test_move_entry_overwrite_replaces_target() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("src");
        let dst_dir = dir.path().join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        fs::write(src_dir.join("a.txt"), "new content").unwrap();
        fs::write(dst_dir.join("a.txt"), "old content").unwrap();

        let result = block_on(move_entry(
            src_dir.join("a.txt").to_string_lossy().to_string(),
            dst_dir.to_string_lossy().to_string(),
            Some(true),
        ));

        assert!(result.is_ok(), "overwrite move failed: {:?}", result.err());
        assert_eq!(
            fs::read_to_string(dst_dir.join("a.txt")).unwrap(),
            "new content"
        );
        assert!(!src_dir.join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn test_delete_broken_symlink() {
        let dir = tempdir().unwrap();
        let link = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("nonexistent"), &link).unwrap();
        assert!(fs::symlink_metadata(&link).is_ok());

        let result = block_on(delete_entry_permanent(link.to_string_lossy().to_string()));
        assert!(
            result.is_ok(),
            "delete broken symlink failed: {:?}",
            result.err()
        );
        assert!(fs::symlink_metadata(&link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_rename_broken_symlink() {
        let dir = tempdir().unwrap();
        let link = dir.path().join("dangling");
        std::os::unix::fs::symlink(dir.path().join("nonexistent"), &link).unwrap();

        let result = block_on(rename_entry(
            link.to_string_lossy().to_string(),
            "renamed_link".to_string(),
        ));
        assert!(
            result.is_ok(),
            "rename broken symlink failed: {:?}",
            result.err()
        );
        assert!(fs::symlink_metadata(dir.path().join("renamed_link")).is_ok());
    }

    #[test]
    fn test_estimate_size() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("file1.txt"), "hello").unwrap();
        fs::write(dir.path().join("file2.txt"), "world!").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir/nested.txt"), "abc").unwrap();

        let result = block_on(estimate_size(vec![dir
            .path()
            .to_string_lossy()
            .to_string()]))
        .unwrap();
        assert_eq!(result.file_count, 3);
        assert_eq!(result.total_bytes, 14);
    }

    #[cfg(unix)]
    #[test]
    fn test_estimate_size_does_not_follow_symlink_cycle() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("file.txt"), "data").unwrap();
        // Cycle: sub/loop -> parent dir
        std::os::unix::fs::symlink(dir.path(), sub.join("loop")).unwrap();

        let result = block_on(estimate_size(vec![dir
            .path()
            .to_string_lossy()
            .to_string()]))
        .unwrap();
        // file.txt + the symlink itself; must terminate.
        assert_eq!(result.file_count, 2);
    }

    #[test]
    fn test_read_text_file_rejects_directory() {
        let dir = tempdir().unwrap();
        let result = block_on(read_text_file(
            dir.path().to_string_lossy().to_string(),
            None,
        ));
        assert!(matches!(result, Err(AppError::InvalidPath(_))));
    }

    // ---- Large / streaming copy hardening (issue #174) ----

    use std::sync::atomic::{AtomicBool, Ordering};

    /// Streaming copy of a multi-chunk file reproduces content byte-for-byte.
    #[test]
    fn test_copy_streams_multichunk_file_exactly() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("big.bin");
        // ~8 MiB + a tail, so several 1 MiB chunks plus a partial one.
        let mut data = vec![0u8; 8 * 1024 * 1024 + 7];
        for (i, b) in data.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        fs::write(&src, &data).unwrap();

        let mut tracker = detached_tracker();
        let dst = dir.path().join("copy.bin");
        copy_recursively(&src, &dst, &mut tracker).unwrap();

        assert_eq!(fs::metadata(&dst).unwrap().len(), data.len() as u64);
        assert_eq!(fs::read(&dst).unwrap(), data);
    }

    /// A cancellation flag set before the copy starts aborts it mid-file
    /// (proves the streaming loop checks the flag, not just between files).
    #[test]
    fn test_copy_cancel_aborts_mid_file() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("big.bin");
        fs::write(&src, vec![1u8; 4 * 1024 * 1024]).unwrap();

        let flag = AtomicBool::new(true); // already cancelled
        let mut tracker =
            ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, Some(&flag));
        let dst = dir.path().join("copy.bin");
        let err = copy_recursively(&src, &dst, &mut tracker).expect_err("cancelled copy must fail");
        assert!(err.to_string().contains("cancelled"), "got: {}", err);
    }

    /// A cancelled/failed copy must not leave a partially-written target.
    #[test]
    fn test_copy_cancel_cleans_up_partial_target() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("src");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("a.bin"), vec![0u8; 2 * 1024 * 1024]).unwrap();
        let dest_dir = dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        let flag = AtomicBool::new(true);
        let mut tracker =
            ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, Some(&flag));
        let err = copy_entry_inner(
            &src_dir,
            &dest_dir,
            "src",
            None,
            &src_dir.to_string_lossy(),
            &mut tracker,
        )
        .expect_err("cancelled copy must fail");
        assert!(err.to_string().contains("cancelled"));
        assert!(
            !dest_dir.join("src").exists(),
            "partial copy should have been cleaned up"
        );
    }

    /// cancel_copy through the registry aborts a copy_entry_impl job.
    #[test]
    fn test_cancel_copy_registry_aborts_job() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("big.bin");
        fs::write(&src, vec![2u8; 6 * 1024 * 1024]).unwrap();
        let dest_dir = dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        // Pre-register + cancel the job id, then bypass the impl's own
        // start_with_id (which would reset the flag) by driving copy_recursively
        // with the registry's flag directly — same pattern archive tests use.
        let job_id = 424_242;
        let flag = COPY_TASKS.start_with_id(job_id);
        flag.store(true, Ordering::Relaxed);
        let mut tracker = ProgressTracker::new(
            None,
            "copy-progress",
            "Copy cancelled",
            job_id,
            0,
            Some(&flag),
        );
        let err = copy_recursively(&src, &dest_dir.join("big.bin"), &mut tracker)
            .expect_err("cancelled copy must fail");
        assert!(err.to_string().contains("cancelled"));
        COPY_TASKS.cleanup(job_id);
    }

    /// A moderately large directory tree copies completely without recursing
    /// unboundedly or losing entries.
    #[test]
    fn test_copy_tree_many_files() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        // 1,500 files across 15 subdirs — enough to exercise the recursive walk
        // while staying fast on CI.
        for d in 0..15 {
            let sub = src.join(format!("dir{d:02}"));
            fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                fs::write(sub.join(format!("f{f:03}.txt")), b"x").unwrap();
            }
        }
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();

        copy_entry_impl(
            None,
            src.to_string_lossy().to_string(),
            dest.to_string_lossy().to_string(),
            None,
            None,
        )
        .unwrap();

        let copied = dest.join("src");
        let mut fc = 0u64;
        let mut tb = 0u64;
        estimate_path_size(&copied, &mut fc, &mut tb);
        assert_eq!(fc, 1500, "all files should be copied");
    }

    /// A symlink cycle inside a copied tree must not cause unbounded recursion:
    /// the link is recreated as a link rather than followed.
    #[cfg(unix)]
    #[test]
    fn test_copy_tree_recreates_symlink_without_following_cycle() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("real.txt"), "real").unwrap();
        // Cycle: src/loop -> src
        std::os::unix::fs::symlink(&src, src.join("loop")).unwrap();

        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        copy_entry_impl(
            None,
            src.to_string_lossy().to_string(),
            dest.to_string_lossy().to_string(),
            None,
            None,
        )
        .expect("copy with symlink cycle must terminate");

        let copied = dest.join("src");
        assert!(copied.join("real.txt").exists());
        let link_meta = fs::symlink_metadata(copied.join("loop")).unwrap();
        assert!(
            link_meta.file_type().is_symlink(),
            "symlink should be recreated, not followed"
        );
    }

    /// Heavy: 1 GiB single-file copy streams without buffering the whole file.
    /// Run manually: `cargo test copy_large_sparse -- --ignored --nocapture`.
    #[test]
    #[ignore = "allocates ~1 GiB of IO; run on demand"]
    fn test_copy_large_sparse_file() {
        use std::io::{Seek, SeekFrom};
        let dir = tempdir().unwrap();
        let src = dir.path().join("huge.bin");
        let size: u64 = 1024 * 1024 * 1024;
        {
            let mut f = fs::File::create(&src).unwrap();
            f.seek(SeekFrom::Start(size - 1)).unwrap();
            f.write_all(&[0u8]).unwrap();
        }
        let dest_dir = dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        let start = std::time::Instant::now();
        copy_entry_impl(
            None,
            src.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
            None,
            None,
        )
        .unwrap();
        eprintln!("1 GiB copy took {:?}", start.elapsed());
        assert_eq!(fs::metadata(dest_dir.join("huge.bin")).unwrap().len(), size);
    }

    /// Heavy: 20k-file tree copy. Run manually with `--ignored --nocapture`.
    #[test]
    #[ignore = "creates 20k files; run on demand"]
    fn test_copy_tree_20k_files() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        for d in 0..40 {
            let sub = src.join(format!("dir{d:02}"));
            fs::create_dir_all(&sub).unwrap();
            for f in 0..500 {
                fs::write(sub.join(format!("f{f:03}.txt")), b"x").unwrap();
            }
        }
        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let start = std::time::Instant::now();
        copy_entry_impl(
            None,
            src.to_string_lossy().to_string(),
            dest.to_string_lossy().to_string(),
            None,
            None,
        )
        .unwrap();
        eprintln!("20k-file tree copy took {:?}", start.elapsed());
        let mut fc = 0u64;
        let mut tb = 0u64;
        estimate_path_size(&dest.join("src"), &mut fc, &mut tb);
        assert_eq!(fc, 20_000);
    }
}
