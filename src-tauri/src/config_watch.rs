//! Watches the app config directory for edits made outside the app (#599).
//!
//! Settings are a plain JSON file and user themes are plain CSS, so people
//! edit them directly — with an editor, `sed`, or a dotfile manager. Before
//! this module those edits only took effect on the next launch. Now a change
//! to `settings.json`, `bookmarks.json`, `folder-views.json`, or user theme
//! CSS emits `config-file-changed` to every
//! window, which re-reads the file and applies it live.
//!
//! Two deliberate constraints:
//!
//! * **Only the files the frontend can act on are reported.** The config dir
//!   also holds window state, bookmarks and per-plugin blobs that the app
//!   rewrites constantly; forwarding those would be a steady stream of events
//!   nothing listens to. `watched_config_name` is the whole allowlist.
//! * **Echo suppression is the frontend's job, not this module's.** The app's
//!   own writes are indistinguishable from an external edit at the filesystem
//!   layer (`write_atomic` renames a temp file over the destination, exactly
//!   as a careful editor does). The frontend already knows what it last wrote
//!   and whether a write is in flight, so it decides; here we just report.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Trailing debounce window. An editor's save can produce several events
/// (truncate, write, rename, chmod); one reload per settled file is enough.
const DEBOUNCE: Duration = Duration::from_millis(200);
/// Poll interval for the debounce flush thread.
const FLUSH_INTERVAL: Duration = Duration::from_millis(80);
/// Symlink targets can be retargeted by a dotfile manager while the app runs.
/// Re-resolve them periodically so their new targets are picked up.
const WATCH_PLAN_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

/// The settings blob the frontend reloads into its settings store.
const SETTINGS_FILE: &str = "settings.json";
const BOOKMARKS_FILE: &str = "bookmarks.json";
const FOLDER_VIEWS_FILE: &str = "folder-views.json";
/// User theme CSS lives one level down, in `<config>/themes/`.
const THEMES_DIR: &str = "themes";

#[derive(Clone, Serialize)]
struct ConfigChangedPayload {
    /// Config-dir-relative name, always forward-slashed: `settings.json` or
    /// `themes/<name>.css`.
    filename: String,
}

/// The filesystem locations that must be watched to observe reloadable config.
///
/// `config_dir` is always watched recursively. Symlink targets outside it are
/// added to `external_roots` by the implementation that resolves this plan.
/// A resolved view of the config paths a filesystem watcher must observe.
///
/// This is public so integration tests and embedding callers can drive the
/// same watcher mapping as the app rather than duplicating symlink handling.
#[derive(Clone)]
struct WatchPlan {
    config_dir: PathBuf,
    external_roots: Vec<(PathBuf, RecursiveMode)>,
    external_files: HashMap<PathBuf, String>,
    external_themes_dir: Option<PathBuf>,
}

/// The watcher and the external roots currently registered on it. Only the
/// refresh worker touches it after setup; the event callback never does.
struct Registrations<W> {
    watcher: W,
    /// Confirmed active native coverage only; failed removals are not coverage.
    external_roots: HashMap<PathBuf, RecursiveMode>,
    pending_removals: HashSet<PathBuf>,
    /// An ancestor unwatch can remove the config directory's native coverage.
    /// Keep that obligation separate from the external-root plan for retries.
    config_root_needs_restore: bool,
}

impl<W> Registrations<W> {
    fn new(watcher: W, external_roots: HashMap<PathBuf, RecursiveMode>) -> Self {
        Self {
            watcher,
            external_roots,
            pending_removals: HashSet::new(),
            config_root_needs_restore: false,
        }
    }
}

/// Registration operations of a filesystem watcher.
///
/// Every notify backend completes `watch`/`unwatch` on the same thread that
/// runs the event callback: inotify and ReadDirectoryChangesW wait for their
/// event loop to acknowledge the request, and FSEvents stops and restarts its
/// run loop once it is idle. A caller must therefore never hold a lock the
/// event callback takes across these calls, or the two threads deadlock
/// (#913).
trait WatchRegistration {
    type Error: Display;
    fn register(&mut self, path: &Path, mode: RecursiveMode) -> Result<(), Self::Error>;
    fn unregister(&mut self, path: &Path) -> Result<(), Self::Error>;
    /// inotify recursively removes separately registered descendant roots;
    /// exact-root backends must retain those registrations without re-watching.
    fn unregister_removes_descendants(&self) -> bool {
        false
    }
}

impl WatchRegistration for RecommendedWatcher {
    type Error = notify::Error;

    fn register(&mut self, path: &Path, mode: RecursiveMode) -> Result<(), Self::Error> {
        self.watch(path, mode)
    }

    fn unregister(&mut self, path: &Path) -> Result<(), Self::Error> {
        match self.unwatch(path) {
            // A previous partial removal or ancestor removal may have already
            // retired this root. Treat its absence as completed cleanup.
            Err(error) if matches!(error.kind, notify::ErrorKind::WatchNotFound) => Ok(()),
            result => result,
        }
    }

    fn unregister_removes_descendants(&self) -> bool {
        // These are the platforms where notify uses INotifyWatcher.
        cfg!(any(target_os = "linux", target_os = "android"))
    }
}

impl WatchPlan {
    fn watched_config_name(&self, changed: &Path) -> Option<String> {
        watched_config_name(&self.config_dir, changed).or_else(|| {
            let changed = std::fs::canonicalize(changed).ok()?;
            if let Some(filename) = self.external_files.get(&changed) {
                return Some(filename.clone());
            }
            let theme = changed
                .strip_prefix(self.external_themes_dir.as_ref()?)
                .ok()?;
            match theme.components().collect::<Vec<_>>().as_slice() {
                [std::path::Component::Normal(name)] if name.to_str()?.ends_with(".css") => {
                    Some(format!("{THEMES_DIR}/{}", name.to_str()?))
                }
                _ => None,
            }
        })
    }
}

