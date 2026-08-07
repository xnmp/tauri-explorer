//! Watches the app config directory for edits made outside the app (#599).
//!
//! Settings are a plain JSON file and user themes are plain CSS, so people
//! edit them directly — with an editor, `sed`, or a dotfile manager. Before
//! this module those edits only took effect on the next launch. Now a change
//! to `settings.json` or `themes/*.css` emits `config-file-changed` to every
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
use std::path::Path;
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
/// User theme CSS lives one level down, in `<config>/themes/`.
const THEMES_DIR: &str = "themes";

#[derive(Clone, Serialize)]
struct ConfigChangedPayload {
    /// Config-dir-relative name, always forward-slashed: `settings.json` or
    /// `themes/<name>.css`.
    filename: String,
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
        [SETTINGS_FILE] => Some(SETTINGS_FILE.to_string()),
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
    use super::{settings_path, watched_config_name};
    use std::path::Path;

    #[test]
    fn reports_the_settings_blob_and_user_theme_css() {
        let dir = Path::new("/home/u/.config/tauri-explorer");
        assert_eq!(
            watched_config_name(dir, &settings_path(dir)),
            Some("settings.json".to_string())
        );
        assert_eq!(
            watched_config_name(dir, &dir.join("themes").join("midnight.css")),
            Some("themes/midnight.css".to_string())
        );
    }

    #[test]
    fn ignores_files_no_listener_reacts_to() {
        let dir = Path::new("/home/u/.config/tauri-explorer");
        for path in [
            dir.join("bookmarks.json"),
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
}
