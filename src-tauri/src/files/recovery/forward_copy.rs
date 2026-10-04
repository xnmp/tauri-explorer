//! Production replacement orchestration. A single worker owns admission,
//! promotion, staged copying and publication; no phase owner escapes its result.
use super::{
    coordinator::Reservation,
    model::{OperationSpec, ReplacementSpec},
    replacement_execution::ReplacementExecution,
};
use crate::{
    error::AppError,
    files::{
        anchored_copy::CopyProgress,
        file_identity::of_file,
        mutation::{CopyReplacementReceipt, FileMutationReceipt},
        native_directory::Directory,
    },
};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Own the admitted paths separately from execution so its refresh projection
/// survives even a panicking worker. No artifact effects occur while preparing.
pub(super) struct PreparedCopy {
    reservation: Reservation,
    spec: ReplacementSpec,
    presentation: PathBuf,
}

mod batch;
mod plan;
pub(super) use batch::{execute_batch, BatchExecution};
#[cfg(test)]
use plan::prepare;
pub(super) use plan::prepare_batch;

/// Shared unstarted-owner settlement. Move preparation retires its reservations
/// through exactly the same bounded, diagnostic-preserving policy.
pub(super) fn finish_unstarted_owners(reservations: Vec<Reservation>, error: AppError) -> AppError {
    plan::finish_unstarted(reservations, error)
}

impl PreparedCopy {
    pub(super) fn matches_observation(
        &self,
        expected: &crate::files::mutation::CopyObservation,
    ) -> bool {
        self.spec.source_version == expected.source
            && self.spec.parent == expected.parent
            && Some(&self.spec.original) == expected.target.as_ref()
    }

    pub(super) fn retire(copies: Vec<Self>, error: AppError) -> AppError {
        plan::finish_unstarted(
            copies.into_iter().map(|copy| copy.reservation).collect(),
            error,
        )
    }
    /// The command's history settlement already publishes the requested parent.
    /// Add the admitted physical spelling only when distinct; no duplicate event
    /// is needed for the common case without aliases.
    pub(super) fn physical_refresh(&self) -> Option<String> {
        self.spec
            .target
            .0
            .parent()
            .filter(|parent| Some(*parent) != self.presentation.parent())
            .map(|parent| parent.to_string_lossy().into_owned())
    }

    pub(super) fn execute(
        self,
        progress: &mut impl CopyProgress,
    ) -> Result<FileMutationReceipt, AppError> {
        self.execute_verified(progress, None)
    }

    /// Validate the original independently of the generated copy source.
    pub(super) fn execute_verified(
        self,
        progress: &mut impl CopyProgress,
        original: Option<&crate::files::image_crop::SourceRevision>,
    ) -> Result<FileMutationReceipt, AppError> {
        self.execute_traced(progress, original, None)
    }

    pub(super) fn execute_traced(
        self,
        progress: &mut impl CopyProgress,
        original: Option<&crate::files::image_crop::SourceRevision>,
        trace: Option<(&crate::trace::TraceRunHandle, &str)>,
    ) -> Result<FileMutationReceipt, AppError> {
        if let Some(revision) = original {
            if let Err(error) =
                crate::files::image_crop::verify_source(&self.spec.target.0, revision)
            {
                return Err(Self::retire(vec![self], error));
            }
        }
        let Self {
            reservation,
            spec,
            presentation: target,
        } = self;
        if let Err(error) = progress.check_cancelled() {
            return Err(plan::finish_unstarted(vec![reservation], error));
        }
        let committed = spec.target.0.clone();
        let parent_identity = spec.parent;
        // A failed promotion may already have published immutable catalog evidence.
        // From this point errors must never promise ordinary partial-copy cleanup.
        let operation = reservation
            .promote(OperationSpec::CopyReplacement(spec))
            .map_err(|failure| {
                let error = failure.error;
                drop(failure.reservation);
                retained(error)
            })?;
        let id = operation.intent().id.clone();
        let result = (|| {
            let mut execution = ReplacementExecution::prepare(operation)?;
            execution.stage_copy(progress)?;
            if let Some((run, digest)) = trace {
                execution.prepare_trace(run, &committed, digest)?;
            }
            // Cancellation is honored until displacement. Once the original is
            // parked, finish publication without allowing cancellation to strand it.
            progress.check_cancelled()?;
            if let Some(revision) = original {
                crate::files::image_crop::verify_source(&committed, revision)?;
            }
            execution.displace_copy()?;
            if let Some(revision) = original {
                execution.verify_original_revision(revision)?;
            }
            execution.publish_copy()?;
            Ok::<_, AppError>(execution.operation.state().effect_revision)
        })();
        let revision = result.map_err(retained)?;
        let mut receipt = FileMutationReceipt::committed(&committed);
        // Keep aliases useful to the requesting pane only while its parent still
        // denotes the native directory captured by the durable operation.
        if target
            .parent()
            .and_then(|parent| fs::canonicalize(parent).ok())
            .and_then(|parent| Directory::open(&parent).ok())
            .and_then(|directory| of_file(&directory.file).ok())
            == Some(parent_identity)
        {
            receipt.path = target.to_string_lossy().into_owned();
            if let Some(entry) = &mut receipt.entry {
                entry.path = receipt.path.clone();
            }
        }
        let mut refresh_dirs: Vec<String> = [committed.as_path(), Path::new(&receipt.path)]
            .into_iter()
            .filter_map(|path| path.parent())
            .map(|parent| parent.to_string_lossy().into_owned())
            .collect();
        refresh_dirs.sort_unstable();
        refresh_dirs.dedup();
        receipt.replacement = Some(CopyReplacementReceipt {
            history: super::model::ReplacementHistory {
                id: id.clone(),
                revision,
                refresh_dirs,
            },
            id,
            warning: None,
        });
        Ok(receipt)
    }
}

fn retained(error: AppError) -> AppError {
    AppError::MutationUncertain(format!(
        "Replacement evidence is retained in File Recovery; inspect it before retrying. {error}"
    ))
}

#[cfg(test)]
#[path = "../../../test_support/recovery_forward_copy.rs"]
mod tests;
