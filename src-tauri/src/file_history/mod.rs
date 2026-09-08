//! Application-owned file history and inverse execution.
mod action;
mod execution;
mod forward;
mod model;
pub(crate) use forward::{run_forward, MutationOutcome, MutationReply};
pub(crate) use model::Action;
pub(crate) use model::ForwardEffect;
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
        Some(action) => action::prepare(action, !cfg!(target_os = "macos")),
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

struct NativeOperations;

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

impl execution::Operations for NativeOperations {
    async fn rename(&self, path: String, name: String) -> Result<(), execution::OperationError> {
        crate::files::file_ops::rename_entry(path, name)
            .await
            .map(|_| ())
            .map_err(operation_error)
    }
    async fn move_entry(
        &self,
        path: String,
        destination: String,
    ) -> Result<Option<String>, execution::OperationError> {
        crate::files::file_ops::move_entry(path, destination, Some(false))
            .await
            .map(|receipt| receipt.recovery.map(|recovery| recovery.message()))
            .map_err(operation_error)
    }
    async fn trash(&self, path: String) -> Result<(), execution::OperationError> {
        crate::files::trash::move_to_trash(path)
            .await
            .map_err(operation_error)
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
        paths: Vec<String>,
    ) -> Result<crate::files::trash::FileBatchOutcome, execution::OperationError> {
        crate::files::trash::restore_from_trash(paths)
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
        let action = reservation.action.clone();
        let (result, affected) = match supervise(async move {
            #[cfg(feature = "e2e-renderer-recovery")]
            acceptance_gate::after_admission(expected_entry_id, direction)
                .await
                .expect("Native history acceptance gate failed");
            execution::execute(action, &NativeOperations, direction).await
        })
        .await
        {
            Ok(result) => {
                let affected = execution_affected(&result);
                (result, affected)
            }
            Err(error) => (
                Execution {
                    error: Some(error),
                    ..Execution::default()
                },
                action::affected_dirs(&reservation.action),
            ),
        };
        let mut service = service().lock().unwrap();
        service.histories.finish(reservation, &result);
        service.publish();
        let reply = service.reply(client, result.completed, result.error);
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
