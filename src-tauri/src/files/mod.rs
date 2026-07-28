//! File operations module for Tauri commands.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-3b5s, tauri-explorer-9djf.6

pub mod dir_listing;
pub mod drives;
pub mod external_apps;
pub mod file_ops;
pub mod fs_watcher;
pub mod git_status;
pub mod shortcuts;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// Run a blocking closure on the async runtime's blocking thread pool so
/// heavy filesystem work doesn't stall the main async executor.
pub(crate) async fn run_blocking<T, F>(f: F) -> Result<T, crate::error::AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, crate::error::AppError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => Err(crate::error::AppError::Other(format!(
            "Background task failed: {e}"
        ))),
    }
}

/// File system entry representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified: String, // ISO 8601
    #[serde(default)]
    pub is_symlink: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_empty: Option<bool>,
    /// True when this directory entry is a git repo root: it contains a
    /// `.git` entry (a directory for a normal repo, or a *file* for a
    /// worktree/submodule gitlink). Always `false` for non-directory
    /// entries. `#[serde(default)]` keeps older callers/fixtures that omit
    /// the field compatible.
    #[serde(default)]
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Directory,
}

/// Directory listing response.
///
/// `entries` is an `Arc` so cache hits in `dir_listing` share the cached
/// allocation instead of deep-cloning thousands of `FileEntry`s per call
/// (serde's `rc` feature serializes through the Arc transparently).
#[derive(Debug, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: std::sync::Arc<Vec<FileEntry>>,
    pub listing_id: Option<u64>,
}

/// Convert metadata to FileEntry, detecting symlinks.
///
/// Uses `symlink_metadata` (lstat) to check for symlinks, then follows with
/// `fs::metadata` (stat) only for actual symlinks to get the resolved target info.
/// This avoids redundant syscalls for the common case (non-symlink entries).
pub(crate) fn metadata_to_entry(path: &Path, sym_meta: &fs::Metadata) -> FileEntry {
    metadata_to_entry_with_git_repo_probe(path, sym_meta, true)
}

/// Convert metadata to a file entry, optionally skipping the per-directory
/// `.git` probe used only for folder-icon decoration.
pub(crate) fn metadata_to_entry_with_git_repo_probe(
    path: &Path,
    sym_meta: &fs::Metadata,
    probe_git_repo: bool,
) -> FileEntry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let is_symlink = sym_meta.file_type().is_symlink();

    // For symlinks, follow to get resolved kind/size/modified.
    // For non-symlinks, sym_meta already has the correct values.
    let resolved = if is_symlink {
        fs::metadata(path).ok()
    } else {
        None
    };
    let effective = resolved.as_ref().unwrap_or(sym_meta);

    let kind = if effective.is_dir() {
        FileKind::Directory
    } else if is_symlink && fs::read_dir(path).is_ok() {
        // Windows can't follow WSL/Linux symlinks (LX_SYMLINK reparse tags) via
        // stat, so `fs::metadata` above reports the link itself, not its target.
        // Enumerating the path makes the provider resolve the link: if it lists,
        // the target is a directory. (Cheap — only for symlinks that didn't
        // already resolve to a dir; a non-dir read_dir fails fast.)
        FileKind::Directory
    } else {
        FileKind::File
    };

    // `.git` is checked as either a directory (a normal repo) or a file
    // (worktrees/submodules use a gitlink file). Listings on slow mounts skip
    // this optional decoration probe to avoid a network round-trip per child.
    let is_git_repo =
        probe_git_repo && matches!(kind, FileKind::Directory) && path.join(".git").exists();

    let size = if effective.is_dir() {
        0
    } else {
        effective.len()
    };

    let modified = effective
        .modified()
        .ok()
        .map(|t| {
            DateTime::<Local>::from(t)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        })
        .unwrap_or_default();

    let symlink_target = if is_symlink {
        fs::read_link(path)
            .ok()
            .map(|t| t.to_string_lossy().to_string())
    } else {
        None
    };

    FileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        kind,
        size,
        modified,
        is_symlink,
        symlink_target,
        is_empty: None,
        is_git_repo,
    }
}

/// Convert metadata to FileEntry including the `is_empty` probe. Used only by
/// single-entry call sites (create/rename/copy results) where the extra
/// `read_dir` is trivial and the caller wants the flag resolved immediately.
/// Directory *listings* deliberately skip this — they leave `is_empty` as `None`
/// and let the frontend resolve emptiness lazily via `is_directory_empty` (#129),
/// so a 10k-directory scan doesn't pay 10k `read_dir`s up front.
pub(crate) fn metadata_to_entry_probed(path: &Path, sym_meta: &fs::Metadata) -> FileEntry {
    let mut entry = metadata_to_entry(path, sym_meta);
    fill_is_empty(std::slice::from_mut(&mut entry));
    entry
}

/// Backfill `is_empty` for directory entries in parallel (one `read_dir` per
/// subdirectory). Only [`metadata_to_entry_probed`] uses this now; listings
/// resolve emptiness lazily on the frontend instead (#129).
pub(crate) fn fill_is_empty(entries: &mut [FileEntry]) {
    use rayon::prelude::*;
    entries
        .par_iter_mut()
        .filter(|e| matches!(e.kind, FileKind::Directory) && e.is_empty.is_none())
        .for_each(|e| {
            e.is_empty = Some(fs::read_dir(&e.path).is_ok_and(|mut d| d.next().is_none()));
        });
}

/// Estimate total file count and size for a list of paths.
/// Recursively walks directories. Used for progress estimation before copy/move.
#[derive(Debug, Serialize)]
pub struct SizeEstimate {
    #[serde(rename = "fileCount")]
    pub file_count: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
}
