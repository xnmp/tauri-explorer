//! Ordered native move sessions.
//!
//! Only the inspection and the effect are move-specific: `copy_session::run`
//! owns ordering, conflict pauses, cancellation and the completed prefix, so a
//! move session cannot drift into a weaker retention contract than a copy.
//!
//! A move has two hazards a copy does not. It removes the source, so the
//! session must never begin an effect it has not first admitted; and its
//! inverse is the durable record, never a path, so a receipt that carries a
//! relocation record must not also produce a path-only Move action.
use super::{
    copy_session::{Conflict, Control, Inspection, Work},
    file_ops,
    mutation::FileMutationReceipt,
    WorkerCompletion,
};
use crate::{error::AppError, files, progress::ProgressTracker};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::{fs, path::Path, sync::Arc};

#[derive(Clone)]
pub(crate) struct MoveWork {
    pub app: Option<tauri::AppHandle>,
    pub job_id: u64,
    #[cfg(target_os = "linux")]
    pub recovery: (files::recovery::Runtime, PathBuf),
}

impl Work for MoveWork {
    async fn inspect(
        &self,
        source: String,
        destination: String,
        remaining: usize,
    ) -> Result<Inspection, AppError> {
        files::run_blocking(move || inspect(source, destination, remaining)).await
    }

    async fn apply(
        &self,
        inspection: Inspection,
        overwrite: bool,
        control: Arc<Control>,
        progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    ) -> WorkerCompletion<FileMutationReceipt> {
        files::run_blocking_context(
            RelocateWork {
                native: self.clone(),
                inspection,
                overwrite,
                control,
                progress,
            },
            RelocateWork::execute,
        )
        .await
    }
}

fn inspect(source: String, destination: String, remaining: usize) -> Result<Inspection, AppError> {
    let path = Path::new(&source);
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath("Move source has no name".into()))?;
    // Resolve aliases per child, exactly as a copy session does. The worker
    // then relocates these physical spellings even if the user retargets a
    // symlink while a conflict prompt is open.
    let source_parent = fs::canonicalize(
        path.parent()
            .ok_or_else(|| AppError::InvalidPath("Move source has no parent".into()))?,
    )?;
    let physical_source = source_parent.join(name);
    let presentation = destination;
    let destination = fs::canonicalize(&presentation)?;
    if !destination.is_dir() {
        return Err(AppError::InvalidPath(
            "Move destination is not a directory".into(),
        ));
    }
    // Reject before any prompt: a directory relocated under itself would
    // detach the subtree from the namespace entirely.
    file_ops::reject_dir_into_itself(&physical_source, &destination)?;
    let source_meta = fs::symlink_metadata(&physical_source)?;
    let target = destination.join(name);
    let target_meta = match fs::symlink_metadata(&target) {
        Ok(meta) => Some(meta),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    // A move within one directory is already at its destination. It is a
    // success with no effect, never an overwrite prompt against itself.
    let conflict = if source_parent == destination {
        None
    } else {
        target_meta.as_ref().map(|meta| {
            let original = files::metadata_to_entry_with_git_repo_probe(&target, meta, false);
            let source_entry =
                files::metadata_to_entry_with_git_repo_probe(&physical_source, &source_meta, false);
            Conflict {
                file_name: name.to_string_lossy().into_owned(),
                source_path: source.clone(),
                remaining,
                source_size: source_entry.size,
                source_modified: source_entry.modified,
                dest_size: original.size,
                dest_modified: original.modified,
            }
        })
    };
    Ok(Inspection {
        source: physical_source.to_string_lossy().into_owned(),
        destination: destination.to_string_lossy().into_owned(),
        presentation,
        conflict,
        bytes: if source_meta.is_dir() {
            0
        } else {
            source_meta.len()
        },
        #[cfg(target_os = "linux")]
        observation: None,
    })
}

struct RelocateWork {
    native: MoveWork,
    inspection: Inspection,
    overwrite: bool,
    control: Arc<Control>,
    progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
}

impl RelocateWork {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        let source = Path::new(&self.inspection.source);
        let destination = Path::new(&self.inspection.destination);
        let name = source
            .file_name()
            .ok_or_else(|| AppError::InvalidPath("Move source has no name".into()))?;
        let target = destination.join(name);
        // Relocating an entry to the directory it already occupies is a
        // success that touches nothing. Reporting it as a conflict or an
        // overwrite would let a same-directory paste destroy the entry.
        if source == target {
            return Ok(present(
                FileMutationReceipt::committed(&target),
                &self.inspection,
            ));
        }
        let mut tracker = ProgressTracker::new(
            self.native.app.as_ref(),
            "move-progress",
            "Move cancelled",
            self.native.job_id,
            self.inspection.bytes,
            Some(self.control.cancelled.cancellation_flag()),
        )
        .report_to(self.progress.as_ref());
        #[cfg(target_os = "linux")]
        if cfg!(feature = "durable-move-recovery") {
            // The durable path decides overwriting from the target it observes,
            // so an un-prompted conflict must fail closed here. A target that
            // appears after this check is still safe: the durable overwrite
            // retains the displaced original rather than discarding it.
            if !self.overwrite && fs::symlink_metadata(&target).is_ok() {
                return Err(AppError::AlreadyExists(
                    target.to_string_lossy().into_owned(),
                ));
            }
            return self
                .native
                .recovery
                .0
                .move_entry(
                    self.native.recovery.1.clone(),
                    source,
                    &target,
                    &mut tracker,
                )
                .map(|receipt| present(receipt, &self.inspection));
        }
        let _ = &mut tracker;
        file_ops::move_entry_impl(
            self.inspection.source.clone(),
            self.inspection.destination.clone(),
            Some(self.overwrite),
        )
        .map(|receipt| present(receipt, &self.inspection))
    }
}

/// Physical paths remain the recovery authority. Preserve the pane's spelling
/// only while its alias still names the inspected destination directory.
fn present(mut receipt: FileMutationReceipt, inspection: &Inspection) -> FileMutationReceipt {
    if fs::canonicalize(&inspection.presentation).ok().as_deref()
        != Some(Path::new(&inspection.destination))
    {
        return receipt;
    }
    if let Some(name) = Path::new(&receipt.path).file_name() {
        receipt.path = Path::new(&inspection.presentation)
            .join(name)
            .to_string_lossy()
            .into_owned();
        if let Some(entry) = &mut receipt.entry {
            entry.path = receipt.path.clone();
        }
    }
    receipt
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/move_session.rs"]
mod tests;
