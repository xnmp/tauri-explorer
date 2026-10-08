//! Bounded, rotating on-disk slow-load records (#1022).
//!
//! Each record is one JSON file named by its trace ID inside the app log
//! directory's `slow-loads/` folder, next to `crashes/`. A later write for the
//! same ID (the load finished, or the frontend replaced the native fallback)
//! atomically replaces the file. Only the newest [`MAX_RECORDS`] are kept;
//! trace IDs start with a fixed-width epoch-millisecond prefix, so name order
//! is chronological order.
use super::trace::valid_trace_id;
use serde::{de::DeserializeOwned, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const MAX_RECORDS: usize = 20;
pub(crate) const MAX_RECORD_BYTES: usize = 64 * 1024;
const EXTENSION: &str = ".json";

fn record_path(dir: &Path, id: &str) -> io::Result<PathBuf> {
    if !valid_trace_id(id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid slow-load trace ID",
        ));
    }
    Ok(dir.join(format!("{id}{EXTENSION}")))
}

/// Record IDs present in `dir`, newest first. Foreign files are ignored.
fn record_ids(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(EXTENSION)?;
            valid_trace_id(id).then(|| id.to_owned())
        })
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids
}

pub(crate) fn write<T: Serialize>(dir: &Path, id: &str, record: &T) -> io::Result<()> {
    let path = record_path(dir, id)?;
    let bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "slow-load record exceeds its size bound",
        ));
    }
    std::fs::create_dir_all(dir)?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = dir.join(format!(".{id}.{sequence}.tmp"));
    std::fs::write(&temporary, &bytes)?;
    std::fs::rename(&temporary, &path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })?;
    prune(dir);
    Ok(())
}

fn prune(dir: &Path) {
    for stale in record_ids(dir).into_iter().skip(MAX_RECORDS) {
        if let Ok(path) = record_path(dir, &stale) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Newest-first records that still parse; corrupt or foreign files are skipped.
pub(crate) fn read_recent<T: DeserializeOwned>(dir: &Path, limit: usize) -> Vec<T> {
    record_ids(dir)
        .into_iter()
        .filter_map(|id| {
            let path = record_path(dir, &id).ok()?;
            let metadata = std::fs::metadata(&path).ok()?;
            if metadata.len() > MAX_RECORD_BYTES as u64 {
                return None;
            }
            serde_json::from_slice(&std::fs::read(path).ok()?).ok()
        })
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Fake {
        id: String,
        note: String,
    }

    fn id(n: u64) -> String {
        format!("{:013}-a", 1_700_000_000_000 + n)
    }

    fn fake(n: u64, note: &str) -> Fake {
        Fake {
            id: id(n),
            note: note.into(),
        }
    }

    #[test]
    fn writes_replace_by_id_and_read_back_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &id(1), &fake(1, "pending")).unwrap();
        write(dir.path(), &id(2), &fake(2, "pending")).unwrap();
        write(dir.path(), &id(1), &fake(1, "finished")).unwrap();
        let records: Vec<Fake> = read_recent(dir.path(), 10);
        assert_eq!(records, vec![fake(2, "pending"), fake(1, "finished")]);
    }

    #[test]
    fn rotation_keeps_only_the_newest_records() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(MAX_RECORDS as u64 + 7) {
            write(dir.path(), &id(n), &fake(n, "x")).unwrap();
        }
        let records: Vec<Fake> = read_recent(dir.path(), 100);
        assert_eq!(records.len(), MAX_RECORDS);
        assert_eq!(records[0].id, id(MAX_RECORDS as u64 + 6));
        assert_eq!(records.last().unwrap().id, id(7));
        let files = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(files, MAX_RECORDS, "no temporary files remain");
    }

    #[test]
    fn rejects_unsafe_ids_and_oversized_records() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write(dir.path(), "../escape", &fake(0, "x")).is_err());
        assert!(!dir.path().parent().unwrap().join("escape.json").exists());
        let huge = fake(1, &"x".repeat(MAX_RECORD_BYTES));
        assert!(write(dir.path(), &id(1), &huge).is_err());
        assert!(read_recent::<Fake>(dir.path(), 5).is_empty());
    }

    #[test]
    fn corrupt_foreign_and_missing_files_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_recent::<Fake>(&dir.path().join("absent"), 5).is_empty());
        write(dir.path(), &id(1), &fake(1, "ok")).unwrap();
        std::fs::write(dir.path().join(format!("{}.json", id(2))), b"{not json").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"hello").unwrap();
        std::fs::write(dir.path().join("other.json"), b"{}").unwrap();
        let records: Vec<Fake> = read_recent(dir.path(), 5);
        assert_eq!(records, vec![fake(1, "ok")]);
        // Pruning never deletes files that are not records.
        assert!(dir.path().join("notes.txt").exists());
    }
}
