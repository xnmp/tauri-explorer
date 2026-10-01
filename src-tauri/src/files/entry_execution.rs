//! Entry admission and execution shared by commands and native history inverses.
use super::{admission, entry_plan::EntryPlan, mutation::FileMutationReceipt, WorkerCompletion};
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

pub(crate) async fn execute(plan: EntryPlan, runtime: &admission::Runtime) -> Outcome {
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
            target: PathBuf::new(),
            rename: None,
        }
    }

    fn unretired(&mut self, error: AppError) {
        let mut warnings: crate::diagnostics::Warnings =
            self.completion.warning.take().into_iter().collect();
        warnings.push(admission::unretired_warning("File operation", &error));
        self.completion.warning = Some(warnings.into_vec().join("\n"));
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/file_entry_execution.rs"]
mod tests;
