//! File operations module for Tauri commands.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-3b5s, tauri-explorer-9djf.6

pub mod dir_listing;
pub mod external_apps;
pub mod file_ops;

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

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
pub(crate) fn metadata_to_entry(path: &Path, metadata: &fs::Metadata) -> FileEntry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let kind = if metadata.is_dir() {
        FileKind::Directory
    } else {
        FileKind::File
    };

    let size = if metadata.is_dir() { 0 } else { metadata.len() };

    let modified = metadata
        .modified()
        .ok()
        .map(|t| DateTime::<Local>::from(t).format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_default();

    // Check if entry is a symlink (symlink_metadata doesn't follow links)
    let sym_meta = fs::symlink_metadata(path).ok();
    let is_symlink = sym_meta
        .as_ref()
        .map_or(false, |m| m.file_type().is_symlink());
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
