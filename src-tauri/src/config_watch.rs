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
use std::collections::HashMap;
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

struct WatchState {
    plan: WatchPlan,
    registered_external_roots: HashMap<PathBuf, RecursiveMode>,
}

trait WatchRegistration {
    type Error: Display;
    fn register(&mut self, path: &Path, mode: RecursiveMode) -> Result<(), Self::Error>;
    fn unregister(&mut self, path: &Path) -> Result<(), Self::Error>;
}

impl WatchRegistration for RecommendedWatcher {
    type Error = notify::Error;

    fn register(&mut self, path: &Path, mode: RecursiveMode) -> Result<(), Self::Error> {
        self.watch(path, mode)
    }

    fn unregister(&mut self, path: &Path) -> Result<(), Self::Error> {
        self.unwatch(path)
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

/// A small real-watcher harness for consumers that need to verify config
/// autoreload behaviour without constructing a Tauri application.
pub struct ConfigWatchHarness {
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
    _watcher: Arc<Mutex<RecommendedWatcher>>,
}

impl Drop for ConfigWatchHarness {
    fn drop(&mut self) {
        let (lock, wake) = &*self.stop;
        if let Ok(mut stopped) = lock.lock() {
            *stopped = true;
            wake.notify_all();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
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
    let initial_plan = config_watch_plan(&config_dir);
    let watch_state = Arc::new(Mutex::new(WatchState {
        plan: initial_plan.clone(),
        registered_external_roots: HashMap::new(),
    }));
    let callback_state = Arc::clone(&watch_state);
    let on_change = Arc::new(on_change);
    let callback = Arc::clone(&on_change);
    let callback_config_dir = config_dir.clone();
    let watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
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
        let names = {
            let Ok(state) = callback_state.lock() else {
                return;
            };
            event
                .paths
                .iter()
                .filter_map(|path| state.plan.watched_config_name(path))
                .collect::<Vec<_>>()
        };
        for name in names {
            callback(name);
        }
    })?;
    let watcher = Arc::new(Mutex::new(watcher));
    {
        let mut watcher = watcher.lock().expect("config watcher lock");
        watcher.watch(&config_dir, RecursiveMode::Recursive)?;
        for (root, mode) in &initial_plan.external_roots {
            watcher.watch(root, *mode)?;
            watch_state
                .lock()
                .expect("config watch state lock")
                .registered_external_roots
                .insert(root.clone(), *mode);
        }
    }

    let stop = Arc::new((Mutex::new(false), Condvar::new()));
    let refresh_stop = Arc::clone(&stop);
    let refresh_watcher = Arc::clone(&watcher);
    let worker = std::thread::spawn(move || loop {
        let (lock, wake) = &*refresh_stop;
        let Ok(stopped) = lock.lock() else {
            break;
        };
        let Ok((stopped, _)) = wake.wait_timeout(stopped, WATCH_PLAN_REFRESH_INTERVAL) else {
            break;
        };
        if *stopped {
            break;
        }
        drop(stopped);
        if let Ok(mut watcher) = refresh_watcher.lock() {
            apply_watch_plan_update(&config_dir, &watch_state, &mut *watcher);
        }
    });
    Ok(ConfigWatchHarness {
        stop,
        worker: Some(worker),
        _watcher: watcher,
    })
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

/// Register newly resolved external roots while holding the plan lock. The
/// callback takes the same lock before mapping an event, so it cannot see a
/// new root with the old plan in the small interval after `watch` succeeds.
fn apply_watch_plan_update(
    config_dir: &Path,
    watch_state: &Arc<Mutex<WatchState>>,
    watcher: &mut impl WatchRegistration,
) {
    let replacement = config_watch_plan(config_dir);
    reconcile_watch_plan(replacement, watch_state, watcher);
}

fn reconcile_watch_plan(
    replacement: WatchPlan,
    watch_state: &Arc<Mutex<WatchState>>,
    watcher: &mut impl WatchRegistration,
) {
    let Ok(mut state) = watch_state.lock() else {
        return;
    };

    // Establish every new target before publishing the new callback mapping.
    // If any registration fails, the old plan and its complete coverage stay
    // authoritative; successful additions are retained for the next retry.
    for (root, mode) in &replacement.external_roots {
        if state.registered_external_roots.get(root) == Some(mode) {
            continue;
        }
        if let Err(error) = watcher.register(root, *mode) {
            log::warn!(
                "Config autoreload cannot watch updated symlink target {}: {error}",
                root.display()
            );
            return;
        }
        state.registered_external_roots.insert(root.clone(), *mode);
    }

    state.plan = replacement;
    let stale: Vec<PathBuf> = state
        .registered_external_roots
        .keys()
        .filter(|root| {
            !state
                .plan
                .external_roots
                .iter()
                .any(|(current, _)| current == *root)
        })
        .cloned()
        .collect();
    for root in stale {
        match watcher.unregister(&root) {
            Ok(()) => {
                state.registered_external_roots.remove(&root);
            }
            Err(error) => log::warn!(
                "Config autoreload cannot retire old symlink target {}: {error}",
                root.display()
            ),
        }
    }
}

/// Path of the config file the frontend reloads, for tests and diagnostics.
#[cfg(test)]
fn settings_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(SETTINGS_FILE)
}

#[cfg(test)]
mod tests {
    use super::{
        pending, reconcile_watch_plan, settings_path, watched_config_name, WatchPlan,
        WatchRegistration, WatchState, BOOKMARKS_FILE, FOLDER_VIEWS_FILE, SETTINGS_FILE,
        THEMES_DIR, WATCH_PLAN_REFRESH_INTERVAL,
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
            external_files.insert(root.join(SETTINGS_FILE), SETTINGS_FILE.to_string());
            vec![(root.to_path_buf(), RecursiveMode::NonRecursive)]
        });
        WatchPlan {
            config_dir: config_dir.to_path_buf(),
            external_roots,
            external_files,
            external_themes_dir: None,
        }
    }

