//! Configuration file persistence module.
//! Issue: tauri-ti0l
//!
//! Provides Tauri commands for reading/writing JSON config files
//! in the app's config directory (~/.config/tauri-explorer/ on Linux).

use crate::error::AppError;
use std::fs;
use std::path::PathBuf;

/// Get the app config directory, creating it if needed.
fn config_dir() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Other("Could not determine config directory".into()))?;
    let dir = base.join("tauri-explorer");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Other(format!("Failed to create config dir: {}", e)))?;
    }
    Ok(dir)
}

/// Read a JSON config file. Returns the raw JSON string.
/// Returns empty string if file doesn't exist (not an error).
#[tauri::command]
pub fn read_config_file(filename: String) -> Result<String, AppError> {
    let path = config_dir()?.join(&filename);
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path)
        .map_err(|e| AppError::Other(format!("Failed to read config file '{}': {}", filename, e)))
}

/// Write a JSON config file. Creates or overwrites the file.
#[tauri::command]
pub fn write_config_file(filename: String, data: String) -> Result<(), AppError> {
    let path = config_dir()?.join(&filename);
    fs::write(&path, &data)
        .map_err(|e| AppError::Other(format!("Failed to write config file '{}': {}", filename, e)))
}

/// Get the app config directory path.
#[tauri::command]
pub fn get_config_dir() -> Result<String, AppError> {
    config_dir().map(|p| p.to_string_lossy().into_owned())
}

/// Read all CSS files from ~/.config/tauri-explorer/themes/.
/// Returns a vec of (filename, css_content) pairs.
/// Returns empty vec if directory doesn't exist.
#[tauri::command]
pub fn list_user_themes() -> Result<Vec<(String, String)>, AppError> {
    let themes_dir = config_dir()?.join("themes");
    if !themes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut themes = Vec::new();
    let entries = fs::read_dir(&themes_dir)
        .map_err(|e| AppError::Other(format!("Failed to read themes dir: {}", e)))?;

    for entry in entries {
        let entry = entry
            .map_err(|e| AppError::Other(format!("Failed to read dir entry: {}", e)))?;
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
