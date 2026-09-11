//! Recovery application service. Inventory is private-storage-only; explicit
//! inspection, resolution and retirement hold native operation ownership
//! outside admission.
use super::{
    coordinator::{Coordinator, InventoryEntry},
    model::{
        DurableIntent, OperationSpec, Phase, RecoveryChoice, RecoveryItem, RecoverySnapshot,
        RecoveryStorage,
    },
    replacement_execution::ReplacementExecution,
    replacement_restoration::RestorationStep,
    replacement_transition::{transition, ReplacementTransition},
    retention::{self, Budget, Retention, Usage},
    retirement::{Eligibility, Retirement},
};
use crate::error::AppError;
use std::sync::Arc;

/// Bounded listing from durable evidence alone: no ownership claims, no
/// measurement and no user-volume probes. Safe to call from any worker.
pub(super) fn list(coordinator: &Coordinator) -> Result<RecoverySnapshot, AppError> {
    let inventory = coordinator.inventory()?;
    let mut usage = Usage::default();
    for entry in &inventory.entries {
        let (position, bytes) = position(entry);
        usage.add(position, bytes, true);
    }
    Ok(RecoverySnapshot {
        revision: inventory.revision,
        items: inventory.entries.iter().map(pending).collect(),
        storage: storage(&usage, &budget()),
        error: None,
    })
}

/// One retention enforcement pass followed by a fresh listing. Called only
/// from recovery-session activity or immediately after a record is created;
/// never from application startup (ADR 0020's startup boundary).
pub(super) fn enforce(coordinator: &Arc<Coordinator>) -> Result<RecoverySnapshot, AppError> {
    let budget = budget();
    let usage = super::retirement::enforce(coordinator)?;
    let mut snapshot = list(coordinator)?;
    // The pass observed more than the evidence-only listing can: keep its
    // measured, unavailable and reclaimable counts.
    snapshot.storage = storage(&usage, &budget);
    Ok(snapshot)
}

fn budget() -> Budget {
    crate::config::read_settings_value()
        .as_ref()
        .map_or_else(Budget::default, Budget::from_settings)
}

fn storage(usage: &Usage, budget: &Budget) -> RecoveryStorage {
    RecoveryStorage {
        used_bytes: usage.bytes,
        budget_bytes: budget.bytes,
        records: usage.records,
        record_budget: budget.records,
        unmeasured: usage.unmeasured,
        unavailable: usage.unavailable,
        discardable: usage.discardable,
        at_capacity: usage.at_capacity(budget),
    }
}

fn position(entry: &InventoryEntry) -> (Retention, Option<u64>) {
    match &entry.state {
        Some(state) => (
            retention::retention(&entry.intent.operation, state),
            retention::measured_bytes(state),
        ),
        None => (Retention::Unresolved, None),
    }
}

/// First discovery can still explain immutable evidence when its mutable index
/// is unavailable. No checkpoint, ownership generation or action is invented.
pub(super) fn unindexed(intents: Vec<DurableIntent>, error: AppError) -> RecoverySnapshot {
    let mut usage = Usage::default();
    let items = intents
        .into_iter()
        .map(|intent| {
            usage.add(Retention::Unresolved, None, true);
            pending(&InventoryEntry {
                intent,
                generation: None,
                state: None,
                digest: [0; 32],
            })
        })
        .collect();
    RecoverySnapshot {
        revision: 0,
        items,
        storage: storage(&usage, &budget()),
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
        RecoveryChoice::Discard => operate(coordinator, id, Request::Discard(generation)),
    }
}

enum Request {
    Inspect,
    Restore(u64),
    Discard(u64),
}

