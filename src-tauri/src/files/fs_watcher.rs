//! Filesystem watcher for auto-refreshing directory listings.
//! Issue: tauri-explorer-2gdf
//!
//! Uses `notify` crate to watch directories for external changes.
//! Refcounted watches allow multiple panes viewing the same directory
//! to share a single OS watch. Debounces events (300ms, trailing) before
//! emitting `directory-changed`, so bulk operations produce one event per
//! directory instead of a storm.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

use super::dir_listing::invalidate_dir_cache_sync;
use crate::error::AppError;
use crate::search::{invalidate_search_cache_for_change, invalidate_search_cache_root};

/// Trailing debounce window for `directory-changed` events.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Poll interval for the debounce flush thread.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// Event payload emitted to the frontend when a watched directory changes.
#[derive(Clone, Serialize)]
struct DirectoryChangedPayload {
    path: String,
    /// Wall-clock time when notify observed the newest change in this batch.
    /// The frontend uses this to recognize a delayed notification that is
    /// already covered by a directory listing which started afterward.
    observed_at_ms: u64,
}

#[derive(Clone, Copy)]
struct PendingChange {
    last_event: Instant,
    observed_at_ms: u64,
}

/// Singleton filesystem watcher with refcounted directory watches.
#[derive(Debug)]
struct FsWatcher {
    watcher: RecommendedWatcher,
    search_watcher: Option<RecommendedWatcher>,
    watched: HashMap<String, usize>,
    search_watched: HashSet<String>,
}

static FS_WATCHER: OnceLock<Mutex<FsWatcher>> = OnceLock::new();

#[cfg(test)]
static TEST_WATCHED_PATHS: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();

/// Directories with pending change events, keyed by the time of the most
/// recent event. Flushed (emitted) once no new event arrived for DEBOUNCE.
static PENDING_CHANGES: OnceLock<Mutex<HashMap<String, PendingChange>>> = OnceLock::new();

fn pending_changes() -> &'static Mutex<HashMap<String, PendingChange>> {
    PENDING_CHANGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn is_test_watched(path: &Path) -> bool {
    #[cfg(test)]
    if TEST_WATCHED_PATHS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .is_ok_and(|paths| paths.contains(path))
    {
        return true;
    }

    false
}

pub(crate) fn ensure_search_cache_watched(path: &Path) -> bool {
    if is_test_watched(path) {
        return true;
    }

    let path_string = path.to_string_lossy().to_string();
    let Some(mut watcher) = FS_WATCHER.get().and_then(|watcher| watcher.lock().ok()) else {
        return false;
    };
    if !watcher.watched.contains_key(&path_string) {
        return false;
    }
    if watcher.search_watched.contains(&path_string) {
        return true;
    }
    let Some(search_watcher) = watcher.search_watcher.as_mut() else {
        return false;
    };
    if let Err(error) = search_watcher.watch(path, RecursiveMode::Recursive) {
        log::warn!(
            "Failed to establish recursive Quick Open cache watch for {}: {}",
            path.display(),
            error
        );
        return false;
    }
    // Coverage may be returning after a failed rebuild. Advance the epoch
    // before advertising it so a walk that started in the uncovered gap
    // cannot publish into the newly covered cache.
    invalidate_search_cache_root(path);
    watcher.search_watched.insert(path_string);
    true
}

pub(crate) fn is_search_cache_watched(path: &Path) -> bool {
    if is_test_watched(path) {
        return true;
    }

    FS_WATCHER
        .get()
        .and_then(|watcher| watcher.lock().ok())
        .is_some_and(|watcher| {
            let path = path.to_string_lossy().to_string();
            watcher.watched.contains_key(&path) && watcher.search_watched.contains(&path)
        })
}

#[cfg(test)]
pub(crate) fn mark_directory_watched_for_test(path: &Path) {
    TEST_WATCHED_PATHS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .expect("test watched paths lock")
        .insert(path.to_path_buf());
}

pub(crate) fn invalidate_directory_caches_for_change(path: &Path) {
    let path_string = path.to_string_lossy();
    invalidate_dir_cache_sync(&path_string);
    invalidate_search_cache_for_change(path);
}

fn new_search_cache_watcher() -> Result<RecommendedWatcher, notify::Error> {
    notify::recommended_watcher(move |res: Result<Event, notify::Error>| match res {
        Ok(event)
            if matches!(
                event.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) =>
        {
            for path in event.paths {
                invalidate_search_cache_for_change(&path);
            }
        }
        Ok(_) => {}
        Err(error) => log::warn!("Quick Open cache watcher error: {}", error),
    })
}

/// Recreate all recursive registrations after one root is removed. On Linux,
/// notify's inotify backend can remove descendant OS watches when overlapping
/// parent and child registrations share a watcher. Rebuilding gives every
/// surviving root fresh coverage and a fresh cache publication epoch.
fn rebuild_search_cache_watches(watcher: &mut FsWatcher) {
    let roots: Vec<String> = watcher.search_watched.iter().cloned().collect();
    let mut replacement = match new_search_cache_watcher() {
        Ok(replacement) => replacement,
        Err(error) => {
            log::warn!(
                "Failed to rebuild recursive Quick Open cache watcher (cache disabled): {}",
                error
            );
            watcher.search_watched.clear();
            watcher.search_watcher = None;
            for root in roots {
                invalidate_search_cache_root(Path::new(&root));
            }
            return;
        }
    };

    let mut failed = Vec::new();
    for root in &roots {
        if let Err(error) = replacement.watch(Path::new(root), RecursiveMode::Recursive) {
            log::warn!(
                "Failed to restore recursive Quick Open cache watch for {}: {}",
                root,
                error
            );
            failed.push(root.clone());
        }
    }
    for root in &failed {
        watcher.search_watched.remove(root);
    }
    watcher.search_watcher = Some(replacement);

    for root in roots {
        invalidate_search_cache_root(Path::new(&root));
    }
}

