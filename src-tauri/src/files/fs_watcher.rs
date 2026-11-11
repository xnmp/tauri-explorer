//! Filesystem watcher for auto-refreshing directory listings.
//! Issue: tauri-explorer-2gdf
//!
//! Uses `notify` crate to watch directories for external changes.
//! Renderer-owned leases allow multiple panes viewing the same directory
//! to share a single OS watch. Debounces events (300ms, trailing) before
//! emitting `directory-changed`, so bulk operations produce one event per
//! directory instead of a storm. App-settled mutations bypass the trailing
//! debounce and publish on the next flush, retaining priority when coalesced.

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
use super::search_observation::SearchObservation;
use super::watch_observation::{Callback, Factory, Mode, Notice, Observation};
use crate::error::AppError;
use crate::load_diagnostics::{Phase, TraceHandle};
use crate::renderer_owner::{self, Owner};
use crate::search::{invalidate_search_cache_for_change, invalidate_search_cache_root};

/// Trailing debounce window for `directory-changed` events.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Longest a watcher batch may wait, measured from its FIRST pending event.
/// A trailing-only debounce never flushes a directory that is written
/// continuously (build output, downloads, logs), leaving its listing stale for
/// as long as the writes last (#1593). The cap trades a few extra refreshes
/// during sustained churn (at most one per cap) for bounded staleness; it must
/// not undercut DEBOUNCE, so a lone burst still coalesces after its quiet period.
const MAX_WAIT: Duration = Duration::from_millis(1500);
const _: () = assert!(MAX_WAIT.as_millis() >= DEBOUNCE.as_millis());
/// Poll interval for the debounce flush thread.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// App-settled mutations reconcile promptly; ordinary filesystem churn debounces.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum ChangeOrigin {
    Watcher,
    Mutation,
}

/// Event payload emitted to the frontend when a watched directory changes.
#[derive(Clone, Serialize)]
struct DirectoryChangedPayload {
    origin: ChangeOrigin,
    path: String,
    /// Wall-clock time when the newest change in this batch was observed.
    /// The frontend uses this to recognize a delayed notification that is
    /// already covered by a directory listing which started afterward.
    observed_at_ms: u64,
}

#[derive(Clone, Copy)]
struct PendingChange {
    origin: ChangeOrigin,
    /// Earliest pending event: anchors the MAX_WAIT cap.
    first_event: Instant,
    last_event: Instant,
    observed_at_ms: u64,
}

impl PendingChange {
    fn merge(&mut self, next: Self) {
        self.first_event = self.first_event.min(next.first_event);
        self.last_event = self.last_event.max(next.last_event);
        self.observed_at_ms = self.observed_at_ms.max(next.observed_at_ms);
        if next.origin == ChangeOrigin::Mutation {
            self.origin = ChangeOrigin::Mutation;
        }
    }

    fn ready(self, now: Instant) -> bool {
        self.origin == ChangeOrigin::Mutation
            || now.duration_since(self.last_event) >= DEBOUNCE
            || now.duration_since(self.first_event) >= MAX_WAIT
    }
}

/// Cache invalidation boundary used by both native observation modes.
trait CacheInvalidation: Clone + Send + Sync + 'static {
    fn changed(&self, path: &Path);
    fn root(&self, path: &Path);
}

#[derive(Clone, Copy)]
struct GlobalSearchCache;

impl CacheInvalidation for GlobalSearchCache {
    fn changed(&self, path: &Path) {
        invalidate_search_cache_for_change(path);
    }
    fn root(&self, path: &Path) {
        invalidate_search_cache_root(path);
    }
}

/// Native observation and recursive cache coverage shared by directory leases.
struct NativeObserver<C: CacheInvalidation> {
    direct: Observation,
    search: SearchObservation,
    cache: C,
}

type FsWatcher = DirectoryWatches<NativeObserver<GlobalSearchCache>>;

static RETIRED_OWNERS: AtomicBool = AtomicBool::new(false);

/// Native lifecycle callbacks do not lock or perform notify operations.
pub(crate) fn retire_owners() {
    RETIRED_OWNERS.store(true, Ordering::Release);
}

