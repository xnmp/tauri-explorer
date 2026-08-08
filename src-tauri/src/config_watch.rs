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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
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
struct WatchPlan {
    config_dir: PathBuf,
    external_roots: Vec<(PathBuf, RecursiveMode)>,
    external_files: HashMap<PathBuf, String>,
    external_themes_dir: Option<PathBuf>,
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
                external_roots.push((parent.to_path_buf(), RecursiveMode::NonRecursive));
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

/// Keep the watcher alive for the process lifetime; dropping it stops it.
static CONFIG_WATCHER: OnceLock<Mutex<RecommendedWatcher>> = OnceLock::new();

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
        _ => None,
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

    let watch_plan = Arc::new(Mutex::new(config_watch_plan(&config_dir)));
    let callback_plan = Arc::clone(&watch_plan);
    let watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| {
        let event = match result {
            Ok(event) => event,
            Err(error) => {
                log::warn!("config_watch error: {error}");
                return;
            }
        };
        // Access-only events (reads, opens) never change content.
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let Ok(plan) = callback_plan.lock() else {
            return;
        };
        for path in &event.paths {
            if let Some(name) = plan.watched_config_name(path) {
                if let Ok(mut map) = pending().lock() {
                    map.insert(name, Instant::now());
                }
            }
        }
    });

    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(error) => {
            log::error!("Config autoreload disabled (watcher unavailable): {error}");
            return;
        }
    };

    // Recursive so `themes/` is covered even when it is created later.
    if let Err(error) = watcher.watch(&config_dir, RecursiveMode::Recursive) {
        log::error!("Config autoreload disabled (cannot watch config dir): {error}");
        return;
    }

    let external_roots = watch_plan
        .lock()
        .expect("config watch plan lock")
        .external_roots
        .clone();
    for (root, mode) in &external_roots {
        if let Err(error) = watcher.watch(root, *mode) {
            log::warn!(
                "Config autoreload cannot watch symlink target {}: {error}",
                root.display()
            );
        }
    }

    if CONFIG_WATCHER.set(Mutex::new(watcher)).is_err() {
        log::warn!("Config watcher already initialized");
        return;
    }

    spawn_flush_thread(app.clone(), config_dir.clone(), watch_plan);
    log::info!(
        "Config autoreload watching {}",
        config_dir.to_string_lossy()
    );
}