/// Initialize the filesystem watcher. Call once during app setup.
pub fn init_watcher<R: Runtime>(app: &AppHandle<R>) {
    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let event = match res {
            Ok(e) => e,
            Err(err) => {
                log::warn!("fs_watcher error: {}", err);
                return;
            }
        };

        // Only react to creates, removes, and renames
        match event.kind {
            EventKind::Create(_)
            | EventKind::Remove(_)
            | EventKind::Modify(notify::event::ModifyKind::Name(_)) => {}
            _ => return,
        }

        // Collect unique parent directories from the event paths
        let mut dirs = Vec::new();
        for path in &event.paths {
            let dir = path.parent().unwrap_or(path).to_string_lossy().to_string();
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }

        for dir in dirs {
            // Invalidate the directory cache immediately so re-listings are
            // fresh; the frontend notification is debounced separately.
            invalidate_directory_caches_for_change(Path::new(&dir));

            if let Ok(mut pending) = pending_changes().lock() {
                pending.insert(
                    dir,
                    PendingChange {
                        last_event: Instant::now(),
                        observed_at_ms: unix_time_ms(),
                    },
                );
            }
        }
    });

    // Watcher creation can fail at startup (e.g. inotify instance exhaustion).
    // Degrade to no live refresh instead of panicking the whole app —
    // watch_directory then returns "not initialized" errors, which the
    // frontend already tolerates.
    let watcher = match watcher {
        Ok(w) => w,
        Err(e) => {
            log::error!(
                "Failed to create filesystem watcher (live refresh disabled): {}",
                e
            );
            return;
        }
    };

    // Pane refreshes only need direct children, but Quick Open caches a full
    // recursive listing. Keep a separate recursive watcher so cache coverage
    // does not turn every thumbnail/column watch into an overlapping tree.
    let search_watcher = match new_search_cache_watcher() {
        Ok(watcher) => Some(watcher),
        Err(error) => {
            log::warn!(
                "Failed to create recursive Quick Open cache watcher (cache disabled): {}",
                error
            );
            None
        }
    };

    let fs_watcher = FsWatcher {
        watcher,
        search_watcher,
        watched: HashMap::new(),
        search_watched: HashSet::new(),
    };

    FS_WATCHER
        .set(Mutex::new(fs_watcher))
        .expect("init_watcher called more than once");

    // Flush thread: emits directory-changed once a directory has been quiet
    // for the debounce window (trailing debounce).
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(FLUSH_INTERVAL);

        let ready: Vec<(String, u64)> = {
            let Ok(mut pending) = pending_changes().lock() else {
                continue;
            };
            let now = Instant::now();
            let ready: Vec<(String, u64)> = pending
                .iter()
                .filter(|(_, change)| now.duration_since(change.last_event) >= DEBOUNCE)
                .map(|(dir, change)| (dir.clone(), change.observed_at_ms))
                .collect();
            for (dir, _) in &ready {
                pending.remove(dir);
            }
            ready
        };

        for (dir, observed_at_ms) in ready {
            if let Err(e) = app_handle.emit(
                "directory-changed",
                DirectoryChangedPayload {
                    path: dir.clone(),
                    observed_at_ms,
                },
            ) {
                log::warn!("Failed to emit directory-changed for {}: {}", dir, e);
            }
        }
    });

    log::info!("Filesystem watcher initialized");
}

fn with_watcher<F, R>(f: F) -> Result<R, AppError>
where
    F: FnOnce(&mut FsWatcher) -> Result<R, AppError>,
{
    let mut watcher = FS_WATCHER
        .get()
        .ok_or_else(|| AppError::Other("Filesystem watcher not initialized".to_string()))?
        .lock()
        .map_err(|e| AppError::Other(format!("Watcher lock poisoned: {}", e)))?;
    f(&mut watcher)
}

/// Start watching a directory. Refcounted — multiple calls for the same path
/// increment the count; the OS watch starts only on the first call.
#[tauri::command]
pub async fn watch_directory(path: String) -> Result<(), AppError> {
    with_watcher(|w| {
        if let Some(count) = w.watched.get_mut(&path) {
            *count += 1;
            log::debug!("Incremented watch refcount for {}: {}", path, count);
            return Ok(());
        }
        // Only record the entry once the OS watch actually succeeded, so a
        // failed watch doesn't leave a phantom refcount blocking retries.
        let pb = PathBuf::from(&path);
        w.watcher
            .watch(&pb, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::Other(format!("Failed to watch {}: {}", path, e)))?;
        w.watched.insert(path.clone(), 1);
        log::debug!("Started watching: {}", path);
        Ok(())
    })
}

/// Stop watching a directory. Decrements refcount; OS watch removed at zero.
#[tauri::command]
pub async fn unwatch_directory(path: String) -> Result<(), AppError> {
    with_watcher(|w| {
        if let Some(count) = w.watched.get_mut(&path) {
            *count -= 1;
            if *count == 0 {
                w.watched.remove(&path);
                let pb = PathBuf::from(&path);
                let _ = w.watcher.unwatch(&pb);
                if w.search_watched.remove(&path) {
                    rebuild_search_cache_watches(w);
                }
                // Ending the final watch also ends the cache epoch. Files can
                // change unobserved before this root is watched again, and an
                // in-flight walk from the old epoch must not publish afterward.
                invalidate_search_cache_root(&pb);
                log::debug!("Stopped watching: {}", path);
            } else {
                log::debug!("Decremented watch refcount for {}: {}", path, count);
            }
        }
        Ok(())
    })
}