static FS_WATCHER: OnceLock<Mutex<FsWatcher>> = OnceLock::new();

#[cfg(test)]
static TEST_WATCHED_PATHS: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();

/// Directories with pending change events, keyed by the time of the most
/// recent event. Watcher batches wait for DEBOUNCE; mutation batches flush promptly.
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
    ensure_search_cache_watched_cancellable(path, Arc::new(AtomicBool::new(false)))
}

pub(crate) fn ensure_search_cache_watched_cancellable(
    path: &Path,
    cancelled: Arc<AtomicBool>,
) -> bool {
    if cancelled.load(Ordering::Acquire) {
        return false;
    }
    if is_test_watched(path) {
        return true;
    }

    let Some(watcher) = FS_WATCHER.get() else {
        return false;
    };
    ensure_search_watch_cancellable(watcher, path, cancelled)
}

#[cfg(test)]
fn ensure_search_watch<C: CacheInvalidation>(
    watcher: &Mutex<DirectoryWatches<NativeObserver<C>>>,
    path: &Path,
) -> bool {
    ensure_search_watch_cancellable(watcher, path, Arc::new(AtomicBool::new(false)))
}

fn ensure_search_watch_cancellable<C: CacheInvalidation>(
    watcher: &Mutex<DirectoryWatches<NativeObserver<C>>>,
    path: &Path,
    cancelled: Arc<AtomicBool>,
) -> bool {
    if cancelled.load(Ordering::Acquire) {
        return false;
    }
    let path_string = crate::wire_path::encode_path(path).into_owned();
    let registration = {
        let Ok(watcher) = watcher.lock() else {
            return false;
        };
        if !watcher.covered(&path_string) {
            return false;
        }
        watcher.observer.search.prepare_cancellable(path, cancelled)
    };
    // Recursive registration can traverse millions of directories. Never
    // retain the direct lease mutex while waiting for its independent worker.
    if !registration.wait() {
        return false;
    }
    watcher
        .lock()
        .is_ok_and(|watcher| watcher.covered(&path_string) && watcher.observer.search.healthy(path))
}

