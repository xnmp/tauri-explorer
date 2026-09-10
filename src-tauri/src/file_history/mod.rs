//! Application-owned file history and inverse execution.
mod action;
mod execution;
mod forward;
mod model;
mod plan;
mod retention;
pub(crate) use forward::{run_forward, MutationOutcome, MutationReply};
pub(crate) use model::ForwardEffect;
pub(crate) use model::{Action, Recovery};
#[cfg(feature = "e2e-renderer-recovery")]
#[path = "../../test_support/file_history_gate.rs"]
mod acceptance_gate;
pub(crate) use model::Summary as HistorySummary;

use crate::{
    error::AppError,
    renderer_owner::{self, Owner},
};
use model::{ClientId, Direction, EntryId, Execution, Histories, Summary};
use serde::Serialize;
use std::{
    future::Future,
    sync::{Mutex, OnceLock},
};
use tauri::ipc::Channel;

struct Client {
    id: ClientId,
    owner: Owner,
    channel: Channel<Summary>,
}

#[derive(Default)]
struct Service {
    histories: Histories,
    clients: Vec<Client>,
    next_client: ClientId,
}

static SERVICE: OnceLock<Mutex<Service>> = OnceLock::new();
fn service() -> &'static Mutex<Service> {
    SERVICE.get_or_init(|| Mutex::new(Service::default()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    summary: Summary,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<Action>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Service {
    fn prune(&mut self) {
        self.clients.retain(|client| {
            if client.owner.active() {
                true
            } else {
                self.histories.retire(client.id);
                false
            }
        });
    }
    fn client(&mut self, owner: &Owner) -> Result<ClientId, AppError> {
        self.prune();
        self.clients
            .iter()
            .find(|client| client.owner.same(owner))
            .map(|client| client.id)
            .ok_or_else(|| AppError::Other("File history session is closed".into()))
    }
    fn publish(&mut self) {
        self.prune();
        for client in &self.clients {
            if let Err(error) = client.channel.send(self.histories.summary(client.id)) {
                log::warn!("Could not publish file history summary: {error}");
            }
        }
    }
    fn reply(&self, client: ClientId, action: Option<Action>, error: Option<String>) -> Reply {
        Reply {
            summary: self.histories.summary(client),
            action,
            warnings: Vec::new(),
            error,
        }
    }
}

/// Piggyback history subscription on the existing renderer acknowledgement.
/// The first full snapshot and future updates share the same ordered channel.
pub(crate) fn register(owner: Owner, channel: Channel<Summary>) -> Result<(), AppError> {
    let mut service = service().lock().unwrap();
    service.prune();
    if !owner.active() {
        return Err(AppError::Other("File history session is closed".into()));
    }
    if let Some(client) = service
        .clients
        .iter_mut()
        .find(|client| client.owner.same(&owner))
    {
        client.channel = channel;
    } else {
        service.next_client = service
            .next_client
            .checked_add(1)
            .ok_or_else(|| AppError::Other("File history client IDs exhausted".into()))?;
        let id = service.next_client;
        service.histories.register(id);
        service.clients.push(Client { id, owner, channel });
    }
    service.publish();
    Ok(())
}

/// Native lifecycle hooks must not deallocate retained file histories on the
/// UI thread. Accepted inverse tasks retain their own reservation and continue.
pub(crate) fn retire_owners() {
    if SERVICE.get().is_some() {
        tauri::async_runtime::spawn_blocking(|| service().lock().unwrap().prune());
    }
}

#[tauri::command]
pub async fn file_history_push(
    window: tauri::Window,
    session_id: String,
    action: Option<Action>,
    shared: bool,
) -> Result<Reply, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    // Shape/capability normalization is outside the shared history lock.
    let action = match action {
        Some(action) => action::prepare_renderer(action, !cfg!(target_os = "macos")),
        None => Ok(None),
    };
    let mut service = service().lock().unwrap();
    let client = service.client(&owner)?;
    let error = match action {
        Ok(action) => service.histories.push(client, action, shared).err(),
        Err(error) => {
            // A forward mutation already happened. Even an unretainable
            // receipt must invalidate the superseded redo branch.
            service.histories.push(client, None, shared)?;
            Some(error)
        }
    };
    service.publish();
    Ok(service.reply(client, None, error))
}

#[tauri::command]
pub async fn file_history_clear(
    window: tauri::Window,
    session_id: String,
) -> Result<Reply, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let mut service = service().lock().unwrap();
    let client = service.client(&owner)?;
    service.histories.clear(client);
    service.publish();
    Ok(service.reply(client, None, None))
}

