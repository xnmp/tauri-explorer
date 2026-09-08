//! Native admission and settlement for forward filesystem effects. Infrastructure
//! returns outcomes; it never records history or depends on a renderer lifetime.
use super::{action, model::ForwardEffect, service, supervise, Owner, Summary};
use crate::error::AppError;
use serde::Serialize;
use std::future::Future;

pub(crate) struct MutationOutcome<T> {
    pub result: Result<T, AppError>,
    pub effect: ForwardEffect,
    pub affected: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct MutationReply<T> {
    pub result: T,
    pub history: Summary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub(crate) async fn run_forward<T: Send + 'static>(
    owner: Owner,
    shared: bool,
    potential_directories: Vec<String>,
    work: impl Future<Output = MutationOutcome<T>> + Send + 'static,
) -> Result<MutationReply<T>, AppError> {
    let (client, reservation) = {
        let mut service = service().lock().unwrap();
        let client = service.client(&owner)?;
        let reservation = service.histories.begin_forward(client, shared)?;
        service.publish();
        (client, reservation)
    };
    // Like accepted inverses, this task owns settlement even if the command's
    // IPC waiter or its invoking window disappears before the filesystem reply.
    tauri::async_runtime::spawn(async move {
        #[cfg(feature = "e2e-renderer-recovery")]
        let work = {
            let directories = potential_directories.clone();
            let id = reservation.id();
            async move {
                super::acceptance_gate::after_forward_admission(id, directories)
                    .await.expect("Native forward admission gate failed");
                work.await
            }
        };
        let outcome = match supervise(work).await {
            Ok(outcome) => outcome,
            Err(error) => MutationOutcome {
                result: Err(AppError::Other(error)),
                effect: ForwardEffect::Changed(None),
                affected: potential_directories,
            },
        };
        let (effect, warning) = match outcome.effect {
            ForwardEffect::Changed(Some(action)) => match action::prepare(action, !cfg!(target_os = "macos")) {
                Ok(action) => (ForwardEffect::Changed(action), None),
                Err(error) => {
                    let warning = format!("File operation completed, but its Undo history could not be recorded: {error}");
                    log::warn!("{warning}");
                    (ForwardEffect::Changed(None), Some(warning))
                }
            },
            effect => (effect, None),
        };
        let history = {
            let mut service = service().lock().unwrap();
            service.histories.finish_forward(reservation, effect);
            service.publish();
            service.histories.summary(client)
        };
        crate::files::fs_watcher::publish_file_changes(&outcome.affected);
        outcome.result.map(|result| MutationReply { result, history, warning })
    }).await.map_err(|error| AppError::Other(format!("Native file mutation task failed: {error}")))?
}
