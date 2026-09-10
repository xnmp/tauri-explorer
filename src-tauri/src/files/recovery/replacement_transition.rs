//! Pure legal transitions for durable replacement recovery checkpoints.
use super::model::{DurableIntent, ObjectId, OperationState, Phase, StagedPayload};
use std::io;

pub(super) enum ReplacementTransition {
    BeginRoot,
    RootObserved(ObjectId),
    BeginManifest,
    ManifestCompleted,
    BeginStaging,
    StagingCompleted(StagedPayload),
    BeginDisplacement,
    DisplacementCompleted,
    BeginPublication,
    PublicationCompleted,
    BeginRestoration,
    RestorationCompleted,
    BeginReapplication,
    ReapplicationCompleted,
    /// Lazily record the measured size of the currently retained artifact.
    /// Accounting only; it grants no cleanup authority (ADR 0023).
    RetentionMeasured(u64),
    BeginDiscard,
    DiscardCompleted,
    ReportError(String),
}

pub(super) fn transition(
    intent: &DurableIntent,
    current: &OperationState,
    event: ReplacementTransition,
) -> io::Result<OperationState> {
    intent.validate()?;
    current.validate(intent)?;
    let mut next = current.clone();
    let state = next.replacement_mut()?;
    match event {
        ReplacementTransition::BeginRoot if state.phase == Phase::Planned => {
            state.phase = Phase::RootIntent;
        }
        ReplacementTransition::RootObserved(root) if state.phase == Phase::RootIntent => {
            state.root = Some(root);
            state.phase = Phase::Rooted;
            state.error = None;
        }
        ReplacementTransition::BeginManifest if state.phase == Phase::Rooted => {
            state.phase = Phase::ManifestIntent;
        }
        ReplacementTransition::ManifestCompleted if state.phase == Phase::ManifestIntent => {
            state.phase = Phase::Prepared;
            state.error = None;
        }
        ReplacementTransition::BeginStaging if state.phase == Phase::Prepared => {
            state.phase = Phase::StageIntent;
        }
        ReplacementTransition::StagingCompleted(published) if state.phase == Phase::StageIntent => {
            state.published = Some(published);
            state.phase = Phase::Staged;
            state.error = None;
        }
        // Reasserting an existing transfer intent makes the coordinator verify
        // its exact owner/catalog/checkpoint before native endpoint reconciliation.
        ReplacementTransition::BeginDisplacement
            if matches!(state.phase, Phase::Staged | Phase::DisplaceIntent) =>
        {
            state.phase = Phase::DisplaceIntent;
        }
        ReplacementTransition::DisplacementCompleted if state.phase == Phase::DisplaceIntent => {
            state.phase = Phase::Displaced;
            state.error = None;
        }
        ReplacementTransition::BeginPublication
            if matches!(state.phase, Phase::Displaced | Phase::PublishIntent) =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = Phase::PublishIntent;
            // The retained artifact is about to change identity; a previous
            // measurement describes a different payload (ADR 0023).
            state.retained_bytes = None;
        }
        ReplacementTransition::PublicationCompleted if state.phase == Phase::PublishIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = Phase::Published;
            state.retained_bytes = None;
            state.error = None;
        }
        // `DiscardIntent` is restorable so an interrupted retirement whose live
        // endpoint changed is never a dead end: refusing to finish the removal
        // must still leave the user a non-destructive way to resolve the record
        // (ADR 0023). Nothing has been removed while the artifact is intact.
        ReplacementTransition::BeginRestoration
            if matches!(
                state.phase,
                Phase::DisplaceIntent
                    | Phase::Displaced
                    | Phase::PublishIntent
                    | Phase::Published
                    | Phase::RestoreIntent
                    | Phase::ReapplyIntent
                    | Phase::DiscardIntent
            ) =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = Phase::RestoreIntent;
            // The retained artifact is about to change identity; a previous
            // measurement describes a different payload (ADR 0023).
            state.retained_bytes = None;
        }
        ReplacementTransition::RestorationCompleted if state.phase == Phase::RestoreIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = Phase::Restored;
            state.retained_bytes = None;
            state.error = None;
        }
        ReplacementTransition::BeginReapplication
            if matches!(state.phase, Phase::Restored | Phase::ReapplyIntent) =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = Phase::ReapplyIntent;
            // The retained artifact is about to change identity; a previous
            // measurement describes a different payload (ADR 0023).
            state.retained_bytes = None;
        }
        ReplacementTransition::ReapplicationCompleted if state.phase == Phase::ReapplyIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = Phase::Published;
            state.retained_bytes = None;
            state.error = None;
        }
        // Accounting for the settled artifact. Measuring never clears a
        // recorded error and never advances the phase.
        ReplacementTransition::RetentionMeasured(bytes)
            if matches!(state.phase, Phase::Published | Phase::Restored) =>
        {
            state.retained_bytes = Some(bytes);
        }
        // Reasserting discard intent lets an interrupted retirement resume
        // from its recorded checkpoint without inventing a completed effect.
        ReplacementTransition::BeginDiscard
            if matches!(
                state.phase,
                Phase::Published | Phase::Restored | Phase::DiscardIntent
            ) =>
        {
            state.phase = Phase::DiscardIntent;
        }
        ReplacementTransition::DiscardCompleted if state.phase == Phase::DiscardIntent => {
            state.phase = Phase::Discarded;
            state.retained_bytes = None;
            state.error = None;
        }
        // A completed retirement has nothing left to remove. Both retirement
        // events are no-ops there, so a resumption whose only remaining work
        // is the record commit does not have to special-case its phase.
        ReplacementTransition::BeginDiscard | ReplacementTransition::DiscardCompleted
            if state.phase == Phase::Discarded =>
        {
            state.error = None;
        }
        ReplacementTransition::ReportError(error) => state.error = Some(error),
        _ => return Err(invalid("Illegal recovery replacement phase transition")),
    }
    next.validate(intent)?;
    Ok(next)
}

fn next_effect_revision(revision: u64) -> io::Result<u64> {
    revision
        .checked_add(1)
        .ok_or_else(|| invalid("Recovery effect revision exhausted"))
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_replacement_transition.rs"]
mod tests;
