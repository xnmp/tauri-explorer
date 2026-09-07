//! Filesystem watcher for auto-refreshing directory listings.
//! Issue: tauri-explorer-2gdf
//!
//! Uses `notify` crate to watch directories for external changes.
//! Renderer-owned leases allow multiple panes viewing the same directory
//! to share a single OS watch. Debounces events (300ms, trailing) before
//! emitting `directory-changed`, so bulk operations produce one event per
//! directory instead of a storm.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

use super::dir_listing::invalidate_dir_cache_sync;
use super::directory_watches::{DirectoryWatches, Lease, Observer};
use crate::error::AppError;
use crate::renderer_owner::{self, Owner};
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

/// Native observation and recursive cache coverage shared by directory leases.
struct NativeObserver {
    watcher: RecommendedWatcher,
    search_watcher: Option<RecommendedWatcher>,
    search_watched: HashSet<String>,
}

type FsWatcher = DirectoryWatches<NativeObserver>;

static RETIRED_OWNERS: AtomicBool = AtomicBool::new(false);

/// Native lifecycle callbacks do not lock or perform notify operations.
pub(crate) fn retire_owners() {
    RETIRED_OWNERS.store(true, Ordering::Release);
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

fn is_test_watched(_path: &Path) -> bool {
    #[cfg(test)]
    if TEST_WATCHED_PATHS
        .get_or_init(|| Mutex::new(std::collections::HashSet::new()))
        .lock()
        .is_ok_and(|paths| paths.contains(_path))
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
    if !watcher.covered(&path_string) {
        return false;
    }
    if watcher.observer.search_watched.contains(&path_string) {
        return true;
    }
    let Some(search_watcher) = watcher.observer.search_watcher.as_mut() else {
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
    watcher.observer.search_watched.insert(path_string);
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
            watcher.covered(&path) && watcher.observer.search_watched.contains(&path)
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
fn rebuild_search_cache_watches(watcher: &mut NativeObserver) {
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

fn new_directory_watcher() -> notify::Result<RecommendedWatcher> {
    notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
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
    })
}

impl Observer for NativeObserver {
    fn watch(&mut self, path: &str) -> notify::Result<()> {
        self.watcher
            .watch(Path::new(path), RecursiveMode::NonRecursive)
    }
    fn unwatch(&mut self, path: &str) -> notify::Result<()> {
        self.watcher.unwatch(Path::new(path))
    }
    fn replace(&mut self, paths: &[String]) -> notify::Result<()> {
        let mut replacement = new_directory_watcher()?;
        for path in paths {
            replacement.watch(Path::new(path), RecursiveMode::NonRecursive)?;
        }
        self.watcher = replacement;
        Ok(())
    }
    fn uncovered(&mut self, path: &str) {
        if self.search_watched.remove(path) {
            rebuild_search_cache_watches(self);
        }
        invalidate_search_cache_root(Path::new(path));
    }
}

/// Initialize the filesystem watcher. Call once during app setup.
pub fn init_watcher<R: Runtime>(app: &AppHandle<R>) {
    let watcher = new_directory_watcher();

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

    let fs_watcher = DirectoryWatches::new(NativeObserver {
        watcher,
        search_watcher,
        search_watched: HashSet::new(),
    });

    assert!(
        FS_WATCHER.set(Mutex::new(fs_watcher)).is_ok(),
        "init_watcher called more than once"
    );

    // Flush thread: emits directory-changed once a directory has been quiet
    // for the debounce window (trailing debounce).
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut cleanup_pending = false;
        loop {
            std::thread::sleep(FLUSH_INTERVAL);
            if RETIRED_OWNERS.swap(false, Ordering::AcqRel) || cleanup_pending {
                if let Err(error) = with_watcher(|watcher| {
                    watcher.maintain(Instant::now());
                    cleanup_pending = watcher.needs_cleanup();
                    Ok(())
                }) {
                    log::warn!("Directory owner cleanup failed: {error}");
                }
            }

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

/// A result owns its lease until the awaiting command takes it. This also
/// covers cancellation after a successful oneshot send but before consumption.
struct PendingLease(Option<Lease>);
impl Drop for PendingLease {
    fn drop(&mut self) {
        if let Some(lease) = self.0.take() {
            tauri::async_runtime::spawn_blocking(move || {
                let _ = with_watcher(|watcher| {
                    watcher.abandon(&lease.id);
                    Ok(())
                });
                retire_owners();
            });
        }
    }
}

/// Registration runs off the async executor. An undelivered result reclaims
/// its lease even if cancellation races the command's reply.
pub(crate) async fn acquire_directory(owner: Owner, path: String) -> Result<Lease, AppError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_watcher(|watcher| watcher.acquire(&owner, path))
            .map(|lease| PendingLease(Some(lease)));
        let _ = send.send(result);
        // Also schedules retries if retirement raced a blocked registration.
        retire_owners();
    });
    let mut pending = receive
        .await
        .map_err(|_| AppError::Other("Directory watch registration interrupted".into()))??;
    Ok(pending.0.take().expect("pending directory lease"))
}

pub(crate) async fn release_directory(owner: Owner, id: String) -> Result<(), AppError> {
    super::run_blocking(move || {
        let result = with_watcher(|watcher| watcher.release(&owner, &id));
        // Final release is committed even if its frontend owner disappears
        // after an unwatch failure. Maintenance retries the retained identity.
        retire_owners();
        result
    })
    .await
}

#[tauri::command]
pub async fn watch_directory(
    window: tauri::Window,
    path: String,
    session_id: String,
) -> Result<Lease, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    acquire_directory(owner, path).await
}

#[tauri::command]
pub async fn unwatch_directory(
    window: tauri::Window,
    lease_id: String,
    session_id: String,
) -> Result<(), AppError> {
    match renderer_owner::release_owner(&window, &session_id) {
        Some(owner) => release_directory(owner, lease_id).await,
        None => Ok(()),
    }
}
