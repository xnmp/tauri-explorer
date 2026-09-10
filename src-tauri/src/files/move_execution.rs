//! Move admission and worker lifetime, shared by forward commands and inverses.
//! This is ownership reservation, not a durable move journal or exact inverse.
use super::{move_plan::MovePlan, mutation::FileMutationReceipt, WorkerCompletion};
use crate::error::AppError;

pub(crate) struct Outcome {
    pub completion: WorkerCompletion<FileMutationReceipt>,
    pub affected: Vec<String>,
}

struct Work<O> {
    plan: MovePlan,
    _owner: O,
}
impl<O> Work<O> {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        let destination = self
            .plan
            .target
            .parent()
            .ok_or_else(|| AppError::InvalidPath("Move target requires a parent".into()))?;
        let mut receipt = super::file_ops::move_entry_impl(
            self.plan.source.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
            Some(self.plan.overwrite),
        )?;
        if let Some(presentation) = &self.plan.presentation {
            // Physical paths remain the recovery authority. Preserve the pane's
            // spelling only while its alias still names the admitted directory.
            if presentation
                .parent()
                .and_then(|parent| std::fs::canonicalize(parent).ok())
                .as_deref()
                == Some(destination)
            {
                receipt.path = presentation.to_string_lossy().into_owned();
                if let Some(entry) = &mut receipt.entry {
                    entry.path = receipt.path.clone();
                }
            }
        }
        Ok(receipt)
    }
}

pub(crate) async fn execute_owned<O: Send + 'static>(plan: MovePlan, owner: O) -> Outcome {
    let affected = plan.affected_dirs();
    let completion = super::run_blocking_context(
        Work {
            plan,
            _owner: owner,
        },
        Work::execute,
    )
    .await;
    Outcome {
        completion,
        affected,
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn execute(
    plan: MovePlan,
    runtime: super::recovery::Runtime,
    storage: std::path::PathBuf,
) -> Outcome {
    let admission = match runtime.admit(storage, plan.resources()).await {
        Ok(admission) => admission,
        Err(error) => return unchanged(error),
    };
    let plan = plan.resolve(admission.paths().map(std::path::Path::to_path_buf));
    let mut outcome = match plan {
        Ok(plan) => execute_owned(plan, admission.context()).await,
        Err(error) => unchanged(error),
    };
    // The real worker has returned and dropped its context before settlement.
    // A cleanup failure cannot erase a confirmed destination or become a retry.
    if let Err(error) = super::run_blocking(move || admission.finish()).await {
        let mut warnings: crate::diagnostics::Warnings =
            outcome.completion.warning.take().into_iter().collect();
        warnings.push(format!(
            "Move finished, but its ownership record could not be retired: {error}"
        ));
        outcome.completion.warning = Some(warnings.into_vec().join("\n"));
    }
    outcome
}

#[cfg(target_os = "linux")]
fn unchanged(error: AppError) -> Outcome {
    Outcome {
        completion: WorkerCompletion {
            result: Err(error),
            warning: None,
        },
        affected: Vec::new(),
    }
}