/// Resolve the filesystem roots needed to observe reloadable config files.
///
/// The plan includes any external targets reached through config-directory
/// symlinks, while reported names remain relative to `config_dir`.
fn config_watch_plan(config_dir: &Path) -> WatchPlan {
    let mut external_roots = Vec::new();
    let mut external_files = HashMap::new();
    for filename in [SETTINGS_FILE, BOOKMARKS_FILE, FOLDER_VIEWS_FILE] {
        let configured = config_dir.join(filename);
        let Ok(target) = std::fs::canonicalize(&configured) else {
            continue;
        };
        if !target.starts_with(config_dir) {
            if let Some(parent) = target.parent() {
                // Recursive coverage also handles the case where this same
                // external directory later becomes the themes target. Keeping
                // one stable mode avoids an unwatch/re-watch gap on role changes.
                external_roots.push((parent.to_path_buf(), RecursiveMode::Recursive));
                external_files.insert(target, filename.to_string());
            }
        }
    }

    let external_themes_dir = std::fs::canonicalize(config_dir.join(THEMES_DIR))
        .ok()
        .filter(|target| !target.starts_with(config_dir));
    if let Some(themes_dir) = &external_themes_dir {
        external_roots.push((themes_dir.clone(), RecursiveMode::Recursive));
    }

    external_roots.sort_by(|(left, _), (right, _)| left.cmp(right));
    external_roots.dedup_by(|(left, _), (right, _)| left == right);
    WatchPlan {
        config_dir: config_dir.to_path_buf(),
        external_roots,
        external_files,
        external_themes_dir,
    }
}

/// How long dropping a harness waits for its refresh worker before giving up.
const DROP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
/// Poll interval while waiting for the refresh worker to finish.
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// What the refresh worker is doing, so a stuck teardown can name the
/// watcher operation it is blocked in instead of hanging silently.
#[derive(Clone, Debug, PartialEq, Eq)]
enum WorkerPhase {
    Waiting,
    ResolvingPlan,
    Registering(PathBuf),
    Unregistering(PathBuf),
    StoppingWatcher,
    Exited,
}

impl Display for WorkerPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Waiting => f.write_str("waiting for the next plan refresh"),
            Self::ResolvingPlan => f.write_str("resolving config symlink targets"),
            Self::Registering(root) => write!(f, "registering watch on {}", root.display()),
            Self::Unregistering(root) => {
                write!(f, "unregistering watch on {}", root.display())
            }
            Self::StoppingWatcher => f.write_str("stopping the filesystem watcher"),
            Self::Exited => f.write_str("exited"),
        }
    }
}

/// The refresh worker's current phase and when it entered it.
struct PhaseRecorder(Mutex<(WorkerPhase, Instant)>);

impl Default for PhaseRecorder {
    fn default() -> Self {
        Self(Mutex::new((WorkerPhase::Waiting, Instant::now())))
    }
}

impl PhaseRecorder {
    fn enter(&self, phase: WorkerPhase) {
        if let Ok(mut current) = self.0.lock() {
            *current = (phase, Instant::now());
        }
    }

    fn describe(&self) -> String {
        match self.0.lock() {
            Ok(current) => format!("{} for {:?}", current.0, current.1.elapsed()),
            Err(_) => "unknown (phase lock poisoned)".to_string(),
        }
    }
}

/// A stop request the refresh worker observes between plan refreshes.
#[derive(Default)]
struct StopSignal {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl StopSignal {
    fn request(&self) {
        if let Ok(mut stopped) = self.stopped.lock() {
            *stopped = true;
        }
        self.wake.notify_all();
    }

    /// Wait up to `timeout`; returns whether a stop was requested. A request
    /// made before the wait began is observed immediately, not after a full
    /// refresh interval.
    fn wait(&self, timeout: Duration) -> bool {
        let Ok(stopped) = self.stopped.lock() else {
            return true;
        };
        match self
            .wake
            .wait_timeout_while(stopped, timeout, |stopped| !*stopped)
        {
            Ok((stopped, _)) => *stopped,
            Err(_) => true,
        }
    }
}

/// The refresh worker did not stop cleanly.
#[derive(Debug)]
pub enum ShutdownError {
    /// The worker was still running after the deadline; it has been detached.
    TimedOut { waited: Duration, phase: String },
    /// The worker panicked.
    WorkerPanicked,
}

impl Display for ShutdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TimedOut { waited, phase } => write!(
                f,
                "config watcher worker did not stop within {waited:?}; it has been {phase}"
            ),
            Self::WorkerPanicked => f.write_str("config watcher worker panicked"),
        }
    }
}

/// A small real-watcher harness for consumers that need to verify config
/// autoreload behaviour without constructing a Tauri application.
///
/// The refresh worker owns the filesystem watcher, so the watcher stops only
/// once the worker exits. Teardown is bounded: [`ConfigWatchHarness::shutdown`]
/// reports a worker that does not exit in time, naming the phase it is stuck
/// in, and dropping the harness waits at most `DROP_SHUTDOWN_TIMEOUT` (10 s).
pub struct ConfigWatchHarness {
    stop: Arc<StopSignal>,
    phase: Arc<PhaseRecorder>,
    worker: Option<JoinHandle<()>>,
}

impl ConfigWatchHarness {
    /// Stop watching and wait up to `timeout` for the worker to release the
    /// watcher. After an error the worker is detached, never joined.
    pub fn shutdown(mut self, timeout: Duration) -> Result<(), ShutdownError> {
        self.stop_within(timeout)
    }

    fn stop_within(&mut self, timeout: Duration) -> Result<(), ShutdownError> {
        self.stop.request();
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        let deadline = Instant::now() + timeout;
        while !worker.is_finished() {
            if Instant::now() >= deadline {
                return Err(ShutdownError::TimedOut {
                    waited: timeout,
                    phase: self.phase.describe(),
                });
            }
            std::thread::sleep(SHUTDOWN_POLL_INTERVAL);
        }
        worker.join().map_err(|_| ShutdownError::WorkerPanicked)
    }
}