#[derive(Default)]
struct NativeOperations {
    #[cfg(target_os = "linux")]
    recovery: Option<(crate::files::recovery::Runtime, std::path::PathBuf)>,
}

impl NativeOperations {
    fn for_window(window: &tauri::Window) -> Result<Self, AppError> {
        #[cfg(target_os = "linux")]
        {
            Ok(Self {
                recovery: Some(crate::files::recovery::commands::owner(window)?),
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = window;
            Ok(Self::default())
        }
    }
}

fn operation_error(error: AppError) -> execution::OperationError {
    match error {
        AppError::WorkerFailed(_) | AppError::MutationUncertain(_) => {
            execution::OperationError::Uncertain(error.to_string())
        }
        _ => execution::OperationError::Unchanged(error.to_string()),
    }
}

fn execution_affected(result: &Execution) -> Vec<String> {
    let mut affected: Vec<_> = result
        .completed
        .iter()
        .chain(&result.uncertain)
        .flat_map(action::affected_dirs)
        .chain(result.refresh_dirs.iter().cloned())
        .collect();
    affected.sort_unstable();
    affected.dedup();
    affected
}

/// Join a separately owned worker so a panic cannot strand the application's
/// reservation. Its effects are unknown: consume this inverse without retry
/// and invalidate all potentially affected directories for reconciliation.
async fn supervise<T: Send + 'static>(
    work: impl Future<Output = T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn(work)
        .await
        .map_err(|error| format!("Native file history execution was interrupted; inspect the affected files before continuing: {error}"))
}

/// Retain the plan's refresh projection outside the supervised execution. A
/// panic can lose partial receipts but must not strand history or omit its
/// potentially changed directories from reconciliation.
async fn supervise_inverse<F>(
    prepared: plan::Prepared,
    work: impl FnOnce(plan::Prepared) -> F + Send + 'static,
) -> (Execution, Vec<String>)
where
    F: Future<Output = Execution> + Send + 'static,
{
    let potential_directories = prepared.affected_dirs();
    match supervise(async move { work(prepared).await }).await {
        Ok(result) => {
            let affected = execution_affected(&result);
            (result, affected)
        }
        Err(error) => (
            Execution {
                error: Some(error),
                ..Execution::default()
            },
            potential_directories,
        ),
    }
}

impl execution::Operations for NativeOperations {
    async fn trash_publication(
        &self,
        publication: std::sync::Arc<crate::files::mutation::PublishedEntry>,
    ) -> Result<crate::files::trash::FileBatchOutcome, execution::OperationError> {
        crate::files::trash::trash_publication(publication)
            .await
            .map_err(operation_error)
    }
    async fn replacement(
        &self,
        history: crate::files::recovery::ReplacementHistory,
        direction: crate::files::recovery::ReplacementDirection,
    ) -> Result<crate::files::recovery::ReplacementOutcome, execution::OperationError> {
        #[cfg(target_os = "linux")]
        {
            let (runtime, path) = self.recovery.as_ref().ok_or_else(|| {
                execution::OperationError::Unchanged("Replacement recovery is unavailable".into())
            })?;
            runtime
                .execute_history(path.clone(), history, direction)
                .await
                .map_err(operation_error)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (history, direction);
            Err(execution::OperationError::Unchanged(
                "Replacement recovery is unsupported on this host".into(),
            ))
        }
    }

