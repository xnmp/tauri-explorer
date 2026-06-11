//! Configuration file persistence module.
//! Issue: tauri-ti0l
//!
//! Provides Tauri commands for reading/writing JSON config files
//! in the app's config directory (~/.config/tauri-explorer/ on Linux).

use crate::error::AppError;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

/// Serializes concurrent config writes so they can't interleave.
static WRITE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

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

/// Write `data` to `path` atomically: write a temp file in the same
/// directory, then rename over the destination.
fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Config path has no parent directory"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("Config path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let tmp = parent.join(format!(".{}.tmp-{}", file_name, std::process::id()));
    if let Err(e) = fs::write(&tmp, data) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Read a JSON config file. Returns the raw JSON string.
/// Returns empty string if file doesn't exist (not an error).
#[tauri::command]
pub async fn read_config_file(filename: String) -> Result<String, AppError> {
    let path = resolve_config_path(&filename)?;
    tokio::task::spawn_blocking(move || {
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

/// Write a JSON config file. Creates or overwrites the file atomically.
#[tauri::command]
pub async fn write_config_file(filename: String, data: String) -> Result<(), AppError> {
    let path = resolve_config_path(&filename)?;
    // Serialize concurrent writes so two writers can't interleave.
    let _guard = write_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        log::debug!("Writing config file: {}", filename);
        write_atomic(&path, &data).map_err(|e| {
            AppError::Other(format!("Failed to write config file '{}': {}", filename, e))
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Get the app config directory path.
#[tauri::command]
pub async fn get_config_dir() -> Result<String, AppError> {
    tokio::task::spawn_blocking(|| config_dir().map(|p| p.to_string_lossy().into_owned()))
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
    let themes_dir = config_dir()?.join("themes");
    if !themes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut themes = Vec::new();
    let entries = fs::read_dir(&themes_dir)
        .map_err(|e| AppError::Other(format!("Failed to read themes dir: {}", e)))?;

    for entry in entries {
        let entry =
            entry.map_err(|e| AppError::Other(format!("Failed to read dir entry: {}", e)))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) == Some("css") {
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let content = fs::read_to_string(&path).map_err(|e| {
                AppError::Other(format!("Failed to read theme '{}': {}", filename, e))
            })?;
            themes.push((filename, content));
        }
    }

    Ok(themes)
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
}
