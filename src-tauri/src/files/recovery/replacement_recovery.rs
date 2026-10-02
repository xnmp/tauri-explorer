//! Copy-replacement presentation for the recovery service: restoration is
//! reconciled by the replacement executor from its retained native root.
use super::super::{
    checkpoint::{Phase, State},
    replacement_execution::ReplacementExecution,
    replacement_restoration::RestorationStep,
};
use super::{
    answer, diagnostic, item, reply, retained, Coordinator, DurableOperation, Eligibility,
    RecoveryChoice, RecoverySnapshot, Request, Retirement,
};
use crate::error::AppError;
use std::sync::Arc;

pub(super) fn reconcile(
    coordinator: &Arc<Coordinator>,
    operation: DurableOperation,
    request: Request,
    restorable: bool,
) -> Result<RecoverySnapshot, AppError> {
    // A journaled retirement is presented as retention: retention reporting
    // carries the exact reason a refused retirement preserved its evidence. A
    // phase with no supported restoration needs no user-volume probes, but
    // its retained artifacts may still be explicitly discardable.
    if !restorable {
        return retained(coordinator, operation, false, describe);
    }
    let intent = operation.intent().clone();
    let generation = operation.generation();
    let mut execution = match ReplacementExecution::reopen(operation) {
        Ok(execution) => execution,
        Err(error) => {
            return reply(
                coordinator,
                Some(item(
                    &intent,
                    None,
                    generation,
                    None,
                    "attention",
                    "Recovery files could not be verified; evidence is preserved",
                    vec![],
                )),
                Some(diagnostic(error)),
            )
        }
    };
    if let Err(error) = verify_restoration(&execution) {
        return failed(coordinator, &execution.operation, error);
    }
    match request {
        Request::Inspect => ready(coordinator, execution),
        Request::Restore(_) => match execution.restore_copy() {
            Ok(_) => answer(
                coordinator,
                &execution.operation,
                None,
                "retained",
                "The original has been restored; the retained copy can be discarded",
                vec![],
                None,
            ),
            Err(error) => failed(coordinator, &execution.operation, error),
        },
        Request::Discard(_) | Request::Release(_) => {
            unreachable!("discard and release are dispatched before reconciliation")
        }
    }
}

fn verify_restoration(execution: &ReplacementExecution) -> Result<(), AppError> {
    let staged = execution
        .operation
        .state()
        .staged
        .as_ref()
        .expect("restoration transition validated staged evidence");
    if execution
        .root
        .inspect_restoration(execution.operation.intent(), staged)?
        == RestorationStep::Conflict
    {
        return Err(AppError::MutationUncertain(
            "Recovery files differ from the recorded operation; all entries are preserved".into(),
        ));
    }
    Ok(())
}

/// Restoration is offered; Discard only while the settled record's retained
/// artifact is verifiably disposable, which retirement itself decides.
fn ready(
    coordinator: &Arc<Coordinator>,
    execution: ReplacementExecution,
) -> Result<RecoverySnapshot, AppError> {
    let ReplacementExecution { operation, root } = execution;
    drop(root);
    let intent = operation.intent().clone();
    let (state, generation) = (operation.state().clone(), operation.generation());
    // Retirement keeps the native owner through the final inventory read.
    let retirement = Retirement::open(operation);
    let mut actions = vec![RecoveryChoice::Restore];
    if retirement.as_ref().is_ok_and(|retirement| {
        matches!(
            retirement.eligibility(),
            Eligibility::Discardable | Eligibility::Automatic
        )
    }) {
        actions.push(RecoveryChoice::Discard);
    }
    let view = item(
        &intent,
        Some(&state),
        generation,
        state.retained_bytes,
        "ready",
        "The recorded original can be restored; any published copy will be retained",
        actions,
    );
    reply(coordinator, Some(view), None)
}

fn failed(
    coordinator: &Arc<Coordinator>,
    operation: &DurableOperation,
    error: AppError,
) -> Result<RecoverySnapshot, AppError> {
    answer(
        coordinator,
        operation,
        None,
        "attention",
        "Recovery could not complete; all remaining evidence is preserved",
        vec![],
        Some(error),
    )
}

fn describe(state: &State, _restorable: bool) -> &'static str {
    if state.phase == Phase::Restored {
        "The original has been restored; the retained copy can be discarded"
    } else {
        "Retained recovery files can be discarded"
    }
}