    async fn rename(&self, path: String, name: String) -> Result<(), execution::OperationError> {
        crate::files::file_ops::rename_entry(path, name)
            .await
            .map(|_| ())
            .map_err(operation_error)
    }
    async fn move_entry(&self, path: String, destination: String) -> execution::MoveResult {
        let failed = |error| execution::MoveResult {
            result: Err(error),
            warning: None,
            affected: Vec::new(),
        };
        let plan = match crate::files::move_plan::MovePlan::new(path, destination, false) {
            Ok(plan) => plan,
            Err(error) => return failed(operation_error(error)),
        };
        #[cfg(target_os = "linux")]
        let outcome = match &self.recovery {
            Some((runtime, storage)) => {
                crate::files::move_execution::execute(plan, runtime.clone(), storage.clone()).await
            }
            // Direct filesystem tests use the default adapter. Live windows
            // always supply their application-owned recovery runtime.
            #[cfg(test)]
            None => crate::files::move_execution::execute_owned(plan, ()).await,
            #[cfg(not(test))]
            None => {
                return failed(execution::OperationError::Unchanged(
                    "Move recovery ownership is unavailable".into(),
                ))
            }
        };
        #[cfg(not(target_os = "linux"))]
        let outcome = crate::files::move_execution::execute_owned(plan, ()).await;
        let changed = matches!(
            &outcome.completion.result,
            Ok(_) | Err(AppError::MutationUncertain(_) | AppError::WorkerFailed(_))
        );
        execution::MoveResult {
            result: outcome
                .completion
                .result
                .map(|receipt| receipt.recovery.map(|recovery| recovery.message()))
                .map_err(operation_error),
            warning: outcome.completion.warning,
            // Return physical aliases through the existing outer refresh owner.
            affected: if changed {
                outcome.affected
            } else {
                Vec::new()
            },
        }
    }
    async fn trash_many(
        &self,
        paths: Vec<String>,
    ) -> Result<crate::files::trash::FileBatchOutcome, execution::OperationError> {
        crate::files::trash::move_multiple_to_trash(paths)
            .await
            .map_err(operation_error)
    }
    async fn restore(
        &self,
        requests: Vec<crate::files::trash_artifact::RestoreRequest>,
    ) -> Result<crate::files::trash::FileBatchOutcome, execution::OperationError> {
        crate::files::trash::restore_entries(requests)
            .await
            .map_err(operation_error)
    }
}

#[tauri::command]
pub async fn file_history_execute(
    window: tauri::Window,
    session_id: String,
    direction: Direction,
    expected_entry_id: EntryId,
) -> Result<Reply, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let operations = NativeOperations::for_window(&window)?;
    let (client, reservation) = {
        let mut service = service().lock().unwrap();
        let client = service.client(&owner)?;
        let reservation = match service
            .histories
            .begin(client, direction, expected_entry_id)
        {
            Ok(reservation) => reservation,
            Err(error) => return Ok(service.reply(client, None, Some(error))),
        };
        service.publish();
        (client, reservation)
    };
    // Dropping the invoking renderer/IPC future cannot cancel accepted native
    // execution or its completion in another window's shared history.
    tauri::async_runtime::spawn(async move {
        let prepared = plan::Prepared::new(reservation.action.clone(), direction);
        let (result, affected) = supervise_inverse(prepared, move |prepared| async move {
            #[cfg(feature = "e2e-renderer-recovery")]
            acceptance_gate::after_admission(expected_entry_id, direction)
                .await
                .expect("Native history acceptance gate failed");
            execution::execute_prepared(prepared, &operations).await
        })
        .await;
        let mut service = service().lock().unwrap();
        service.histories.finish(reservation, &result);
        service.publish();
        let mut reply = service.reply(client, result.completed, result.error);
        reply.warnings = result.warnings;
        drop(service);
        crate::files::fs_watcher::publish_file_changes(&affected);
        reply
    })
    .await
    .map_err(|error| AppError::Other(format!("Native file history task failed: {error}")))
}

#[cfg(test)]
#[path = "../../test_support/file_history_uncertainty.rs"]
mod uncertainty_tests;

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/file_history_replacement.rs"]
mod replacement_tests;

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/file_history_publication.rs"]
mod publication_tests;
