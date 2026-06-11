//! Archive operations (compress/extract) for Tauri commands.
//! Issue: tauri-explorer-0xr, tauri-explorer-kez

use crate::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};
use zip::write::FileOptions;

/// Compress files/directories into a ZIP archive.
///
/// Creates a ZIP file in the same directory as the first source path.
/// If a single directory is selected, names the ZIP after that directory.
/// If multiple items, names it "Archive.zip" (with dedup).
#[tauri::command]
pub async fn compress_to_zip(paths: Vec<String>) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || compress_to_zip_sync(paths))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn compress_to_zip_sync(paths: Vec<String>) -> Result<String, AppError> {
    if paths.is_empty() {
        return Err(AppError::Other("No paths provided".into()));
    }

    let first_path = PathBuf::from(&paths[0]);
    let parent_dir = first_path.parent().ok_or(AppError::InvalidPath(
        "Cannot determine parent directory".into(),
    ))?;

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

    if let Err(e) = write_zip(&zip_path, &paths) {
        // Don't leave a corrupt half-written archive behind
        let _ = fs::remove_file(&zip_path);
        return Err(e);
    }

    log::info!("Compressed {} items to ZIP", paths.len());
    Ok(zip_path.to_string_lossy().to_string())
}

fn write_zip(zip_path: &Path, paths: &[String]) -> Result<(), AppError> {
    let file = fs::File::create(zip_path)?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);

    for path_str in paths {
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

    Ok(())
}

/// Extract a ZIP archive.
///
/// If `extract_here` is true, extracts directly into the archive's parent
/// directory, failing before writing anything if any archive entry would
/// overwrite an existing file. Otherwise extracts into a new uniquely-named
/// folder (named after the archive) in the archive's parent directory.
#[tauri::command]
pub async fn extract_archive(archive_path: String, extract_here: bool) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || extract_archive_sync(archive_path, extract_here))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn extract_archive_sync(archive_path: String, extract_here: bool) -> Result<String, AppError> {
    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err(AppError::NotFound(archive_path));
    }

    let parent_dir = archive.parent().ok_or(AppError::InvalidPath(
        "Cannot determine parent directory".into(),
    ))?;

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

    let result = extract_entries(&archive, &dest, extract_here);
    if let Err(e) = result {
        // Don't leave a partially extracted tree behind
        if !extract_here {
            let _ = fs::remove_dir_all(&dest);
        }
        return Err(e);
    }

    Ok(dest.to_string_lossy().to_string())
}

fn extract_entries(archive: &Path, dest: &Path, extract_here: bool) -> Result<(), AppError> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Failed to read ZIP archive: {}", e)))?;

    // Pre-scan: validate every entry and detect conflicts BEFORE writing anything.
    // entry_paths[i] = (destination path, is_dir)
    let mut entry_paths: Vec<(PathBuf, bool)> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| AppError::Other(format!("Failed to read ZIP entry: {}", e)))?;

        let entry_path = dest.join(
            entry
                .enclosed_name()
                .ok_or_else(|| AppError::InvalidPath("Invalid entry name in archive".into()))?,
        );

        // Security: ensure we don't extract outside dest
        if !entry_path.starts_with(dest) {
            return Err(AppError::InvalidPath(
                "ZIP entry contains path traversal".into(),
            ));
        }

        // Existing directories merge harmlessly; existing files would be
        // silently overwritten, so refuse up front.
        if !entry.is_dir() && entry_path.exists() {
            return Err(AppError::AlreadyExists(
                entry_path.to_string_lossy().to_string(),
            ));
        }

        entry_paths.push((entry_path, entry.is_dir()));
    }

    log::info!(
        "Extracting archive ({} entries, extract_here={})",
        zip.len(),
        extract_here
    );
    let result = (|| -> Result<(), AppError> {
        for (i, (entry_path, is_dir)) in entry_paths.iter().enumerate() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| AppError::Other(format!("Failed to read ZIP entry: {}", e)))?;

            if *is_dir {
                fs::create_dir_all(entry_path)?;
            } else {
                if let Some(parent) = entry_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut outfile = fs::File::create(entry_path)?;
                std::io::copy(&mut entry, &mut outfile)?;
            }

            // Restore unix permissions (e.g. +x) stored in the archive
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                if mode != 0 {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(entry_path, fs::Permissions::from_mode(mode));
                }
            }
        }
        Ok(())
    })();

    if let Err(e) = result {
        if extract_here {
            // Best-effort cleanup: the pre-scan guaranteed these files didn't
            // exist before, so anything present now was created by us.
            for (path, is_dir) in entry_paths.iter().rev() {
                if *is_dir {
                    let _ = fs::remove_dir(path); // only removes if empty
                } else {
                    let _ = fs::remove_file(path);
                }
            }
        }
        return Err(e);
    }

    Ok(())
}