impl Drop for ConfigWatchHarness {
    fn drop(&mut self) {
        if let Err(error) = self.stop_within(DROP_SHUTDOWN_TIMEOUT) {
            log::error!("{error}");
            eprintln!("{error}");
        }
    }
}

/// Watch `config_dir`, including external symlink targets, and report the
/// frontend-visible filename for every relevant write.
pub fn watch_config_changes<F>(
    config_dir: PathBuf,
    on_change: F,
) -> notify::Result<ConfigWatchHarness>
where
    F: Fn(String) + Send + Sync + 'static,
{
    watch_config_changes_with_source(config_dir, move |name, _source| on_change(name))
}

/// Map an event's paths to the reloadable config names they affect.
///
/// This is the only lock the event callback takes. The refresh worker holds
/// it just long enough to swap plans, never across a watcher call (#913).
fn map_event_paths(plan: &Mutex<WatchPlan>, paths: &[PathBuf]) -> Vec<(String, PathBuf)> {
    let Ok(plan) = plan.lock() else {
        return Vec::new();
    };
    paths
        .iter()
        .filter_map(|path| {
            plan.watched_config_name(path)
                .map(|name| (name, path.clone()))
        })
        .collect()
}

fn watch_config_changes_with_source<F>(
    config_dir: PathBuf,
    on_change: F,
) -> notify::Result<ConfigWatchHarness>
where
    F: Fn(String, PathBuf) + Send + Sync + 'static,
{
    let initial_plan = config_watch_plan(&config_dir);
    let external_roots = initial_plan.external_roots.clone();
    let plan = Arc::new(Mutex::new(initial_plan));
    let callback_plan = Arc::clone(&plan);
    let callback_config_dir = config_dir.clone();
    let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let event = match result {
            Ok(event) => event,
            Err(error) => {
                log::warn!(
                    "Config autoreload watcher error for {}: {error}",
                    callback_config_dir.display()
                );
                return;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for (name, source) in map_event_paths(&callback_plan, &event.paths) {
            on_change(name, source);
        }
    })?;
    watcher.watch(&config_dir, RecursiveMode::Recursive)?;
    for (root, mode) in &external_roots {
        watcher.watch(root, *mode)?;
    }
    let registrations = Registrations::new(watcher, external_roots.into_iter().collect());

    let stop = Arc::new(StopSignal::default());
    let phase = Arc::new(PhaseRecorder::default());
    let worker = {
        let stop = Arc::clone(&stop);
        let phase = Arc::clone(&phase);
        std::thread::Builder::new()
            .name("config-watch-refresh".into())
            .spawn(move || run_refresh_worker(&config_dir, &plan, registrations, &stop, &phase))
            .map_err(notify::Error::io)?
    };
    Ok(ConfigWatchHarness {
        stop,
        phase,
        worker: Some(worker),
    })
}

/// Periodically re-resolve symlink targets until stopped, then drop the
/// watcher on this thread so a blocked stop is attributed to the worker.
fn run_refresh_worker(
    config_dir: &Path,
    plan: &Mutex<WatchPlan>,
    mut registrations: Registrations<RecommendedWatcher>,
    stop: &StopSignal,
    phase: &PhaseRecorder,
) {
    while !stop.wait(WATCH_PLAN_REFRESH_INTERVAL) {
        phase.enter(WorkerPhase::ResolvingPlan);
        let replacement = config_watch_plan(config_dir);
        reconcile_watch_plan(replacement, plan, &mut registrations, phase);
        phase.enter(WorkerPhase::Waiting);
    }
    phase.enter(WorkerPhase::StoppingWatcher);
    drop(registrations);
    phase.enter(WorkerPhase::Exited);
}

/// Keep the watcher alive for the process lifetime; dropping it stops it.
static CONFIG_WATCHER: OnceLock<ConfigWatchHarness> = OnceLock::new();

/// Config-relative names with a pending change, keyed by their latest event.
static PENDING: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Instant>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Map a changed absolute path to the config-relative name the frontend acts
/// on, or `None` when the change is not one of those.
///
/// This is also what filters out our own atomic-write temp files
/// (`.settings.json.tmp-<pid>`): they are neither `settings.json` nor a
/// `.css` file under `themes/`, so they never match.
pub(crate) fn watched_config_name(config_dir: &Path, changed: &Path) -> Option<String> {
    let relative = changed.strip_prefix(config_dir).ok()?;
    let parts: Vec<&str> = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;

    match parts.as_slice() {
        [name]
            if *name == SETTINGS_FILE || *name == BOOKMARKS_FILE || *name == FOLDER_VIEWS_FILE =>
        {
            Some((*name).to_string())
        }
        [THEMES_DIR, theme] if theme.ends_with(".css") => Some(format!("{THEMES_DIR}/{theme}")),
        _ => {
            let changed = std::fs::canonicalize(changed).ok()?;
            for filename in [SETTINGS_FILE, BOOKMARKS_FILE, FOLDER_VIEWS_FILE] {
                if std::fs::canonicalize(config_dir.join(filename))
                    .ok()
                    .as_ref()
                    == Some(&changed)
                {
                    return Some(filename.to_string());
                }
            }
            None
        }
    }
}

/// Start watching the config directory. Call once during app setup.
///
/// Degrades to no autoreload (never panics) if the directory or the OS watch
/// is unavailable — the app is fully usable without it.
pub fn init_config_watcher(app: &AppHandle) {
    let config_dir = match crate::config::config_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("Config autoreload disabled (no config dir): {error}");
            return;
        }
    };
    // Canonicalize before watching. Dotfile managers routinely symlink the
    // whole config directory into a repo, and a watch on the link reports
    // nothing; macOS FSEvents additionally reports canonical paths, which
    // would make every `strip_prefix` below fail. Watching the resolved
    // directory fixes both. (A symlinked *individual file* inside a real
    // config dir is still not covered — see #604.)
    let config_dir = std::fs::canonicalize(&config_dir).unwrap_or(config_dir);

    let watcher = match watch_config_changes(config_dir.clone(), |name| {
        if let Ok(mut map) = pending().lock() {
            map.insert(name, Instant::now());
        }
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            log::error!("Config autoreload disabled (watcher unavailable): {error}");
            return;
        }
    };
    if CONFIG_WATCHER.set(watcher).is_err() {
        log::warn!("Config watcher already initialized");
        return;
    }

    spawn_flush_thread(app.clone());
    log::info!(
        "Config autoreload watching {}",
        config_dir.to_string_lossy()
    );
}

