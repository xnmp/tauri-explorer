//! Committed filesystem effects are independent of presentation metadata.
use super::{metadata_to_entry_probed, FileEntry};
use crate::error::AppError;
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Debug, Serialize)]
pub struct FileMutationReceipt {
    pub path: String,
    pub entry: Option<FileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<FileMutationRecovery>,
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
        }
    }
}

#[cfg(test)]
#[path = "../../test_support/file_mutation_receipt.rs"]
mod tests;
