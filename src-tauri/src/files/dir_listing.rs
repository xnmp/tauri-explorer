//! Directory listing with caching and streaming support.
//! Issue: tauri-explorer-jag7, tauri-explorer-3b5s

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use super::{metadata_to_entry, DirectoryListing, FileEntry, FileKind};

// ===================
// Directory Listing Cache
// ===================

struct CachedListing {
    entries: Vec<FileEntry>,
    cached_at: Instant,
}

const CACHE_TTL_SECS: u64 = 5;
const MAX_CACHE_ENTRIES: usize = 50;

static DIR_CACHE: OnceLock<Mutex<HashMap<String, CachedListing>>> = OnceLock::new();

fn get_dir_cache() -> &'static Mutex<HashMap<String, CachedListing>> {
    DIR_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Invalidate cache for a specific directory.
#[tauri::command]
pub fn invalidate_dir_cache(path: String) -> Result<(), AppError> {
    let mut cache = get_dir_cache().lock().unwrap();
    cache.remove(&path);
    Ok(())
}

/// List directory contents.
/// Directories are sorted before files, and items are sorted case-insensitively by name.
#[tauri::command]
pub async fn list_directory(path: String) -> Result<DirectoryListing, AppError> {
    let t_start = std::time::Instant::now();

    // Check cache first
    {
        let cache = get_dir_cache().lock().unwrap();
        if let Some(cached) = cache.get(&path) {
            if cached.cached_at.elapsed().as_secs() < CACHE_TTL_SECS {
                log::debug!("list_directory: cache hit ({} entries)", cached.entries.len());
                return Ok(DirectoryListing {
                    path: path.clone(),
                    entries: cached.entries.clone(),
                    listing_id: None,
                });
            }
        }
    }

    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        return Err(AppError::NotFound(path.clone()));
    }

    if !dir_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", path)));
    }

    let entries = scan_directory_parallel(&dir_path);

    let elapsed = t_start.elapsed();
    if elapsed.as_millis() > 100 {
        log::warn!("Slow directory listing: {} entries in {:?}", entries.len(), elapsed);
    } else {
        log::debug!("list_directory: {} entries in {:?}", entries.len(), elapsed);
    }

    // Update cache
    {
        let mut cache = get_dir_cache().lock().unwrap();
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.retain(|_, v| v.cached_at.elapsed().as_secs() < CACHE_TTL_SECS);
        }
        cache.insert(
            path.clone(),
            CachedListing {
                entries: entries.clone(),
                cached_at: Instant::now(),
            },
        );
    }

    Ok(DirectoryListing {
        path,
        entries,
        listing_id: None,
    })
}

/// Sort entries: directories first, then by name case-insensitively.
fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let a_is_dir = matches!(a.kind, FileKind::Directory);
        let b_is_dir = matches!(b.kind, FileKind::Directory);

        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
}

// ===================
// Streaming Directory Listing
// ===================

/// Event payload for streaming directory entries.
#[derive(Debug, Clone, Serialize)]
pub struct DirectoryEntriesEvent {
    #[serde(rename = "listingId")]
    pub listing_id: u64,
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub done: bool,
    #[serde(rename = "totalCount")]
    pub total_count: usize,
}

/// Registry for active directory listings
static LISTINGS: crate::task_registry::TaskRegistry = crate::task_registry::TaskRegistry::new();

/// Scan a directory using jwalk for parallel metadata reading.
/// Returns entries sorted (directories first, then by name).
fn scan_directory_parallel(dir_path: &PathBuf) -> Vec<FileEntry> {
    let mut entries: Vec<FileEntry> = jwalk::WalkDir::new(dir_path)
        .max_depth(1)
        .skip_hidden(false)
        .into_iter()
        .filter_map(|result| {
            let dir_entry = result.ok()?;
            // Skip the root directory itself
            if dir_entry.depth() == 0 {
                return None;
            }
            let path = dir_entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            Some(metadata_to_entry(&path, &metadata))
        })
        .collect();

    sort_entries(&mut entries);
    entries
}

/// Start streaming directory listing.
/// Returns first batch immediately and emits remaining entries via events.
/// Uses jwalk for parallel metadata reading to avoid blocking on large directories.
#[tauri::command]
pub async fn start_streaming_directory(
    app: AppHandle,
    path: String,
) -> Result<DirectoryListing, AppError> {
    let dir_path = PathBuf::from(&path);
    let batch_size = 100;

    if !dir_path.exists() {
        return Err(AppError::NotFound(path));
    }

    if !dir_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", path)));
    }

    let t_scan_start = std::time::Instant::now();
    let mut all_entries = scan_directory_parallel(&dir_path);
    let t_scan_end = std::time::Instant::now();

    let total_count = all_entries.len();
    #[cfg(debug_assertions)]
    eprintln!(
        "[Perf] dir scan '{}': {} entries, scan+sort={:?}",
        path,
        total_count,
        t_scan_end - t_scan_start,
    );

    if total_count <= batch_size {
        return Ok(DirectoryListing {
            path,
            entries: all_entries,
            listing_id: None,
        });
    }

    let first_batch: Vec<FileEntry> = all_entries.drain(..batch_size).collect();
    let remaining = all_entries;

    let (listing_id, cancelled) = LISTINGS.start();

    let path_clone = path.clone();
    std::thread::spawn(move || {
        let mut offset = batch_size;

        for chunk in remaining.chunks(batch_size) {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }

            let _ = app.emit(
                "directory-entries",
                DirectoryEntriesEvent {
                    listing_id,
                    path: path_clone.clone(),
                    entries: chunk.to_vec(),
                    done: offset + chunk.len() >= total_count,
                    total_count,
                },
            );

            offset += chunk.len();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        LISTINGS.cleanup(listing_id);
    });

    Ok(DirectoryListing {
        path,
        entries: first_batch,
        listing_id: Some(listing_id),
    })
}

/// Cancel an active directory listing.
#[tauri::command]
pub fn cancel_directory_listing(listing_id: u64) -> Result<(), AppError> {
    LISTINGS.cancel(listing_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_list_directory() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("test.txt")).unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(list_directory(
                dir.path().to_string_lossy().to_string(),
            ))
            .unwrap();

        assert_eq!(result.entries.len(), 2);
        assert!(matches!(result.entries[0].kind, FileKind::Directory));
        assert!(matches!(result.entries[1].kind, FileKind::File));
    }
}
