//! App-owned file open history (#1525) backing the Details "Date opened"
//! column. The document is opaque JSON owned by the frontend
//! (`domain/open-history.ts`); this module only stores it in the app data
//! directory beside the shared navigation history, so every window and app
//! process reads the same file. A missing, unreadable or oversized file reads
//! as empty: the history is best-effort and must never fail startup.
use crate::error::AppError;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 10k entries of long paths stay far below this; anything larger is corrupt.
pub(crate) const MAX_BYTES: usize = 16 * 1024 * 1024;
const FILE_NAME: &str = "open-history.json";

static WRITE: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn location() -> Result<PathBuf, AppError> {
    dirs::data_local_dir()
        .filter(|path| path.is_absolute())
        .map(|path| path.join("tauri-explorer").join(FILE_NAME))
        .ok_or_else(|| AppError::Other("No open history data directory".into()))
}

/// The stored document, or "" when it is missing, unreadable, not UTF-8 or
/// larger than [`MAX_BYTES`].
pub(crate) fn read_from(path: &Path) -> String {
    let Ok(file) = fs::File::open(path) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    use std::io::Read;
    if file
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_BYTES
    {
        return String::new();
    }
    String::from_utf8(bytes).unwrap_or_default()
}

/// Replace the document atomically: a crash leaves the previous complete file.
pub(crate) fn write_to(path: &Path, data: &str) -> io::Result<()> {
    if data.len() > MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "open history is too large",
        ));
    }
    let _guard = WRITE.lock().unwrap_or_else(|poison| poison.into_inner());
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("open history has no folder"))?;
    fs::create_dir_all(parent)?;
    // Per-process, per-write staging: another app process may be saving too.
    let staging = parent.join(format!(
        ".{FILE_NAME}.tmp-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = fs::File::create(&staging)
        .and_then(|mut file| {
            file.write_all(data.as_bytes())?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&staging, path));
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[tauri::command]
pub async fn read_open_history() -> Result<String, AppError> {
    let path = location()?;
    tauri::async_runtime::spawn_blocking(move || read_from(&path))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))
}

#[tauri::command]
pub async fn write_open_history(data: String) -> Result<(), AppError> {
    let path = location()?;
    tauri::async_runtime::spawn_blocking(move || write_to(&path, &data).map_err(AppError::Io))
        .await
        .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_from(&dir.path().join("absent.json")), "");
    }

    #[test]
    fn write_then_read_round_trips_and_creates_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        write_to(&path, r#"{"version":1,"entries":{"/a":1}}"#).unwrap();
        assert_eq!(read_from(&path), r#"{"version":1,"entries":{"/a":1}}"#);
        write_to(&path, "{}").unwrap();
        assert_eq!(read_from(&path), "{}");
        // No staging files are left behind.
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(FILE_NAME)]);
    }

    #[test]
    fn oversized_or_non_utf8_files_read_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
        assert_eq!(read_from(&path), "");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_from(&path), "");
    }

    #[test]
    fn oversized_writes_are_rejected_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write_to(&path, "{}").unwrap();
        let huge = " ".repeat(MAX_BYTES + 1);
        assert!(write_to(&path, &huge).is_err());
        assert_eq!(read_from(&path), "{}");
    }
}
