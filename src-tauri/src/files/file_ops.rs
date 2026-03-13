//! File CRUD operations: create, rename, copy, move, delete, symlink, estimate, read/write text.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::AppError;
use super::{metadata_to_entry, FileEntry, SizeEstimate};

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
        return Err(AppError::InvalidPath(
            "Directory name cannot be empty".to_string(),
        ));
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
        return Err(AppError::AlreadyExists(
            new_path.to_string_lossy().to_string(),
        ));
    }

    fs::create_dir(&new_path)?;

    let metadata = fs::metadata(&new_path)?;
    Ok(metadata_to_entry(&new_path, &metadata))
}

/// Rename a file or directory.
#[tauri::command]
pub fn rename_entry(path: String, new_name: String) -> Result<FileEntry, AppError> {
    if new_name.is_empty() {
        return Err(AppError::InvalidPath(
            "New name cannot be empty".to_string(),
        ));
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
        return Err(AppError::AlreadyExists(
            target.to_string_lossy().to_string(),
        ));
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

    let copy_name = format!("{} - Copy{}", base_name, extension);
    let target = dest_dir.join(&copy_name);
    if !target.exists() {
        return target;
    }

    for counter in 2..=1000 {
        let copy_name = format!("{} - Copy ({}){}", base_name, counter, extension);
        let target = dest_dir.join(&copy_name);
        if !target.exists() {
            return target;
        }
    }

    dest_dir.join(format!(
        "{} - Copy (overflow){}",
        base_name, extension
    ))
}

/// Copy a file or directory.
/// If overwrite is true and target exists, replaces the existing entry.
#[tauri::command]
pub fn copy_entry(
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
) -> Result<FileEntry, AppError> {
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
            if target.is_dir() {
                fs::remove_dir_all(&target)?;
            } else {
                fs::remove_file(&target)?;
            }
        } else {
            target = generate_copy_name(&dest_dir_path, &source_name, source_path.is_dir());
        }
    }

    if source_path.is_dir() {
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
pub fn move_entry(
    source: String,
    dest_dir: String,
    overwrite: Option<bool>,
) -> Result<FileEntry, AppError> {
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
            return Err(AppError::AlreadyExists(
                target.to_string_lossy().to_string(),
            ));
        }
    }

    // Try a simple rename first (works if same filesystem)
    match fs::rename(&source_path, &target) {
        Ok(()) => {}
        Err(e) => {
            // Only fall back to copy+delete for cross-filesystem moves (EXDEV).
            // Other errors (permission denied, etc.) should be returned immediately.
            let is_cross_device = e.raw_os_error() == Some(libc::EXDEV);
            if !is_cross_device {
                return Err(AppError::Io(e));
            }
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
    }

    let metadata = fs::metadata(&target)?;
    Ok(metadata_to_entry(&target, &metadata))
}

/// Read a text file's contents with a size limit (default 1MB).
#[tauri::command]
pub fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String, AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    let limit = max_bytes.unwrap_or(1_048_576);
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

/// Batch-check which paths exist on the filesystem.
#[tauri::command]
pub fn check_paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| PathBuf::from(p).exists()).collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_create_directory() {
        let dir = tempdir().unwrap();
        let result = create_directory(
            dir.path().to_string_lossy().to_string(),
            "new_folder".to_string(),
        )
        .unwrap();

        assert_eq!(result.name, "new_folder");
        assert!(matches!(result.kind, super::super::FileKind::Directory));
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

        let name = generate_copy_name(dir.path(), "test.txt", false);
        assert_eq!(
            name.file_name().unwrap().to_str().unwrap(),
            "test - Copy.txt"
        );

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

        let source_dir = dir.path().join("my_folder");
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("file1.txt"), "hello").unwrap();
        fs::write(source_dir.join("file2.txt"), "world").unwrap();
        let sub = source_dir.join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("nested.txt"), "nested content").unwrap();

        let dest_dir = dir.path().join("dest");
        fs::create_dir(&dest_dir).unwrap();

        let result = copy_entry(
            source_dir.to_string_lossy().to_string(),
            dest_dir.to_string_lossy().to_string(),
            None,
        );

        assert!(result.is_ok(), "copy_entry failed: {:?}", result.err());
        let entry = result.unwrap();
        assert_eq!(entry.name, "my_folder");

        let copied = dest_dir.join("my_folder");
        assert!(copied.exists());
        assert!(copied.join("file1.txt").exists());
        assert!(copied.join("file2.txt").exists());
        assert!(copied.join("sub").exists());
        assert!(copied.join("sub/nested.txt").exists());
        assert_eq!(
            fs::read_to_string(copied.join("file1.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn test_copy_entry_folder_same_dir() {
        let dir = tempdir().unwrap();

        let source_dir = dir.path().join("my_folder");
        fs::create_dir(&source_dir).unwrap();
        fs::write(source_dir.join("file1.txt"), "hello").unwrap();

        let result = copy_entry(
            source_dir.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
            None,
        );

        assert!(
            result.is_ok(),
            "copy_entry same dir failed: {:?}",
            result.err()
        );
        let entry = result.unwrap();
        assert_eq!(entry.name, "my_folder - Copy");

        let copied = dir.path().join("my_folder - Copy");
        assert!(copied.exists());
        assert!(copied.join("file1.txt").exists());
    }

    #[test]
    fn test_estimate_size() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("file1.txt"), "hello").unwrap();
        fs::write(dir.path().join("file2.txt"), "world!").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();
        fs::write(dir.path().join("subdir/nested.txt"), "abc").unwrap();

        let result = estimate_size(vec![dir.path().to_string_lossy().to_string()]).unwrap();
        assert_eq!(result.file_count, 3);
        assert_eq!(result.total_bytes, 14);
    }
}
