//! File operations module for Tauri commands.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-3b5s

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use crate::error::AppError;

/// File system entry representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified: String, // ISO 8601
    #[serde(default)]
    pub is_symlink: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
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
    pub listing_id: Option<u64>,
}

/// Convert metadata to FileEntry, detecting symlinks.
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

    // Check if entry is a symlink (symlink_metadata doesn't follow links)
    let sym_meta = fs::symlink_metadata(path).ok();
    let is_symlink = sym_meta.as_ref().map_or(false, |m| m.file_type().is_symlink());
    let symlink_target = if is_symlink {
        fs::read_link(path).ok().map(|t| t.to_string_lossy().to_string())
    } else {
        None
    };

    FileEntry {
        name,
        path: path.to_string_lossy().to_string(),
        kind,
        size,
        modified,
        is_symlink,
        symlink_target,
    }
}

// ===================
// Directory Listing Cache
// Issue: tauri-explorer-jag7
// ===================

use std::time::Instant;

struct CachedListing {
    entries: Vec<FileEntry>,
    cached_at: Instant,
}

const CACHE_TTL_SECS: u64 = 5;
const MAX_CACHE_ENTRIES: usize = 50;

static DIR_CACHE: OnceLock<Mutex<HashMap<String, CachedListing>>> = OnceLock::new();

fn get_dir_cache() -> &'static Mutex<HashMap<String, CachedListing>> {
    DIR_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Invalidate cache for a specific directory.
#[tauri::command]
pub fn invalidate_dir_cache(path: String) -> Result<(), AppError> {
    let mut cache = get_dir_cache().lock().unwrap();
    cache.remove(&path);
    Ok(())
}

/// List directory contents.
/// Directories are sorted before files, and items are sorted case-insensitively by name.
#[tauri::command]
pub fn list_directory(path: String) -> Result<DirectoryListing, AppError> {
    // Check cache first
    {
        let cache = get_dir_cache().lock().unwrap();
        if let Some(cached) = cache.get(&path) {
            if cached.cached_at.elapsed().as_secs() < CACHE_TTL_SECS {
                return Ok(DirectoryListing {
                    path: path.clone(),
                    entries: cached.entries.clone(),
                    listing_id: None,
                });
            }
        }
    }

    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        return Err(AppError::NotFound(path.clone()));
    }

    if !dir_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", path)));
    }

    let mut entries = Vec::new();

    let read_dir = fs::read_dir(&dir_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            AppError::PermissionDenied(path.clone())
        } else {
            AppError::Io(e)
        }
    })?;

    for entry_result in read_dir {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue, // Skip inaccessible files
        };

        // Use fs::metadata (follows symlinks) so symlinks to directories
        // get kind=Directory. Fall back to DirEntry::metadata (which is
        // symlink_metadata on Unix) for broken/dangling symlinks.
        let metadata = match fs::metadata(entry.path()) {
            Ok(m) => m,
            Err(_) => match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            },
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

    // Update cache
    {
        let mut cache = get_dir_cache().lock().unwrap();
        // Evict expired entries if cache is full
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.retain(|_, v| v.cached_at.elapsed().as_secs() < CACHE_TTL_SECS);
        }
        cache.insert(
            path.clone(),
            CachedListing {
                entries: entries.clone(),
                cached_at: Instant::now(),
            },
        );
    }

    Ok(DirectoryListing { path, entries, listing_id: None })
}

/// Get the user's home directory.
#[tauri::command]
pub fn get_home_directory() -> Result<String, AppError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppError::NotFound("Home directory not found".to_string()))
}

/// Create a new directory.
#[tauri::command]
pub fn create_directory(parent_path: String, name: String) -> Result<FileEntry, AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidPath("Directory name cannot be empty".to_string()));
    }

    let parent = PathBuf::from(&parent_path);
    if !parent.exists() {
        return Err(AppError::NotFound(format!(
            "Parent directory does not exist: {}",
            parent_path
        )));
    }

    let new_path = parent.join(&name);
    if new_path.exists() {
        return Err(AppError::AlreadyExists(new_path.to_string_lossy().to_string()));
    }

    fs::create_dir(&new_path)?;

    let metadata = fs::metadata(&new_path)?;
    Ok(metadata_to_entry(&new_path, &metadata))
}

