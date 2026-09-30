//! Move admission and worker lifetime, shared by forward commands and inverses.
//! This is ownership reservation, not a durable move journal or exact inverse.
use super::{admission, move_plan::MovePlan, mutation::FileMutationReceipt, WorkerCompletion};
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

/// Journalled relocation. `PreparedMove` performs its own admission, so this
/// path must not take a second reservation over the same resources.
#[cfg(target_os = "linux")]
struct DurableWork {
    plan: MovePlan,
    runtime: super::recovery::Runtime,
}

#[cfg(target_os = "linux")]
impl DurableWork {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        struct Uninterrupted;
        impl super::anchored_copy::CopyProgress for Uninterrupted {
            fn check_cancelled(&mut self) -> Result<(), AppError> {
                Ok(())
            }

            fn advance(&mut self, _: u64, _: &std::path::Path) -> Result<(), AppError> {
                Ok(())
            }
        }
        self.runtime
            .move_entry(&self.plan.source, &self.plan.target, &mut Uninterrupted)
    }
}

pub(crate) async fn execute(plan: MovePlan, runtime: &admission::Runtime) -> Outcome {
    #[cfg(target_os = "linux")]
    if cfg!(feature = "durable-move-recovery") {
        let affected = plan.affected_dirs();
        let runtime = runtime.clone();
        let completion =
            super::run_blocking_context(DurableWork { plan, runtime }, DurableWork::execute).await;
        return Outcome {
            completion,
            affected,
        };
    }
    admission::admitted_execute(plan, runtime, execute_owned).await
}

impl admission::Settle for Outcome {
    fn refused(error: AppError) -> Self {
        Outcome {
            completion: WorkerCompletion {
                result: Err(error),
                warning: None,
            },
            affected: Vec::new(),
        }
    }

    // The real worker has returned and dropped its context before settlement.
    // A cleanup failure cannot erase a confirmed destination or become a retry.
    fn unretired(&mut self, error: AppError) {
        let mut warnings: crate::diagnostics::Warnings =
            self.completion.warning.take().into_iter().collect();
        warnings.push(admission::unretired_warning("Move", &error));
        self.completion.warning = Some(warnings.into_vec().join("\n"));
    }
}
