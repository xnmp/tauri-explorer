//! Observation and execution of a permanent deletion are separate phases.
use crate::error::AppError;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct Prepared {
    path: PathBuf,
    observed: fs::Metadata,
}

impl Prepared {
    pub(crate) fn capture(path: &Path) -> Result<Self, AppError> {
        Ok(Self {
            path: path.to_owned(),
            observed: fs::symlink_metadata(path)?,
        })
    }

    pub(crate) fn execute(self) -> Result<(), AppError> {
        super::file_ops::remove_entry_at(&self.path)
            .map_err(|error| AppError::MutationUncertain(error.to_string()))?;
        log::info!(
            "Permanently deleted entry (is_dir={})",
            self.observed.is_dir()
        );
        Ok(())
    }
}

#[cfg(all(test, unix))]
#[path = "../../test_support/permanent_delete.rs"]
mod tests;
