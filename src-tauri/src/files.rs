//! File operations module for Tauri commands.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// File system entry representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified: String, // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Directory,
}

/// Directory listing response.
#[derive(Debug, Serialize)]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

/// Error types for file operations.
#[derive(Debug, Error)]
pub enum FileError {
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
}

impl Serialize for FileError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convert metadata to FileEntry.
fn metadata_to_entry(path: &Path, metadata: &fs::Metadata) -> FileEntry {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let kind = if metadata.is_dir() {
        FileKind::Directory
    } else {
        FileKind::File
    };

    let size = if metadata.is_dir() { 0 } else { metadata.len() };

    let modified = metadata
        .modified()
        .ok()
        .map(|t| DateTime::<Local>::from(t).format("%Y-%m-%dT%H:%M:%S").to_string())
        .unwrap_or_default();

    FileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        kind,
        size,
        modified,
    }
}

/// List directory contents.
/// Directories are sorted before files, and items are sorted case-insensitively by name.
#[tauri::command]
pub fn list_directory(path: String) -> Result<DirectoryListing, FileError> {
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        return Err(FileError::NotFound(path.clone()));
    }

    if !dir_path.is_dir() {
        return Err(FileError::InvalidPath(format!("Not a directory: {}", path)));
    }

    let mut entries = Vec::new();

    let read_dir = fs::read_dir(&dir_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            FileError::PermissionDenied(path.clone())
        } else {
            FileError::Io(e)
        }
    })?;

    for entry_result in read_dir {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue, // Skip inaccessible files
        };

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // Skip files we can't stat
        };

        entries.push(metadata_to_entry(&entry.path(), &metadata));
    }

    // Sort: directories first, then by name case-insensitively
    entries.sort_by(|a, b| {
        let a_is_dir = matches!(a.kind, FileKind::Directory);
        let b_is_dir = matches!(b.kind, FileKind::Directory);

        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(DirectoryListing { path, entries })
}

/// Get the user's home directory.
#[tauri::command]
pub fn get_home_directory() -> Result<String, FileError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| FileError::NotFound("Home directory not found".to_string()))
}

/// Create a new directory.
#[tauri::command]
pub fn create_directory(parent_path: String, name: String) -> Result<FileEntry, FileError> {
    if name.is_empty() {
        return Err(FileError::InvalidPath("Directory name cannot be empty".to_string()));
    }

    let parent = PathBuf::from(&parent_path);
    if !parent.exists() {
        return Err(FileError::NotFound(format!(
            "Parent directory does not exist: {}",
            parent_path
        )));
    }

    let new_path = parent.join(&name);
    if new_path.exists() {
        return Err(FileError::AlreadyExists(new_path.to_string_lossy().to_string()));
    }

    fs::create_dir(&new_path)?;

    let metadata = fs::metadata(&new_path)?;
    Ok(metadata_to_entry(&new_path, &metadata))
}

/// Rename a file or directory.
#[tauri::command]
pub fn rename_entry(path: String, new_name: String) -> Result<FileEntry, FileError> {
    if new_name.is_empty() {
        return Err(FileError::InvalidPath("New name cannot be empty".to_string()));
    }

    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err(FileError::NotFound(path.clone()));
    }

    let parent = source.parent().ok_or_else(|| {
        FileError::InvalidPath(format!("Cannot get parent directory of: {}", path))
    })?;

    let target = parent.join(&new_name);
    if target.exists() {
        return Err(FileError::AlreadyExists(target.to_string_lossy().to_string()));
    }

    fs::rename(&source, &target)?;

    let metadata = fs::metadata(&target)?;
    Ok(metadata_to_entry(&target, &metadata))
}

/// Generate a unique copy name like "name - Copy.ext" or "name - Copy (2).ext".
fn generate_copy_name(dest_dir: &Path, source_name: &str, is_directory: bool) -> PathBuf {
    let (base_name, extension) = if is_directory {
        (source_name.to_string(), String::new())
    } else if let Some(dot_pos) = source_name.rfind('.') {
        (
            source_name[..dot_pos].to_string(),
            source_name[dot_pos..].to_string(),
        )
    } else {
        (source_name.to_string(), String::new())
    };

    // Try "name - Copy.ext" first
    let copy_name = format!("{} - Copy{}", base_name, extension);
    let target = dest_dir.join(&copy_name);
    if !target.exists() {
        return target;
    }

    // Try "name - Copy (n).ext" for n = 2, 3, 4, ...
    for counter in 2..=1000 {
        let copy_name = format!("{} - Copy ({}){}", base_name, counter, extension);
        let target = dest_dir.join(&copy_name);
        if !target.exists() {
            return target;
        }
    }

    // Fallback (should never reach here)
    dest_dir.join(format!("{} - Copy (overflow){}", base_name, extension))
}

