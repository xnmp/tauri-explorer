//! Recovery application service. Inventory is private-storage-only; explicit
//! inspection and resolution hold native operation ownership outside admission.
use super::{
    coordinator::{Coordinator, InventoryEntry},
    model::{DurableIntent, OperationSpec, Phase, RecoveryChoice, RecoveryItem, RecoverySnapshot},
    replacement_execution::ReplacementExecution,
    replacement_restoration::RestorationStep,
    replacement_transition::{transition, ReplacementTransition},
};
use crate::error::AppError;
use std::sync::Arc;

pub(super) fn list(coordinator: &Coordinator) -> Result<RecoverySnapshot, AppError> {
    let inventory = coordinator.inventory()?;
    Ok(RecoverySnapshot {
        revision: inventory.revision,
        items: inventory.entries.iter().map(pending).collect(),
        error: None,
    })
}

/// First discovery can still explain immutable evidence when its mutable index
/// is unavailable. No checkpoint, ownership generation or action is invented.
pub(super) fn unindexed(intents: Vec<DurableIntent>, error: AppError) -> RecoverySnapshot {
    RecoverySnapshot {
        revision: 0,
        items: intents
            .into_iter()
            .map(|intent| {
                pending(&InventoryEntry {
                    intent,
                    generation: None,
                })
            })
            .collect(),
        error: Some(diagnostic(error)),
    }
}

pub(super) fn inspect(
    coordinator: &Arc<Coordinator>,
    id: &str,
) -> Result<RecoverySnapshot, AppError> {
    operate(coordinator, id, Request::Inspect)
}

pub(super) fn resolve(
    coordinator: &Arc<Coordinator>,
    id: &str,
    generation: u64,
    choice: RecoveryChoice,
) -> Result<RecoverySnapshot, AppError> {
    match choice {
        RecoveryChoice::Restore => operate(coordinator, id, Request::Restore(generation)),
        RecoveryChoice::Discard => Err(AppError::Other(
            "Recovery artifact retirement is not available".into(),
        )),
    }
}

enum Request {
    Inspect,
    Restore(u64),
}

fn operate(
    coordinator: &Arc<Coordinator>,
    id: &str,
    request: Request,
) -> Result<RecoverySnapshot, AppError> {
    let inventory = coordinator.inventory()?;
    let entry = inventory
        .entries
        .into_iter()
        .find(|entry| entry.intent.id == id)
        .ok_or_else(|| AppError::Other("Recovery operation is no longer available".into()))?;
    let Some(generation) = entry.generation else {
        return reply(
            coordinator,
            Some(pending(&entry)),
            Some("Recovery checkpoint is missing; catalog evidence is preserved".into()),
        );
    };
    if let Request::Restore(expected) = request {
        if expected != generation {
            return reply(
                coordinator,
                None,
                Some("Recovery operation changed; inspect it again before restoring".into()),
            );
        }
    }
    let operation = match coordinator.try_claim(id, generation) {
        Ok(Some(operation)) => operation,
        Ok(None) => {
            return reply(
                coordinator,
                Some(item(
                    &entry.intent,
                    generation,
                    "busy",
                    "This operation is owned by another worker",
                    vec![],
                )),
                None,
            )
        }
        Err(error) => return reply(coordinator, None, Some(diagnostic(error))),
    };
    let claimed_generation = operation.generation();
    if operation.intent().operation.move_spec().is_ok() {
        return relocation(coordinator, operation, request);
    }
    // A phase with no supported recovery action needs no user-volume probes.
    if transition(
        operation.intent(),
        operation.state(),
        ReplacementTransition::BeginRestoration,
    )
    .is_err()
    {
        let state = operation.state().replacement().ok();
        let message = if state.is_some_and(|state| state.phase == Phase::Restored) {
            "The original has been restored; retained artifacts still require cleanup"
        } else {
            "This checkpoint requires further recovery support; all evidence is preserved"
        };
        return reply(
            coordinator,
            Some(item(
                operation.intent(),
                claimed_generation,
                "attention",
                message,
                vec![],
            )),
            None,
        );
    }
    let mut execution = match ReplacementExecution::reopen(operation) {
        Ok(execution) => execution,
        Err(error) => {
            return reply(
                coordinator,
                Some(item(
                    &entry.intent,
                    claimed_generation,
                    "attention",
                    "Recovery files could not be verified; evidence is preserved",
                    vec![],
                )),
                Some(diagnostic(error)),
            )
        }
    };
    let result = (|| {
        let state = execution.operation.state().replacement()?;
        let staged = state
            .published
            .as_ref()
            .expect("restoration transition validated staged evidence");
        if execution
            .root
            .inspect_restoration(execution.operation.intent(), staged)?
            == RestorationStep::Conflict
        {
            return Err(AppError::MutationUncertain(
                "Recovery files differ from the recorded operation; all entries are preserved"
                    .into(),
            ));
        }
        match request {
            Request::Inspect => Ok(item(
                execution.operation.intent(),
                execution.operation.generation(),
                "ready",
                "The recorded original can be restored; any published copy will be retained",
                vec![RecoveryChoice::Restore],
            )),
            Request::Restore(_) => {
                execution.restore_copy()?;
                Ok(item(
                    execution.operation.intent(),
                    execution.operation.generation(),
                    "attention",
                    "The original has been restored; retained artifacts still require cleanup",
                    vec![],
                ))
            }
        }
    })();
    let (view, error) = match result {
        Ok(view) => (view, None),
        Err(error) => (
            item(
                execution.operation.intent(),
                execution.operation.generation(),
                "attention",
                "Recovery could not complete; all remaining evidence is preserved",
                vec![],
            ),
            Some(diagnostic(error)),
        ),
    };
    // Keep the native owner through the final inventory read. Other processes
    // cannot start effects between our observation and this snapshot assembly.
    reply(coordinator, Some(view), error)
}