pub(crate) fn is_search_cache_watched(path: &Path) -> bool {
    if is_test_watched(path) {
        return true;
    }

    FS_WATCHER
        .get()
        .and_then(|watcher| watcher.lock().ok())
        .is_some_and(|watcher| {
            watcher.covered(&crate::wire_path::encode_path(path))
                && watcher.observer.search.healthy(path)
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
    invalidate_dir_cache_sync(&crate::wire_path::encode_path(path));
    invalidate_search_cache_for_change(path);
}

/// Native inverse effects, including conservative auxiliary invalidations,
/// outlive their invoking renderer. Publish
/// through the existing cache invalidation and watcher scheduling boundary.
pub(crate) fn publish_file_changes(paths: &[String]) {
    for path in paths {
        // Wire spellings name native paths only through their decoding; a
        // literal `Path::new` would re-escape an escaped name (#1592).
        let Ok(path) = crate::wire_path::decode(path) else {
            log::warn!("Skipping change publication for a non-canonical path: {path:?}");
            continue;
        };
        invalidate_directory_caches_for_change(&path);
        queue_directory_change(&path, ChangeOrigin::Mutation);
    }
}

fn queue_directory_change(path: &Path, origin: ChangeOrigin) {
    if let Ok(mut pending) = pending_changes().lock() {
        record_change(&mut pending, path, origin, Instant::now(), unix_time_ms());
    }
}

/// Adds one event to its directory's pending batch (the queue side of the
/// flush thread's contract).
fn record_change(
    pending: &mut HashMap<String, PendingChange>,
    path: &Path,
    origin: ChangeOrigin,
    now: Instant,
    observed_at_ms: u64,
) {
    let change = PendingChange {
        origin,
        first_event: now,
        last_event: now,
        observed_at_ms,
    };
    pending
        .entry(crate::wire_path::encode_path(path).into_owned())
        .and_modify(|previous| previous.merge(change))
        .or_insert(change);
}

/// Removes and returns every batch ready at `now` (the flush side). A later
/// event for a flushed directory starts a new batch, so its debounce and
/// MAX_WAIT both restart from that event.
fn take_ready_changes(
    pending: &mut HashMap<String, PendingChange>,
    now: Instant,
) -> Vec<(String, PendingChange)> {
    let ready: Vec<(String, PendingChange)> = pending
        .iter()
        .filter(|(_, change)| change.ready(now))
        .map(|(dir, change)| (dir.clone(), *change))
        .collect();
    for (dir, _) in &ready {
        pending.remove(dir);
    }
    ready
}

fn native_watcher(callback: Callback) -> notify::Result<Box<dyn Watcher + Send>> {
    notify::recommended_watcher(callback)
        .map(|watcher| Box::new(watcher) as Box<dyn Watcher + Send>)
}

fn observation<C: CacheInvalidation>(mode: Mode, factory: Factory, cache: C) -> Observation {
    Observation::new(
        mode,
        factory,
        Arc::new(move |notice| match notice {
            Notice::Wake => retire_owners(),
            Notice::Changed { path, names } => {
                if mode == Mode::Recursive {
                    cache.changed(&path);
                } else {
                    if names {
                        invalidate_dir_cache_sync(&crate::wire_path::encode_path(&path));
                        cache.changed(&path);
                    } else {
                        invalidate_dir_cache_sync(&crate::wire_path::encode_path(&path));
                    }
                    queue_directory_change(&path, ChangeOrigin::Watcher);
                }
            }
            Notice::Lost(roots) => {
                for root in roots {
                    cache.root(&root);
                    if mode == Mode::Direct {
                        invalidate_dir_cache_sync(&crate::wire_path::encode_path(&root));
                        queue_directory_change(&root, ChangeOrigin::Watcher);
                    }
                }
            }
            Notice::Invalidated(roots) => {
                // Advance before the native generation advertises coverage. A walk
                // from the gap must not publish into the recovered cache.
                for root in roots {
                    cache.root(&root);
                    if mode == Mode::Direct {
                        invalidate_dir_cache_sync(&crate::wire_path::encode_path(&root));
                    }
                }
            }
            Notice::Restored { roots, refresh } => {
                if mode == Mode::Direct && refresh {
                    for root in roots {
                        queue_directory_change(&root, ChangeOrigin::Watcher);
                    }
                }
            }
        }),
    )
}

impl NativeObserver<GlobalSearchCache> {
    fn new() -> Self {
        Self::with_cache(GlobalSearchCache, |_| Box::new(native_watcher))
    }
}

impl<C: CacheInvalidation> NativeObserver<C> {
    fn with_cache(cache: C, factory: impl Fn(Mode) -> Factory) -> Self {
        Self {
            direct: observation(Mode::Direct, factory(Mode::Direct), cache.clone()),
            search: SearchObservation::new(observation(
                Mode::Recursive,
                factory(Mode::Recursive),
                cache.clone(),
            )),
            cache,
        }
    }
    fn maintain(&mut self, now: Instant) {
        if self.direct.next_work_at(now).is_some_and(|at| at <= now) {
            self.direct.maintain(now);
        }
    }
    fn next_work_at(&self, now: Instant) -> Option<Instant> {
        self.direct.next_work_at(now)
    }
}

/// Lease keys are canonical wire spellings (admission decodes each one
/// first), so a failure here is an invariant breach reported as an error.
fn native_path(path: &str) -> notify::Result<std::borrow::Cow<'_, Path>> {
    crate::wire_path::decode(path).map_err(|error| notify::Error::generic(&error.to_string()))
}

impl<C: CacheInvalidation> Observer for NativeObserver<C> {
    fn healthy(&self, path: &str) -> bool {
        native_path(path).is_ok_and(|path| self.direct.healthy(&path))
    }
    fn watch(&mut self, path: &str) -> notify::Result<()> {
        self.direct.add(&native_path(path)?, false)
    }
    fn observe(&mut self, path: &str) -> notify::Result<()> {
        self.direct.add(&native_path(path)?, true)
    }
    fn unwatch(&mut self, path: &str) -> notify::Result<()> {
        self.direct.remove(&native_path(path)?)
    }
    fn replace(&mut self, paths: &[String]) -> notify::Result<()> {
        let roots = paths
            .iter()
            .map(|path| native_path(path).map(std::borrow::Cow::into_owned))
            .collect::<notify::Result<Vec<_>>>()?;
        self.direct.reset(roots)
    }
    fn uncovered(&mut self, path: &str) {
        if let Ok(path) = native_path(path) {
            self.search.remove(&path);
            self.cache.root(&path);
        }
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

            let ready = {
                let Ok(mut pending) = pending_changes().lock() else {
                    continue;
                };
                take_ready_changes(&mut pending, Instant::now())
            };

            for (dir, change) in ready {
                if let Err(e) = app_handle.emit(
                    "directory-changed",
                    DirectoryChangedPayload {
                        path: dir.clone(),
                        observed_at_ms: change.observed_at_ms,
                        origin: change.origin,
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
    pub fn path(&self) -> &str {
        &self.0.as_ref().expect("pending directory lease").path
    }

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
    acquire_pending_directory(owner, path, false, TraceHandle::none())
        .await
        .map(PendingLease::take)
}

pub(super) async fn observe_directory(
    owner: Owner,
    path: String,
    trace: TraceHandle,
) -> Result<PendingLease, AppError> {
    acquire_pending_directory(owner, path, true, trace).await
}

/// Watch registration holds the process-wide watcher lock across the OS
/// registration call, so a mount that blocks `inotify_add_watch` delays every
/// pane's navigation. The trace separates waiting for that lock from the
/// registration itself (#1022).
async fn acquire_pending_directory(
    owner: Owner,
    path: String,
    observed: bool,
    trace: TraceHandle,
) -> Result<PendingLease, AppError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    trace.enter(Phase::BlockingQueue);
    tauri::async_runtime::spawn_blocking(move || {
        trace.enter(Phase::ResolvePath);
        let path = super::directory_identity::resolve(&path);
        trace.enter(Phase::WatchLock);
        // Admit only canonical wire spellings, so every lease key decodes.
        let result = crate::wire_path::decode(&path)
            .map(drop)
            .and_then(|()| {
                with_watcher(|watcher| {
                    trace.enter(Phase::WatchRegister);
                    if observed {
                        watcher.observe(&owner, path)
                    } else {
                        watcher.acquire(&owner, path)
                    }
                })
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

#[cfg(test)]
#[path = "../../test_support/fs_watcher_changes.rs"]
pub(crate) mod change_tests;

#[cfg(test)]
pub(crate) fn native_search_change_for_test(
    path: &Path,
) -> super::watch_observation::tests::ChangeReceipt {
    super::watch_observation::tests::subscribe_changes(path, Mode::Recursive)
}

#[cfg(test)]
pub(crate) fn settle_search_watch_for_test() {
    let watcher = FS_WATCHER.get().unwrap().lock().unwrap();
    watcher.observer.search.settle();
}

/// Test-only readiness fence for a real-watcher write. The published recursive
/// coverage can still describe a generation whose rebuild is queued (an
/// overlapping root was just released), so first drain the worker's queue,
/// then arm and confirm healthy recursive coverage. A write before this can
/// land between generations: the cache epoch still advances, but no per-path
/// receipt is delivered (#1152).
#[cfg(test)]
fn arm_search_watch<C: CacheInvalidation>(
    watcher: &Mutex<DirectoryWatches<NativeObserver<C>>>,
    path: &Path,
) -> bool {
    let settled = watcher.lock().unwrap().observer.search.settled();
    settled.wait();
    ensure_search_watch(watcher, path)
}

#[cfg(test)]
pub(crate) fn arm_search_watch_for_test(path: &Path) -> bool {
    FS_WATCHER
        .get()
        .is_some_and(|watcher| arm_search_watch(watcher, path))
}
