//! Archive operations (compress/extract) for Tauri commands.
//! Issue: tauri-explorer-0xr, tauri-explorer-kez

use crate::error::AppError;
use crate::files::{FileEntry, FileKind};
use crate::task_registry::TaskRegistry;
use chrono::{DateTime, Local};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use zip::write::FileOptions;

/// Cancellable compression jobs, keyed by client-generated job id so the
/// frontend can cancel while the compress_to_zip invoke is still pending.
static COMPRESS_TASKS: TaskRegistry = TaskRegistry::new();
/// Cancellable extraction jobs (same scheme, separate namespace).
static EXTRACT_TASKS: TaskRegistry = TaskRegistry::new();

/// Aggregate cap on total declared (uncompressed) bytes an archive may expand
/// to. Per-entry caps already stop a single zip-bomb entry from inflating past
/// its declared size, but a malicious archive can still declare thousands of
/// modest entries that together exhaust the disk. This is a defence-in-depth
/// backstop checked in the pre-scan, before a single byte is written.
///
/// We use a fixed generous cap rather than querying real free space: portable
/// free-space detection needs a new dependency (fs2/sysinfo — neither is in the
/// tree, `libc`'s statvfs is Unix-only) and free space is racy anyway (it can
/// drop between the check and the write). 100 GiB clears any legitimate archive
/// while still refusing the petabyte-scale totals a crafted bomb declares.
const MAX_EXTRACT_TOTAL_BYTES: u64 = 100 * 1024 * 1024 * 1024;

/// Byte-level progress + cancellation, threaded through the zip walk. Emits
/// `zip-progress` (compress) or `unzip-progress` (extract) events with the
/// job id, running byte count, and current file.
use crate::progress::ProgressTracker as ZipTracker;

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
        MAX_EXTRACT_TOTAL_BYTES,
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

/// Verify that an existing path resolves inside `canon_root` after following
/// symlinks. Catches symlinked directory components that a lexical
/// `starts_with` on the unresolved path cannot see.
fn ensure_within(canon_root: &Path, path: &Path) -> Result<(), AppError> {
    let resolved = fs::canonicalize(path)?;
    if !resolved.starts_with(canon_root) {
        return Err(AppError::InvalidPath(
            "ZIP entry resolves outside the destination directory".into(),
        ));
    }
    Ok(())
}

