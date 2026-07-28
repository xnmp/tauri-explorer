//! Directory listing with caching and streaming support.
//! Issue: tauri-explorer-jag7, tauri-explorer-3b5s

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

use super::{metadata_to_entry, DirectoryListing, FileEntry, FileKind};
use crate::error::AppError;

// ===================
// Directory Listing Cache
// ===================

struct CachedListing {
    entries: Arc<Vec<FileEntry>>,
    cached_at: Instant,
}

const CACHE_TTL_SECS: u64 = 5;
const MAX_CACHE_ENTRIES: usize = 50;

static DIR_CACHE: OnceLock<Mutex<HashMap<String, CachedListing>>> = OnceLock::new();

fn get_dir_cache() -> &'static Mutex<HashMap<String, CachedListing>> {
    DIR_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Invalidate cache for a specific directory (internal sync helper, callable
/// from non-async contexts like the filesystem watcher callback).
pub(crate) fn invalidate_dir_cache_sync(path: &str) {
    if let Ok(mut cache) = get_dir_cache().lock() {
        cache.remove(path);
    }
}

/// Invalidate cache for a specific directory.
#[tauri::command]
pub async fn invalidate_dir_cache(path: String) -> Result<(), AppError> {
    invalidate_dir_cache_sync(&path);
    Ok(())
}

/// Returns true when the directory has no entries visible under the given
/// `include_hidden` rule. Skips directories the caller can't read (returns
/// false so a folder isn't optimistically hidden).
#[tauri::command]
pub async fn is_directory_empty(path: String, include_hidden: bool) -> Result<bool, AppError> {
    // read_dir is blocking work; keep it off the async executor.
    super::run_blocking(move || {
        let dir_path = PathBuf::from(&path);
        let read = match fs::read_dir(&dir_path) {
            Ok(r) => r,
            Err(_) => return Ok(false),
        };
        for entry in read.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if !include_hidden && name_str.starts_with('.') {
                continue;
            }
            return Ok(false);
        }
        Ok(true)
    })
    .await
}

