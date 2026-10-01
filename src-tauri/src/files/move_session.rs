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
    admission,
    copy_session::{Conflict, Control, Inspection, Work},
    file_ops, move_execution,
    move_plan::MovePlan,
    mutation::FileMutationReceipt,
    WorkerCompletion,
};
use crate::{error::AppError, files, progress::ProgressTracker};
use std::{fs, path::Path, sync::Arc};

#[derive(Clone)]
pub(crate) struct MoveWork {
    /// Progress travels on the request channel, so this session emits no
    /// global job events; `job_id` only labels the tracker's cancel reason.
    pub job_id: u64,
    /// The same admission seam `move_execution::execute` and the native
    /// history move adapter use (#881 follow-up, lesson 680). Trivial on
    /// non-Linux hosts, exactly like every other admitted mutation command.
    pub runtime: admission::Runtime,
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
        let source = Path::new(&inspection.source);
        let destination = Path::new(&inspection.destination);
        let name = match source.file_name() {
            Some(name) => name,
            None => {
                return WorkerCompletion {
                    result: Err(AppError::InvalidPath("Move source has no name".into())),
                    warning: None,
                }
            }
        };
        let target = destination.join(name);
        // Relocating an entry to the directory it already occupies is a
        // success that touches nothing. Reporting it as a conflict or an
        // overwrite would let a same-directory paste destroy the entry.
        if source == target {
            let mut receipt = present(FileMutationReceipt::committed(&target), &inspection);
            receipt.unchanged = true;
            return WorkerCompletion {
                result: Ok(receipt),
                warning: None,
            };
        }

        let tracker = ProgressTracker::new(
            None,
            "move-progress",
            "Move cancelled",
            self.job_id,
            inspection.bytes,
            Some(control.cancelled.cancellation_flag()),
        )
        .report_to(progress.as_ref());
        if let Err(error) = tracker.check_cancelled() {
            return WorkerCompletion {
                result: Err(error),
                warning: None,
            };
        }

        #[cfg(target_os = "linux")]
        if files::recovery::Runtime::DURABLE {
            // The durable path decides overwriting from the target it observes,
            // so an un-prompted conflict must fail closed here. A target that
            // appears after this check is still safe: the durable overwrite
            // retains the displaced original rather than discarding it.
            if !overwrite && fs::symlink_metadata(&target).is_ok() {
                return WorkerCompletion {
                    result: Err(AppError::AlreadyExists(
                        target.to_string_lossy().into_owned(),
                    )),
                    warning: None,
                };
            }
            let completion = files::run_blocking_context(
                DurableRelocateWork {
                    runtime: self.runtime.clone(),
                    control: control.clone(),
                    progress: progress.clone(),
                    job_id: self.job_id,
                    bytes: inspection.bytes,
                    source: source.to_path_buf(),
                    target: target.clone(),
                },
                DurableRelocateWork::execute,
            )
            .await;
            return map_completion(completion, &inspection);
        }

        // Non-durable: admit the resolved source/target through the same
        // seam the native history move adapter uses (`move_execution::execute`
        // -> `admission::admitted_execute`), so a session item can never run
        // while a recovery claim on either path is held (lesson 680; ADR 0024
        // level 3). Plugin moves used to lose this admission when they went
        // through the single-item `move_entry` command's own plan instead of
        // this session's `file_ops::move_entry_impl` shortcut (#881 follow-up).
        let plan = match MovePlan::new(
            inspection.source.clone(),
            inspection.destination.clone(),
            overwrite,
        ) {
            Ok(plan) => plan,
            Err(error) => {
                return WorkerCompletion {
                    result: Err(error),
                    warning: None,
                }
            }
        };
        let outcome = move_execution::execute(plan, &self.runtime).await;
        map_completion(outcome.completion, &inspection)
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

/// The real blocking effect for the durable journal branch only. The
/// non-durable branch is admitted through `move_execution::execute` instead
/// (see `MoveWork::apply`), which owns its own blocking worker.
#[cfg(target_os = "linux")]
struct DurableRelocateWork {
    runtime: admission::Runtime,
    control: Arc<Control>,
    progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    job_id: u64,
    bytes: u64,
    source: std::path::PathBuf,
    target: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl DurableRelocateWork {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        let mut tracker = ProgressTracker::new(
            None,
            "move-progress",
            "Move cancelled",
            self.job_id,
            self.bytes,
            Some(self.control.cancelled.cancellation_flag()),
        )
        .report_to(self.progress.as_ref());
        // The blocking worker may sit queued after the async supervisor's
        // final cancellation check. Fence the native effect at worker entry.
        tracker.check_cancelled()?;
        self.runtime
            .move_entry(&self.source, &self.target, &mut tracker)
    }
}

/// A destination that committed while its source removal did not finish is
/// not a success: the entry may still exist at both names, and an inverse
/// derived from it could destroy whichever copy is the real one. The session
/// records it as uncertain, which stops the run, keeps the cut clipboard and
/// offers no Undo. Also restores the pane's requested display spelling.
fn map_completion(
    mut completion: WorkerCompletion<FileMutationReceipt>,
    inspection: &Inspection,
) -> WorkerCompletion<FileMutationReceipt> {
    completion.result = completion.result.and_then(|receipt| {
        if let Some(recovery) = &receipt.recovery {
            return Err(AppError::MutationUncertain(recovery.message()));
        }
        Ok(present(receipt, inspection))
    });
    completion
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
