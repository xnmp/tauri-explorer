//! Unified error type for all Tauri commands.
//! Issue: tauri-kjg8

use serde::Serialize;
use thiserror::Error;

/// Application-wide error type for Tauri commands.
///
/// All `#[tauri::command]` handlers should return `Result<T, AppError>`
/// instead of `Result<T, String>` for consistent error handling.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("Path not found: {0}")]
    NotFound(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Path already exists: {0}")]
    AlreadyExists(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        let kind = match self {
            AppError::NotFound(_) => "not_found",
            AppError::PermissionDenied(_) => "permission_denied",
            AppError::AlreadyExists(_) => "already_exists",
            AppError::InvalidPath(_) => "invalid_path",
            AppError::Io(_) => "io",
            AppError::Other(_) => "other",
        };
        map.serialize_entry("kind", kind)?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}
