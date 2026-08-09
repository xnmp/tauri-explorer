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
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use super::dir_listing::invalidate_dir_cache_sync;
use crate::error::AppError;

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
    watched: HashMap<String, usize>,
}

static FS_WATCHER: OnceLock<Mutex<FsWatcher>> = OnceLock::new();

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

/// Initialize the filesystem watcher. Call once during app setup.
pub fn init_watcher(app: &AppHandle) {
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
            invalidate_dir_cache_sync(&dir);

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

    let fs_watcher = FsWatcher {
        watcher,
        watched: HashMap::new(),
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
                log::debug!("Stopped watching: {}", path);
            } else {
                log::debug!("Decremented watch refcount for {}: {}", path, count);
            }
        }
        Ok(())
    })
}
