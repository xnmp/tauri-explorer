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
