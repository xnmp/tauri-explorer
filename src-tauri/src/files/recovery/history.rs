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
    })
}