/// Rename a file or directory.
#[tauri::command]
pub fn rename_entry(path: String, new_name: String) -> Result<FileEntry, AppError> {
    if new_name.is_empty() {
        return Err(AppError::InvalidPath("New name cannot be empty".to_string()));
    }

    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err(AppError::NotFound(path.clone()));
    }

    let parent = source.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("Cannot get parent directory of: {}", path))
    })?;

    let target = parent.join(&new_name);
    if target.exists() {
        return Err(AppError::AlreadyExists(target.to_string_lossy().to_string()));
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
/// If overwrite is true and target exists, replaces the existing entry.
#[tauri::command]
pub fn copy_entry(source: String, dest_dir: String, overwrite: Option<bool>) -> Result<FileEntry, AppError> {
    let source_path = PathBuf::from(&source);
    let dest_dir_path = PathBuf::from(&dest_dir);

    if !source_path.exists() {
        return Err(AppError::NotFound(source.clone()));
    }

    if !dest_dir_path.exists() {
        return Err(AppError::NotFound(format!(
            "Destination directory does not exist: {}",
            dest_dir
        )));
    }

    let source_name = source_path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();

    let mut target = dest_dir_path.join(&source_name);

    if target.exists() {
        if overwrite.unwrap_or(false) {
            // Remove existing entry before copying
            if target.is_dir() {
                fs::remove_dir_all(&target)?;
            } else {
                fs::remove_file(&target)?;
            }
        } else {
            // Generate a "name - Copy" style name
            target = generate_copy_name(&dest_dir_path, &source_name, source_path.is_dir());
        }
    }

    if source_path.is_dir() {
        // Copy directory recursively: create target dir then copy contents into it
        fs::create_dir_all(&target)?;
        let mut options = fs_extra::dir::CopyOptions::new();
        options.content_only = true;
        options.overwrite = false;
        fs_extra::dir::copy(&source_path, &target, &options)
            .map_err(|e| AppError::Other(e.to_string()))?;
    } else {
        fs::copy(&source_path, &target)?;
    }

    let metadata = fs::metadata(&target)?;
    Ok(metadata_to_entry(&target, &metadata))
}

/// Move a file or directory.
/// If overwrite is true and target exists, replaces the existing entry.
#[tauri::command]
pub fn move_entry(source: String, dest_dir: String, overwrite: Option<bool>) -> Result<FileEntry, AppError> {
    let source_path = PathBuf::from(&source);
    let dest_dir_path = PathBuf::from(&dest_dir);

    if !source_path.exists() {
        return Err(AppError::NotFound(source.clone()));
    }

    if !dest_dir_path.exists() {
        return Err(AppError::NotFound(format!(
            "Destination directory does not exist: {}",
            dest_dir
        )));
    }

    let source_name = source_path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Invalid source path".to_string()))?
        .to_string_lossy()
        .to_string();

    let target = dest_dir_path.join(&source_name);

    if target.exists() {
        if overwrite.unwrap_or(false) {
            if target.is_dir() {
                fs::remove_dir_all(&target)?;
            } else {
                fs::remove_file(&target)?;
            }
        } else {
            return Err(AppError::AlreadyExists(target.to_string_lossy().to_string()));
        }
    }

    // Try a simple rename first (works if same filesystem)
    if fs::rename(&source_path, &target).is_err() {
        // Fall back to copy + delete for cross-filesystem moves
        if source_path.is_dir() {
            fs::create_dir_all(&target)?;
            let mut options = fs_extra::dir::CopyOptions::new();
            options.content_only = true;
            fs_extra::dir::copy(&source_path, &target, &options)
                .map_err(|e| AppError::Other(e.to_string()))?;
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
pub fn open_file(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    opener::open(&file_path)
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Open a file with a specified application.
#[tauri::command]
pub fn open_file_with(path: String, app: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    std::process::Command::new(&app)
        .arg(&file_path)
        .spawn()
        .map_err(|e| AppError::Io(e))?;

    Ok(())
}

/// Spawn a terminal emulator at the given directory, using the correct
/// arguments for each known terminal. Returns true on success.
fn try_spawn_terminal(term: &str, dir: &std::path::Path) -> bool {
    // Extract just the binary name for matching (handles full paths like /usr/bin/kitty)
    let bin = std::path::Path::new(term)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(term);

    let result = match bin {
        // ghostty and gnome-terminal use --working-directory=PATH (= syntax)
        "ghostty" | "gnome-terminal" => std::process::Command::new(term)
            .arg(format!("--working-directory={}", dir.display()))
            .spawn(),
        // kitty uses --directory
        "kitty" => std::process::Command::new(term)
            .arg("--directory")
            .arg(dir)
            .spawn(),
        // konsole uses --workdir
        "konsole" => std::process::Command::new(term)
            .arg("--workdir")
            .arg(dir)
            .spawn(),
        // alacritty uses --working-directory
        "alacritty" => std::process::Command::new(term)
            .arg("--working-directory")
            .arg(dir)
            .spawn(),
        // xterm and others: use current_dir as universal fallback
        _ => std::process::Command::new(term)
            .current_dir(dir)
            .spawn(),
    };

    result.is_ok()
}

/// Open a terminal at a directory path.
/// If `terminal` is non-empty, use that command; otherwise auto-detect.
#[tauri::command]
pub fn open_in_terminal(path: String, terminal: Option<String>) -> Result<(), AppError> {
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        return Err(AppError::NotFound(path));
    }

    // Use the directory itself or its parent for files
    let dir = if dir_path.is_dir() {
        dir_path
    } else {
        dir_path.parent().map(|p| p.to_path_buf()).unwrap_or(dir_path)
    };

    // Try user-configured terminal first (use current_dir which works universally)
    if let Some(ref term) = terminal {
        if !term.is_empty() {
            if try_spawn_terminal(term, &dir) {
                return Ok(());
            }
            // Fall through to auto-detect if configured terminal fails
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try common Linux terminal emulators with their correct arguments
        let terminals = ["ghostty", "kitty", "alacritty", "gnome-terminal", "konsole", "xterm"];
        for term in &terminals {
            if try_spawn_terminal(term, &dir) {
                return Ok(());
            }
        }
        // Fallback: use x-terminal-emulator
        std::process::Command::new("x-terminal-emulator")
            .current_dir(&dir)
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&dir)
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd.exe"])
            .current_dir(&dir)
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }

    Ok(())
}

/// Read a text file's contents with a size limit (default 1MB).
/// Returns the file content as a string. Binary files will fail gracefully.
#[tauri::command]
pub fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    let limit = max_bytes.unwrap_or(1_048_576); // 1MB default
    let metadata = fs::metadata(&file_path)?;

    if metadata.len() > limit {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("File too large: {} bytes (limit: {})", metadata.len(), limit),
        )));
    }

    let content = fs::read(&file_path)?;
    String::from_utf8(content).map_err(|_| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "File contains invalid UTF-8 (likely binary)",
        ))
    })
}