/// Copy a file or directory.
#[tauri::command]
pub fn copy_entry(source: String, dest_dir: String) -> Result<FileEntry, FileError> {
    let source_path = PathBuf::from(&source);
    let dest_dir_path = PathBuf::from(&dest_dir);

    if !source_path.exists() {
        return Err(FileError::NotFound(source.clone()));
    }

    if !dest_dir_path.exists() {
        return Err(FileError::NotFound(format!(
            "Destination directory does not exist: {}",
            dest_dir
        )));
    }

    let source_name = source_path
        .file_name()
        .ok_or_else(|| FileError::InvalidPath("Invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();

    let mut target = dest_dir_path.join(&source_name);

    // If target exists, generate a "name - Copy" style name
    if target.exists() {
        target = generate_copy_name(&dest_dir_path, &source_name, source_path.is_dir());
    }

    if source_path.is_dir() {
        // Copy directory recursively
        let options = fs_extra::dir::CopyOptions::new();
        fs_extra::dir::copy(&source_path, &target.parent().unwrap(), &options)
            .map_err(|e| FileError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        // fs_extra copies into the directory, so adjust path
        let actual_target = target.parent().unwrap().join(&source_name);
        if actual_target != target && actual_target.exists() {
            fs::rename(&actual_target, &target)?;
        }
    } else {
        fs::copy(&source_path, &target)?;
    }

    let metadata = fs::metadata(&target)?;
    Ok(metadata_to_entry(&target, &metadata))
}

/// Move a file or directory.
#[tauri::command]
pub fn move_entry(source: String, dest_dir: String) -> Result<FileEntry, FileError> {
    let source_path = PathBuf::from(&source);
    let dest_dir_path = PathBuf::from(&dest_dir);

    if !source_path.exists() {
        return Err(FileError::NotFound(source.clone()));
    }

    if !dest_dir_path.exists() {
        return Err(FileError::NotFound(format!(
            "Destination directory does not exist: {}",
            dest_dir
        )));
    }

    let source_name = source_path
        .file_name()
        .ok_or_else(|| FileError::InvalidPath("Invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();

    let target = dest_dir_path.join(&source_name);

    if target.exists() {
        return Err(FileError::AlreadyExists(target.to_string_lossy().to_string()));
    }

    // Try a simple rename first (works if same filesystem)
    if fs::rename(&source_path, &target).is_err() {
        // Fall back to copy + delete for cross-filesystem moves
        if source_path.is_dir() {
            let options = fs_extra::dir::CopyOptions::new();
            fs_extra::dir::copy(&source_path, &dest_dir_path, &options)
                .map_err(|e| FileError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            fs::remove_dir_all(&source_path)?;
        } else {
            fs::copy(&source_path, &target)?;
            fs::remove_file(&source_path)?;
        }
    }

    let metadata = fs::metadata(&target)?;
    Ok(metadata_to_entry(&target, &metadata))
}

/// Open a file with the system's default application.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), FileError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(FileError::NotFound(path));
    }

    opener::open(&file_path)
        .map_err(|e| FileError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))
}

/// Delete a file or directory permanently (not to trash).
/// For trash, use the existing move_to_trash command.
#[tauri::command]
pub fn delete_entry_permanent(path: String) -> Result<(), FileError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(FileError::NotFound(path));
    }

    if file_path.is_dir() {
        fs::remove_dir_all(&file_path)?;
    } else {
        fs::remove_file(&file_path)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_list_directory() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("test.txt")).unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let result = list_directory(dir.path().to_string_lossy().to_string()).unwrap();

        assert_eq!(result.entries.len(), 2);
        // Directories should come first
        assert!(matches!(result.entries[0].kind, FileKind::Directory));
        assert!(matches!(result.entries[1].kind, FileKind::File));
    }

    #[test]
    fn test_create_directory() {
        let dir = tempdir().unwrap();
        let result = create_directory(
            dir.path().to_string_lossy().to_string(),
            "new_folder".to_string(),
        )
        .unwrap();

        assert_eq!(result.name, "new_folder");
        assert!(matches!(result.kind, FileKind::Directory));
        assert!(dir.path().join("new_folder").exists());
    }

    #[test]
    fn test_rename_entry() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("old_name.txt");
        File::create(&file_path).unwrap();

        let result =
            rename_entry(file_path.to_string_lossy().to_string(), "new_name.txt".to_string())
                .unwrap();

        assert_eq!(result.name, "new_name.txt");
        assert!(!file_path.exists());
        assert!(dir.path().join("new_name.txt").exists());
    }

    #[test]
    fn test_generate_copy_name() {
        let dir = tempdir().unwrap();

        // First copy
        let name = generate_copy_name(dir.path(), "test.txt", false);
        assert_eq!(name.file_name().unwrap().to_str().unwrap(), "test - Copy.txt");

        // Create that file, then generate another name
        File::create(&name).unwrap();
        let name2 = generate_copy_name(dir.path(), "test.txt", false);
        assert_eq!(
            name2.file_name().unwrap().to_str().unwrap(),
            "test - Copy (2).txt"
        );
    }
}