fn add_file_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    path: &Path,
    name: &str,
    options: FileOptions<()>,
) -> Result<(), AppError> {
    // Preserve unix permissions (e.g. +x) in the archive
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::PermissionsExt;
        match fs::metadata(path) {
            Ok(md) => options.unix_permissions(md.permissions().mode()),
            Err(_) => options,
        }
    };

    zip.start_file(name, options)
        .map_err(|e| AppError::Other(format!("Failed to add file to ZIP: {}", e)))?;

    // Stream the file into the archive instead of buffering it in memory
    let mut file = fs::File::open(path)?;
    std::io::copy(&mut file, zip)?;

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

        // Don't follow symlinks: following can recurse forever on cycles
        // and duplicate whole trees. DirEntry::file_type doesn't follow.
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            log::debug!("Skipping symlink in ZIP: {:?}", entry_path);
            continue;
        }

        if file_type.is_dir() {
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
        let zip_path = compress_to_zip_sync(vec![src_dir.to_string_lossy().to_string()]).unwrap();
        assert!(PathBuf::from(&zip_path).exists());

        // Extract
        let dest = extract_archive_sync(zip_path, false).unwrap();
        let dest_path = PathBuf::from(&dest);
        assert!(dest_path.join("source/hello.txt").exists());
        assert!(dest_path.join("source/sub/nested.txt").exists());

        let content = fs::read_to_string(dest_path.join("source/hello.txt")).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_extract_here_refuses_to_overwrite_existing_file() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("a.txt"), "from archive").unwrap();
        fs::write(src_dir.join("b.txt"), "also from archive").unwrap();

        let zip_path = compress_to_zip_sync(vec![src_dir.to_string_lossy().to_string()]).unwrap();

        // Extract into a separate dir where "source/b.txt" already exists
        let target = dir.path().join("target");
        fs::create_dir_all(target.join("source")).unwrap();
        fs::write(target.join("source/b.txt"), "precious user data").unwrap();
        let moved_zip = target.join("archive.zip");
        fs::rename(&zip_path, &moved_zip).unwrap();

        let result = extract_archive_sync(moved_zip.to_string_lossy().to_string(), true);
        let err = result.expect_err("conflicting extraction must fail");
        assert!(
            err.to_string().contains("b.txt"),
            "error should name the conflicting path, got: {}",
            err
        );

        // Pre-scan must fail before writing anything: a.txt was never created
        // and the existing file is untouched.
        assert!(!target.join("source/a.txt").exists());
        assert_eq!(
            fs::read_to_string(target.join("source/b.txt")).unwrap(),
            "precious user data"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_compress_skips_symlinks() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("real.txt"), "real").unwrap();
        // Symlink cycle: source/loop -> source
        std::os::unix::fs::symlink(&src_dir, src_dir.join("loop")).unwrap();

        let zip_path = compress_to_zip_sync(vec![src_dir.to_string_lossy().to_string()]).unwrap();

        let dest = extract_archive_sync(zip_path, false).unwrap();
        let dest_path = PathBuf::from(&dest);
        assert!(dest_path.join("source/real.txt").exists());
        assert!(
            !dest_path.join("source/loop").exists(),
            "symlink should be skipped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_extract_restores_unix_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        let script = src_dir.join("run.sh");
        fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let zip_path = compress_to_zip_sync(vec![src_dir.to_string_lossy().to_string()]).unwrap();
        let dest = extract_archive_sync(zip_path, false).unwrap();

        let extracted = PathBuf::from(&dest).join("source/run.sh");
        let mode = fs::metadata(&extracted).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "executable bits should survive extraction"
        );
    }
}
