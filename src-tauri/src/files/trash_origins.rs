//! Tauri Explorer's own record of where trashed items came from (#863).
//!
//! macOS keeps an item's original location private to Finder, so the Trash
//! view could not restore anything there. When the application trashes an
//! item itself, it now finds the item in the trash folder by its file
//! identity (a move to the Trash on the same volume keeps the inode) and
//! records the trashed path, original path and identity. Restore requires
//! that same identity at the trashed path, an existing original folder and
//! an unoccupied destination, then renames without replacement.
//!
//! The logic is portable Unix so Linux tests cover it; only macOS production
//! code records and restores through it.
use super::native_directory::Directory;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::{
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// Bound the record file; the oldest records are dropped first.
const MAX_RECORDS: usize = 10_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Record {
    pub trashed: PathBuf,
    pub original: PathBuf,
    pub device: u64,
    pub inode: u64,
    /// RFC 3339 deletion time.
    pub deleted_at: String,
}

impl Record {
    /// Whether `metadata` (of the entry at `trashed`) is the recorded item.
    pub(crate) fn matches(&self, metadata: &std::fs::Metadata) -> bool {
        metadata.dev() == self.device && metadata.ino() == self.inode
    }
}

/// One JSON file of records. Writers in this process are serialized; the file
/// is replaced atomically so a crash leaves the previous complete list.
pub(crate) struct Store {
    path: PathBuf,
}

static WRITE: Mutex<()> = Mutex::new(());

impl Store {
    pub(crate) fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// The application's record file.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub(crate) fn default_location() -> Option<Self> {
        dirs::data_local_dir()
            .filter(|path| path.is_absolute())
            .map(|path| {
                Self::at(
                    path.join("io.github.xnmp.tauri-explorer")
                        .join("trash-origins.json"),
                )
            })
    }

    /// Records whose trashed path still exists. A missing or unreadable file
    /// is an empty record set: listing must not fail because of it.
    pub(crate) fn load(&self) -> Vec<Record> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, records: &[Record]) -> io::Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("record file has no folder"))?;
        std::fs::create_dir_all(parent)?;
        // Per-process staging: another app process may be saving too.
        let staging = self
            .path
            .with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&staging, serde_json::to_vec(records)?)?;
        std::fs::rename(staging, &self.path)
    }

    fn update(&self, change: impl FnOnce(&mut Vec<Record>)) -> io::Result<()> {
        let _guard = WRITE.lock().unwrap_or_else(|poison| poison.into_inner());
        let mut records = self.load();
        change(&mut records);
        // Forget items that have left the trash (emptied, restored elsewhere).
        records.retain(|record| std::fs::symlink_metadata(&record.trashed).is_ok());
        let excess = records.len().saturating_sub(MAX_RECORDS);
        records.drain(..excess);
        self.save(&records)
    }

    pub(crate) fn add(&self, record: Record) -> io::Result<()> {
        self.update(|records| {
            records.retain(|existing| existing.trashed != record.trashed);
            records.push(record);
        })
    }

    pub(crate) fn remove(&self, trashed: &Path) -> io::Result<()> {
        self.update(|records| records.retain(|record| record.trashed != trashed))
    }
}

/// Trash `path` with `trash`, then record where it landed in `trash_dir`.
/// The deletion result is authoritative: an item that cannot be found or
/// recorded is still trashed, only without an in-app restore destination.
pub(crate) fn trash_recorded(
    path: &Path,
    trash_dir: &Path,
    store: &Store,
    trash: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let before = std::fs::symlink_metadata(path)?;
    // Restore walks folders without following symlinks, so record the
    // resolved folder (macOS `/tmp` is `/private/tmp`), keeping the leaf.
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(AppError::InvalidPath(path.display().to_string()));
    };
    let original = std::fs::canonicalize(parent)?.join(name);
    trash(path)?;
    let landed = std::fs::read_dir(trash_dir).ok().and_then(|entries| {
        entries
            .flatten()
            .map(|entry| entry.path())
            .find(|candidate| {
                std::fs::symlink_metadata(candidate)
                    .is_ok_and(|meta| meta.dev() == before.dev() && meta.ino() == before.ino())
            })
    });
    if let Some(trashed) = landed {
        let record = Record {
            trashed,
            original,
            device: before.dev(),
            inode: before.ino(),
            deleted_at: chrono::Local::now().to_rfc3339(),
        };
        if let Err(error) = store.add(record) {
            log::warn!(
                "Trashed {}, but its origin was not recorded: {error}",
                path.display()
            );
        }
    }
    Ok(())
}

/// Move the recorded item back to its original path. Refuses a changed item,
/// a missing original folder and an occupied destination without effects.
pub(crate) fn restore(record: &Record, store: &Store) -> Result<(), AppError> {
    let current = std::fs::symlink_metadata(&record.trashed)?;
    if !record.matches(&current) {
        return Err(AppError::Other(
            "The item in the Trash changed since it was listed; nothing was restored".into(),
        ));
    }
    let (Some(source_parent), Some(source_name)) =
        (record.trashed.parent(), record.trashed.file_name())
    else {
        return Err(AppError::InvalidPath(record.trashed.display().to_string()));
    };
    let (Some(target_parent), Some(target_name)) =
        (record.original.parent(), record.original.file_name())
    else {
        return Err(AppError::InvalidPath(record.original.display().to_string()));
    };
    let target_directory = Directory::open(target_parent).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            AppError::NotFound(format!(
                "The original folder {} no longer exists or its drive is not mounted. Restore or recreate that folder first.",
                target_parent.display()
            ))
        } else {
            error.into()
        }
    })?;
    Directory::open(source_parent)?
        .rename_to(source_name, &target_directory, target_name)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                AppError::AlreadyExists(format!(
                    "{} already exists. Rename or move it, then restore again.",
                    record.original.display()
                ))
            } else {
                error.into()
            }
        })?;
    if let Err(error) = store.remove(&record.trashed) {
        log::warn!(
            "Restored {}, but its record was not removed: {error}",
            record.original.display()
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../test_support/trash_origins.rs"]
mod tests;