/// List directory contents.
/// Directories are sorted before files, and items are sorted case-insensitively by name.
#[tauri::command]
pub async fn list_directory(path: String) -> Result<DirectoryListing, AppError> {
    let t_start = std::time::Instant::now();

    // Check cache first
    {
        let cache = get_dir_cache()
            .lock()
            .map_err(|e| AppError::Other(format!("dir cache lock poisoned: {e}")))?;
        if let Some(cached) = cache.get(&path) {
            if cached.cached_at.elapsed().as_secs() < CACHE_TTL_SECS {
                log::debug!(
                    "list_directory: cache hit ({} entries)",
                    cached.entries.len()
                );
                return Ok(DirectoryListing {
                    path: path.clone(),
                    entries: Arc::clone(&cached.entries),
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

    // jwalk + per-entry stat calls are blocking work; keep them off the async
    // executor. `is_empty` is left unresolved (`None`) here: probing it costs one
    // `read_dir` per subdirectory (~2-3x the listing syscalls in folder-heavy
    // directories) purely to dim empty-folder icons. The frontend resolves
    // emptiness lazily for visible directories via `is_directory_empty` (#129);
    // Miller columns already do their own on-demand probing.
    let entries =
        Arc::new(super::run_blocking(move || Ok(scan_directory_parallel(&dir_path))).await?);

    let elapsed = t_start.elapsed();
    if elapsed.as_millis() > 100 {
        log::warn!(
            "Slow directory listing: {} entries in {:?}",
            entries.len(),
            elapsed
        );
    } else {
        log::debug!("list_directory: {} entries in {:?}", entries.len(), elapsed);
    }

    // Update cache
    {
        let mut cache = get_dir_cache()
            .lock()
            .map_err(|e| AppError::Other(format!("dir cache lock poisoned: {e}")))?;
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.retain(|_, v| v.cached_at.elapsed().as_secs() < CACHE_TTL_SECS);
            // Still full (every entry fresh): evict the oldest entries so the
            // cache can't grow past MAX_CACHE_ENTRIES.
            while cache.len() >= MAX_CACHE_ENTRIES {
                let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, v)| v.cached_at)
                    .map(|(k, _)| k.clone())
                else {
                    break;
                };
                cache.remove(&oldest);
            }
        }
        cache.insert(
            path.clone(),
            CachedListing {
                entries: Arc::clone(&entries),
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
// pub: exercised directly by the `sort_entries` criterion bench
// (src-tauri/benches/sort_entries.rs).
pub fn sort_entries(entries: &mut [FileEntry]) {
    // Cache the (non-directory, lowercased-name) key so each name is lowercased
    // once rather than twice per comparison. `false < true`, so directories
    // (is_not_directory = false) sort ahead of files, then name case-insensitively.
    entries.sort_by_cached_key(|e| {
        let is_not_directory = !matches!(e.kind, FileKind::Directory);
        (is_not_directory, e.name.to_lowercase())
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
// pub: exercised directly by the `scan_directory_parallel` criterion bench
// (src-tauri/benches/scan_directory_parallel.rs).
pub fn scan_directory_parallel(dir_path: &PathBuf) -> Vec<FileEntry> {
    use rayon::prelude::*;

    // jwalk parallelizes readdir, but the per-entry symlink_metadata stat would
    // otherwise serialize on the consuming thread. Collect the child paths first,
    // then fan the stat + metadata_to_entry work out across rayon's thread pool so
    // a flat 10k-entry dir doesn't stat on a single core.
    let paths: Vec<PathBuf> = jwalk::WalkDir::new(dir_path)
        .max_depth(1)
        .skip_hidden(false)
        .into_iter()
        .filter_map(|result| {
            let dir_entry = result.ok()?;
            // Skip the root directory itself
            if dir_entry.depth() == 0 {
                return None;
            }
            Some(dir_entry.path())
        })
        .collect();

    let mut entries: Vec<FileEntry> = paths
        .into_par_iter()
        .filter_map(|path| {
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
    // jwalk + per-entry stat calls are blocking work; keep them off the async executor.
    let mut all_entries =
        super::run_blocking(move || Ok(scan_directory_parallel(&dir_path))).await?;
    let t_scan_end = std::time::Instant::now();

    let total_count = all_entries.len();
    #[cfg(debug_assertions)]
    eprintln!(
        "[Perf] dir scan '{}': {} entries, scan+sort={:?}",
        path,
        total_count,
        t_scan_end - t_scan_start,
    );

    // The scan leaves is_empty unset (`None`): probing it costs one read_dir per
    // subdirectory, so a 10k-dir scan would pay 10k read_dirs. The frontend
    // resolves emptiness lazily for visible directories via `is_directory_empty`
    // (#129), so neither the first batch nor the streamed chunks probe it here.
    if total_count <= batch_size {
        return Ok(DirectoryListing {
            path,
            entries: Arc::new(all_entries),
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
            // Brief pacing so batched emits don't flood the IPC channel. The
            // entries are already fully scanned, so every millisecond here is
            // pure added latency — 1ms keeps a 10k-entry stream under ~100ms
            // of pacing (was 5ms ≈ 500ms).
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        LISTINGS.cleanup(listing_id);
    });

    Ok(DirectoryListing {
        path,
        entries: Arc::new(first_batch),
        listing_id: Some(listing_id),
    })
}

/// Cancel an active directory listing.
#[tauri::command]
pub async fn cancel_directory_listing(listing_id: u64) -> Result<(), AppError> {
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
            .block_on(list_directory(dir.path().to_string_lossy().to_string()))
            .unwrap();

        assert_eq!(result.entries.len(), 2);
        assert!(matches!(result.entries[0].kind, FileKind::Directory));
        assert!(matches!(result.entries[1].kind, FileKind::File));
    }

    /// The parallel scan never pays the per-subdirectory is_empty probe (its
    /// dominant per-entry cost). Emptiness is resolved lazily by the frontend
    /// via `is_directory_empty`, so scans leave `is_empty` as `None` (#129).
    #[test]
    fn scan_does_not_probe_is_empty() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::create_dir(dir.path().join("full")).unwrap();
        File::create(dir.path().join("full/child.txt")).unwrap();
        File::create(dir.path().join("plain.txt")).unwrap();

        let entries = scan_directory_parallel(&dir.path().to_path_buf());
        assert!(
            entries.iter().all(|e| e.is_empty.is_none()),
            "scan must not pay the is_empty probe"
        );
    }

    /// list_directory no longer resolves is_empty eagerly (#129): every entry's
    /// is_empty is left `None` and the frontend fills it on demand.
    #[test]
    fn list_directory_leaves_is_empty_unresolved() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt
            .block_on(list_directory(dir.path().to_string_lossy().to_string()))
            .unwrap();

        assert!(result.entries.iter().all(|e| e.is_empty.is_none()));
    }

    /// The dedicated command the frontend uses for lazy resolution still
    /// distinguishes empty from non-empty directories.
    #[test]
    fn is_directory_empty_command_resolves_emptiness() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("empty")).unwrap();
        fs::create_dir(dir.path().join("full")).unwrap();
        File::create(dir.path().join("full/child.txt")).unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let empty = rt
            .block_on(is_directory_empty(
                dir.path().join("empty").to_string_lossy().to_string(),
                false,
            ))
            .unwrap();
        let full = rt
            .block_on(is_directory_empty(
                dir.path().join("full").to_string_lossy().to_string(),
                false,
            ))
            .unwrap();
        assert!(empty);
        assert!(!full);
    }

    /// Directories are flagged `is_git_repo` when they contain a `.git`
    /// directory (normal repo) or a `.git` file (worktree/submodule
    /// gitlink) — plain folders and files are never flagged (#463).
    #[test]
    fn scan_detects_git_repo_dir_and_gitlink_file_but_not_plain_folders() {
        let dir = tempdir().unwrap();

        // Normal repo: `.git` is a directory.
        fs::create_dir(dir.path().join("repo-dir")).unwrap();
        fs::create_dir(dir.path().join("repo-dir/.git")).unwrap();

        // Worktree/submodule: `.git` is a file (a gitlink pointing elsewhere).
        fs::create_dir(dir.path().join("repo-file")).unwrap();
        fs::write(
            dir.path().join("repo-file/.git"),
            "gitdir: ../.git/worktrees/repo-file\n",
        )
        .unwrap();

        // Plain folder: no `.git` at all.
        fs::create_dir(dir.path().join("plain")).unwrap();

        // A file at the top level too, to confirm files are never flagged.
        File::create(dir.path().join("plain.txt")).unwrap();

        let entries = scan_directory_parallel(&dir.path().to_path_buf());
        let by_name = |name: &str| entries.iter().find(|e| e.name == name).unwrap();

        assert!(
            by_name("repo-dir").is_git_repo,
            "`.git` dir should flag repo"
        );
        assert!(
            by_name("repo-file").is_git_repo,
            "`.git` gitlink file (worktree/submodule) should flag repo"
        );
        assert!(
            !by_name("plain").is_git_repo,
            "plain folder must not be flagged"
        );
        assert!(
            !by_name("plain.txt").is_git_repo,
            "files are never flagged, even named oddly"
        );
    }

    /// UNC roots cover both Windows network shares and WSL's 9P share. A
    /// directory listing must not add one `.git` stat per child there (#480).
    #[test]
    fn git_repo_detection_policy_skips_unc_listing_roots() {
        assert!(should_probe_git_repos(&PathBuf::from("C:\\Users\\me\\repos")));
        assert!(!should_probe_git_repos(&PathBuf::from(
            r"\\server\share\large-directory"
        )));
        assert!(!should_probe_git_repos(&PathBuf::from(
            r"\\wsl.localhost\Ubuntu\home\me\large-directory"
        )));
    }

    /// The listing seam returns a compatible `false` flag without touching a
    /// child `.git` path when its root uses the slow-mount policy (#480).
    #[test]
    fn slow_mount_scan_does_not_detect_child_git_repositories() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("repo")) .unwrap();
        fs::create_dir(dir.path().join("repo/.git")).unwrap();

        let entries = scan_directory_parallel_with_git_repo_probe(&dir.path().to_path_buf(), false);
        assert!(
            !entries.iter().find(|entry| entry.name == "repo").unwrap().is_git_repo,
            "slow-mount listings must leave is_git_repo false rather than stat each child .git"
        );
    }

    /// Contract test mirroring `tests/contract/fs-ops.contract.test.ts`
    /// (mock side). Both build the `listing_order` scenario from the shared
    /// fixture and assert the same ordering contract: directories first, then
    /// case-insensitive by name, dotfiles included. If the mock's listing
    /// order drifts from this backend, one side fails.
    #[test]
    fn contract_listing_order_matches_fixture() {
        let fx: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/contract/fixtures/fs_ops.json"))
                .expect("fixture is valid JSON");
        let scenario = &fx["listing_order"];
        let as_strs = |key: &str| -> Vec<&str> {
            scenario[key]
                .as_array()
                .unwrap_or_else(|| panic!("fixture key {key} missing"))
                .iter()
                .map(|v| v.as_str().expect("fixture names are strings"))
                .collect()
        };

        let dir = tempdir().unwrap();
        for d in as_strs("input_dirs") {
            fs::create_dir(dir.path().join(d)).unwrap();
        }
        for f in as_strs("input_files") {
            fs::write(dir.path().join(f), "x").unwrap();
        }

        let rt = tokio::runtime::Runtime::new().unwrap();
        let listing = rt
            .block_on(list_directory(dir.path().to_string_lossy().to_string()))
            .unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, as_strs("expected_order"));
    }
}