/// Write text content to a new file.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<FileEntry, AppError> {
    let file_path = PathBuf::from(&path);

    if file_path.exists() {
        return Err(AppError::AlreadyExists(path));
    }

    fs::write(&file_path, content.as_bytes())?;
    let metadata = fs::metadata(&file_path)?;
    Ok(metadata_to_entry(&file_path, &metadata))
}

/// Delete a file or directory permanently (not to trash).
/// For trash, use the existing move_to_trash command.
#[tauri::command]
pub fn delete_entry_permanent(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    if file_path.is_dir() {
        fs::remove_dir_all(&file_path)?;
    } else {
        fs::remove_file(&file_path)?;
    }

    Ok(())
}

/// Create a symbolic link.
///
/// Creates a symlink at `link_path` pointing to `target_path`.
#[tauri::command]
pub fn create_symlink(target_path: String, link_path: String) -> Result<FileEntry, AppError> {
    let target = PathBuf::from(&target_path);
    let link = PathBuf::from(&link_path);

    if !target.exists() {
        return Err(AppError::NotFound(target_path));
    }

    if link.exists() {
        return Err(AppError::AlreadyExists(link_path));
    }

    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link)?;

    #[cfg(windows)]
    {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(&target, &link)?;
        } else {
            std::os::windows::fs::symlink_file(&target, &link)?;
        }
    }

    let metadata = fs::metadata(&link)?;
    Ok(metadata_to_entry(&link, &metadata))
}

