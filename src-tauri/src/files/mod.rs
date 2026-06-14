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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Directory,
}

/// Directory listing response.
#[derive(Debug, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub listing_id: Option<u64>,
}

/// Convert metadata to FileEntry, detecting symlinks.
///
/// Uses `symlink_metadata` (lstat) to check for symlinks, then follows with
/// `fs::metadata` (stat) only for actual symlinks to get the resolved target info.
/// This avoids redundant syscalls for the common case (non-symlink entries).
pub(crate) fn metadata_to_entry(path: &Path, sym_meta: &fs::Metadata) -> FileEntry {
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
    } else {
        FileKind::File
    };

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

    let is_empty = if effective.is_dir() {
        Some(fs::read_dir(path).is_ok_and(|mut d| d.next().is_none()))
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
        is_empty,
    }
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
