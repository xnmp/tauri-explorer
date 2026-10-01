//! Explicit ownership of a destination displaced by an overwrite operation.
//! Unlike unpublished staging, dropping this owner never deletes user data.
//! Persistent journals/startup reconciliation and identity anchoring remain
//! prerequisites for complete overwrite history and process-crash recovery.

use super::publication::{private_directory, rename_noreplace};
use crate::error::AppError;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) struct DisplacedEntry {
    root: PathBuf,
    payload: PathBuf,
    original: PathBuf,
}

impl DisplacedEntry {
    fn capture(original: &Path) -> Result<Self, AppError> {
        let parent = original
            .parent()
            .ok_or_else(|| AppError::InvalidPath(original.display().to_string()))?;
        let directory = private_directory(parent, ".tauri-explorer-recovery-")?;
        // This record makes a retained original identifiable to manual recovery.
        // It is not a durable multi-volume transaction journal or global index.
        fs::write(
            directory.path().join("original-path.json"),
            serde_json::to_vec(original).map_err(|error| AppError::Other(error.to_string()))?,
        )?;
        let payload = directory.path().join("original");
        // Relinquish destructor cleanup BEFORE moving any user bytes. Even an
        // ambiguous rename error must not destroy an original that arrived.
        let held = Self {
            root: directory.keep(),
            payload,
            original: original.to_owned(),
        };
        if let Err(error) = rename_noreplace(original, &held.payload) {
            return Err(AppError::Other(format!(
                "Could not retain {} before replacement: {error}. Inspect recovery data at {}",
                original.display(),
                held.root.display()
            )));
        }
        Ok(held)
    }

    pub(super) fn retain(self) -> PathBuf {
        self.payload
    }

    /// Called only after a complete overwrite has committed. Failed removal
    /// retains the original-path record and reports the leftover artifact.
    pub(super) fn discard(self) {
        match super::file_ops::remove_entry_at(&self.payload) {
            Ok(()) => self.remove_record(),
            Err(error) => log::warn!(
                "Overwrite committed; previous destination remains at {}: {error}",
                self.payload.display()
            ),
        }
    }

    fn remove_record(self) {
        if let Err(error) = fs::remove_file(self.root.join("original-path.json"))
            .and_then(|_| fs::remove_dir(&self.root))
        {
            log::warn!(
                "Could not remove resolved replacement record {}: {error}",
                self.root.display()
            );
        }
    }

    fn restore(self, cause: AppError) -> AppError {
        match rename_noreplace(&self.payload, &self.original) {
            Ok(()) => { self.remove_record(); cause },
            Err(error) => AppError::Other(format!(
                "{cause}; could not restore the previous destination to {}: {error}. It is retained at {}",
                self.original.display(), self.payload.display()
            )),
        }
    }
}

/// Keep rollback policy shared across copy and move. The caller receives the
/// displaced artifact only after publication and decides whether recovery still
/// needs it. A rollback never replaces an entry created by another operation.
pub(super) fn replace<T>(
    target: &Path,
    publish: impl FnOnce() -> Result<T, AppError>,
) -> Result<(T, DisplacedEntry), AppError> {
    let held = DisplacedEntry::capture(target)?;
    match publish() {
        Ok(result) => Ok((result, held)),
        Err(error) => Err(held.restore(error)),
    }
}