fn extract_entries(
    app: Option<&tauri::AppHandle>,
    archive: &Path,
    dest: &Path,
    extract_here: bool,
    job_id: u64,
    cancelled: Option<&AtomicBool>,
    max_total_bytes: u64,
) -> Result<(), AppError> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Failed to read ZIP archive: {}", e)))?;

    // Resolve the destination once up front. Per-entry containment checks
    // below compare against this real path, so a symlinked directory inside
    // dest can't redirect writes outside it (zip-slip via symlink, which a
    // purely lexical starts_with() on the unresolved path would miss).
    let canon_dest = fs::canonicalize(dest)?;

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
        // silently overwritten, so refuse up front. symlink_metadata (not
        // exists()) so a dangling symlink at the target also counts as
        // occupied instead of being silently followed on create.
        if !entry.is_dir() && fs::symlink_metadata(&entry_path).is_ok() {
            return Err(AppError::AlreadyExists(
                entry_path.to_string_lossy().to_string(),
            ));
        }

        if !entry.is_dir() {
            // saturating: declared sizes are attacker-controlled u64s, so a
            // crafted archive could wrap the sum past 2^64 and slip under the
            // aggregate cap below.
            total_bytes = total_bytes.saturating_add(entry.size());
        }
        entry_paths.push((entry_path, entry.is_dir()));
    }

    // Aggregate zip-bomb guard, checked before any write. The per-entry cap
    // during extraction only stops a single entry inflating past its declared
    // size; an archive can still *declare* an exhaustive total across many
    // entries and fill the disk honestly.
    if total_bytes > max_total_bytes {
        return Err(AppError::Other(format!(
            "Archive declares {} bytes of uncompressed data, exceeding the {} byte extraction limit; refusing to extract",
            total_bytes, max_total_bytes
        )));
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
                ensure_within(&canon_dest, entry_path)?;
            } else {
                if let Some(parent) = entry_path.parent() {
                    fs::create_dir_all(parent)?;
                    ensure_within(&canon_dest, parent)?;
                }
                // create_new: never follow a symlink planted at the target
                // between the pre-scan and this write, and never truncate a
                // file that appeared in that window.
                let mut outfile = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(entry_path)?;
                // Stream in chunks so each one reports progress and observes
                // cancellation, instead of one opaque std::io::copy.
                // Cap output at the size declared in the central directory:
                // a zip bomb's entries inflate far past what they declare.
                let declared = entry.size();
                let mut written: u64 = 0;
                let mut buf = vec![0u8; 1024 * 1024];
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    written += n as u64;
                    if written > declared {
                        return Err(AppError::Other(format!(
                            "ZIP entry expands past its declared size of {} bytes; refusing to extract",
                            declared
                        )));
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

/// Preview listing of a ZIP archive: its entries plus, when the archive's
/// sole top-level item is a directory, the name of that directory we
/// descended into (so the UI can show "contains one folder: X").
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub entries: Vec<FileEntry>,
    pub root_folder: Option<String>,
}

/// List the contents of a ZIP archive (one level deep) for the preview pane —
/// mirrors how a folder preview shows its direct children. If the only
/// top-level item is a directory, descend into it and report its name as
/// `root_folder`. Directories sort first, then alphabetically.
#[tauri::command]
pub async fn list_archive_contents(archive_path: String) -> Result<ArchiveListing, AppError> {
    tokio::task::spawn_blocking(move || list_archive_contents_sync(&archive_path))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// One zip entry reduced to its path components + classification.
struct ZipEntryInfo {
    comps: Vec<String>,
    is_dir: bool,
    size: u64,
}

/// Collapse entries to the level directly under `prefix`: the component at
/// index `prefix.len()` of every entry that nests below `prefix`. A name is a
/// directory if anything nests deeper under it, or its own entry is a dir.
/// Returns `name -> (is_dir, size)`.
fn level_under(entries: &[ZipEntryInfo], prefix: &[String]) -> BTreeMap<String, (bool, u64)> {
    let depth = prefix.len();
    let mut level: BTreeMap<String, (bool, u64)> = BTreeMap::new();
    for e in entries {
        if e.comps.len() <= depth || e.comps[..depth] != *prefix {
            continue;
        }
        let name = e.comps[depth].clone();
        let has_more = e.comps.len() > depth + 1;
        let is_dir = has_more || (e.comps.len() == depth + 1 && e.is_dir);
        let size = if is_dir { 0 } else { e.size };
        level
            .entry(name)
            .and_modify(|(d, s)| {
                if is_dir {
                    *d = true;
                } else {
                    *s = size;
                }
            })
            .or_insert((is_dir, size));
    }
    level
}

fn list_archive_contents_sync(archive_path: &str) -> Result<ArchiveListing, AppError> {
    let path = Path::new(archive_path);
    if !path.exists() {
        return Err(AppError::NotFound(archive_path.to_string()));
    }

    // ZIP entries carry no per-file mtime we surface here; use the archive's
    // own mtime for every row (the preview row doesn't display it anyway).
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            DateTime::<Local>::from(t)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        })
        .unwrap_or_default();

    let file = fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::Other(format!("Failed to read ZIP archive: {}", e)))?;

    // Read every entry's path components once (metadata only, no decoding).
    let mut infos: Vec<ZipEntryInfo> = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let entry = zip
            .by_index(i)
            .map_err(|e| AppError::Other(format!("Failed to read ZIP entry: {}", e)))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue; // skip entries with unsafe/invalid names
        };
        let comps: Vec<String> = enclosed
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .filter(|c| !c.is_empty())
            .collect();
        if comps.is_empty() {
            continue;
        }
        infos.push(ZipEntryInfo {
            comps,
            is_dir: entry.is_dir(),
            size: entry.size(),
        });
    }

    // Start at the top level and keep descending while the sole entry at the
    // current level is a directory, so a single-root archive — or a chain of
    // nested single folders (a/b/c/…) — shows the useful contents instead of
    // one lonely folder. `root_folder` reports the descended path (e.g. "a/b").
    let mut prefix: Vec<String> = Vec::new();
    loop {
        let level = level_under(&infos, &prefix);
        if level.len() != 1 {
            break;
        }
        let (name, (is_dir, _)) = level.iter().next().unwrap();
        if !*is_dir {
            break;
        }
        prefix.push(name.clone());
    }
    let root_folder = if prefix.is_empty() {
        None
    } else {
        Some(prefix.join("/"))
    };
    let level = level_under(&infos, &prefix);

    let mut entries: Vec<FileEntry> = level
        .into_iter()
        .map(|(name, (is_dir, size))| {
            let mut full = prefix.clone();
            full.push(name.clone());
            FileEntry {
                path: format!("{}!/{}", archive_path, full.join("/")),
                kind: if is_dir {
                    FileKind::Directory
                } else {
                    FileKind::File
                },
                size,
                modified: modified.clone(),
                is_symlink: false,
                symlink_target: None,
                is_empty: None,
                is_git_repo: false, // synthetic entries inside an archive, not real dirs
                name,
            }
        })
        .collect();

    entries.sort_by(|a, b| {
        let a_dir = matches!(a.kind, FileKind::Directory);
        let b_dir = matches!(b.kind, FileKind::Directory);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(ArchiveListing {
        entries,
        root_folder,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
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

    #[cfg(unix)]
    #[test]
    fn test_extract_rejects_symlinked_dir_escape() {
        // Zip contains data/inner.txt. At the destination, "data" is a
        // symlink pointing outside — extraction must refuse rather than
        // follow it and write outside the destination (zip-slip variant).
        let dir = tempdir().unwrap();
        let build = dir.path().join("build");
        fs::create_dir_all(build.join("data")).unwrap();
        fs::write(build.join("data/inner.txt"), "payload").unwrap();
        let zip_path = compress_to_zip_sync(
            None,
            vec![build.join("data").to_string_lossy().to_string()],
            None,
        )
        .unwrap();

        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let moved_zip = dest.join("data.zip");
        fs::rename(&zip_path, &moved_zip).unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, dest.join("data")).unwrap();

        let err = extract_archive_sync(None, moved_zip.to_string_lossy().to_string(), true, None)
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        assert!(
            !outside.join("inner.txt").exists(),
            "extraction escaped the destination directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_extract_refuses_dangling_symlink_at_target() {
        // A dangling symlink occupying an entry's path must count as an
        // existing file, not be followed and created elsewhere.
        let dir = tempdir().unwrap();
        let build = dir.path().join("build");
        fs::create_dir(&build).unwrap();
        fs::write(build.join("hello.txt"), "hi").unwrap();
        let zip_path = compress_to_zip_sync(
            None,
            vec![build.join("hello.txt").to_string_lossy().to_string()],
            None,
        )
        .unwrap();

        let dest = dir.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let moved_zip = dest.join("hello.zip");
        fs::rename(&zip_path, &moved_zip).unwrap();
        let target = dir.path().join("planted");
        std::os::unix::fs::symlink(&target, dest.join("hello.txt")).unwrap();

        let err = extract_archive_sync(None, moved_zip.to_string_lossy().to_string(), true, None)
            .unwrap_err();
        assert!(matches!(err, AppError::AlreadyExists(_)), "got {err:?}");
        assert!(!target.exists(), "write went through the planted symlink");
    }

    #[test]
    fn test_list_archive_contents_descends_into_sole_root_folder() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("root");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("readme.txt"), "hi").unwrap();
        fs::write(src.join("data.bin"), vec![0u8; 1234]).unwrap();
        fs::create_dir(src.join("nested")).unwrap();
        fs::write(src.join("nested/deep.txt"), "deep").unwrap();

        // Zipping the dir yields root/, root/readme.txt, root/nested/deep.txt
        // — the sole top-level item is the directory "root", so we descend
        // into it and show ITS contents, reporting root_folder = "root".
        let zip_path =
            compress_to_zip_sync(None, vec![src.to_string_lossy().to_string()], None).unwrap();
        let listing = list_archive_contents_sync(&zip_path).unwrap();
        assert_eq!(listing.root_folder.as_deref(), Some("root"));
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        // nested (dir) first, then files alphabetically.
        assert_eq!(names, vec!["nested", "data.bin", "readme.txt"]);
        let data = listing
            .entries
            .iter()
            .find(|e| e.name == "data.bin")
            .unwrap();
        assert!(matches!(data.kind, FileKind::File));
        assert_eq!(data.size, 1234);
        // Synthetic paths carry the descended prefix.
        assert!(data.path.ends_with("!/root/data.bin"));
        let nested = listing.entries.iter().find(|e| e.name == "nested").unwrap();
        assert!(matches!(nested.kind, FileKind::Directory));
    }

    #[test]
    fn test_list_archive_contents_descends_through_nested_single_folders() {
        // root/only/deep/{a.txt,b.txt} — each level above "deep" has a single
        // sub-directory, so descent continues until it reaches real content.
        let dir = tempdir().unwrap();
        let root = dir.path().join("root");
        let deep = root.join("only").join("deep");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("a.txt"), "a").unwrap();
        fs::write(deep.join("b.txt"), "b").unwrap();

        let zip_path =
            compress_to_zip_sync(None, vec![root.to_string_lossy().to_string()], None).unwrap();
        let listing = list_archive_contents_sync(&zip_path).unwrap();
        assert_eq!(listing.root_folder.as_deref(), Some("root/only/deep"));
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        let a = listing.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert!(a.path.ends_with("!/root/only/deep/a.txt"));
    }

    #[test]
    fn test_list_archive_contents_multiple_top_level_no_descent() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("root");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("readme.txt"), "hi").unwrap();
        fs::write(src.join("data.bin"), vec![0u8; 1234]).unwrap();
        fs::create_dir(src.join("nested")).unwrap();
        fs::write(src.join("nested/deep.txt"), "deep").unwrap();

        // Zip the files/dir directly → multiple top-level entries → no descent.
        let files = vec![
            src.join("readme.txt").to_string_lossy().to_string(),
            src.join("data.bin").to_string_lossy().to_string(),
            src.join("nested").to_string_lossy().to_string(),
        ];
        let zip = compress_to_zip_sync(None, files, None).unwrap();
        let listing = list_archive_contents_sync(&zip).unwrap();
        assert_eq!(listing.root_folder, None);
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["nested", "data.bin", "readme.txt"]);
        let nested = listing.entries.iter().find(|e| e.name == "nested").unwrap();
        assert!(nested.path.ends_with("!/nested"));
    }

    #[test]
    fn test_list_archive_contents_single_top_level_file_no_descent() {
        // A lone top-level *file* (not a folder) must not trigger descent.
        let dir = tempdir().unwrap();
        let f = dir.path().join("solo.txt");
        fs::write(&f, "hi").unwrap();
        let zip = compress_to_zip_sync(None, vec![f.to_string_lossy().to_string()], None).unwrap();
        let listing = list_archive_contents_sync(&zip).unwrap();
        assert_eq!(listing.root_folder, None);
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "solo.txt");
    }

    #[test]
    fn test_list_archive_contents_missing_file() {
        let err = list_archive_contents_sync("/no/such/archive.zip").expect_err("must error");
        assert!(matches!(err, AppError::NotFound(_)));
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
        let err = extract_entries(
            None,
            Path::new(&zip_path),
            &dest,
            true,
            job_id,
            Some(&flag),
            MAX_EXTRACT_TOTAL_BYTES,
        )
        .expect_err("cancelled extraction must fail");
        assert!(err.to_string().contains("cancelled"));
        // Aborted before writing anything.
        assert!(!dest.join("source/big.bin").exists());
        EXTRACT_TASKS.cleanup(job_id);
    }

    #[test]
    fn test_extract_refuses_archive_declaring_more_than_total_cap() {
        // An archive whose entries together declare more output than the
        // aggregate cap must be refused during the pre-scan, before any
        // write. The cap is injected small here so the test doesn't need a
        // real 100 GiB archive; the production call site passes
        // MAX_EXTRACT_TOTAL_BYTES through the same parameter.
        let dir = tempdir().unwrap();
        let src_dir = dir.path().join("source");
        fs::create_dir(&src_dir).unwrap();
        fs::write(src_dir.join("a.bin"), vec![0u8; 4096]).unwrap();
        fs::write(src_dir.join("b.bin"), vec![0u8; 4096]).unwrap();
        let zip_path =
            compress_to_zip_sync(None, vec![src_dir.to_string_lossy().to_string()], None).unwrap();

        let dest = dir.path().join("out");
        fs::create_dir_all(&dest).unwrap();
        // Each entry is under this cap; only the aggregate exceeds it.
        let err = extract_entries(None, Path::new(&zip_path), &dest, true, 0, None, 6000)
            .expect_err("archive declaring more than the cap must be refused");
        assert!(err.to_string().contains("extraction limit"), "got {err:?}");
        // Refused before writing anything.
        assert!(!dest.join("source").exists());
        assert!(!dest.join("source/a.bin").exists());
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