/// Emit `config-file-changed` once a file has been quiet for the debounce
/// window, so one editor save yields one reload.
fn spawn_flush_thread(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(FLUSH_INTERVAL);

        let ready: Vec<String> = {
            let Ok(mut map) = pending().lock() else {
                continue;
            };
            let now = Instant::now();
            let ready: Vec<String> = map
                .iter()
                .filter(|(_, last)| now.duration_since(**last) >= DEBOUNCE)
                .map(|(name, _)| name.clone())
                .collect();
            for name in &ready {
                map.remove(name);
            }
            ready
        };

        for filename in ready {
            log::debug!("config-file-changed: {filename}");
            if let Err(error) = app.emit(
                "config-file-changed",
                ConfigChangedPayload {
                    filename: filename.clone(),
                },
            ) {
                log::warn!("Failed to emit config-file-changed for {filename}: {error}");
            }
        }
    });
}

/// Move the watcher to `replacement`'s external roots and publish it as the
/// callback's mapping.
///
/// The plan lock is held only to swap plans, never across `register` or
/// `unregister`: those calls wait for the backend thread that runs the event
/// callback, and that callback takes the plan lock (#913). The replacement is
/// published before new roots are registered, so the first event a new root
/// delivers is already mapped and an event from a retired root is already
/// filtered. If a registration fails, the previous plan is restored and its
/// roots stay watched; successful additions are retained for the next retry.
/// Removing a recursive ancestor can also remove surviving descendants on
/// inotify. Invalidate their registration records and restore that coverage
/// after all retirements, including the permanent config-directory watch.
fn reconcile_watch_plan<W: WatchRegistration>(
    replacement: WatchPlan,
    plan: &Mutex<WatchPlan>,
    registrations: &mut Registrations<W>,
    phase: &PhaseRecorder,
) {
    let config_dir = replacement.config_dir.clone();
    let required_roots = replacement.external_roots.clone();
    restore_config_root(&config_dir, registrations, phase);
    let additions: Vec<(PathBuf, RecursiveMode)> = replacement
        .external_roots
        .iter()
        .filter(|(root, mode)| registrations.external_roots.get(root) != Some(mode))
        .cloned()
        .collect();
    let stale: Vec<PathBuf> = registrations
        .external_roots
        .keys()
        .filter(|root| {
            !replacement
                .external_roots
                .iter()
                .any(|(current, _)| current == *root)
        })
        .cloned()
        .collect();
    let previous = match plan.lock() {
        Ok(mut current) => std::mem::replace(&mut *current, replacement),
        Err(_) => return,
    };

    for (root, mode) in additions {
        phase.enter(WorkerPhase::Registering(root.clone()));
        if let Err(error) = registrations.watcher.register(&root, mode) {
            log::warn!(
                "Config autoreload cannot watch updated symlink target {}: {error}",
                root.display()
            );
            if let Ok(mut current) = plan.lock() {
                *current = previous;
            }
            return;
        }
        registrations.external_roots.insert(root, mode);
    }

    for root in stale {
        phase.enter(WorkerPhase::Unregistering(root.clone()));
        let result = registrations.watcher.unregister(&root);
        if registrations.watcher.unregister_removes_descendants() {
            // Even a failed removal can partially change native coverage.
            // Invalidate surviving descendants, but retain every obsolete root
            // until its own cleanup succeeds: a partial ancestor removal may
            // have left its native descendant watches running.
            registrations.external_roots.retain(|current, _| {
                !current.starts_with(&root)
                    || !required_roots
                        .iter()
                        .any(|(required, _)| required == current)
            });
            if config_dir.starts_with(&root) {
                registrations.config_root_needs_restore = true;
            }
        }
        match result {
            Ok(()) => {
                registrations.external_roots.remove(&root);
            }
            Err(error) => log::warn!(
                "Config autoreload cannot retire old symlink target {}: {error}",
                root.display()
            ),
        }
    }

    restore_config_root(&config_dir, registrations, phase);
    for (root, mode) in required_roots {
        if registrations.external_roots.get(&root) == Some(&mode) {
            continue;
        }
        phase.enter(WorkerPhase::Registering(root.clone()));
        match registrations.watcher.register(&root, mode) {
            Ok(()) => {
                registrations.external_roots.insert(root, mode);
            }
            Err(error) => log::warn!(
                "Config autoreload cannot restore surviving symlink target {}: {error}",
                root.display()
            ),
        }
        // Failed restorations remain absent from external_roots, so the next
        // refresh retries them as additions rather than assuming coverage.
    }
}

fn restore_config_root<W: WatchRegistration>(
    config_dir: &Path,
    registrations: &mut Registrations<W>,
    phase: &PhaseRecorder,
) {
    if !registrations.config_root_needs_restore {
        return;
    }
    phase.enter(WorkerPhase::Registering(config_dir.to_path_buf()));
    match registrations
        .watcher
        .register(config_dir, RecursiveMode::Recursive)
    {
        Ok(()) => registrations.config_root_needs_restore = false,
        Err(error) => log::warn!(
            "Config autoreload cannot restore config directory {}: {error}",
            config_dir.display()
        ),
    }
}

/// Path of the config file the frontend reloads, for tests and diagnostics.
#[cfg(test)]
fn settings_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(SETTINGS_FILE)
}

#[cfg(test)]
#[path = "../test_support/config_watch_nested_roots_test.rs"]
mod nested_root_tests;

