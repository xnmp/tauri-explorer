//! Archive operations (compress/extract) for Tauri commands.
//! Issue: tauri-explorer-0xr, tauri-explorer-kez

use crate::error::AppError;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::FileOptions;

/// Compress files/directories into a ZIP archive.
///
/// Creates a ZIP file in the same directory as the first source path.
/// If a single directory is selected, names the ZIP after that directory.
/// If multiple items, names it "Archive.zip" (with dedup).
#[tauri::command]
pub fn compress_to_zip(paths: Vec<String>) -> Result<String, AppError> {
    if paths.is_empty() {
        return Err(AppError::Other("No paths provided".into()));
    }

    let first_path = PathBuf::from(&paths[0]);
    let parent_dir = first_path
        .parent()
        .ok_or(AppError::InvalidPath("Cannot determine parent directory".into()))?;

    // Determine output filename
    let base_name = if paths.len() == 1 {
        first_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Archive".to_string())
    } else {
        "Archive".to_string()
    };

    let zip_path = find_unique_path(parent_dir, &base_name, "zip");

    let file = fs::File::create(&zip_path)?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for path_str in &paths {
        let path = PathBuf::from(path_str);
        let entry_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if path.is_dir() {
            add_directory_to_zip(&mut zip_writer, &path, &entry_name, options)?;
        } else {
            add_file_to_zip(&mut zip_writer, &path, &entry_name, options)?;
        }
    }

    zip_writer
        .finish()
        .map_err(|e| AppError::Other(format!("Failed to finalize ZIP: {}", e)))?;

    Ok(zip_path.to_string_lossy().to_string())
}

/// Extract a ZIP archive to a directory.
///
/// If `dest_dir` is None, extracts to a folder named after the archive
/// in the same directory as the archive.
/// If `extract_here` is true, extracts directly into the archive's parent directory.
#[tauri::command]
pub fn extract_archive(
    archive_path: String,
    extract_here: bool,
) -> Result<String, AppError> {
    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err(AppError::NotFound(archive_path));
    }

    let parent_dir = archive
        .parent()
        .ok_or(AppError::InvalidPath("Cannot determine parent directory".into()))?;

    let dest = if extract_here {
        parent_dir.to_path_buf()
    } else {
        let folder_name = archive
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "extracted".to_string());
        let dest = find_unique_path(parent_dir, &folder_name, "");
        fs::create_dir_all(&dest)?;
        dest
    };

    let file = fs::File::open(&archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Failed to read ZIP archive: {}", e)))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| AppError::Other(format!("Failed to read ZIP entry: {}", e)))?;

        let entry_path = dest.join(
            entry
                .enclosed_name()
                .ok_or_else(|| AppError::InvalidPath("Invalid entry name in archive".into()))?,
        );

        // Security: ensure we don't extract outside dest
        if !entry_path.starts_with(&dest) {
            return Err(AppError::InvalidPath("ZIP entry contains path traversal".into()));
        }

        if entry.is_dir() {
            fs::create_dir_all(&entry_path)?;
        } else {
            if let Some(parent) = entry_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = fs::File::create(&entry_path)?;
            std::io::copy(&mut entry, &mut outfile)?;
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

fn add_file_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    path: &Path,
    name: &str,
    options: FileOptions<()>,
) -> Result<(), AppError> {
    zip.start_file(name, options)
        .map_err(|e| AppError::Other(format!("Failed to add file to ZIP: {}", e)))?;

    let mut file = fs::File::open(path)?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;
    zip.write_all(&buffer)?;

    Ok(())
}

fn add_directory_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    options: FileOptions<()>,
) -> Result<(), AppError> {
    zip.add_directory(format!("{}/", prefix), options)
        .map_err(|e| AppError::Other(format!("Failed to add directory to ZIP: {}", e)))?;

    let entries = fs::read_dir(dir)?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let entry_name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let full_name = format!("{}/{}", prefix, entry_name);

        if entry_path.is_dir() {
            add_directory_to_zip(zip, &entry_path, &full_name, options)?;
        } else {
            add_file_to_zip(zip, &entry_path, &full_name, options)?;
        }
    }

    Ok(())
}

/// Find a unique path by appending (2), (3), etc. if needed.
fn find_unique_path(dir: &Path, base_name: &str, extension: &str) -> PathBuf {
    let make_path = |suffix: &str| {
        if extension.is_empty() {
            dir.join(format!("{}{}", base_name, suffix))
        } else {
            dir.join(format!("{}{}.{}", base_name, suffix, extension))
        }
    };

    let first = make_path("");
    if !first.exists() {
        return first;
    }

    for i in 2..=1000 {
        let path = make_path(&format!(" ({})", i));
        if !path.exists() {
            return path;
        }
    }

    make_path(" (overflow)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_compress_and_extract() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("hello.txt"), "hello world").unwrap();
        fs::create_dir(src_dir.join("sub")).unwrap();
        fs::write(src_dir.join("sub/nested.txt"), "nested content").unwrap();

        // Compress
        let zip_path = compress_to_zip(vec![src_dir.to_string_lossy().to_string()]).unwrap();
        assert!(PathBuf::from(&zip_path).exists());

        // Extract
        let dest = extract_archive(zip_path, false).unwrap();
        let dest_path = PathBuf::from(&dest);
        assert!(dest_path.join("source/hello.txt").exists());
        assert!(dest_path.join("source/sub/nested.txt").exists());

        let content = fs::read_to_string(dest_path.join("source/hello.txt")).unwrap();
        assert_eq!(content, "hello world");
    }
}