/// Emit `config-file-changed` once a file has been quiet for the debounce
/// window, so one editor save yields one reload.
fn spawn_flush_thread(app: AppHandle, config_dir: PathBuf, watch_plan: Arc<Mutex<WatchPlan>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(FLUSH_INTERVAL);

        refresh_watch_plan(&config_dir, &watch_plan);

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

/// Re-resolve symlink targets and add watches for newly selected external
/// roots. Old roots are intentionally left watched: a target can be swapped
/// while an editor still has it open, and the current plan filters those stale
/// events without risking a gap during the handover.
fn refresh_watch_plan(config_dir: &Path, watch_plan: &Arc<Mutex<WatchPlan>>) {
    static LAST_REFRESH: OnceLock<Mutex<Instant>> = OnceLock::new();
    let last_refresh = LAST_REFRESH.get_or_init(|| Mutex::new(Instant::now()));
    let Ok(mut last_refresh) = last_refresh.lock() else {
        return;
    };
    if last_refresh.elapsed() < WATCH_PLAN_REFRESH_INTERVAL {
        return;
    }
    *last_refresh = Instant::now();

    let replacement = config_watch_plan(config_dir);
    let current_roots = match watch_plan.lock() {
        Ok(plan) => plan.external_roots.clone(),
        Err(_) => return,
    };
    let Some(watcher) = CONFIG_WATCHER.get() else {
        return;
    };
    let Ok(mut watcher) = watcher.lock() else {
        return;
    };
    for (root, mode) in &replacement.external_roots {
        if current_roots.iter().any(|(current, _)| current == root) {
            continue;
        }
        if let Err(error) = watcher.watch(root, *mode) {
            log::warn!(
                "Config autoreload cannot watch updated symlink target {}: {error}",
                root.display()
            );
        }
    }
    drop(watcher);
    if let Ok(mut plan) = watch_plan.lock() {
        *plan = replacement;
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
        config_watch_plan, pending, settings_path, watched_config_name, BOOKMARKS_FILE,
        FOLDER_VIEWS_FILE,
    };
    use notify::{RecommendedWatcher, RecursiveMode, Watcher};
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    fn reported_name_after_external_write(config_dir: &Path, changed: &Path) -> Option<String> {
        let plan = config_watch_plan(config_dir);
        let (sent, received) = mpsc::channel();
        let mut watcher: RecommendedWatcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                if let Ok(event) = event {
                    for path in event.paths {
                        if let Some(filename) = plan.watched_config_name(&path) {
                            let _ = sent.send(filename);
                        }
                    }
                }
            })
            .expect("watcher");
        watcher
            .watch(config_dir, RecursiveMode::Recursive)
            .expect("watch config directory");
        for (root, mode) in &config_watch_plan(config_dir).external_roots {
            watcher.watch(root, *mode).expect("watch external target");
        }

        std::fs::write(changed, "external edit").expect("write symlink target");
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(filename) = received.recv_timeout(Duration::from_millis(100)) {
                return Some(filename);
            }
        }
        None
    }

    #[cfg(unix)]
    #[test]
    fn reports_writes_to_symlinked_settings_targets() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config_dir = temp.path().join("config");
        let external_dir = temp.path().join("dotfiles");
        std::fs::create_dir_all(&config_dir).expect("config directory");
        std::fs::create_dir_all(&external_dir).expect("external directory");
        let target = external_dir.join("settings.json");
        std::fs::write(&target, "{}").expect("initial settings");
        std::os::unix::fs::symlink(&target, config_dir.join("settings.json"))
            .expect("symlinked settings");

        assert_eq!(
            reported_name_after_external_write(&config_dir, &target),
            Some("settings.json".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn re_resolves_retargeted_settings_and_theme_symlinks() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let config_dir = temp.path().join("config");
        let first_target_dir = temp.path().join("first");
        let replacement_target_dir = temp.path().join("replacement");
        std::fs::create_dir_all(&config_dir).expect("config directory");
        std::fs::create_dir_all(&first_target_dir).expect("first target directory");
        std::fs::create_dir_all(&replacement_target_dir).expect("replacement target directory");

        let first_settings = first_target_dir.join("settings.json");
        let replacement_settings = replacement_target_dir.join("settings.json");
        std::fs::write(&first_settings, "{}").expect("first settings");
        std::fs::write(&replacement_settings, "{}").expect("replacement settings");
        std::os::unix::fs::symlink(&first_settings, config_dir.join("settings.json"))
            .expect("first settings symlink");
        std::fs::remove_file(config_dir.join("settings.json")).expect("replace settings symlink");
        std::os::unix::fs::symlink(&replacement_settings, config_dir.join("settings.json"))
            .expect("replacement settings symlink");

        let replacement_themes = replacement_target_dir.join("themes");
        std::fs::create_dir_all(&replacement_themes).expect("replacement themes directory");
        let replacement_theme = replacement_themes.join("midnight.css");
        std::fs::write(&replacement_theme, "body {}").expect("replacement theme");
        std::os::unix::fs::symlink(&replacement_themes, config_dir.join("themes"))
            .expect("themes symlink");

        let plan = config_watch_plan(&config_dir);
        assert_eq!(
            plan.watched_config_name(&replacement_settings),
            Some("settings.json".to_string())
        );
        assert_eq!(
            plan.watched_config_name(&replacement_theme),
            Some("themes/midnight.css".to_string())
        );
        assert!(plan
            .external_roots
            .iter()
            .any(|(root, _)| root == &replacement_target_dir));
        assert!(plan
            .external_roots
            .iter()
            .any(|(root, _)| root == &replacement_themes));
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
}
