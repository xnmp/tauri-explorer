//! Configuration file persistence module.
//! Issue: tauri-ti0l
//!
//! Provides Tauri commands for reading/writing JSON config files
//! in the app's config directory (~/.config/tauri-explorer/ on Linux).
#![allow(clippy::disallowed_methods)] // Retire-when: #1638 closed (non-UTF-8 names, ADR 0031)

use crate::error::AppError;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

/// Serializes concurrent config writes so they can't interleave.
static WRITE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn write_lock() -> &'static AsyncMutex<()> {
    WRITE_LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Get the app config directory, creating it if needed.
pub(crate) fn config_dir() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Other("Could not determine config directory".into()))?;
    let dir = base.join("tauri-explorer");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Other(format!("Failed to create config dir: {}", e)))?;
    }
    Ok(dir)
}

/// Read `settings.json` as opaque JSON, without creating or repairing
/// anything. An absent, oversized or malformed file means "no configured
/// values"; callers must fall back to their own defaults rather than treating
/// a broken settings file as a request to disable a bound (ADR 0023).
///
/// Only the Unix recovery coordinator reads budgets today; keep the gate in
/// step with those callers so non-Unix builds do not carry dead code.
#[cfg(unix)]
pub(crate) fn read_settings_value() -> Option<serde_json::Value> {
    const SETTINGS_FILE: &str = "settings.json";
    const MAX_SETTINGS_BYTES: usize = 1024 * 1024;
    let path = dirs::config_dir()?
        .join("tauri-explorer")
        .join(SETTINGS_FILE);
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Validate that a config filename is a plain file name (no path separators,
/// no parent-dir components, not absolute) so it cannot escape the config dir.
fn validate_filename(filename: &str) -> Result<(), AppError> {
    let path = Path::new(filename);
    let is_plain_name = !filename.is_empty()
        && !filename.contains('/')
        && !filename.contains('\\')
        && !path.is_absolute()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && filename != "..";
    if !is_plain_name {
        return Err(AppError::InvalidPath(format!(
            "Invalid config filename: {}",
            filename
        )));
    }
    Ok(())
}

/// Resolve a validated filename inside the config directory.
fn resolve_config_path(filename: &str) -> Result<PathBuf, AppError> {
    validate_filename(filename)?;
    let dir = config_dir()?;
    let path = dir.join(filename);
    // Defense in depth: the resolved path must stay inside the config dir.
    if !path.starts_with(&dir) {
        return Err(AppError::InvalidPath(format!(
            "Config path escapes config directory: {}",
            filename
        )));
    }
    Ok(path)
}

/// Follow a config-file symlink chain without requiring the final target to
/// exist. `canonicalize` cannot resolve a dangling final link, which is a
/// valid dotfile-manager setup that a first app save should populate.
pub(crate) fn resolve_write_target(path: &Path) -> std::io::Result<PathBuf> {
    const MAX_SYMLINKS: usize = 40;
    let mut target = path.to_path_buf();
    let mut followed = 0;

    loop {
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if followed == MAX_SYMLINKS {
                    return Err(std::io::Error::other(format!(
                        "Config symlink chain exceeds {MAX_SYMLINKS} links"
                    )));
                }
                let next = fs::read_link(&target)?;
                followed += 1;
                target = if next.is_absolute() {
                    next
                } else {
                    target
                        .parent()
                        .ok_or_else(|| std::io::Error::other("Symlink has no parent directory"))?
                        .join(next)
                };
            }
            Ok(_) => return Ok(target),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(target),
            Err(error) => return Err(error),
        }
    }
}

