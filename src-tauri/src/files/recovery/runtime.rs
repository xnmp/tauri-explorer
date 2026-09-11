//! Application-owned lazy recovery admission. Construction performs no filesystem
//! work; initialization and reservation happen inside the actual blocking task.
use super::{
    context::MutationAdmission,
    coordinator::Coordinator,
    resources::{self, Request},
};
use crate::error::AppError;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub(crate) struct Runtime {
    initialized: Arc<Mutex<Option<Initialized>>>,
    subscriptions: super::subscriptions::Subscriptions,
}

struct Initialized {
    path: PathBuf,
    coordinator: Arc<Coordinator>,
}

impl Runtime {
    /// Production replacement policy. Retention is deliberately opt-in until
    /// durable retirement exists. Discovery/history for existing records stays
    /// available in either build, and transient copies still obey their claims.
    pub(crate) fn copy_overwriting(
        &self,
        path: PathBuf,
        source: &std::path::Path,
        target: &std::path::Path,
        expected: Option<&crate::files::mutation::CopyObservation>,
        progress: &mut crate::progress::ProgressTracker,
    ) -> Result<crate::files::mutation::FileMutationReceipt, AppError> {
        // Both policies compile against the same recovery contracts. This
        // constant removes the opt-in branch from ordinary optimized builds.
        if cfg!(feature = "durable-copy-recovery") {
            match expected {
                Some(expected) => {
                    self.replace_copy_observed(path, source, target, expected, progress)
                }
                None => self.replace_copy(path, source, target, progress),
            }
        } else {
            use super::resources::{Access, Scope};
            let coordinator = self.coordinator(path)?;
            let reservation = coordinator.reserve(vec![
                Request {
                    path: source.to_owned(),
                    access: Access::Read,
                    scope: Scope::Subtree,
                },
                Request {
                    path: target.to_owned(),
                    access: Access::Write,
                    scope: Scope::Subtree,
                },
            ])?;
            let result = (|| {
                let paths: Vec<_> = reservation.paths().collect();
                let source = paths[0];
                let target = paths[1];
                let destination = target
                    .parent()
                    .ok_or_else(|| AppError::InvalidPath("Copy target requires a parent".into()))?;
                crate::files::file_ops::copy_entry_tracked(
                    source,
                    destination,
                    Some(true),
                    progress,
                    expected,
                    |source, destination, target, tracker| {
                        crate::files::file_ops::copy_entry_overwriting_observed(
                            source,
                            destination,
                            target,
                            tracker,
                            expected,
                        )
                    },
                )
            })();
            // The current blocking worker owns this reservation through all
            // staging/publication effects. Never turn committed work into an
            // ordinary error that invites replay after cleanup fails.
            match (result, reservation.finish()) {
                (Ok(receipt), Ok(())) => Ok(receipt),
                (Ok(mut receipt), Err(error)) => {
                    receipt.warning = Some(format!(
                        "Copy committed, but ownership cleanup failed: {error}"
                    ));
                    Ok(receipt)
                }
                (Err(error), Ok(())) => Err(error),
                (Err(error), Err(cleanup)) => Err(AppError::MutationUncertain(format!(
                    "{error}; copy ownership cleanup failed: {cleanup}"
                ))),
            }
        }
    }

