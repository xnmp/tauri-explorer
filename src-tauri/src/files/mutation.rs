//! Committed filesystem effects are independent of presentation metadata.
use super::{metadata_to_entry_probed, FileEntry};
use crate::error::AppError;
use serde::Serialize;
use std::{fs, path::Path};

/// Native observation of the object an ordinary copy actually published.
/// Paths are resolved at publication; callers cannot mint this through IPC.
/// EntryVersion detects ordinary replacement/metadata changes, not arbitrary
/// recursive edits or restored timestamps (see entry_version.rs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PublishedEntry {
    pub path: std::path::PathBuf,
    pub parent: super::object_id::ObjectId,
    pub version: super::entry_version::EntryVersion,
}

impl PublishedEntry {
    pub(crate) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>() + 2 * std::mem::size_of::<usize>() + self.path.capacity()
    }
}

/// Objects inspected for an ordered copy before requesting an overwrite choice.
#[cfg(target_os = "linux")]
pub(crate) struct CopyObservation {
    pub source: super::entry_version::EntryVersion,
    pub parent: super::object_id::ObjectId,
    pub target: Option<super::entry_version::EntryVersion>,
}

/// Other platforms cannot supply an observation until their copy adapters are
/// qualified. Shared copy dispatch accepts only `None` on these platforms.
#[cfg(not(target_os = "linux"))]
pub(crate) enum CopyObservation {}

#[derive(Debug, Serialize)]
pub struct FileMutationReceipt {
    pub path: String,
    pub entry: Option<FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<FileMutationRecovery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replacement: Option<CopyReplacementReceipt>,
    #[serde(skip)]
    pub(crate) warning: Option<String>,
    #[serde(skip)]
    pub(crate) publication: Option<std::sync::Arc<PublishedEntry>>,
}

/// The original is durably retained. An ordinary Copy inverse would remove the
/// publication without restoring it, so callers must not record that inverse.
#[derive(Debug, Serialize)]
pub struct CopyReplacementReceipt {
    pub id: String,
    #[serde(skip)]
    pub(crate) history: super::recovery::ReplacementHistory,
    #[serde(skip)]
    pub warning: Option<String>,
}

/// A destination was committed, but the complete requested move did not
/// finish. Never infer that the remaining source is intact after a recursive
/// removal error, or offer a path-only inverse which can destroy the last copy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMutationRecovery {
    pub source_path: String,
    pub destination_path: String,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub displaced_path: Option<String>,
}

impl FileMutationRecovery {
    pub(crate) fn message(&self) -> String {
        let retained = self
            .displaced_path
            .as_ref()
            .map(|path| format!(" The previous destination is retained at {path}."))
            .unwrap_or_default();
        format!("Files were copied to {}, but removing {} did not finish: {}. Inspect both locations before continuing.{retained}", self.destination_path, self.source_path, self.error)
    }
}

impl FileMutationReceipt {
    pub(crate) fn committed(path: &Path) -> Self {
        Self::inspect(path, |path| {
            let metadata = fs::symlink_metadata(path)?;
            Ok(metadata_to_entry_probed(path, &metadata))
        })
    }

    pub(crate) fn inspect(
        path: &Path,
        inspect: impl FnOnce(&Path) -> Result<FileEntry, AppError>,
    ) -> Self {
        let entry = inspect(path)
            .map_err(|error| {
                log::warn!(
                    "Mutation committed at {}, but its entry metadata is unavailable: {error}",
                    path.display()
                );
            })
            .ok();
        Self {
            path: path.to_string_lossy().into_owned(),
            entry,
            recovery: None,
            replacement: None,
            warning: None,
            publication: None,
        }
    }
}

#[cfg(test)]
#[path = "../../test_support/file_mutation_receipt.rs"]
mod tests;
