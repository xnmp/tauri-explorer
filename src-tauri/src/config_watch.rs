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
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Trailing debounce window. An editor's save can produce several events
/// (truncate, write, rename, chmod); one reload per settled file is enough.
const DEBOUNCE: Duration = Duration::from_millis(200);
/// Poll interval for the debounce flush thread.
const FLUSH_INTERVAL: Duration = Duration::from_millis(80);

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
}

impl WatchPlan {
    fn watched_config_name(&self, changed: &Path) -> Option<String> {
        watched_config_name(&self.config_dir, changed)
    }
}

fn config_watch_plan(config_dir: &Path) -> WatchPlan {
    WatchPlan {
        config_dir: config_dir.to_path_buf(),
        external_roots: Vec::new(),
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

    let watch_root = config_dir.clone();
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
        for path in &event.paths {
            if let Some(name) = watched_config_name(&watch_root, path) {
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

    if CONFIG_WATCHER.set(Mutex::new(watcher)).is_err() {
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

/// Path of the config file the frontend reloads, for tests and diagnostics.
#[cfg(test)]
fn settings_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(SETTINGS_FILE)
}

#[cfg(test)]
mod tests {
    use super::{pending, settings_path, watched_config_name, BOOKMARKS_FILE, FOLDER_VIEWS_FILE};
    use notify::{RecommendedWatcher, RecursiveMode, Watcher};
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

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
