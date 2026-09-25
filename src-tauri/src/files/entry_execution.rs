//! Entry admission and execution shared by commands and native history inverses.
use super::{entry_plan::EntryPlan, mutation::FileMutationReceipt, WorkerCompletion};
use crate::error::AppError;
use std::path::PathBuf;

pub(crate) struct Outcome {
    pub completion: WorkerCompletion<FileMutationReceipt>,
    pub affected: Vec<String>,
    pub target: PathBuf,
    pub rename: Option<(String, String)>,
}

struct Work<O> {
    plan: Option<EntryPlan>,
    _owner: O,
}
impl<O> Work<O> {
    fn execute(&mut self) -> Result<FileMutationReceipt, AppError> {
        super::file_ops::execute_entry_impl(self.plan.take().expect("entry executes once"))
    }
}

pub(crate) async fn execute_owned<O: Send + 'static>(plan: EntryPlan, owner: O) -> Outcome {
    let affected = plan.affected_dirs();
    let target = plan.target().to_owned();
    let rename = plan
        .rename_names()
        .map(|(old, new)| (old.to_owned(), new.to_owned()));
    let completion = super::run_blocking_context(
        Work {
            plan: Some(plan),
            _owner: owner,
        },
        Work::execute,
    )
    .await;
    Outcome {
        completion,
        affected,
        target,
        rename,
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn admit(
    plan: EntryPlan,
    runtime: super::recovery::Runtime,
    storage: PathBuf,
) -> Result<(EntryPlan, super::recovery::MutationAdmission), AppError> {
    let admission = runtime.admit(storage, plan.resources()).await?;
    match plan.resolve(admission.paths().map(std::path::Path::to_path_buf)) {
        Ok(plan) => Ok((plan, admission)),
        Err(error) => {
            // No worker started; release the reservation on this error path too.
            let _ = super::run_blocking(move || admission.finish()).await;
            Err(error)
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn finish(
    mut outcome: Outcome,
    admission: super::recovery::MutationAdmission,
) -> Outcome {
    if let Err(error) = super::run_blocking(move || admission.finish()).await {
        let mut warnings: crate::diagnostics::Warnings =
            outcome.completion.warning.take().into_iter().collect();
        warnings.push(format!(
            "File operation finished, but its ownership record could not be retired: {error}"
        ));
        outcome.completion.warning = Some(warnings.into_vec().join("\n"));
    }
    outcome
}

#[cfg(target_os = "linux")]
pub(crate) async fn execute(
    plan: EntryPlan,
    runtime: super::recovery::Runtime,
    storage: PathBuf,
) -> Outcome {
    match admit(plan, runtime, storage).await {
        Ok((plan, admission)) => {
            let outcome = execute_owned(plan, admission.context()).await;
            finish(outcome, admission).await
        }
        Err(error) => Outcome {
            completion: WorkerCompletion {
                result: Err(error),
                warning: None,
            },
            affected: Vec::new(),
            target: PathBuf::new(),
            rename: None,
        },
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/file_entry_execution.rs"]
mod tests;
