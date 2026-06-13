//! Archive operations (compress/extract) for Tauri commands.
//! Issue: tauri-explorer-0xr, tauri-explorer-kez

use crate::error::AppError;
use crate::task_registry::TaskRegistry;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;
use zip::write::FileOptions;

/// Cancellable compression jobs, keyed by client-generated job id so the
/// frontend can cancel while the compress_to_zip invoke is still pending.
static COMPRESS_TASKS: TaskRegistry = TaskRegistry::new();
/// Cancellable extraction jobs (same scheme, separate namespace).
static EXTRACT_TASKS: TaskRegistry = TaskRegistry::new();

/// Emitted on the `zip-progress` / `unzip-progress` events.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ArchiveProgress {
    job_id: u64,
    bytes_done: u64,
    bytes_total: u64,
    current_file: String,
}

const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Byte-level progress + cancellation, threaded through the zip walk.
/// `event` is the Tauri event name to emit ("zip-progress" for compress,
/// "unzip-progress" for extract); `cancel_msg` is the error on cancellation.
struct ZipTracker<'a> {
    app: Option<&'a tauri::AppHandle>,
    event: &'static str,
    cancel_msg: &'static str,
    job_id: u64,
    bytes_done: u64,
    bytes_total: u64,
    cancelled: Option<&'a AtomicBool>,
    last_emit: Instant,
}

impl<'a> ZipTracker<'a> {
    fn new(
        app: Option<&'a tauri::AppHandle>,
        event: &'static str,
        cancel_msg: &'static str,
        job_id: u64,
        bytes_total: u64,
        cancelled: Option<&'a AtomicBool>,
    ) -> Self {
        Self {
            app,
            event,
            cancel_msg,
            job_id,
            bytes_done: 0,
            bytes_total,
            cancelled,
            // Backdated so the very first chunk emits immediately.
            last_emit: Instant::now() - PROGRESS_EMIT_INTERVAL,
        }
    }

    fn check_cancelled(&self) -> Result<(), AppError> {
        if self
            .cancelled
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Err(AppError::Other(self.cancel_msg.into()));
        }
        Ok(())
    }

    /// Record `n` more bytes processed; throttled progress emit.
    fn advance(&mut self, n: u64, current_file: &Path) -> Result<(), AppError> {
        self.bytes_done += n;
        self.check_cancelled()?;
        if let Some(app) = self.app {
            if self.last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
                self.last_emit = Instant::now();
                let _ = app.emit(
                    self.event,
                    ArchiveProgress {
                        job_id: self.job_id,
                        bytes_done: self.bytes_done,
                        bytes_total: self.bytes_total,
                        current_file: current_file.to_string_lossy().to_string(),
                    },
                );
            }
        }
        Ok(())
    }
}

/// Compress files/directories into a ZIP archive.
///
/// Creates a ZIP file in the same directory as the first source path.
/// If a single directory is selected, names the ZIP after that directory.
/// If multiple items, names it "Archive.zip" (with dedup).
///
/// `job_id` (client-generated) keys `zip-progress` events and cancellation
/// via `cancel_compress`. The blocking work runs off the async runtime.
#[tauri::command]
pub async fn compress_to_zip(
    app: tauri::AppHandle,
    paths: Vec<String>,
    job_id: Option<u64>,
) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || compress_to_zip_sync(Some(&app), paths, job_id))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Cancel a running compression job. The job fails with "Compression
/// cancelled" and the partial archive is removed.
#[tauri::command]
pub async fn cancel_compress(job_id: u64) {
    COMPRESS_TASKS.cancel(job_id);
}

fn compress_to_zip_sync(
    app: Option<&tauri::AppHandle>,
    paths: Vec<String>,
    job_id: Option<u64>,
) -> Result<String, AppError> {
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

    let cancelled = job_id.map(|id| COMPRESS_TASKS.start_with_id(id));
    let total = estimate_total_bytes(&paths);
    let mut tracker = ZipTracker::new(
        app,
        "zip-progress",
        "Compression cancelled",
        job_id.unwrap_or(0),
        total,
        cancelled.as_deref(),
    );
    let result = write_zip(&zip_path, &paths, &mut tracker);
    if let Some(id) = job_id {
        COMPRESS_TASKS.cleanup(id);
    }

    if let Err(e) = result {
        // Don't leave a corrupt half-written archive behind
        let _ = fs::remove_file(&zip_path);
        return Err(e);
    }

    log::info!("Compressed {} items to ZIP", paths.len());
    Ok(zip_path.to_string_lossy().to_string())
}