impl Request {
    fn expected(&self) -> Option<u64> {
        match self {
            Self::Inspect => None,
            Self::Restore(generation) | Self::Discard(generation) => Some(*generation),
        }
    }
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
    if request
        .expected()
        .is_some_and(|expected| expected != generation)
    {
        return reply(
            coordinator,
            None,
            Some("Recovery operation changed; inspect it again before acting".into()),
        );
    }
    let operation = match coordinator.try_claim(id, generation) {
        Ok(Some(operation)) => operation,
        Ok(None) => {
            return reply(
                coordinator,
                Some(item(
                    &entry.intent,
                    generation,
                    None,
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
    if let Request::Discard(_) = request {
        return discard(coordinator, operation, &entry.intent, claimed_generation);
    }
    if operation.intent().operation.move_spec().is_ok() {
        return relocation(coordinator, operation, request);
    }
    // A journaled retirement is presented as retention even though restoration
    // remains a legal transition out of it: retention reporting carries the
    // exact reason a refused retirement preserved its evidence, which the
    // restoration path would flatten into a generic message.
    let retiring = operation
        .state()
        .replacement()
        .is_ok_and(|state| matches!(state.phase, Phase::DiscardIntent | Phase::Discarded));
    // A phase with no supported restoration needs no user-volume probes, but
    // its retained artifacts may still be explicitly discardable.
    if retiring
        || transition(
            operation.intent(),
            operation.state(),
            ReplacementTransition::BeginRestoration,
        )
        .is_err()
    {
        return retention_only(coordinator, operation, &entry.intent, claimed_generation);
    }
    let mut execution = match ReplacementExecution::reopen(operation) {
        Ok(execution) => execution,
        Err(error) => {
            return reply(
                coordinator,
                Some(item(
                    &entry.intent,
                    claimed_generation,
                    None,
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
            Request::Inspect => {
                let mut actions = vec![RecoveryChoice::Restore];
                if discardable(&execution) {
                    actions.push(RecoveryChoice::Discard);
                }
                Ok(item(
                    execution.operation.intent(),
                    execution.operation.generation(),
                    retention::measured_bytes(execution.operation.state()),
                    "ready",
                    "The recorded original can be restored; any published copy will be retained",
                    actions,
                ))
            }
            Request::Restore(_) => {
                execution.restore_copy()?;
                Ok(item(
                    execution.operation.intent(),
                    execution.operation.generation(),
                    None,
                    "retained",
                    "The original has been restored; the retained copy can be discarded",
                    vec![],
                ))
            }
            Request::Discard(_) => unreachable!("discard is dispatched before reopening"),
        }
    })();
    let (view, error) = match result {
        Ok(view) => (view, None),
        Err(error) => (
            item(
                execution.operation.intent(),
                execution.operation.generation(),
                None,
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

/// Only an inspected `Remove` step offers discard: the live public entry must
/// independently hold the payload that survives the retained artifact.
fn discardable(execution: &ReplacementExecution) -> bool {
    let Ok(state) = execution.operation.state().replacement() else {
        return false;
    };
    let Some(staged) = state.published.as_ref() else {
        return false;
    };
    let Some((retained, _)) = retention::retention(
        &execution.operation.intent().operation,
        execution.operation.state(),
    )
    .settled() else {
        return false;
    };
    matches!(
        execution
            .root
            .retirement_step(execution.operation.intent(), staged, retained),
        Ok(super::replacement_artifact::RetirementStep::Remove)
    )
}

/// Present a record whose only remaining action is retention: a completed
/// restoration, or an interrupted retirement to resume.
fn retention_only(
    coordinator: &Arc<Coordinator>,
    operation: super::coordinator::DurableOperation,
    intent: &DurableIntent,
    generation: u64,
) -> Result<RecoverySnapshot, AppError> {
    let restored = operation
        .state()
        .replacement()
        .is_ok_and(|state| state.phase == Phase::Restored);
    let retirement = match Retirement::open(operation) {
        Ok(retirement) => retirement,
        Err(error) => {
            return reply(
                coordinator,
                Some(item(
                    intent,
                    generation,
                    None,
                    "attention",
                    "Retained recovery files could not be observed; all evidence is preserved",
                    vec![],
                )),
                Some(diagnostic(error)),
            )
        }
    };
    let (status, message, actions) = match retirement.eligibility() {
        Eligibility::Preserved(reason) => ("attention", reason.clone(), vec![]),
        Eligibility::Discardable | Eligibility::Automatic | Eligibility::Resume if restored => (
            "retained",
            "The original has been restored; the retained copy can be discarded".to_owned(),
            vec![RecoveryChoice::Discard],
        ),
        _ => (
            "retained",
            "Retained recovery files can be discarded".to_owned(),
            vec![RecoveryChoice::Discard],
        ),
    };
    let bytes = retention::measured_bytes(retirement_state(&retirement));
    let generation = retirement.generation();
    reply(
        coordinator,
        Some(item(intent, generation, bytes, status, &message, actions)),
        None,
    )
}

fn retirement_state(retirement: &Retirement) -> &super::model::OperationState {
    retirement.state()
}

fn discard(
    coordinator: &Arc<Coordinator>,
    operation: super::coordinator::DurableOperation,
    intent: &DurableIntent,
    generation: u64,
) -> Result<RecoverySnapshot, AppError> {
    let retirement = match Retirement::open(operation) {
        Ok(retirement) => retirement,
        Err(error) => {
            return reply(
                coordinator,
                Some(item(
                    intent,
                    generation,
                    None,
                    "attention",
                    "Retained recovery files could not be observed; all evidence is preserved",
                    vec![],
                )),
                Some(diagnostic(error)),
            )
        }
    };
    if let Eligibility::Preserved(reason) = retirement.eligibility() {
        let reason = reason.clone();
        let generation = retirement.generation();
        return reply(
            coordinator,
            Some(item(intent, generation, None, "attention", &reason, vec![])),
            Some(reason.clone()),
        );
    }
    match retirement.retire() {
        // The record is gone; the fresh listing is the whole answer.
        Ok(()) => reply(coordinator, None, None),
        Err(error) => reply(coordinator, None, Some(diagnostic(error))),
    }
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
                None,
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
                    None,
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
            None,
            "ready",
            ready,
            vec![RecoveryChoice::Restore],
        )),
        Request::Restore(_) => execution.restore_move().map(|()| {
            item(
                execution.operation.intent(),
                execution.operation.generation(),
                None,
                "attention",
                "The moved entry has been returned to its source; retained artifacts still require cleanup",
                vec![],
            )
        }),
        // Discard is dispatched to retirement before a move is reopened, and a
        // move record has no retirement plan yet, so it is never offered here.
        Request::Discard(_) => unreachable!("discard never reaches move reconciliation"),
    };
    let (view, error) = match result {
        Ok(view) => (view, None),
        Err(error) => (
            item(
                execution.operation.intent(),
                execution.operation.generation(),
                None,
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
    // Listing stays a bounded evidence read: it reports the retained size it
    // already knows but never claims an inspected status of its own.
    let (_, bytes) = position(entry);
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
        bytes,
        status,
        message,
        vec![],
    )
}

fn item(
    intent: &DurableIntent,
    generation: u64,
    retained_bytes: Option<u64>,
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
        retained_bytes,
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
