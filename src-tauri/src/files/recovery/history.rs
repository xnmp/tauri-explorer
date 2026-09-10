//! Native history resolves durable identities, never renderer-supplied paths.
use super::{
    coordinator::{Coordinator, HistoryPosition},
    model::{ReplacementDirection, ReplacementHistory, ReplacementOutcome},
    replacement_execution::ReplacementExecution,
};
use crate::error::AppError;
use std::sync::Arc;

pub(super) fn execute(
    coordinator: &Arc<Coordinator>,
    mut history: ReplacementHistory,
    direction: ReplacementDirection,
) -> Result<ReplacementOutcome, AppError> {
    let position = match direction {
        ReplacementDirection::Restore => HistoryPosition::Published,
        ReplacementDirection::Reapply => HistoryPosition::Restored,
    };
    let operation = coordinator
        .try_claim_history(&history.id, history.revision, position)?
        .ok_or_else(|| AppError::Other("Replacement is owned by another native worker".into()))?;
    // A move record IS its own inverse; there is no separate reapply. Reaching
    // this point required the exact identity, revision and stable position.
    if operation.intent().operation.move_spec().is_ok() {
        if !matches!(direction, ReplacementDirection::Restore) {
            return Err(AppError::Other(
                "A durable move cannot be reapplied; its record was consumed by Undo".into(),
            ));
        }
        let mut execution = super::move_execution::MoveExecution::reopen(operation)?;
        execution.restore_move().map_err(|error| AppError::MutationUncertain(format!("Move history could not complete; inspect File Recovery before continuing. {error}")))?;
        history.revision = execution.operation.state().move_state()?.effect_revision;
        return Ok(ReplacementOutcome {
            history,
            warning: None,
            reapplicable: false,
        });
    }
    let mut execution = ReplacementExecution::reopen(operation)?;
    // Once execution begins, an error may leave a durable intent or file effect.
    // Consume the history inverse and retain explicit recovery authority instead
    // of presenting an unsafe retry or inventing its opposite.
    match direction {
        ReplacementDirection::Restore => execution.restore_copy(),
        ReplacementDirection::Reapply => execution.reapply_copy(),
    }.map_err(|error| AppError::MutationUncertain(format!("Replacement history could not complete; inspect File Recovery before continuing. {error}")))?;
    let state = execution.operation.state().replacement()?;
    history.revision = state.effect_revision;
    Ok(ReplacementOutcome {
        history,
        warning: None,
        reapplicable: true,
    })
}
