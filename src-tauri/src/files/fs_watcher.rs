//! Filesystem watcher for auto-refreshing directory listings.
//! Issue: tauri-explorer-2gdf
//!
//! Uses `notify` crate to watch directories for external changes.
//! Renderer-owned leases allow multiple panes viewing the same directory
//! to share a single OS watch. Debounces events (300ms, trailing) before
//! emitting `directory-changed`, so bulk operations produce one event per
//! directory instead of a storm.

use notify::Watcher;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

use super::dir_listing::invalidate_dir_cache_sync;
use super::directory_watches::{DirectoryWatches, Lease, Observer};
use super::watch_observation::{Callback, Mode, Notice, Observation};
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
    direct: Observation,
    search: Observation,
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
    watcher.observer.search.add(path, true).is_ok()
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
            watcher.covered(&path) && watcher.observer.search.healthy(Path::new(&path))
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

fn queue_directory_change(path: &Path) {
    if let Ok(mut pending) = pending_changes().lock() {
        pending.insert(
            path.to_string_lossy().into_owned(),
            PendingChange {
                last_event: Instant::now(),
                observed_at_ms: unix_time_ms(),
            },
        );
    }
}

fn native_watcher(callback: Callback) -> notify::Result<Box<dyn Watcher + Send>> {
    notify::recommended_watcher(callback)
        .map(|watcher| Box::new(watcher) as Box<dyn Watcher + Send>)
}

fn observation(mode: Mode) -> Observation {
    Observation::new(
        mode,
        Box::new(native_watcher),
        Arc::new(move |notice| match notice {
            Notice::Wake => retire_owners(),
            Notice::Changed { path, names } => {
                if mode == Mode::Recursive {
                    invalidate_search_cache_for_change(&path);
                } else {
                    if names {
                        invalidate_directory_caches_for_change(&path);
                    } else {
                        invalidate_dir_cache_sync(&path.to_string_lossy());
                    }
                    queue_directory_change(&path);
                }
            }
            Notice::Lost(roots) => {
                for root in roots {
                    invalidate_search_cache_root(&root);
                    if mode == Mode::Direct {
                        invalidate_dir_cache_sync(&root.to_string_lossy());
                        queue_directory_change(&root);
                    }
                }
            }
            Notice::Invalidated(roots) => {
                // Advance before the native generation advertises coverage. A walk
                // from the gap must not publish into the recovered cache.
                for root in roots {
                    invalidate_search_cache_root(&root);
                    if mode == Mode::Direct {
                        invalidate_dir_cache_sync(&root.to_string_lossy());
                    }
                }
            }
            Notice::Restored { roots, refresh } => {
                if mode == Mode::Direct && refresh {
                    for root in roots {
                        queue_directory_change(&root);
                    }
                }
            }
        }),
    )
}

impl NativeObserver {
    fn new() -> Self {
        Self {
            direct: observation(Mode::Direct),
            search: observation(Mode::Recursive),
        }
    }
    fn maintain(&mut self, now: Instant) {
        if self.direct.next_work_at(now).is_some_and(|at| at <= now) {
            self.direct.maintain(now);
        }
        if self.search.next_work_at(now).is_some_and(|at| at <= now) {
            self.search.maintain(now);
        }
    }
    fn next_work_at(&self, now: Instant) -> Option<Instant> {
        self.direct
            .next_work_at(now)
            .into_iter()
            .chain(self.search.next_work_at(now))
            .min()
    }
}

impl Observer for NativeObserver {
    fn healthy(&self, path: &str) -> bool {
        self.direct.healthy(Path::new(path))
    }
    fn watch(&mut self, path: &str) -> notify::Result<()> {
        self.direct.add(Path::new(path), false)
    }
    fn observe(&mut self, path: &str) -> notify::Result<()> {
        self.direct.add(Path::new(path), true)
    }
    fn unwatch(&mut self, path: &str) -> notify::Result<()> {
        self.direct.remove(Path::new(path))
    }
    fn replace(&mut self, paths: &[String]) -> notify::Result<()> {
        self.direct.reset(paths)
    }
    fn uncovered(&mut self, path: &str) {
        let _ = self.search.remove(Path::new(path));
        invalidate_search_cache_root(Path::new(path));
    }
}

/// Initialize the filesystem watcher. Call once during app setup.
pub fn init_watcher<R: Runtime>(app: &AppHandle<R>) {
    // Native watchers are demand-driven: ordinary startup need not create an
    // empty recursive observer, and a failed factory can retry on later demand.
    let fs_watcher = DirectoryWatches::new(NativeObserver::new());

    assert!(
        FS_WATCHER.set(Mutex::new(fs_watcher)).is_ok(),
        "init_watcher called more than once"
    );

    // Flush thread: emits directory-changed once a directory has been quiet
    // for the debounce window (trailing debounce).
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut next_maintenance = None;
        loop {
            std::thread::sleep(FLUSH_INTERVAL);
            let now = Instant::now();
            if RETIRED_OWNERS.swap(false, Ordering::AcqRel)
                || next_maintenance.is_some_and(|at| at <= now)
            {
                if let Err(error) = with_watcher(|watcher| {
                    let now = Instant::now();
                    watcher.maintain(now);
                    watcher.observer.maintain(now);
                    next_maintenance = watcher
                        .next_cleanup_at(now)
                        .into_iter()
                        .chain(watcher.observer.next_work_at(now))
                        .min();
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
pub(super) struct PendingLease(Option<Lease>);

impl PendingLease {
    pub fn take(mut self) -> Lease {
        self.0.take().expect("pending directory lease")
    }
}
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
    acquire_pending_directory(owner, path, false)
        .await
        .map(PendingLease::take)
}

pub(super) async fn observe_directory(
    owner: Owner,
    path: String,
) -> Result<PendingLease, AppError> {
    acquire_pending_directory(owner, path, true).await
}

async fn acquire_pending_directory(
    owner: Owner,
    path: String,
    observed: bool,
) -> Result<PendingLease, AppError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_watcher(|watcher| {
            if observed {
                watcher.observe(&owner, path)
            } else {
                watcher.acquire(&owner, path)
            }
        })
        .map(|lease| PendingLease(Some(lease)));
        let _ = send.send(result);
        // Also schedules retries if retirement raced a blocked registration.
        retire_owners();
    });
    receive
        .await
        .map_err(|_| AppError::Other("Directory watch registration interrupted".into()))?
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