/// Write `data` atomically through any config-file symlink: resolve the final
/// target once, write a temp file beside it, then rename over that target.
fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    // Resolving once is the operation's linearization point: a concurrent
    // retarget of the config symlink affects the next write, not this one.
    let path = resolve_write_target(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Config path has no parent directory"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("Config path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let (tmp, mut file) = loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{}.tmp-{}-{}",
            file_name,
            std::process::id(),
            sequence
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    // Config files can hold secrets (plugin API keys) — owner-only on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = file.write_all(data.as_bytes()).and_then(|_| file.flush()) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(file);
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Read a JSON config file. Returns the raw JSON string.
/// Returns empty string if file doesn't exist (not an error).
#[tauri::command]
pub async fn read_config_file(filename: String) -> Result<String, AppError> {
    let path = resolve_config_path(&filename)?;
    tokio::task::spawn_blocking(move || {
        if filename == "plugin.trace.json" {
            crate::ai::migrate_summary(path.parent().expect("config parent"))
                .map_err(|error| AppError::Other(error.message))?;
        }
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| {
            AppError::Other(format!("Failed to read config file '{}': {}", filename, e))
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Write a user theme CSS file into `<config>/themes/` atomically (#203).
/// Same single-component filename validation as config files, plus a .css
/// extension requirement — theme generation must not become a file-write
/// primitive.
#[tauri::command]
pub async fn write_theme_file(filename: String, data: String) -> Result<(), AppError> {
    validate_filename(&filename)?;
    if !filename.ends_with(".css") {
        return Err(AppError::InvalidPath(format!(
            "Theme file must end in .css: {filename}"
        )));
    }
    let dir = config_dir()?.join("themes");
    tokio::task::spawn_blocking(move || {
        let _guard = write_lock().blocking_lock();
        write_theme_file_in(&dir, &filename, &data)
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Refuses a theme the listing would skip ([`MAX_THEME_CSS_BYTES`]), so a
/// write never reports success for a theme that then cannot appear (#1595).
fn write_theme_file_in(dir: &Path, filename: &str, data: &str) -> Result<(), AppError> {
    if data.len() as u64 > MAX_THEME_CSS_BYTES {
        return Err(AppError::InvalidPath(format!(
            "Theme '{filename}' is {} bytes; themes are limited to {MAX_THEME_CSS_BYTES} bytes",
            data.len()
        )));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Other(format!("Failed to create themes dir: {e}")))?;
    write_atomic(&dir.join(filename), data)
        .map_err(|e| AppError::Other(format!("Failed to write theme '{filename}': {e}")))
}

/// Write a JSON config file. Creates or overwrites the file atomically.
#[tauri::command]
pub async fn write_config_file(filename: String, data: String) -> Result<(), AppError> {
    let path = resolve_config_path(&filename)?;
    // Serialize concurrent writes so two writers can't interleave.
    let _guard = write_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        log::debug!("Writing config file: {}", filename);
        if filename == "plugin.trace.json" {
            return crate::ai::write_trace_config(path.parent().expect("config parent"), &data)
                .map_err(|error| AppError::Other(error.message));
        }
        if filename == "plugin.openai-image.json" {
            return crate::ai::image_migration::write_source(
                path.parent().expect("config parent"),
                &data,
            )
            .map_err(|error| AppError::Service {
                code: error.code.into(),
                message: error.message,
            });
        }
        write_atomic(&path, &data).map_err(|e| {
            AppError::Other(format!("Failed to write config file '{}': {}", filename, e))
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Read all CSS files from ~/.config/tauri-explorer/themes/.
/// Returns a vec of (filename, css_content) pairs.
/// Returns empty vec if directory doesn't exist.
#[tauri::command]
pub async fn list_user_themes() -> Result<Vec<(String, String)>, AppError> {
    tokio::task::spawn_blocking(list_user_themes_sync)
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn list_user_themes_sync() -> Result<Vec<(String, String)>, AppError> {
    list_user_themes_in(&config_dir()?.join("themes"))
}

/// Lists `<config>/themes/*.css` with the same per-file rules as layouts: a
/// file that is not a regular file (directory, FIFO, dangling symlink), larger
/// than [`MAX_THEME_CSS_BYTES`], unreadable or not UTF-8 is skipped with a
/// warning and never hides the other themes (#1595). A file whose NAME is not
/// UTF-8 is skipped too: lossy conversion could give two files the same name.
///
/// Sorted by filename (byte order): the frontend injects one `<style>` per
/// theme in this order, and a later stylesheet wins both the cascade and a
/// theme id reused across files, so precedence must not follow directory
/// hash order.
fn list_user_themes_in(themes_dir: &Path) -> Result<Vec<(String, String)>, AppError> {
    let entries = match fs::read_dir(themes_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Other(format!("Failed to read themes dir: {}", e))),
    };

    let mut themes = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!("Skipping unreadable themes dir entry: {e}");
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("css") {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            log::warn!(
                "Skipping theme with a non-UTF-8 file name: {}",
                path.display()
            );
            continue;
        };
        match read_bounded_css(&path, MAX_THEME_CSS_BYTES) {
            Ok(css) => themes.push((filename.to_owned(), css)),
            Err(CssReadError::TooLarge) => {
                log::warn!("Skipping theme '{filename}': larger than {MAX_THEME_CSS_BYTES} bytes")
            }
            Err(reason) => log::warn!("Skipping theme '{filename}': {}", reason.as_str()),
        }
    }
    themes.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(themes)
}

/// Why a user stylesheet was not read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CssReadError {
    NotAFile,
    TooLarge,
    Unreadable,
}

impl CssReadError {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotAFile => "not-a-file",
            Self::TooLarge => "too-large",
            Self::Unreadable => "unreadable",
        }
    }
}

/// Reads a user stylesheet (following symlinks) only if it is a regular file
/// of at most `limit` bytes of UTF-8. The open is non-blocking and the handle
/// is re-checked, so a FIFO (named or swapped in after the metadata check)
/// cannot hang the listing; at most one byte past the limit is read, so a file
/// that grows after its metadata was read (or reports no length) cannot be
/// read unbounded. A leased regular file is retried with a blocking open; only
/// a FIFO swapped in during that retry's window could still block.
fn read_bounded_css(path: &Path, limit: u64) -> Result<String, CssReadError> {
    use std::io::Read;
    let metadata = fs::metadata(path).map_err(|_| CssReadError::Unreadable)?;
    if !metadata.is_file() {
        return Err(CssReadError::NotAFile);
    }
    if metadata.len() > limit {
        return Err(CssReadError::TooLarge);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        // A lease holder (Samba, NFS server) makes a non-blocking open fail
        // while it breaks the lease. The metadata said regular file, so wait
        // for the break like any other reader; the type is re-checked below.
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => fs::File::open(path),
        other => other,
    }
    .map_err(|_| CssReadError::Unreadable)?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(CssReadError::NotAFile);
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CssReadError::Unreadable)?;
    if bytes.len() as u64 > limit {
        return Err(CssReadError::TooLarge);
    }
    String::from_utf8(bytes).map_err(|_| CssReadError::Unreadable)
}

/// Largest user colour theme read from `<config>/themes/` (#1595). Built-in
/// themes are about 5 KiB; the cap only stops a stray huge file from being
/// read into memory and injected into the document.
const MAX_THEME_CSS_BYTES: u64 = 512 * 1024;

/// Largest user layout stylesheet read from `<config>/layouts/` (#1306).
/// Mirrors `MAX_LAYOUT_CSS_BYTES` in `src/lib/domain/layout-theme.ts`.
const MAX_LAYOUT_CSS_BYTES: u64 = 512 * 1024;
const LAYOUTS_DIR: &str = "layouts";

/// One `.css` file in the layouts folder. Unlike colour themes, one bad file
/// never fails the listing: it is reported with `css: None` and an `error`,
/// so the frontend can explain why that layout falls back to Default.
#[derive(Debug, serde::Serialize, PartialEq, Eq)]
pub struct UserLayoutFile {
    filename: String,
    css: Option<String>,
    error: Option<&'static str>,
}

/// List user layout CSS files from `<config>/layouts/` (#1306). Returns an
/// empty list when the folder does not exist.
#[tauri::command]
pub async fn list_user_layouts() -> Result<Vec<UserLayoutFile>, AppError> {
    tokio::task::spawn_blocking(|| list_user_layouts_in(&config_dir()?.join(LAYOUTS_DIR)))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn list_user_layouts_in(dir: &Path) -> Result<Vec<UserLayoutFile>, AppError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Other(format!("Failed to read layouts dir: {e}"))),
    };
    let mut layouts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("css") {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let (css, error) = match read_bounded_css(&path, MAX_LAYOUT_CSS_BYTES) {
            Ok(css) => (Some(css), None),
            Err(CssReadError::NotAFile) => continue,
            Err(reason) => (None, Some(reason.as_str())),
        };
        layouts.push(UserLayoutFile {
            filename: filename.to_owned(),
            css,
            error,
        });
    }
    layouts.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(layouts)
}

/// Create `<config>/layouts/` if needed and return its absolute path, for
/// the "Open layouts folder" action (#1306).
#[tauri::command]
pub async fn ensure_layouts_dir() -> Result<String, AppError> {
    tokio::task::spawn_blocking(|| {
        let dir = config_dir()?.join(LAYOUTS_DIR);
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Other(format!("Failed to create layouts dir: {e}")))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_path_traversal_filenames() {
        assert!(validate_filename("../escape.json").is_err());
        assert!(validate_filename("..").is_err());
        assert!(validate_filename("a/../b.json").is_err());
        assert!(validate_filename("/etc/passwd").is_err());
        assert!(validate_filename("subdir/settings.json").is_err());
        assert!(validate_filename("subdir\\settings.json").is_err());
        assert!(validate_filename("").is_err());
    }

    #[test]
    fn accepts_plain_filenames() {
        assert!(validate_filename("settings.json").is_ok());
        assert!(validate_filename("window-state.json").is_ok());
        assert!(validate_filename(".hidden.json").is_ok());
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_files() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");

        write_atomic(&path, "{\"a\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        write_atomic(&path, "{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_updates_symlink_target_without_replacing_link() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let link = dir.path().join("settings.json");
        fs::write(&target, "old").unwrap();
        symlink(&target, &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_follows_relative_symlink_chains() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let middle = dir.path().join("current-settings.json");
        let link = dir.path().join("settings.json");
        fs::write(&target, "old").unwrap();
        symlink("managed-settings.json", &middle).unwrap();
        symlink("current-settings.json", &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(&middle)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_creates_dangling_symlink_target_without_replacing_link() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let link = dir.path().join("settings.json");
        symlink("managed-settings.json", &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_keeps_owner_only_permissions_through_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let link = dir.path().join("settings.json");
        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&target, &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_accepts_exactly_the_supported_symlink_depth() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("target.json");
        fs::write(&target, "old").unwrap();
        for index in (0..40).rev() {
            let destination = if index == 39 {
                "target.json".to_string()
            } else {
                format!("link-{}.json", index + 1)
            };
            symlink(destination, dir.path().join(format!("link-{index}.json"))).unwrap();
        }

        write_atomic(&dir.path().join("link-0.json"), "new").unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_does_not_follow_a_precreated_staging_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let victim = dir.path().join("unrelated.json");
        fs::write(&victim, "keep").unwrap();
        let predictable = dir
            .path()
            .join(format!(".settings.json.tmp-{}", std::process::id()));
        symlink(&victim, &predictable).unwrap();

        let result = write_atomic(&path, "new");

        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        assert!(
            result.is_ok(),
            "a planted staging symlink must not block a safe write: {result:?}"
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "new");
    }
    #[test]
    fn lists_layouts_without_failing_on_bad_files() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("b.css"), ":root { --layout-gap: 2px; }").unwrap();
        fs::write(dir.path().join("notes.txt"), "ignored").unwrap();
        fs::write(
            dir.path().join("big.css"),
            vec![b'a'; MAX_LAYOUT_CSS_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(dir.path().join("binary.css"), [0xff, 0xfe, 0x00]).unwrap();
        fs::create_dir(dir.path().join("folder.css")).unwrap();

        let layouts = list_user_layouts_in(dir.path()).unwrap();
        let summary: Vec<_> = layouts
            .iter()
            .map(|l| (l.filename.as_str(), l.css.is_some(), l.error))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("b.css", true, None),
                ("big.css", false, Some("too-large")),
                ("binary.css", false, Some("unreadable")),
            ]
        );
    }

    #[test]
    fn missing_layouts_dir_lists_nothing() {
        let dir = tempdir().unwrap();
        assert!(list_user_layouts_in(&dir.path().join("absent"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn issue_1595_one_bad_theme_does_not_hide_the_rest() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("good.css"), "body{}").unwrap();
        fs::write(dir.path().join("bad.css"), [0xff, 0xfe, 0x80]).unwrap();
        fs::create_dir(dir.path().join("dir.css")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("nowhere"), dir.path().join("dangling.css"))
            .unwrap();
        fs::write(dir.path().join("notes.txt"), "x").unwrap();
        let themes = list_user_themes_in(dir.path()).unwrap();
        assert_eq!(themes, vec![("good.css".to_string(), "body{}".to_string())]);
    }

    #[test]
    fn issue_1595_missing_themes_dir_is_empty() {
        let dir = tempdir().unwrap();
        assert!(list_user_themes_in(&dir.path().join("absent"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn issue_1595_themes_path_that_is_a_file_errors() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("themes");
        fs::write(&f, "x").unwrap();
        assert!(list_user_themes_in(&f).is_err());
    }

    /// Themes are injected as `<style>` elements in listing order, and a
    /// later stylesheet wins both the cascade and a reused theme id, so the
    /// order must not depend on directory hash order (#1595).
    #[test]
    fn issue_1595_themes_are_listed_in_filename_order() {
        let dir = tempdir().unwrap();
        let names = [
            "zeta.css",
            "Alpha.css",
            "mid.css",
            "beta.css",
            "b-2.css",
            "b-10.css",
        ];
        for name in names {
            fs::write(dir.path().join(name), name).unwrap();
        }
        let listed: Vec<String> = list_user_themes_in(dir.path())
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        let mut expected: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        expected.sort();
        assert_eq!(listed, expected);
    }

    #[test]
    fn issue_1595_oversized_theme_is_skipped() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("good.css"), "body{}").unwrap();
        fs::write(
            dir.path().join("huge.css"),
            vec![b'a'; MAX_THEME_CSS_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(
            dir.path().join("limit.css"),
            vec![b'a'; MAX_THEME_CSS_BYTES as usize],
        )
        .unwrap();
        let names: Vec<String> = list_user_themes_in(dir.path())
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, ["good.css", "limit.css"]);
    }

    /// Opening a FIFO for reading blocks until a writer appears, which would
    /// hang theme loading at startup; it must be skipped from its metadata.
    #[cfg(unix)]
    #[test]
    fn issue_1595_fifo_named_like_a_theme_is_skipped_without_blocking() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("good.css"), "body{}").unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(dir.path().join("pipe.css"))
            .status()
            .unwrap()
            .success());
        let (tx, rx) = std::sync::mpsc::channel();
        let path = dir.path().to_path_buf();
        // A blocked open cannot be cancelled: bound the wait on a detached thread.
        std::thread::spawn(move || {
            let _ = tx.send(list_user_themes_in(&path).map_err(|e| e.to_string()));
        });
        let themes = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("theme listing blocked on a FIFO")
            .unwrap();
        assert_eq!(themes, vec![("good.css".to_string(), "body{}".to_string())]);
    }

    /// Lossy conversion would map distinct non-UTF-8 names onto the same
    /// `\u{FFFD}` name (and data-user-theme attribute); such files are skipped.
    #[cfg(target_os = "linux")]
    #[test]
    fn issue_1595_non_utf8_theme_names_are_skipped() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("good.css"), "body{}").unwrap();
        for raw in [&b"\xff.css"[..], b"\xfe.css"] {
            let name = std::ffi::OsStr::from_bytes(raw);
            fs::write(dir.path().join(name), "body{color:red}").unwrap();
        }
        let themes = list_user_themes_in(dir.path()).unwrap();
        assert_eq!(themes, vec![("good.css".to_string(), "body{}".to_string())]);
    }

    #[test]
    fn issue_1595_theme_writes_share_the_listing_size_limit() {
        let dir = tempdir().unwrap();
        let limit = MAX_THEME_CSS_BYTES as usize;
        let at_limit = "a".repeat(limit);
        write_theme_file_in(dir.path(), "fits.css", &at_limit).unwrap();
        let too_big = "a".repeat(limit + 1);
        let error = write_theme_file_in(dir.path(), "big.css", &too_big).unwrap_err();
        assert!(
            matches!(&error, AppError::InvalidPath(m) if m.contains("big.css") && m.contains(&limit.to_string())),
            "{error:?}"
        );
        assert!(!dir.path().join("big.css").exists());
        let names: Vec<String> = list_user_themes_in(dir.path())
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, ["fits.css"]);
    }

    /// A file under a write lease (held here by a child process, as Samba or
    /// an NFS server would) refuses a non-blocking open with EWOULDBLOCK while
    /// the lease breaks; the theme must still be listed once it is released.
    #[cfg(target_os = "linux")]
    #[test]
    fn issue_1595_leased_theme_is_read_after_the_lease_breaks() {
        use std::io::{BufRead, Write};
        let skip = |reason: &str| {
            let _ = writeln!(
                std::io::stderr(),
                "SKIPPED issue_1595_leased_theme_is_read_after_the_lease_breaks: {reason}"
            );
        };
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("good.css"), "body{}").unwrap();
        let leased = dir.path().join("leased.css");
        fs::write(&leased, "p{}").unwrap();
        const HOLDER: &str = r#"
import fcntl, os, signal, sys
F_SETLEASE = 1024
fd = os.open(sys.argv[1], os.O_RDONLY)
signal.signal(signal.SIGIO, lambda *_: fcntl.fcntl(fd, F_SETLEASE, fcntl.F_UNLCK))
try:
    fcntl.fcntl(fd, F_SETLEASE, fcntl.F_WRLCK)
except OSError as e:
    print("no-lease", e, flush=True)
    sys.exit(0)
print("leased", flush=True)
sys.stdin.read()
"#;
        let Ok(mut holder) = std::process::Command::new("python3")
            .args(["-c", HOLDER])
            .arg(&leased)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
        else {
            return skip("python3 is not available");
        };
        let mut line = String::new();
        std::io::BufReader::new(holder.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        if line.trim() != "leased" {
            let _ = holder.wait();
            return skip(&format!("the lease could not be taken: {}", line.trim()));
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let path = dir.path().to_path_buf();
        std::thread::spawn(move || {
            let _ = tx.send(list_user_themes_in(&path).map_err(|e| e.to_string()));
        });
        // Bounded by the kernel's lease-break-time (45 s by default) if the
        // holder ever failed to release on SIGIO.
        let listed = rx.recv_timeout(std::time::Duration::from_secs(60));
        drop(holder.stdin.take());
        let _ = holder.wait();
        let names: Vec<String> = listed
            .expect("theme listing did not return")
            .unwrap()
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, ["good.css", "leased.css"]);
    }
}