/// Estimate total file count and size for a list of paths.
/// Recursively walks directories. Used for progress estimation before copy/move.
#[derive(Debug, Serialize)]
pub struct SizeEstimate {
    #[serde(rename = "fileCount")]
    pub file_count: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
}

#[tauri::command]
pub fn estimate_size(paths: Vec<String>) -> Result<SizeEstimate, AppError> {
    let mut file_count: u64 = 0;
    let mut total_bytes: u64 = 0;

    for path_str in &paths {
        let path = PathBuf::from(path_str);
        if !path.exists() {
            return Err(AppError::NotFound(path_str.clone()));
        }
        estimate_path_size(&path, &mut file_count, &mut total_bytes);
    }

    Ok(SizeEstimate {
        file_count,
        total_bytes,
    })
}

fn estimate_path_size(path: &Path, file_count: &mut u64, total_bytes: &mut u64) {
    if path.is_file() {
        *file_count += 1;
        if let Ok(metadata) = fs::metadata(path) {
            *total_bytes += metadata.len();
        }
    } else if path.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                estimate_path_size(&entry.path(), file_count, total_bytes);
            }
        }
    }
}

// ===================
// Streaming Directory Listing
// Issue: tauri-explorer-3b5s
// ===================

/// Event payload for streaming directory entries.
#[derive(Debug, Clone, Serialize)]
pub struct DirectoryEntriesEvent {
    #[serde(rename = "listingId")]
    pub listing_id: u64,
    pub path: String,
    pub entries: Vec<FileEntry>,
    pub done: bool,
    #[serde(rename = "totalCount")]
    pub total_count: usize,
}

/// Registry for active directory listings
static LISTINGS: crate::task_registry::TaskRegistry = crate::task_registry::TaskRegistry::new();