    /// Production move policy. Durable records park cross-filesystem sources
    /// and retain displaced originals indefinitely until retirement exists
    /// (#687), so creating them is opt-in. Discovery, restoration and history
    /// for existing records stay available in either build.
    pub(crate) fn move_entry(
        &self,
        path: PathBuf,
        source: &std::path::Path,
        target: &std::path::Path,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<crate::files::mutation::FileMutationReceipt, AppError> {
        // Both policies compile against the same recovery contracts. This
        // constant removes the opt-in branch from ordinary optimized builds.
        if !cfg!(feature = "durable-move-recovery") {
            return Err(AppError::Other(
                "Durable move recovery is not enabled in this build".into(),
            ));
        }
        let coordinator = self.coordinator(path)?;
        let prepared = super::forward_move::PreparedMove::prepare(&coordinator, source, target)?;
        let result = prepared.execute(progress);
        let refresh: Vec<String> = result
            .as_ref()
            .ok()
            .and_then(|receipt| receipt.relocation.as_ref())
            .map(|relocation| relocation.history.refresh_dirs.clone())
            .unwrap_or_default();
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::files::fs_watcher::publish_file_changes(&refresh);
        }))
        .is_err()
        {
            log::warn!("Move completed, but directory refresh publication was interrupted");
        }
        // Publication belongs to the owned worker, so losing the requesting IPC
        // future cannot hide an operation that actually completed.
        match super::service::list(&coordinator) {
            Ok(snapshot) => self.subscriptions.publish(&snapshot),
            Err(error) => log::warn!("Could not refresh move recovery inventory: {error}"),
        }
        result
    }

    pub(crate) async fn execute_history(
        &self,
        path: PathBuf,
        history: super::ReplacementHistory,
        direction: super::ReplacementDirection,
    ) -> Result<super::ReplacementOutcome, AppError> {
        let runtime = self.clone();
        super::super::run_blocking(move || {
            let coordinator = runtime.coordinator(path)?;
            let mut result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                super::history::execute(&coordinator, history, direction)
            }));
            // The native owner has dropped before inventory publication, including
            // unwinding. History's outer supervisor owns filesystem refresh using
            // the captured token projection, avoiding duplicate watcher events.
            match super::service::list(&coordinator) {
                Ok(snapshot) => runtime.subscriptions.publish(&snapshot),
                Err(error) => {
                    log::warn!("Could not refresh replacement history inventory: {error}");
                    if let Ok(Ok(outcome)) = &mut result {
                        outcome.warning = Some(format!("File history completed, but File Recovery inventory could not refresh: {error}"));
                    }
                }
            }
            match result { Ok(result) => result, Err(panic) => std::panic::resume_unwind(panic) }
        }).await
    }

    /// Called inside the copy's owned blocking worker. Publish after the
    /// executor releases its native owner, even if the IPC waiter disappeared.
    pub(crate) fn replace_copy(
        &self,
        path: PathBuf,
        source: &std::path::Path,
        target: &std::path::Path,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<crate::files::mutation::FileMutationReceipt, AppError> {
        self.replace_copy_with(path, source, target, progress, super::service::enforce)
    }

    pub(crate) fn replace_copy_observed(
        &self,
        path: PathBuf,
        source: &std::path::Path,
        target: &std::path::Path,
        expected: &crate::files::mutation::CopyObservation,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
    ) -> Result<crate::files::mutation::FileMutationReceipt, AppError> {
        self.replace_copies_observed(
            path,
            &[(source, target)],
            Some(expected),
            progress,
            super::service::enforce,
        )
        .map(super::forward_copy::BatchExecution::into_single)?
    }

    fn replace_copy_with(
        &self,
        path: PathBuf,
        source: &std::path::Path,
        target: &std::path::Path,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
        inventory: impl FnOnce(&Arc<Coordinator>) -> Result<super::model::RecoverySnapshot, AppError>,
    ) -> Result<crate::files::mutation::FileMutationReceipt, AppError> {
        self.replace_copies_with(path, &[(source, target)], progress, inventory)
            .map(super::forward_copy::BatchExecution::into_single)?
    }

    fn replace_copies_with(
        &self,
        path: PathBuf,
        copies: &[(&std::path::Path, &std::path::Path)],
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
        inventory: impl FnOnce(&Arc<Coordinator>) -> Result<super::model::RecoverySnapshot, AppError>,
    ) -> Result<super::forward_copy::BatchExecution, AppError> {
        self.replace_copies_observed(path, copies, None, progress, inventory)
    }

    fn replace_copies_observed(
        &self,
        path: PathBuf,
        copies: &[(&std::path::Path, &std::path::Path)],
        expected: Option<&crate::files::mutation::CopyObservation>,
        progress: &mut impl crate::files::anchored_copy::CopyProgress,
        inventory: impl FnOnce(&Arc<Coordinator>) -> Result<super::model::RecoverySnapshot, AppError>,
    ) -> Result<super::forward_copy::BatchExecution, AppError> {
        let coordinator = self.coordinator(path)?;
        let prepared = super::forward_copy::prepare_batch(&coordinator, copies, progress)?;
        if expected.is_some_and(|expected| {
            prepared.len() != 1 || !prepared[0].matches_observation(expected)
        }) {
            return Err(super::forward_copy::PreparedCopy::retire(prepared,
                AppError::Other("Copy source or conflict changed before admission; retry to review the current entries".into())));
        }
        let mut result = super::forward_copy::execute_batch(prepared, progress);
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::files::fs_watcher::publish_file_changes(&result.physical_refresh);
        }))
        .is_err()
        {
            result.warn(
                "Copy completed its execution, but directory refresh publication was interrupted"
                    .into(),
            );
        }
        let publication = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let snapshot = inventory(&coordinator)?;
            self.subscriptions.publish(&snapshot);
            Ok::<(), AppError>(())
        }));
        match publication {
            Ok(Ok(())) => {},
            Ok(Err(error)) => {
                log::warn!("Could not refresh retained copy recovery inventory: {error}");
                result.warn(format!("File Recovery inventory could not refresh: {error}"));
            },
            Err(_) => result.warn("File Recovery inventory publication was interrupted; reopen File Recovery to retry discovery".into()),
        }
        Ok(result)
    }

    fn coordinator(&self, path: PathBuf) -> Result<Arc<Coordinator>, AppError> {
        let mut initialized = self
            .initialized
            .lock()
            .map_err(|_| AppError::Other("Recovery initialization was interrupted".into()))?;
        match initialized.as_ref() {
            Some(state) if state.path != path => Err(AppError::Other(
                "Recovery storage changed during this application session".into(),
            )),
            Some(state) => Ok(Arc::clone(&state.coordinator)),
            None => {
                let parent = path.parent().ok_or_else(|| {
                    AppError::InvalidPath(
                        "Recovery storage requires an application directory".into(),
                    )
                })?;
                std::fs::create_dir_all(parent)?;
                let coordinator = Coordinator::open(&path)?;
                *initialized = Some(Initialized {
                    path,
                    coordinator: Arc::clone(&coordinator),
                });
                Ok(coordinator)
            }
        }
    }

    /// Register before dispatching discovery so concurrent completed operations
    /// cannot fall into a list-then-listen gap. The pending guard seals a failed
    /// or cancelled acknowledgement; committed channels follow renderer lifetime.
    pub(crate) async fn subscribe(
        &self,
        path: PathBuf,
        owner: crate::renderer_owner::Owner,
        token: u64,
        receive: impl Fn(&super::model::RecoverySnapshot) -> bool + Send + Sync + 'static,
    ) -> Result<super::model::RecoverySnapshot, AppError> {
        let registration = self
            .subscriptions
            .subscribe(owner, token, Arc::new(receive))?;
        let snapshot = self.list(path).await?;
        registration.commit()?;
        Ok(snapshot)
    }

    pub(crate) fn unsubscribe(
        &self,
        owner: &crate::renderer_owner::Owner,
        token: u64,
    ) -> Result<(), AppError> {
        self.subscriptions.unsubscribe(owner, token)
    }

    fn inventory(&self, path: PathBuf) -> Result<super::model::RecoverySnapshot, AppError> {
        let coordinator = match self.coordinator(path.clone()) {
            Ok(coordinator) => coordinator,
            Err(error) => {
                // Never replace a live indexed view with revision-zero fallback.
                if self
                    .initialized
                    .lock()
                    .map_err(|_| AppError::Other("Recovery initialization was interrupted".into()))?
                    .is_some()
                {
                    return Err(error);
                }
                let intents = Coordinator::discover_catalog(&path)?;
                if intents.is_empty() {
                    return Err(error);
                }
                return Ok(super::service::unindexed(intents, error));
            }
        };
        // Evidence only. Listing is on the automatic session-bootstrap path
        // (`subscribe` calls it), so it must not claim ownership, probe user
        // volumes or remove anything — ADR 0020's startup boundary. Retention
        // enforcement runs from `retire_eligible` and after a record is
        // created, both of which are deliberate activity.
        super::service::list(&coordinator)
    }

    pub(crate) async fn list(
        &self,
        path: PathBuf,
    ) -> Result<super::model::RecoverySnapshot, AppError> {
        let runtime = self.clone();
        super::super::run_blocking(move || {
            let result = runtime.inventory(path);
            if let Ok(snapshot) = &result {
                runtime.subscriptions.publish(snapshot);
            }
            result
        })
        .await
    }

    /// Publication belongs to the owned worker, so losing the requesting IPC
    /// future does not hide an operation that actually completed. On failure a
    /// claim may already have advanced: publish fresh inventory when available,
    /// preserving the original operation error and never retrying its effects.
    async fn operate(
        &self,
        path: PathBuf,
        operation: impl FnOnce(&Arc<Coordinator>) -> Result<super::model::RecoverySnapshot, AppError>
            + Send
            + 'static,
    ) -> Result<super::model::RecoverySnapshot, AppError> {
        let runtime = self.clone();
        super::super::run_blocking(move || {
            let coordinator = runtime.coordinator(path)?;
            let result = operation(&coordinator);
            match &result {
                Ok(snapshot) => runtime.subscriptions.publish(snapshot),
                Err(_) => {
                    if let Ok(snapshot) = super::service::list(&coordinator) {
                        runtime.subscriptions.publish(&snapshot);
                    }
                }
            }
            result
        })
        .await
    }

    /// Explicit retention enforcement from recovery-session activity.
    pub(crate) async fn retire_eligible(
        &self,
        path: PathBuf,
    ) -> Result<super::model::RecoverySnapshot, AppError> {
        self.operate(path, super::service::enforce).await
    }

    pub(crate) async fn inspect(
        &self,
        path: PathBuf,
        id: String,
    ) -> Result<super::model::RecoverySnapshot, AppError> {
        self.operate(path, move |coordinator| {
            super::service::inspect(coordinator, &id)
        })
        .await
    }

    pub(crate) async fn resolve(
        &self,
        path: PathBuf,
        id: String,
        generation: u64,
        choice: super::model::RecoveryChoice,
    ) -> Result<super::model::RecoverySnapshot, AppError> {
        self.operate(path, move |coordinator| {
            super::service::resolve(coordinator, &id, generation, choice)
        })
        .await
    }

    pub(crate) async fn admit(
        &self,
        path: PathBuf,
        requests: Vec<Request>,
    ) -> Result<MutationAdmission, AppError> {
        let runtime = self.clone();
        super::super::run_blocking(move || {
            resources::validate_requests(&requests)?;
            let coordinator = runtime.coordinator(path)?;
            coordinator.reserve(requests).map(MutationAdmission::new)
        })
        .await
        .map_err(|error| {
            // Admission has not dispatched user-file work. A failed admission
            // worker must not be classified as an uncertain filesystem effect.
            AppError::Other(format!(
                "Could not acquire file operation ownership: {error}"
            ))
        })
    }
}

#[cfg(test)]
#[path = "../../../test_support/recovery_runtime.rs"]
mod tests;
