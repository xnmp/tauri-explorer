//! Durable-move presentation for the recovery service. Moves reconcile through
//! their own executor. Restoration is offered only while the record still
//! names an exact original: a removed parked source leaves nothing to return,
//! and this service never deletes to "finish" a move.
use super::super::{
    checkpoint::{Effect, Event, Phase, State},
    move_capability,
    move_capability_model::Step,
    move_execution::MoveExecution,
};
use super::{
    answer, diagnostic, forget_hint, item, item_in, reply, retained, retained_folders, Coordinator,
    DurableOperation, Eligibility, Exits, RecoveryChoice, RecoverySnapshot, Request, Retirement,
};
use crate::error::AppError;
use std::sync::Arc;

/// A move whose capability preflight has not finished never started: only its
/// verified probe evidence can be discarded.
pub(super) fn preflight(
    coordinator: &Arc<Coordinator>,
    operation: DurableOperation,
    request: Request,
) -> Result<RecoverySnapshot, AppError> {
    let observation = move_capability::inspect(&operation);
    if matches!(request, Request::Discard(_)) && observation.is_ok() {
        return match move_capability::discard(operation, None) {
            Ok(()) => reply(coordinator, None, None),
            Err(error) => reply(coordinator, None, Some(diagnostic(error))),
        };
    }
    let error = match (&request, &observation) {
        (Request::Restore(_), _) => {
            Some("This move never started and has no restoration to apply".to_owned())
        }
        (Request::Release(_), _) => {
            Some("This move never started; discard its capability data instead".to_owned())
        }
        (Request::Discard(_), Err(error)) => Some(diagnostic(AppError::Other(error.to_string()))),
        _ => None,
    };
    let (message, actions) = match observation {
        Ok(()) => (
            "The move never started. Its verified capability-check data can be discarded."
                .to_owned(),
            vec![RecoveryChoice::Discard],
        ),
        Err(error) => (
            format!(
                "The move never started; unverified capability-check evidence is preserved: \
                 {error}"
            ),
            vec![],
        ),
    };
    let mut view = item(
        operation.intent(),
        Some(operation.state()),
        operation.generation(),
        None,
        "attention",
        &message,
        actions,
    );
    // Probe evidence is separate from the not-yet-created move artifacts.
    view.retained_path = unresolved_probe(&operation);
    view.retained_paths = view.retained_path.iter().cloned().collect();
    reply(coordinator, Some(view), error)
}

/// The first probe whose evidence may still exist on disk.
fn unresolved_probe(operation: &DurableOperation) -> Option<String> {
    let progress = operation.state().preflight.as_ref()?;
    let index = progress
        .steps
        .iter()
        .position(|step| !matches!(step, Step::Planned | Step::Absent | Step::Removed { .. }))?;
    let probes = operation.intent().operation.kind().probes();
    Some(probes.get(index)?.path.0.to_string_lossy().into_owned())
}

