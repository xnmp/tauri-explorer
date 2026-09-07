//! Committed filesystem effects are independent of presentation metadata.
use super::{metadata_to_entry_probed, FileEntry};
use crate::error::AppError;
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Debug, Serialize)]
pub struct FileMutationReceipt {
    pub path: String,
    pub entry: Option<FileEntry>,
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
        let entry = inspect(path).map_err(|error| {
            log::warn!("Mutation committed at {}, but its entry metadata is unavailable: {error}", path.display());
        }).ok();
        Self { path: path.to_string_lossy().into_owned(), entry }
    }
}

#[cfg(test)]
#[path = "../../test_support/file_mutation_receipt.rs"]
mod tests;
