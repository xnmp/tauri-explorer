//! Pure legal transitions for durable move recovery checkpoints.
//!
//! The ordering encoded here is the crash contract. A source is parked only
//! after its destination is published, and its parked copy is removed only
//! after parking is durable, so no boundary can leave both endpoints absent.
use super::model::{DurableIntent, ObjectId, OperationState, StagedPayload};
use super::move_model::{MovePhase, MoveSpec, Strategy};
use std::io;

pub(super) enum MoveTransition {
    BeginRoots,
    RootsObserved {
        source: Option<ObjectId>,
        target: Option<ObjectId>,
    },
    BeginManifests,
    ManifestsCompleted,
    BeginStaging,
    StagingCompleted(StagedPayload),
    BeginDisplacement,
    DisplacementCompleted,
    BeginPublication,
    PublicationCompleted,
    BeginPark,
    ParkCompleted,
    /// Reachable only from a durable park. No production caller yet: finishing
    /// a parked move belongs with durable retirement (#687).
    #[allow(dead_code)]
    BeginSourceRemoval,
    #[allow(dead_code)]
    SourceRemoved,
    BeginRestoration,
    RestorationCompleted,
    ReportError(String),
}

pub(super) fn transition(
    intent: &DurableIntent,
    current: &OperationState,
    event: MoveTransition,
) -> io::Result<OperationState> {
    intent.validate()?;
    current.validate(intent)?;
    let spec = intent.operation.move_spec()?.clone();
    let mut next = current.clone();
    let state = next.move_state_mut()?;
    let staging = spec.strategy == Strategy::CopyParked;
    let overwriting = spec.target_original.is_some();
    let rooted = spec.source_root.is_some() || spec.target_root.is_some();
    match event {
        MoveTransition::BeginRoots if state.phase == MovePhase::Planned && rooted => {
            state.phase = MovePhase::RootIntent;
        }
        MoveTransition::RootsObserved { source, target }
            if state.phase == MovePhase::RootIntent
                && source.is_some() == spec.source_root.is_some()
                && target.is_some() == spec.target_root.is_some() =>
        {
            state.source_root = source;
            state.target_root = target;
            state.phase = MovePhase::Rooted;
            state.error = None;
        }
        MoveTransition::BeginManifests if state.phase == MovePhase::Rooted => {
            state.phase = MovePhase::ManifestIntent;
        }
        MoveTransition::ManifestsCompleted if state.phase == MovePhase::ManifestIntent => {
            state.phase = MovePhase::Prepared;
            state.error = None;
        }
        MoveTransition::BeginStaging if state.phase == MovePhase::Prepared && staging => {
            state.phase = MovePhase::StageIntent;
        }
        MoveTransition::StagingCompleted(staged) if state.phase == MovePhase::StageIntent => {
            state.staged = Some(staged);
            state.phase = MovePhase::Staged;
            state.error = None;
        }
        // Reasserting a transfer intent lets the executor reconcile a lost
        // effect or reply; native endpoints, not the label, choose the effect.
        MoveTransition::BeginDisplacement
            if overwriting
                && match state.phase {
                    MovePhase::Prepared => !staging,
                    MovePhase::Staged => staging,
                    MovePhase::DisplaceIntent => true,
                    _ => false,
                } =>
        {
            state.phase = MovePhase::DisplaceIntent;
        }
        MoveTransition::DisplacementCompleted if state.phase == MovePhase::DisplaceIntent => {
            state.phase = MovePhase::Displaced;
            state.error = None;
        }
        MoveTransition::BeginPublication
            if match state.phase {
                // The same-filesystem non-overwrite fast path is one atomic
                // no-replace rename; it needs no private storage at all.
                MovePhase::Planned => !rooted,
                MovePhase::Prepared => !staging && !overwriting,
                MovePhase::Staged => staging && !overwriting,
                MovePhase::Displaced | MovePhase::PublishIntent => true,
                _ => false,
            } =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::PublishIntent;
        }
        MoveTransition::PublicationCompleted if state.phase == MovePhase::PublishIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::Published;
            state.error = None;
        }
        // Parking is reachable only from a published destination. A rename
        // never parks: its single effect already vacated the source name.
        MoveTransition::BeginPark
            if staging && matches!(state.phase, MovePhase::Published | MovePhase::ParkIntent) =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::ParkIntent;
        }
        MoveTransition::ParkCompleted if state.phase == MovePhase::ParkIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::Parked;
            state.error = None;
        }
        // Removal destroys the last exact original identity, so it is reachable
        // only from a durable park and never from restoration.
        MoveTransition::BeginSourceRemoval
            if matches!(state.phase, MovePhase::Parked | MovePhase::RemoveIntent) =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::RemoveIntent;
        }
        // Removal advances the revision so that a history position plus a
        // revision names exactly one state: a caller holding the completed
        // move's revision can never claim a record whose source is gone.
        MoveTransition::SourceRemoved if state.phase == MovePhase::RemoveIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::Removed;
            state.error = None;
        }
        // Restoration is the record's own inverse. `Removed` is deliberately
        // absent: once the parked source is gone there is no exact original.
        MoveTransition::BeginRestoration
            if matches!(
                state.phase,
                MovePhase::DisplaceIntent
                    | MovePhase::Displaced
                    | MovePhase::PublishIntent
                    | MovePhase::Published
                    | MovePhase::ParkIntent
                    | MovePhase::Parked
                    | MovePhase::RestoreIntent
            ) =>
        {
            next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::RestoreIntent;
        }
        MoveTransition::RestorationCompleted if state.phase == MovePhase::RestoreIntent => {
            state.effect_revision = next_effect_revision(state.effect_revision)?;
            state.phase = MovePhase::Restored;
            state.error = None;
        }
        MoveTransition::ReportError(error) => state.error = Some(error),
        _ => return Err(invalid("Illegal recovery move phase transition")),
    }
    next.validate(intent)?;
    Ok(next)
}

/// The endpoint a restoration must reach the source through. This depends only
/// on the immutable strategy, never on the current phase: an interrupted
/// restoration is retried from `RestoreIntent`, and deriving the origin from
/// that phase would forget that the source is parked and strand it forever.
/// The executor decides what work remains by observing the source itself.
pub(super) fn restoration_source(spec: &MoveSpec) -> RestorationSource {
    match spec.strategy {
        Strategy::CopyParked => RestorationSource::Parked,
        Strategy::Rename => RestorationSource::Published,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RestorationSource {
    /// A cross-filesystem source may be hidden under private storage. It is
    /// renamed home when absent, and the published destination is retired only
    /// after the source is verified present at its own name.
    Parked,
    /// A same-filesystem publication is itself the original object.
    Published,
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
#[path = "../../../test_support/recovery_move_transition.rs"]
mod tests;