pub(super) fn reconcile(
    coordinator: &Arc<Coordinator>,
    operation: DurableOperation,
    request: Request,
    restorable: bool,
) -> Result<RecoverySnapshot, AppError> {
    let checkpoint = operation.intent().checkpoint(operation.state());
    if matches!(request, Request::Inspect) && checkpoint.retention().retirable() {
        let (operation, exits) = observe(operation, restorable);
        return retained(coordinator, operation, exits, describe);
    }
    if !restorable {
        let message = match operation.state().phase {
            Phase::Staged => {
                "A copy was staged but never published; both original locations are unchanged"
            }
            Phase::Restored => {
                "The moved entry has been returned to its source; retained artifacts still \
                 require cleanup"
            }
            _ => "This move has not reached a restorable position; all evidence is preserved",
        };
        return answer(
            coordinator,
            &operation,
            None,
            "attention",
            message,
            vec![],
            None,
        );
    }
    let ready = match operation.state().phase {
        Phase::Parked => {
            "The moved entry can be returned to its source; its destination copy will be \
             removed only after the source is back"
        }
        Phase::Published => "The moved entry can be returned to its source",
        _ => "This interrupted move can be returned to its source",
    };
    let intent = operation.intent().clone();
    let generation = operation.generation();
    let folders = retained_folders(&intent, Some(operation.state()));
    let retirable = checkpoint.retention().retirable();
    let mut execution = match MoveExecution::reopen(operation) {
        Ok(execution) => execution,
        Err(error) => {
            return reply(
                coordinator,
                Some(item_in(
                    &intent,
                    folders,
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
    let admitted = match execution.admit_restoration() {
        Ok(admitted) => admitted,
        // Refused before any effect: the record is exactly as it was.
        Err(refusal) if retirable => {
            let exits = Exits {
                restorable: false,
                refusal: Some(refusal.error.to_string()),
                forget: refusal.lasting,
            };
            let mut snapshot = retained(coordinator, execution.operation, exits, describe)?;
            snapshot.error =
                matches!(request, Request::Restore(_)).then(|| diagnostic(refusal.error));
            return Ok(snapshot);
        }
        // An unfinished restoration that can neither finish nor return
        // anything more would otherwise offer a Restore that never succeeds.
        Err(refusal) => {
            // Never offer a Restore that admission refuses now: a refusal
            // the user can resolve waits for them, and Inspect asks again.
            let (message, actions) = if refusal.lasting {
                (
                    format!("{} {}", refusal.error, forget_hint(&folders)),
                    vec![RecoveryChoice::Release],
                )
            } else {
                (refusal.error.to_string(), vec![])
            };
            let error = matches!(request, Request::Restore(_)).then_some(refusal.error);
            return answer(
                coordinator,
                &execution.operation,
                None,
                "attention",
                &message,
                actions,
                error,
            );
        }
    };
    let (status, message, actions, error) = match request {
        Request::Inspect => ("ready", ready, vec![RecoveryChoice::Restore], None),
        Request::Restore(_) => match execution.restore_admitted(admitted) {
            Ok(()) => (
                "attention",
                "The moved entry has been returned to its source; retained artifacts still \
                 require cleanup",
                vec![],
                None,
            ),
            Err(error) => (
                "attention",
                "Move recovery could not complete; all remaining evidence is preserved",
                vec![],
                Some(error),
            ),
        },
        Request::Discard(_) | Request::Release(_) => {
            unreachable!("discard and release never reach move reconciliation")
        }
    };
    answer(
        coordinator,
        &execution.operation,
        None,
        status,
        message,
        actions,
        error,
    )
}

/// Restoration admission from the live endpoints of a retained record. Only
/// a lasting refusal from verified roots lets Forget end a restorable record,
/// and only a verified missing `publication` a restored one; a record whose
/// roots cannot be reopened offers neither Restore nor Forget (#795).
fn observe(operation: DurableOperation, restorable: bool) -> (DurableOperation, Exits) {
    if operation.state().retirement.is_some() {
        return (operation, Exits::default());
    }
    if !restorable {
        return match MoveExecution::try_reopen(operation) {
            Ok(execution) => {
                let forget = execution.restored_without_publication().unwrap_or(false);
                (
                    execution.operation,
                    Exits {
                        forget,
                        ..Exits::default()
                    },
                )
            }
            Err(failure) => (failure.0, Exits::default()),
        };
    }
    match MoveExecution::try_reopen(operation) {
        Ok(execution) => {
            let exits = match execution.admit_restoration() {
                Ok(_) => Exits {
                    restorable: true,
                    ..Exits::default()
                },
                Err(refusal) => Exits {
                    restorable: false,
                    refusal: Some(refusal.error.to_string()),
                    forget: refusal.lasting,
                },
            };
            (execution.operation, exits)
        }
        Err(failure) => (failure.0, Exits::default()),
    }
}

/// Forget a move record only after observing, under the same ownership, that
/// nothing else can end it: Restore is refused for a lasting reason from
/// verified roots (or a restored move verifiably retains no publication)
/// and, for a retained record, its discard is preserved. An unreadable volume or root, or a
/// refusal the user can resolve, is never proof of that (#795).
pub(super) fn forget(
    coordinator: &Arc<Coordinator>,
    operation: DurableOperation,
) -> Result<RecoverySnapshot, AppError> {
    let refused = || {
        reply(
            coordinator,
            None,
            Some("Restore or Discard can still resolve this record; it was not forgotten".into()),
        )
    };
    let restorable = operation
        .intent()
        .transition(operation.state(), Event::Begin(Effect::Restore))
        .is_ok();
    let retirable = operation
        .intent()
        .checkpoint(operation.state())
        .retention()
        .retirable();
    let operation = if restorable {
        match MoveExecution::try_reopen(operation) {
            Ok(execution) => match execution.admit_restoration() {
                Err(refusal) if refusal.lasting => execution.operation,
                _ => return refused(),
            },
            Err(failure) => return reply(coordinator, None, Some(diagnostic(failure.1))),
        }
    } else if retirable && operation.state().phase == Phase::Restored {
        match MoveExecution::try_reopen(operation) {
            Ok(execution) if execution.restored_without_publication().unwrap_or(false) => {
                execution.operation
            }
            Ok(_) => return refused(),
            Err(failure) => return reply(coordinator, None, Some(diagnostic(failure.1))),
        }
    } else {
        // Neither restorable nor restored: an interrupted forward move
        // reconciles through its own executor.
        return refused();
    };
    let operation = if retirable {
        let retirement = match Retirement::open(operation) {
            Ok(retirement) => retirement,
            Err(error) => return reply(coordinator, None, Some(diagnostic(error))),
        };
        if !matches!(retirement.eligibility(), Eligibility::Preserved(_)) {
            return refused();
        }
        retirement.operation
    } else {
        operation
    };
    match operation.forget_stranded() {
        Ok(()) => reply(coordinator, None, None),
        Err(error) => reply(coordinator, None, Some(diagnostic(error))),
    }
}

fn describe(_state: &State, restorable: bool) -> &'static str {
    if restorable {
        "Restore this move or discard its recovery data. Discard permanently removes its Undo \
         history and any retained originals."
    } else {
        "The move no longer needs restoration; its retained recovery data can be discarded."
    }
}