/// Durable moves reconcile through their own executor. Restoration is offered
/// only while the record still names an exact original: a removed parked source
/// leaves nothing to return, and this service never deletes to "finish" a move.
fn relocation(
    coordinator: &Arc<Coordinator>,
    operation: crate::files::recovery::coordinator::DurableOperation,
    request: Request,
) -> Result<RecoverySnapshot, AppError> {
    use super::move_model::MovePhase;
    use super::move_transition::{transition as move_transition, MoveTransition};
    let generation = operation.generation();
    let restorable = move_transition(
        operation.intent(),
        operation.state(),
        MoveTransition::BeginRestoration,
    )
    .is_ok();
    if !restorable {
        let message = match operation.state().move_state().map(|state| state.phase) {
            Ok(MovePhase::Staged) => {
                "A copy was staged but never published; both original locations are unchanged"
            }
            Ok(MovePhase::Removed) => {
                "This move completed and its source was discarded; nothing remains to restore"
            }
            Ok(MovePhase::Restored) => {
                "The moved entry has been returned to its source; retained artifacts still require cleanup"
            }
            _ => "This move has not reached a restorable position; all evidence is preserved",
        };
        return reply(
            coordinator,
            Some(item(
                operation.intent(),
                generation,
                "attention",
                message,
                vec![],
            )),
            None,
        );
    }
    let phase = operation.state().move_state()?.phase;
    let intent = operation.intent().clone();
    let mut execution = match super::move_execution::MoveExecution::reopen(operation) {
        Ok(execution) => execution,
        Err(error) => {
            return reply(
                coordinator,
                Some(item(
                    &intent,
                    generation,
                    "attention",
                    "Move recovery files could not be verified; evidence is preserved",
                    vec![],
                )),
                Some(diagnostic(error)),
            )
        }
    };
    let ready = match phase {
        MovePhase::Parked => "The moved entry can be returned to its source; its destination copy will be removed only after the source is back",
        MovePhase::Published => "The moved entry can be returned to its source",
        _ => "This interrupted move can be returned to its source",
    };
    let result = match request {
        Request::Inspect => Ok(item(
            execution.operation.intent(),
            execution.operation.generation(),
            "ready",
            ready,
            vec![RecoveryChoice::Restore],
        )),
        Request::Restore(_) => execution.restore_move().map(|()| {
            item(
                execution.operation.intent(),
                execution.operation.generation(),
                "attention",
                "The moved entry has been returned to its source; retained artifacts still require cleanup",
                vec![],
            )
        }),
    };
    let (view, error) = match result {
        Ok(view) => (view, None),
        Err(error) => (
            item(
                execution.operation.intent(),
                execution.operation.generation(),
                "attention",
                "Move recovery could not complete; all remaining evidence is preserved",
                vec![],
            ),
            Some(diagnostic(error)),
        ),
    };
    reply(coordinator, Some(view), error)
}

fn reply(
    coordinator: &Coordinator,
    observed: Option<RecoveryItem>,
    error: Option<String>,
) -> Result<RecoverySnapshot, AppError> {
    let mut snapshot = list(coordinator)?;
    if let Some(observed) = observed {
        if let Some(current) = snapshot
            .items
            .iter_mut()
            .find(|entry| entry.id == observed.id && entry.generation == observed.generation)
        {
            *current = observed;
        }
    }
    snapshot.error = error;
    Ok(snapshot)
}

fn pending(entry: &InventoryEntry) -> RecoveryItem {
    let (status, message) = if entry.generation.is_some() {
        (
            "pending",
            "Inspect this interrupted operation before choosing a recovery action",
        )
    } else {
        (
            "attention",
            "Recovery checkpoint is missing; catalog evidence is preserved",
        )
    };
    item(
        &entry.intent,
        entry.generation.unwrap_or(0),
        status,
        message,
        vec![],
    )
}

fn item(
    intent: &DurableIntent,
    generation: u64,
    status: &'static str,
    message: &str,
    actions: Vec<RecoveryChoice>,
) -> RecoveryItem {
    let (original, retained) = match &intent.operation {
        OperationSpec::CopyReplacement(spec) => (&spec.target, Some(&spec.root)),
        OperationSpec::Move(spec) => (&spec.source, spec.roots().next().map(|root| &root.path)),
    };
    RecoveryItem {
        id: intent.id.clone(),
        generation,
        original_path: original.0.to_string_lossy().into_owned(),
        // The artifact container stays meaningful after restoration moves the
        // original home and retains the copy as `publication`. Inventory does
        // not probe this recorded location or grant renderer-owned authority.
        retained_path: retained.map(|path| path.0.to_string_lossy().into_owned()),
        status,
        message: message.into(),
        actions,
    }
}

fn diagnostic(error: AppError) -> String {
    let mut message = error.to_string();
    let mut end = message.len().min(super::model::MAX_ERROR_BYTES);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    message
}

#[cfg(test)]
#[path = "../../../test_support/recovery_service.rs"]
mod tests;
