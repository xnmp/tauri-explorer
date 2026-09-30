//! The one admission seam for file mutations: admit, bind, execute, retire.
//! Linux admits through the recovery coordinator; other hosts have none yet
//! (#772) and execute unadmitted. This is the only place that fork is made.
use crate::error::AppError;
use std::future::Future;

#[cfg(target_os = "linux")]
pub(crate) use super::recovery::Runtime;
#[cfg(target_os = "linux")]
pub(crate) type Owner = super::recovery::MutationContext;

#[cfg(not(target_os = "linux"))]
#[derive(Clone)]
pub(crate) struct Runtime;
#[cfg(not(target_os = "linux"))]
pub(crate) type Owner = ();

#[cfg(not(target_os = "linux"))]
impl Runtime {
    #[cfg(test)]
    pub(crate) fn new(_storage: std::path::PathBuf) -> Self {
        Self
    }

    /// Only Linux recovery creates replacement records.
    pub(crate) async fn execute_history(
        &self,
        _: super::recovery::ReplacementHistory,
        _: super::recovery::ReplacementDirection,
    ) -> Result<super::recovery::ReplacementOutcome, AppError> {
        Err(AppError::Other(
            "Replacement recovery is unsupported on this host".into(),
        ))
    }
}

/// The application's runtime, managed once its storage path is known.
pub(crate) fn runtime(window: &tauri::Window) -> Result<Runtime, AppError> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        window
            .try_state::<Runtime>()
            .map(|runtime| runtime.inner().clone())
            .ok_or_else(|| AppError::Other("File recovery storage is unavailable".into()))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(Runtime)
    }
}

/// A plan names its claims before admission, then binds to the exact physical
/// paths admission returned, in request order.
pub(crate) trait Plan: Sized {
    #[cfg(target_os = "linux")]
    fn resources(&self) -> Vec<super::recovery::ResourceRequest>;
    #[cfg(target_os = "linux")]
    fn resolve(self, admitted: impl Iterator<Item = std::path::PathBuf>) -> Result<Self, AppError>;
}

// Unadmitted hosts never refuse or retire.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) trait Settle {
    /// Admission or binding failed before any worker started.
    fn refused(error: AppError) -> Self;
    /// The work returned, but its ownership record remains. This is only a
    /// diagnostic: an error would invite replaying a completed effect.
    fn unretired(&mut self, error: AppError);
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn unretired_warning(operation: &str, error: &AppError) -> String {
    format!("{operation} finished, but its ownership record could not be retired: {error}")
}

/// Whether a result may have changed the filesystem: callers reconcile worker
/// loss and uncertain effects, and never retry them.
pub(crate) fn changed<T>(result: &Result<T, AppError>) -> bool {
    matches!(
        result,
        Ok(_) | Err(AppError::MutationUncertain(_) | AppError::WorkerFailed(_))
    )
}

/// Admit `plan`, bind it, run `execute` with the admission's owner, then
/// retire the admission once `execute` has returned. A binding failure is
/// refused without dispatching work but still retires its reservation.
pub(crate) async fn admitted_execute<P: Plan, O: Settle, F: Future<Output = O>>(
    plan: P,
    runtime: &Runtime,
    execute: impl FnOnce(P, Owner) -> F,
) -> O {
    #[cfg(target_os = "linux")]
    {
        let admission = match runtime.admit(plan.resources()).await {
            Ok(admission) => admission,
            Err(error) => return O::refused(error),
        };
        match plan.resolve(admission.paths().map(std::path::Path::to_path_buf)) {
            Ok(plan) => {
                let owner = admission.context();
                retire(execute(plan, owner).await, admission).await
            }
            Err(error) => retire(O::refused(error), admission).await,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = runtime;
        execute(plan, ()).await
    }
}

/// [`admitted_execute`] for a selection whose claims are observed under the
/// coordinator's revision fence (`PreparedSelection::into_admission`).
#[cfg(target_os = "linux")]
pub(crate) async fn admitted_prepared<T: Send + 'static, O: Settle, F: Future<Output = O>>(
    runtime: &Runtime,
    prepare: impl FnMut() -> Result<(T, Vec<super::recovery::resources::Resource>), AppError>
        + Send
        + 'static,
    execute: impl FnOnce(T, Owner) -> F,
) -> O {
    match runtime.admit_prepared(prepare).await {
        Ok((prepared, admission)) => {
            let owner = admission.context();
            retire(execute(prepared, owner).await, admission).await
        }
        Err(error) => O::refused(error),
    }
}

#[cfg(target_os = "linux")]
async fn retire<O: Settle>(mut outcome: O, admission: super::recovery::MutationAdmission) -> O {
    if let Err(error) = super::run_blocking(move || admission.finish()).await {
        outcome.unretired(error);
    }
    outcome
}
