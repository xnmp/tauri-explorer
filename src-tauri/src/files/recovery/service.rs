//! Recovery application service. Inventory is private-storage-only; explicit
//! inspection, resolution and retirement hold native operation ownership
//! outside admission. Retention, discard and forget are one lifecycle for
//! every kind; only restoration is presented by a per-kind handler.
use super::{
    checkpoint::{Effect, Event, Side, State, Step},
    coordinator::{Coordinator, DurableOperation, InventoryEntry},
    model::{
        bounded_error, DurableIntent, OperationSpec, RecoveryChoice, RecoveryItem,
        RecoverySnapshot, RecoveryStorage,
    },
    retention::{Budget, Retention, Usage},
    retirement::{Eligibility, Retirement},
};
use crate::error::AppError;
use std::sync::Arc;

#[path = "move_recovery.rs"]
mod relocation;
#[path = "replacement_recovery.rs"]
mod replacement;

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
            entry.intent.checkpoint(state).retention(),
            state.retained_bytes,
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
        RecoveryChoice::Release => operate(coordinator, id, Request::Release(generation)),
    }
}

enum Request {
    Inspect,
    Restore(u64),
    Discard(u64),
    Release(u64),
}

impl Request {
    fn expected(&self) -> Option<u64> {
        match self {
            Self::Inspect => None,
            Self::Restore(generation) | Self::Discard(generation) | Self::Release(generation) => {
                Some(*generation)
            }
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
                    entry.state.as_ref(),
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
    if in_preflight(&operation) {
        return relocation::preflight(coordinator, operation, request);
    }
    match request {
        Request::Discard(_) => discard(coordinator, operation),
        // Decided from durable evidence alone: a stranded record's volume may
        // be the very thing that can no longer be observed.
        Request::Release(_) => match operation.forget_retirement() {
            Ok(()) => reply(coordinator, None, None),
            Err(error) => reply(coordinator, None, Some(diagnostic(error))),
        },
        Request::Inspect | Request::Restore(_) => {
            let restorable = operation
                .intent()
                .transition(operation.state(), Event::Begin(Effect::Restore))
                .is_ok();
            match &operation.intent().operation {
                OperationSpec::CopyReplacement(_) => {
                    replacement::reconcile(coordinator, operation, request, restorable)
                }
                OperationSpec::Move(_) => {
                    relocation::reconcile(coordinator, operation, request, restorable)
                }
            }
        }
    }
}

/// A record whose capability probes have not all been proven or removed has
/// no user effect yet; only its probe evidence can be inspected or discarded.
fn in_preflight(operation: &DurableOperation) -> bool {
    !operation.intent().operation.kind().probes().is_empty()
        && matches!(
            operation.state().phase,
            super::checkpoint::Phase::Planned | super::checkpoint::Phase::Aborted
        )
}

fn discard(
    coordinator: &Arc<Coordinator>,
    operation: DurableOperation,
) -> Result<RecoverySnapshot, AppError> {
    let intent = operation.intent().clone();
    let generation = operation.generation();
    let folders = retained_folders(&intent, Some(operation.state()));
    let retirement = match Retirement::open(operation) {
        Ok(retirement) => retirement,
        Err(error) => {
            return reply(
                coordinator,
                Some(item_in(
                    &intent,
                    folders,
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
        return reply(
            coordinator,
            Some(item(
                &intent,
                Some(retirement.state()),
                retirement.operation.generation(),
                None,
                "attention",
                &reason,
                vec![],
            )),
            Some(reason.clone()),
        );
    }
    match retirement.retire() {
        // The record is gone; the fresh listing is the whole answer.
        Ok(()) => reply(coordinator, None, None),
        Err(error) => reply(coordinator, None, Some(diagnostic(error))),
    }
}

/// The retention view of a settled or retiring record, identical for every
/// kind except the message `describe` gives an ordinary retained record.
fn retained(
    coordinator: &Arc<Coordinator>,
    operation: DurableOperation,
    restorable: bool,
    describe: fn(&State, bool) -> &'static str,
) -> Result<RecoverySnapshot, AppError> {
    let intent = operation.intent().clone();
    let generation = operation.generation();
    let forgettable = operation.state().forgettable();
    let folders = retained_folders(&intent, Some(operation.state()));
    let hint = forget_hint(&folders);
    let retirement = match Retirement::open(operation) {
        Ok(retirement) => retirement,
        Err(error) => {
            let (message, actions, error) = if forgettable {
                (
                    format!(
                        "Discard stopped before finishing and its recovery files can no \
                         longer be verified: {error}. {hint}"
                    ),
                    vec![RecoveryChoice::Release],
                    None,
                )
            } else {
                (
                    "Retained recovery files could not be verified; all evidence is preserved"
                        .to_owned(),
                    vec![],
                    Some(diagnostic(error)),
                )
            };
            let view = item_in(
                &intent,
                folders,
                generation,
                None,
                "attention",
                &message,
                actions,
            );
            return reply(coordinator, Some(view), error);
        }
    };
    let state = retirement.state();
    // A committed discard that failed has already consumed Undo; it is not
    // an ordinary retained record, so say so and offer only a retry.
    let interrupted = state.retirement.as_ref().and(state.error.as_ref());
    let (status, message, actions) = match (retirement.eligibility(), interrupted) {
        (Eligibility::Preserved(reason), _) if forgettable => (
            "attention",
            format!("{reason}. {hint}"),
            vec![RecoveryChoice::Release],
        ),
        (Eligibility::Preserved(reason), _) => ("attention", reason.clone(), vec![]),
        (_, Some(error)) => (
            "attention",
            format!(
                "Discard stopped before finishing; its Undo history is gone and the \
                 remaining recovery files are preserved. Retry Discard once this is \
                 resolved: {error}. {hint}"
            ),
            vec![RecoveryChoice::Discard, RecoveryChoice::Release],
        ),
        _ => {
            let restorable = restorable && state.retirement.is_none();
            let mut actions = Vec::new();
            if restorable {
                actions.push(RecoveryChoice::Restore);
            }
            actions.push(RecoveryChoice::Discard);
            let message = match &state.deferred {
                // Nothing was removed; only the automatic attempt stopped.
                Some(reason) => format!(
                    "Automatic cleanup of its retained recovery data could not start and \
                     will not be retried automatically: {reason}. Discard retries it."
                ),
                None => describe(state, restorable).to_owned(),
            };
            ("retained", message, actions)
        }
    };
    reply(
        coordinator,
        Some(item(
            &intent,
            Some(state),
            retirement.operation.generation(),
            state.retained_bytes,
            status,
            &message,
            actions,
        )),
        None,
    )
}

/// Shown wherever a stopped discard can be forgotten instead of retried. It
/// names how many folders stay behind, because a cross-volume move can leave
/// files in a recovery folder beside each endpoint.
fn forget_hint(folders: &[String]) -> String {
    let kept = match folders {
        [] => "",
        [_] => "; its remaining files stay in the listed folder",
        _ => "; its remaining files stay in each listed folder",
    };
    format!(
        "If it cannot be resolved, Forget releases this record and its locks without \
         deleting anything{kept}"
    )
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

/// Reply with the claimed record's current view. Keeping the native owner
/// through the final inventory read means no other process starts effects
/// between our observation and this snapshot assembly.
fn answer(
    coordinator: &Coordinator,
    operation: &DurableOperation,
    retained_bytes: Option<u64>,
    status: &'static str,
    message: &str,
    actions: Vec<RecoveryChoice>,
    error: Option<AppError>,
) -> Result<RecoverySnapshot, AppError> {
    let view = item(
        operation.intent(),
        Some(operation.state()),
        operation.generation(),
        retained_bytes,
        status,
        message,
        actions,
    );
    reply(coordinator, Some(view), error.map(diagnostic))
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
        entry.state.as_ref(),
        entry.generation.unwrap_or(0),
        bytes,
        status,
        message,
        vec![],
    )
}

fn item(
    intent: &DurableIntent,
    state: Option<&State>,
    generation: u64,
    retained_bytes: Option<u64>,
    status: &'static str,
    message: &str,
    actions: Vec<RecoveryChoice>,
) -> RecoveryItem {
    let folders = retained_folders(intent, state);
    item_in(
        intent,
        folders,
        generation,
        retained_bytes,
        status,
        message,
        actions,
    )
}

/// The artifact folders a record may still hold, from durable evidence alone:
/// inventory never probes them or grants renderer-owned authority. The source
/// root is listed first. Only a root whose removal completed is omitted: a
/// stopped discard may have left any of a root it started removing, so it
/// still names every folder that can hold retained files.
fn retained_folders(intent: &DurableIntent, state: Option<&State>) -> Vec<String> {
    let kind = intent.operation.kind();
    let retirement = state.and_then(|state| state.retirement.as_ref());
    [Side::Source, Side::Target]
        .into_iter()
        .filter(|side| {
            retirement
                .and_then(|retirement| *retirement.steps.get(*side))
                .is_none_or(|step| step != Step::Removed)
        })
        .filter_map(|side| kind.root(side))
        .map(|root| root.path.0.to_string_lossy().into_owned())
        .collect()
}

fn item_in(
    intent: &DurableIntent,
    folders: Vec<String>,
    generation: u64,
    retained_bytes: Option<u64>,
    status: &'static str,
    message: &str,
    actions: Vec<RecoveryChoice>,
) -> RecoveryItem {
    RecoveryItem {
        id: intent.id.clone(),
        generation,
        original_path: intent
            .operation
            .kind()
            .listed_path()
            .0
            .to_string_lossy()
            .into_owned(),
        // The artifact container stays meaningful after restoration moves the
        // original home and retains the copy as `publication`.
        retained_path: folders.first().cloned(),
        retained_paths: folders,
        retained_bytes,
        status,
        message: message.into(),
        actions,
    }
}

fn diagnostic(error: AppError) -> String {
    bounded_error(error.to_string())
}

#[cfg(test)]
#[path = "../../../test_support/recovery_service.rs"]
mod tests;