    fn state(initial: WatchPlan) -> Arc<Mutex<WatchState>> {
        Arc::new(Mutex::new(WatchState {
            registered_external_roots: initial.external_roots.iter().cloned().collect(),
            plan: initial,
        }))
    }

    #[test]
    fn repeated_retargets_watch_new_before_retiring_old_without_growth() {
        let config = Path::new("/config");
        let first = Path::new("/targets/0");
        let watch_state = state(plan(config, Some(first)));
        let mut watcher = RecordingWatcher::default();
        watcher.registered.insert(first.to_path_buf());

        for index in 1..1000 {
            let next = PathBuf::from(format!("/targets/{index}"));
            reconcile_watch_plan(plan(config, Some(&next)), &watch_state, &mut watcher);
            expect_single_registration(&watch_state, &watcher, &next);
            let tail = &watcher.operations[watcher.operations.len() - 2..];
            assert_eq!(tail[0], ("watch".into(), next));
            assert_eq!(tail[1].0, "unwatch");
        }
    }

    fn expect_single_registration(
        watch_state: &Arc<Mutex<WatchState>>,
        watcher: &RecordingWatcher,
        expected: &Path,
    ) {
        assert_eq!(watcher.registered, HashSet::from([expected.to_path_buf()]));
        let state = watch_state.lock().expect("watch state");
        assert_eq!(state.registered_external_roots.len(), 1);
        assert!(state.registered_external_roots.contains_key(expected));
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
        let watch_state = state(plan(&config, Some(&old)));
        let mut watcher = RecordingWatcher {
            registered: HashSet::from([old.clone()]),
            fail_registration: Some(new.clone()),
            ..Default::default()
        };

        reconcile_watch_plan(plan(&config, Some(&new)), &watch_state, &mut watcher);
        expect_single_registration(&watch_state, &watcher, &old);
        assert_eq!(
            watch_state
                .lock()
                .expect("watch state")
                .plan
                .watched_config_name(&old.join(SETTINGS_FILE)),
            Some(SETTINGS_FILE.to_string())
        );

        watcher.fail_registration = None;
        reconcile_watch_plan(plan(&config, Some(&new)), &watch_state, &mut watcher);
        expect_single_registration(&watch_state, &watcher, &new);
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
        let watch_state = state(plan(&config, Some(&old)));
        let mut watcher = RecordingWatcher {
            registered: HashSet::from([old.clone()]),
            ..Default::default()
        };

        reconcile_watch_plan(plan(&config, Some(&new)), &watch_state, &mut watcher);
        {
            let state = watch_state.lock().expect("watch state");
            assert_eq!(
                state.plan.watched_config_name(&old.join(SETTINGS_FILE)),
                None
            );
            assert_eq!(
                state.plan.watched_config_name(&new.join(SETTINGS_FILE)),
                Some(SETTINGS_FILE.to_string())
            );
        }

        reconcile_watch_plan(plan(&config, None), &watch_state, &mut watcher);
        assert!(watcher.registered.is_empty());
        assert!(watch_state
            .lock()
            .expect("watch state")
            .registered_external_roots
            .is_empty());
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
        let configured = config.join(SETTINGS_FILE);
        symlink(&old_file, &configured).expect("initial settings symlink");

        let (sent, received) = mpsc::channel();
        let harness = super::watch_config_changes(config, move |name| {
            let _ = sent.send(name);
        })
        .expect("config watcher");

        std::fs::write(&old_file, "old-1").expect("initial target write");
        assert_eq!(
            received
                .recv_timeout(Duration::from_secs(3))
                .ok()
                .as_deref(),
            Some(SETTINGS_FILE)
        );

        std::fs::remove_file(&configured).expect("remove old symlink");
        symlink(&new_file, &configured).expect("retarget settings symlink");
        std::thread::sleep(WATCH_PLAN_REFRESH_INTERVAL + Duration::from_millis(300));
        while received.try_recv().is_ok() {}

        // The old native registration has been removed after new coverage was
        // established, while writes through the new target remain observable.
        std::fs::write(&old_file, "old-2").expect("retired target write");
        assert!(received.recv_timeout(Duration::from_millis(400)).is_err());
        std::fs::write(&new_file, "new-1").expect("replacement target write");
        assert_eq!(
            received
                .recv_timeout(Duration::from_secs(3))
                .ok()
                .as_deref(),
            Some(SETTINGS_FILE)
        );

        let drop_started = Instant::now();
        drop(harness);
        assert!(drop_started.elapsed() < Duration::from_secs(1));
        while received.try_recv().is_ok() {}
        std::fs::write(&new_file, "new-2").expect("write after teardown");
        assert!(received.recv_timeout(Duration::from_millis(400)).is_err());
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