#[cfg(test)]
#[path = "../test_support/config_watch_registration_contracts_test.rs"]
mod registration_contract_tests;

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::THEMES_DIR;
    use super::{
        map_event_paths, pending, reconcile_watch_plan, settings_path, watched_config_name,
        ConfigWatchHarness, PhaseRecorder, Registrations, ShutdownError, StopSignal, WatchPlan,
        WatchRegistration, WorkerPhase, BOOKMARKS_FILE, FOLDER_VIEWS_FILE, SETTINGS_FILE,
    };
    use notify::{RecommendedWatcher, RecursiveMode, Watcher};
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct RecordingWatcher {
        registered: HashSet<PathBuf>,
        operations: Vec<(String, PathBuf)>,
        fail_registration: Option<PathBuf>,
    }

    impl WatchRegistration for RecordingWatcher {
        type Error = &'static str;

        fn register(&mut self, path: &Path, _mode: RecursiveMode) -> Result<(), Self::Error> {
            self.operations.push(("watch".into(), path.to_path_buf()));
            if self.fail_registration.as_deref() == Some(path) {
                return Err("injected registration failure");
            }
            self.registered.insert(path.to_path_buf());
            Ok(())
        }

        fn unregister(&mut self, path: &Path) -> Result<(), Self::Error> {
            self.operations.push(("unwatch".into(), path.to_path_buf()));
            self.registered.remove(path);
            Ok(())
        }
    }

    fn plan(config_dir: &Path, root: Option<&Path>) -> WatchPlan {
        let mut external_files = HashMap::new();
        let external_roots = root.map_or_else(Vec::new, |root| {
            // Production keys external files by canonical target, and matching
            // canonicalizes the changed path (`\\?\` on Windows, /private on macOS).
            let file = root.join(SETTINGS_FILE);
            let key = std::fs::canonicalize(&file).unwrap_or(file);
            external_files.insert(key, SETTINGS_FILE.to_string());
            vec![(root.to_path_buf(), RecursiveMode::NonRecursive)]
        });
        WatchPlan {
            config_dir: config_dir.to_path_buf(),
            external_roots,
            external_files,
            external_themes_dir: None,
        }
    }

    /// The published plan plus a watcher already registered on its roots.
    fn installed<W: WatchRegistration>(
        initial: WatchPlan,
        watcher: W,
    ) -> (Arc<Mutex<WatchPlan>>, Registrations<W>) {
        let registrations =
            Registrations::new(watcher, initial.external_roots.iter().cloned().collect());
        (Arc::new(Mutex::new(initial)), registrations)
    }

    fn reported(plan: &Mutex<WatchPlan>, changed: &Path) -> Option<String> {
        map_event_paths(plan, &[changed.to_path_buf()])
            .into_iter()
            .next()
            .map(|(name, _)| name)
    }

    #[test]
    fn repeated_retargets_watch_new_before_retiring_old_without_growth() {
        let config = Path::new("/config");
        let first = Path::new("/targets/0");
        let (current, mut registrations) = installed(
            plan(config, Some(first)),
            RecordingWatcher {
                registered: HashSet::from([first.to_path_buf()]),
                ..Default::default()
            },
        );
        let phase = PhaseRecorder::default();

        for index in 1..1000 {
            let next = PathBuf::from(format!("/targets/{index}"));
            reconcile_watch_plan(
                plan(config, Some(&next)),
                &current,
                &mut registrations,
                &phase,
            );
            let watcher = &registrations.watcher;
            assert_eq!(watcher.registered, HashSet::from([next.clone()]));
            let tail = &watcher.operations[watcher.operations.len() - 2..];
            assert_eq!(tail[0], ("watch".into(), next));
            assert_eq!(tail[1].0, "unwatch");
        }
    }

    #[test]
    fn failed_new_registration_keeps_old_plan_and_watch_until_retry() {
        let temp = tempfile::tempdir().expect("temp roots");
        let config = temp.path().join("config");
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        std::fs::create_dir_all(&config).expect("config dir");
        std::fs::create_dir_all(&old).expect("old target");
        std::fs::create_dir_all(&new).expect("new target");
        std::fs::write(old.join(SETTINGS_FILE), "{}").expect("old settings");
        std::fs::write(new.join(SETTINGS_FILE), "{}").expect("new settings");
        let (current, mut registrations) = installed(
            plan(&config, Some(&old)),
            RecordingWatcher {
                registered: HashSet::from([old.clone()]),
                fail_registration: Some(new.clone()),
                ..Default::default()
            },
        );
        let phase = PhaseRecorder::default();

        reconcile_watch_plan(
            plan(&config, Some(&new)),
            &current,
            &mut registrations,
            &phase,
        );
        assert_eq!(
            registrations.watcher.registered,
            HashSet::from([old.clone()])
        );
        assert_eq!(
            reported(&current, &old.join(SETTINGS_FILE)),
            Some(SETTINGS_FILE.to_string())
        );
        assert_eq!(reported(&current, &new.join(SETTINGS_FILE)), None);

        registrations.watcher.fail_registration = None;
        reconcile_watch_plan(
            plan(&config, Some(&new)),
            &current,
            &mut registrations,
            &phase,
        );
        assert_eq!(
            registrations.watcher.registered,
            HashSet::from([new.clone()])
        );
        assert_eq!(
            reported(&current, &new.join(SETTINGS_FILE)),
            Some(SETTINGS_FILE.to_string())
        );
    }

    #[test]
    fn delayed_old_callbacks_are_filtered_after_handover_and_final_plan_retires_external_watch() {
        let temp = tempfile::tempdir().expect("temp roots");
        let config = temp.path().join("config");
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        std::fs::create_dir_all(&config).expect("config dir");
        std::fs::create_dir_all(&old).expect("old target");
        std::fs::create_dir_all(&new).expect("new target");
        std::fs::write(old.join(SETTINGS_FILE), "{}").expect("old settings");
        std::fs::write(new.join(SETTINGS_FILE), "{}").expect("new settings");
        let (current, mut registrations) = installed(
            plan(&config, Some(&old)),
            RecordingWatcher {
                registered: HashSet::from([old.clone()]),
                ..Default::default()
            },
        );
        let phase = PhaseRecorder::default();

        reconcile_watch_plan(
            plan(&config, Some(&new)),
            &current,
            &mut registrations,
            &phase,
        );
        assert_eq!(reported(&current, &old.join(SETTINGS_FILE)), None);
        assert_eq!(
            reported(&current, &new.join(SETTINGS_FILE)),
            Some(SETTINGS_FILE.to_string())
        );

        reconcile_watch_plan(plan(&config, None), &current, &mut registrations, &phase);
        assert!(registrations.watcher.registered.is_empty());
    }

    /// Models the contract every notify backend has: `watch`/`unwatch` wait
    /// for the backend thread, which may first have to finish delivering an
    /// event to the callback. Here each call delivers one event from the
    /// affected root through the production mapping on another thread and
    /// waits (boundedly) for it, recording what the callback reported.
    struct CallbackCoupledWatcher {
        plan: Arc<Mutex<WatchPlan>>,
        delivered: Vec<(PathBuf, Option<String>)>,
        blocked: Vec<PathBuf>,
    }

    impl CallbackCoupledWatcher {
        fn deliver_event_from(&mut self, root: &Path) -> Result<(), &'static str> {
            let plan = Arc::clone(&self.plan);
            let changed = root.join(SETTINGS_FILE);
            let (sent, received) = mpsc::channel();
            let event = changed.clone();
            std::thread::spawn(move || {
                let name = map_event_paths(&plan, &[event]).into_iter().next();
                let _ = sent.send(name.map(|(name, _)| name));
            });
            match received.recv_timeout(Duration::from_secs(5)) {
                Ok(name) => {
                    self.delivered.push((changed, name));
                    Ok(())
                }
                Err(_) => {
                    self.blocked.push(root.to_path_buf());
                    Err("event callback was blocked while the watcher waited for it")
                }
            }
        }
    }

    impl WatchRegistration for CallbackCoupledWatcher {
        type Error = &'static str;

        fn register(&mut self, path: &Path, _mode: RecursiveMode) -> Result<(), Self::Error> {
            self.deliver_event_from(path)
        }

        fn unregister(&mut self, path: &Path) -> Result<(), Self::Error> {
            self.deliver_event_from(path)
        }
    }

    /// #913: holding the plan lock across `watch`/`unwatch` deadlocked the
    /// refresh worker against the backend's callback thread.
    #[test]
    fn watcher_registration_never_waits_on_a_blocked_event_callback() {
        let temp = tempfile::tempdir().expect("temp roots");
        let config = temp.path().join("config");
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        for dir in [&config, &old, &new] {
            std::fs::create_dir_all(dir).expect("fixture dir");
        }
        std::fs::write(old.join(SETTINGS_FILE), "{}").expect("old settings");
        std::fs::write(new.join(SETTINGS_FILE), "{}").expect("new settings");
        let current = Arc::new(Mutex::new(plan(&config, Some(&old))));
        let mut registrations = Registrations::new(
            CallbackCoupledWatcher {
                plan: Arc::clone(&current),
                delivered: Vec::new(),
                blocked: Vec::new(),
            },
            HashMap::from([(old.clone(), RecursiveMode::NonRecursive)]),
        );

        reconcile_watch_plan(
            plan(&config, Some(&new)),
            &current,
            &mut registrations,
            &PhaseRecorder::default(),
        );

        let watcher = &registrations.watcher;
        assert!(
            watcher.blocked.is_empty(),
            "callback blocked during: {:?}",
            watcher.blocked
        );
        // The first event from the new target is already reported, and one
        // from the retiring target is already filtered.
        assert_eq!(
            watcher.delivered,
            vec![
                (new.join(SETTINGS_FILE), Some(SETTINGS_FILE.to_string())),
                (old.join(SETTINGS_FILE), None),
            ]
        );
        assert_eq!(
            reported(&current, &new.join(SETTINGS_FILE)),
            Some(SETTINGS_FILE.to_string())
        );
    }

    /// The same inversion against the platform's real backend: hand the
    /// watch back and forth while both targets are written continuously.
    #[test]
    fn real_watcher_handover_under_event_load_does_not_deadlock() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let temp = tempfile::tempdir().expect("temp roots");
        let config = temp.path().join("config");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        for dir in [&config, &first, &second] {
            std::fs::create_dir_all(dir).expect("fixture dir");
            std::fs::write(dir.join(SETTINGS_FILE), "{}").expect("fixture settings");
        }
        let first = std::fs::canonicalize(first).expect("canonical first");
        let second = std::fs::canonicalize(second).expect("canonical second");

        let current = Arc::new(Mutex::new(plan(&config, Some(&first))));
        let callback_plan = Arc::clone(&current);
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if let Ok(event) = event {
                    let _ = map_event_paths(&callback_plan, &event.paths);
                }
            })
            .expect("watcher");
        watcher
            .watch(&first, RecursiveMode::NonRecursive)
            .expect("initial watch");
        let mut registrations = Registrations::new(
            watcher,
            HashMap::from([(first.clone(), RecursiveMode::NonRecursive)]),
        );

        let writing = Arc::new(AtomicBool::new(true));
        let writer = {
            let writing = Arc::clone(&writing);
            let targets = [first.join(SETTINGS_FILE), second.join(SETTINGS_FILE)];
            std::thread::spawn(move || {
                let mut revision = 0u64;
                while writing.load(Ordering::Relaxed) {
                    for target in &targets {
                        std::fs::write(target, revision.to_string()).expect("load write");
                    }
                    revision += 1;
                    // Paced: an unbroken write storm starves inotify's event
                    // loop of the watch request itself, which is backend
                    // fairness, not the lock inversion this test targets.
                    std::thread::sleep(Duration::from_millis(1));
                }
            })
        };

        const HANDOVERS: usize = 40;
        let phase = Arc::new(PhaseRecorder::default());
        let (progress, handovers) = mpsc::channel();
        let worker = {
            let phase = Arc::clone(&phase);
            std::thread::spawn(move || {
                for index in 0..HANDOVERS {
                    let next = if index % 2 == 0 { &second } else { &first };
                    reconcile_watch_plan(
                        plan(&config, Some(next)),
                        &current,
                        &mut registrations,
                        &phase,
                    );
                    let _ = progress.send(index);
                }
            })
        };
        for expected in 0..HANDOVERS {
            match handovers.recv_timeout(Duration::from_secs(10)) {
                Ok(index) => assert_eq!(index, expected),
                Err(_) => {
                    writing.store(false, Ordering::Relaxed);
                    panic!(
                        "handover {expected} did not finish within 10 s; the worker has been {}",
                        phase.describe()
                    );
                }
            }
        }
        writing.store(false, Ordering::Relaxed);
        writer.join().expect("writer");
        worker.join().expect("worker");
    }

    /// Blocks `register` until the test releases it, like a watcher backend
    /// that never answers.
    struct StuckWatcher(Arc<Mutex<()>>);

    impl WatchRegistration for StuckWatcher {
        type Error = &'static str;

        fn register(&mut self, _path: &Path, _mode: RecursiveMode) -> Result<(), Self::Error> {
            let _released = self.0.lock();
            Ok(())
        }

        fn unregister(&mut self, _path: &Path) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    #[test]
    fn shutdown_of_a_stuck_worker_fails_within_its_deadline_and_names_the_phase() {
        let config = Path::new("/config");
        let target = Path::new("/targets/unanswered");
        let gate = Arc::new(Mutex::new(()));
        let held = gate.lock().expect("gate");
        let phase = Arc::new(PhaseRecorder::default());
        let (entered, entered_register) = mpsc::channel();
        let worker = {
            let phase = Arc::clone(&phase);
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || {
                let current = Mutex::new(plan(config, None));
                let mut registrations = Registrations::new(StuckWatcher(gate), HashMap::new());
                let _ = entered.send(());
                reconcile_watch_plan(
                    plan(config, Some(target)),
                    &current,
                    &mut registrations,
                    &phase,
                );
            })
        };
        entered_register.recv().expect("worker started");
        let deadline = Instant::now() + Duration::from_secs(5);
        while phase.describe().starts_with("waiting") && Instant::now() < deadline {
            std::thread::yield_now();
        }
        let harness = ConfigWatchHarness {
            stop: Arc::new(StopSignal::default()),
            phase: Arc::clone(&phase),
            worker: Some(worker),
        };

        let started = Instant::now();
        let error = harness
            .shutdown(Duration::from_millis(200))
            .expect_err("a stuck worker must not report a clean shutdown");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(matches!(error, ShutdownError::TimedOut { .. }));
        let message = error.to_string();
        assert!(
            message.contains(&WorkerPhase::Registering(target.to_path_buf()).to_string()),
            "{message}"
        );
        drop(held);
    }

    #[test]
    fn a_stop_requested_before_the_worker_waits_is_observed_immediately() {
        let stop = StopSignal::default();
        stop.request();
        let started = Instant::now();
        assert!(stop.wait(Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!StopSignal::default().wait(Duration::from_millis(1)));
    }

    #[test]
    fn reports_reloadable_json_blobs_and_user_theme_css() {
        let dir = Path::new("/home/u/.config/tauri-explorer");
        assert_eq!(
            watched_config_name(dir, &settings_path(dir)),
            Some("settings.json".to_string())
        );
        assert_eq!(
            watched_config_name(dir, &dir.join("themes").join("midnight.css")),
            Some("themes/midnight.css".to_string())
        );
        assert_eq!(
            watched_config_name(dir, &dir.join("bookmarks.json")),
            Some("bookmarks.json".to_string())
        );
        assert_eq!(
            watched_config_name(dir, &dir.join("folder-views.json")),
            Some("folder-views.json".to_string())
        );
    }

    #[test]
    fn ignores_files_no_listener_reacts_to() {
        let dir = Path::new("/home/u/.config/tauri-explorer");
        for path in [
            dir.join("window-state.json"),
            dir.join("themes").join("notes.txt"),
            dir.join("themes").join("nested").join("deep.css"),
            Path::new("/home/u/.config/other-app/settings.json").to_path_buf(),
        ] {
            assert_eq!(
                watched_config_name(dir, &path),
                None,
                "{} should not be reported",
                path.display()
            );
        }
    }

    /// `write_atomic` stages `.settings.json.tmp-<pid>` beside the target and
    /// renames it over. The staged file must not look like a settings change,
    /// or every save the app makes would emit twice.
    #[test]
    fn ignores_the_atomic_write_staging_file() {
        let dir = Path::new("/home/u/.config/tauri-explorer");
        assert_eq!(
            watched_config_name(dir, &dir.join(".settings.json.tmp-4242")),
            None
        );
    }

    #[test]
    fn real_filesystem_events_queue_both_live_reload_blobs() {
        let temp = tempfile::tempdir().expect("temporary config directory");
        let root = temp.path().to_path_buf();
        pending().lock().expect("pending lock").clear();
        let (sent, received) = mpsc::channel();
        let callback_root = root.clone();
        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        if let Some(filename) = watched_config_name(&callback_root, &path) {
                            pending()
                                .lock()
                                .expect("pending lock")
                                .insert(filename.clone(), Instant::now());
                            let _ = sent.send(filename);
                        }
                    }
                }
            })
            .expect("watcher");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("watch temporary config directory");

        std::fs::write(root.join(BOOKMARKS_FILE), "[]").expect("external bookmarks edit");
        std::fs::write(root.join(FOLDER_VIEWS_FILE), "{}").expect("external folder views edit");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut observed = Vec::new();
        while Instant::now() < deadline && observed.len() < 2 {
            if let Ok(filename) = received.recv_timeout(Duration::from_millis(100)) {
                if !observed.contains(&filename) {
                    observed.push(filename);
                }
            }
        }
        observed.sort();
        assert_eq!(observed, [BOOKMARKS_FILE, FOLDER_VIEWS_FILE]);
        let queued = pending().lock().expect("pending lock");
        assert!(queued.contains_key(BOOKMARKS_FILE));
        assert!(queued.contains_key(FOLDER_VIEWS_FILE));
    }

    #[cfg(unix)]
    #[test]
    fn real_watcher_handover_observes_new_symlink_target_and_retires_old_target() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temporary watcher tree");
        let config = temp.path().join("config");
        let old_dir = temp.path().join("old");
        let new_dir = temp.path().join("new");
        std::fs::create_dir_all(&config).expect("config dir");
        std::fs::create_dir_all(&old_dir).expect("old target dir");
        std::fs::create_dir_all(&new_dir).expect("new target dir");
        let old_file = old_dir.join(SETTINGS_FILE);
        let new_file = new_dir.join(SETTINGS_FILE);
        std::fs::write(&old_file, "old-0").expect("old target");
        std::fs::write(&new_file, "new-0").expect("new target");
        let old_root = std::fs::canonicalize(&old_dir).expect("canonical old target dir");
        let new_root = std::fs::canonicalize(&new_dir).expect("canonical new target dir");
        let old_source = old_root.join(SETTINGS_FILE);
        let new_source = new_root.join(SETTINGS_FILE);
        let configured = config.join(SETTINGS_FILE);
        symlink(&old_file, &configured).expect("initial settings symlink");
        let sentinel_source = std::fs::canonicalize(&config)
            .expect("canonical config dir")
            .join(BOOKMARKS_FILE);

        let (sent, received) = mpsc::channel();
        let config_dir = config.clone();
        let harness = super::watch_config_changes_with_source(config, move |name, source| {
            // Normalize only the parent: canonicalizing the symlink leaf
            // would mistake a config-entry event for a target-file event.
            let source = source
                .parent()
                .and_then(|parent| std::fs::canonicalize(parent).ok())
                .and_then(|parent| source.file_name().map(|file| parent.join(file)))
                .unwrap_or(source);
            let _ = sent.send((name, source));
        })
        .expect("config watcher");
        let receive_from = |expected: &Path, timeout: Duration| -> Option<String> {
            let deadline = Instant::now() + timeout;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return None;
                }
                match received.recv_timeout(remaining) {
                    Ok((name, source)) if source == expected => return Some(name),
                    Ok(_) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => return None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        panic!("config watcher stopped before the handover test completed")
                    }
                }
            }
        };

        std::fs::write(&old_file, "old-1").expect("initial target write");
        assert_eq!(
            receive_from(&old_source, Duration::from_secs(3)).as_deref(),
            Some(SETTINGS_FILE)
        );

        std::fs::remove_file(&configured).expect("remove old symlink");
        symlink(&new_file, &configured).expect("retarget settings symlink");
        // Observe an event from the actual new target instead of assuming the
        // polling worker finished within a fixed sleep under parallel CI load.
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut new_target_observed = false;
        let mut attempt = 0;
        while Instant::now() < deadline {
            std::fs::write(&new_file, format!("new-{attempt}")).expect("replacement target probe");
            if receive_from(&new_source, Duration::from_millis(100)).as_deref()
                == Some(SETTINGS_FILE)
            {
                new_target_observed = true;
                break;
            }
            attempt += 1;
        }
        assert!(new_target_observed, "replacement target was not observed");

        // The sourced new-file receipt proves the handover completed; delayed
        // config-entry events cannot substitute for it. The watcher delivers
        // one ordered event stream, so a retired-target write followed by a
        // first-ever write to another watched file needs no silence window:
        // any report of the retired write arrives before the sentinel's.
        std::fs::write(&old_file, "old-2").expect("retired target write");
        std::fs::write(config_dir.join(BOOKMARKS_FILE), "[]").expect("sentinel write");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "sentinel write was not observed");
            match received.recv_timeout(remaining) {
                Ok((_, source)) if source == old_source => {
                    panic!("a write to the retired symlink target was still reported")
                }
                Ok((name, source)) if source == sentinel_source => {
                    assert_eq!(name, BOOKMARKS_FILE);
                    break;
                }
                Ok(_) => continue,
                Err(error) => panic!("sentinel write was not observed: {error:?}"),
            }
        }

        // Bounded: a worker stuck in a watcher call fails here with the
        // phase it is blocked in rather than hanging the job (#913).
        let shutdown_started = Instant::now();
        if let Err(error) = harness.shutdown(Duration::from_secs(10)) {
            panic!("{error}");
        }
        assert!(shutdown_started.elapsed() < Duration::from_secs(1));
        // Draining the channel until its sender disconnects proves teardown;
        // a short silence window could miss a delayed callback.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "watcher callback stayed alive after teardown"
            );
            match received.recv_timeout(remaining) {
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!("watcher callback stayed alive after teardown")
                }
            }
        }
        std::fs::write(&new_file, "new-2").expect("write after teardown");
        assert!(matches!(
            received.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn shared_external_file_and_theme_root_keeps_recursive_coverage() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temporary watcher tree");
        let config = temp.path().join("config");
        let shared = temp.path().join("shared");
        std::fs::create_dir_all(&config).expect("config dir");
        std::fs::create_dir_all(&shared).expect("shared target");
        std::fs::write(shared.join(SETTINGS_FILE), "{}").expect("settings target");
        symlink(shared.join(SETTINGS_FILE), config.join(SETTINGS_FILE)).expect("settings symlink");
        symlink(&shared, config.join(THEMES_DIR)).expect("themes symlink");

        let plan = super::config_watch_plan(&config);
        assert_eq!(
            plan.external_roots,
            vec![(
                std::fs::canonicalize(shared).expect("canonical shared root"),
                RecursiveMode::Recursive,
            )]
        );
    }
}