/// Start streaming directory listing.
/// Returns first batch immediately and emits remaining entries via events.
/// For small directories (< batch_size), this behaves like regular list_directory.
#[tauri::command]
pub fn start_streaming_directory(
    app: AppHandle,
    path: String,
) -> Result<DirectoryListing, AppError> {
    let dir_path = PathBuf::from(&path);
    let batch_size = 100; // First batch size and subsequent event batch size

    if !dir_path.exists() {
        return Err(AppError::NotFound(path));
    }

    if !dir_path.is_dir() {
        return Err(AppError::InvalidPath(format!("Not a directory: {}", path)));
    }

    let read_dir = fs::read_dir(&dir_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            AppError::PermissionDenied(path.clone())
        } else {
            AppError::Io(e)
        }
    })?;

    // Collect all entries first (needed for sorting)
    let mut all_entries: Vec<FileEntry> = Vec::new();

    for entry_result in read_dir {
        let entry = match entry_result {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Use fs::metadata (follows symlinks) so symlinks to directories
        // get kind=Directory. Fall back for broken/dangling symlinks.
        let metadata = match fs::metadata(entry.path()) {
            Ok(m) => m,
            Err(_) => match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            },
        };

        all_entries.push(metadata_to_entry(&entry.path(), &metadata));
    }

    // Sort: directories first, then by name case-insensitively
    all_entries.sort_by(|a, b| {
        let a_is_dir = matches!(a.kind, FileKind::Directory);
        let b_is_dir = matches!(b.kind, FileKind::Directory);

        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    let total_count = all_entries.len();

    // If small directory, return everything immediately
    if total_count <= batch_size {
        return Ok(DirectoryListing {
            path,
            entries: all_entries,
            listing_id: None,
        });
    }

    // Split into first batch and remaining
    let first_batch: Vec<FileEntry> = all_entries.drain(..batch_size).collect();
    let remaining = all_entries; // Now contains the rest

    // Create listing ID and cancellation flag
    let (listing_id, cancelled) = LISTINGS.start();

    // Spawn background thread to emit remaining entries
    let path_clone = path.clone();
    std::thread::spawn(move || {
        let mut offset = batch_size;

        for chunk in remaining.chunks(batch_size) {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }

            let _ = app.emit(
                "directory-entries",
                DirectoryEntriesEvent {
                    listing_id,
                    path: path_clone.clone(),
                    entries: chunk.to_vec(),
                    done: offset + chunk.len() >= total_count,
                    total_count,
                },
            );

            offset += chunk.len();

            // Small delay to let UI render
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        LISTINGS.cleanup(listing_id);
    });

    // Return first batch immediately with listing_id as a separate field
    Ok(DirectoryListing {
        path,
        entries: first_batch,
        listing_id: Some(listing_id),
    })
}

/// Cancel an active directory listing.
#[tauri::command]
pub fn cancel_directory_listing(listing_id: u64) -> Result<(), AppError> {
    LISTINGS.cancel(listing_id);
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

    #[test]
    fn test_copy_entry_folder_with_files() {
        let dir = tempdir().unwrap();

        // Create source folder with files
        let source_dir = dir.path().join("my_folder");
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("file1.txt"), "hello").unwrap();
        fs::write(source_dir.join("file2.txt"), "world").unwrap();
        let sub = source_dir.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("nested.txt"), "nested content").unwrap();

        // Create destination directory
        let dest_dir = dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        // Copy the folder
        let result = copy_entry(
            source_dir.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
        );

        assert!(result.is_ok(), "copy_entry failed: {:?}", result.err());
        let entry = result.unwrap();
        assert_eq!(entry.name, "my_folder");

        // Verify contents were copied
        let copied = dest_dir.join("my_folder");
        assert!(copied.exists(), "Copied folder should exist");
        assert!(copied.join("file1.txt").exists(), "file1.txt should exist");
        assert!(copied.join("file2.txt").exists(), "file2.txt should exist");
        assert!(copied.join("sub").exists(), "sub dir should exist");
        assert!(copied.join("sub/nested.txt").exists(), "nested.txt should exist");
        assert_eq!(fs::read_to_string(copied.join("file1.txt")).unwrap(), "hello");
    }

    #[test]
    fn test_copy_entry_folder_same_dir() {
        let dir = tempdir().unwrap();

        // Create source folder with files
        let source_dir = dir.path().join("my_folder");
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("file1.txt"), "hello").unwrap();

        // Copy to same parent directory (should create "my_folder - Copy")
        let result = copy_entry(
            source_dir.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
        );

        assert!(result.is_ok(), "copy_entry same dir failed: {:?}", result.err());
        let entry = result.unwrap();
        assert_eq!(entry.name, "my_folder - Copy");

        // Verify copy contents
        let copied = dir.path().join("my_folder - Copy");
        assert!(copied.exists(), "Copy folder should exist");
        assert!(copied.join("file1.txt").exists(), "file1.txt should be in copy");
    }

    #[test]
    fn test_estimate_size() {
        let dir = tempdir().unwrap();
        // Create a file with known size
        fs::write(dir.path().join("file1.txt"), "hello").unwrap();
        fs::write(dir.path().join("file2.txt"), "world!").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir/nested.txt"), "abc").unwrap();

        let result = estimate_size(vec![dir.path().to_string_lossy().to_string()]).unwrap();
        assert_eq!(result.file_count, 3);
        assert_eq!(result.total_bytes, 14); // 5 + 6 + 3
    }
}