/// Sum file sizes the same way the zip walk will visit them (symlinks
/// skipped), so byte progress reaches ~100% exactly at completion.
fn estimate_total_bytes(paths: &[String]) -> u64 {
    fn walk(path: &Path, acc: &mut u64) {
        let Ok(md) = fs::symlink_metadata(path) else {
            return;
        };
        if md.file_type().is_symlink() {
            return;
        }
        if md.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    walk(&entry.path(), acc);
                }
            }
        } else {
            *acc += md.len();
        }
    }

    let mut total = 0u64;
    for p in paths {
        walk(Path::new(p), &mut total);
    }
    total
}

fn write_zip(zip_path: &Path, paths: &[String], tracker: &mut ZipTracker) -> Result<(), AppError> {
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
            add_directory_to_zip(&mut zip_writer, &path, &entry_name, options, tracker)?;
        } else {
            add_file_to_zip(&mut zip_writer, &path, &entry_name, options, tracker)?;
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
///
/// `job_id` (client-generated) keys `unzip-progress` events and cancellation
/// via `cancel_extract`. The blocking work runs off the async runtime.
#[tauri::command]
pub async fn extract_archive(
    app: tauri::AppHandle,
    archive_path: String,
    extract_here: bool,
    job_id: Option<u64>,
) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        extract_archive_sync(Some(&app), archive_path, extract_here, job_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Cancel a running extraction job. The job fails with "Extraction
/// cancelled" and the partial output is removed.
#[tauri::command]
pub async fn cancel_extract(job_id: u64) {
    EXTRACT_TASKS.cancel(job_id);
}

fn extract_archive_sync(
    app: Option<&tauri::AppHandle>,
    archive_path: String,
    extract_here: bool,
    job_id: Option<u64>,
) -> Result<String, AppError> {
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

    let cancelled = job_id.map(|id| EXTRACT_TASKS.start_with_id(id));
    let result = extract_entries(
        app,
        &archive,
        &dest,
        extract_here,
        job_id.unwrap_or(0),
        cancelled.as_deref(),
    );
    if let Some(id) = job_id {
        EXTRACT_TASKS.cleanup(id);
    }
    if let Err(e) = result {
        // Don't leave a partially extracted tree behind
        if !extract_here {
            let _ = fs::remove_dir_all(&dest);
        }
        return Err(e);
    }

    Ok(dest.to_string_lossy().to_string())
}

fn extract_entries(
    app: Option<&tauri::AppHandle>,
    archive: &Path,
    dest: &Path,
    extract_here: bool,
    job_id: u64,
    cancelled: Option<&AtomicBool>,
) -> Result<(), AppError> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Failed to read ZIP archive: {}", e)))?;

    // Pre-scan: validate every entry and detect conflicts BEFORE writing anything.
    // entry_paths[i] = (destination path, is_dir)
    let mut entry_paths: Vec<(PathBuf, bool)> = Vec::with_capacity(zip.len());
    // Total uncompressed bytes, so progress reaches ~100% at completion.
    let mut total_bytes: u64 = 0;
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

        if !entry.is_dir() {
            total_bytes += entry.size();
        }
        entry_paths.push((entry_path, entry.is_dir()));
    }

    log::info!(
        "Extracting archive ({} entries, extract_here={})",
        zip.len(),
        extract_here
    );
    let mut tracker = ZipTracker::new(
        app,
        "unzip-progress",
        "Extraction cancelled",
        job_id,
        total_bytes,
        cancelled,
    );
    let result = (|| -> Result<(), AppError> {
        for (i, (entry_path, is_dir)) in entry_paths.iter().enumerate() {
            tracker.check_cancelled()?;
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
                // Stream in chunks so each one reports progress and observes
                // cancellation, instead of one opaque std::io::copy.
                let mut buf = vec![0u8; 1024 * 1024];
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    std::io::Write::write_all(&mut outfile, &buf[..n])?;
                    tracker.advance(n as u64, entry_path)?;
                }
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
    tracker: &mut ZipTracker,
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

    tracker.check_cancelled()?;
    zip.start_file(name, options)
        .map_err(|e| AppError::Other(format!("Failed to add file to ZIP: {}", e)))?;

    // Stream the file into the archive in chunks instead of buffering it in
    // memory; each chunk advances byte progress and observes cancellation.
    let mut file = fs::File::open(path)?;
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(zip, &buf[..n])?;
        tracker.advance(n as u64, path)?;
    }

    Ok(())
}

fn add_directory_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    options: FileOptions<()>,
    tracker: &mut ZipTracker,
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
            add_directory_to_zip(zip, &entry_path, &full_name, options, tracker)?;
        } else {
            add_file_to_zip(zip, &entry_path, &full_name, options, tracker)?;
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
        let zip_path =
            compress_to_zip_sync(None, vec![src_dir.to_string_lossy().to_string()], None).unwrap();
        assert!(PathBuf::from(&zip_path).exists());

        // Extract
        let dest = extract_archive_sync(None, zip_path, false, None).unwrap();
        let dest_path = PathBuf::from(&dest);
        assert!(dest_path.join("source/hello.txt").exists());
        assert!(dest_path.join("source/sub/nested.txt").exists());

        let content = fs::read_to_string(dest_path.join("source/hello.txt")).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_cancelled_compress_fails_and_removes_partial_zip() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        // Multi-chunk file so cancellation is observed mid-write.
        fs::write(src_dir.join("big.bin"), vec![0u8; 3 * 1024 * 1024]).unwrap();

        let job_id = 999_001;
        // Cancel before starting: start_with_id replaces the flag, so set it
        // through the same registry path the command uses.
        let flag = COMPRESS_TASKS.start_with_id(job_id);
        flag.store(true, Ordering::Relaxed);

        // Bypass compress_to_zip_sync's own registration (it would reset the
        // flag): drive write_zip with a cancelled tracker directly.
        let zip_path = dir.path().join("source.zip");
        let mut tracker = ZipTracker::new(
            None,
            "zip-progress",
            "Compression cancelled",
            job_id,
            3 * 1024 * 1024,
            Some(&flag),
        );
        let err = write_zip(
            &zip_path,
            &[src_dir.to_string_lossy().to_string()],
            &mut tracker,
        )
        .expect_err("cancelled compression must fail");
        assert!(err.to_string().contains("cancelled"));
        COMPRESS_TASKS.cleanup(job_id);
    }

    #[test]
    fn test_cancelled_extract_aborts_without_writing() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("big.bin"), vec![0u8; 3 * 1024 * 1024]).unwrap();
        let zip_path =
            compress_to_zip_sync(None, vec![src_dir.to_string_lossy().to_string()], None).unwrap();

        let job_id = 999_002;
        let flag = EXTRACT_TASKS.start_with_id(job_id);
        flag.store(true, Ordering::Relaxed);

        // extract_archive_sync would reset the flag via its own start_with_id;
        // drive extract_entries directly with the pre-cancelled flag. With
        // extract_here=true, extract_entries owns best-effort cleanup.
        let dest = dir.path().join("out");
        fs::create_dir_all(&dest).unwrap();
        let err = extract_entries(None, Path::new(&zip_path), &dest, true, job_id, Some(&flag))
            .expect_err("cancelled extraction must fail");
        assert!(err.to_string().contains("cancelled"));
        // Aborted before writing anything.
        assert!(!dest.join("source/big.bin").exists());
        EXTRACT_TASKS.cleanup(job_id);
    }

    #[test]
    fn test_estimate_total_bytes_matches_file_sizes() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("a.txt"), vec![1u8; 1000]).unwrap();
        fs::create_dir(src_dir.join("sub")).unwrap();
        fs::write(src_dir.join("sub/b.txt"), vec![2u8; 500]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(src_dir.join("a.txt"), src_dir.join("link.txt")).unwrap();

        let total = estimate_total_bytes(&[src_dir.to_string_lossy().to_string()]);
        assert_eq!(total, 1500, "symlinks must not count toward total");
    }

    #[test]
    fn test_extract_here_refuses_to_overwrite_existing_file() {
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("a.txt"), "from archive").unwrap();
        fs::write(src_dir.join("b.txt"), "also from archive").unwrap();

        let zip_path =
            compress_to_zip_sync(None, vec![src_dir.to_string_lossy().to_string()], None).unwrap();

        // Extract into a separate dir where "source/b.txt" already exists
        let target = dir.path().join("target");
        fs::create_dir_all(target.join("source")).unwrap();
        fs::write(target.join("source/b.txt"), "precious user data").unwrap();
        let moved_zip = target.join("archive.zip");
        fs::rename(&zip_path, &moved_zip).unwrap();

        let result =
            extract_archive_sync(None, moved_zip.to_string_lossy().to_string(), true, None);
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

        let zip_path =
            compress_to_zip_sync(None, vec![src_dir.to_string_lossy().to_string()], None).unwrap();

        let dest = extract_archive_sync(None, zip_path, false, None).unwrap();
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

        let zip_path =
            compress_to_zip_sync(None, vec![src_dir.to_string_lossy().to_string()], None).unwrap();
        let dest = extract_archive_sync(None, zip_path, false, None).unwrap();

        let extracted = PathBuf::from(&dest).join("source/run.sh");
        let mode = fs::metadata(&extracted).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "executable bits should survive extraction"
        );
    }
}
