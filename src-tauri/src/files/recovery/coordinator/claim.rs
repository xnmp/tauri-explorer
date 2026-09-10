//! Reacquire an abandoned indexed operation without changing its immutable owner.
//! A claim advances the checkpoint generation but grants no inferred file effect.
use super::super::model::{OperationState, Phase};
use super::super::move_model::MovePhase;
use super::*;

enum Expected {
    Generation(u64),
    StableEffect { revision: u64, phase: Phase },
}

impl Expected {
    fn accepts(&self, generation: u64, checkpoint: &OperationCheckpoint) -> bool {
        match self {
            Self::Generation(expected) => generation == *expected,
            Self::StableEffect { revision, phase } => match &checkpoint.state {
                OperationState::Replacement(state) => {
                    state.effect_revision == *revision && state.phase == *phase
                }
                // A completed move rests at `Published` (rename) or `Parked`
                // (cross filesystem); the exact revision pins which one.
                OperationState::Move(state) => {
                    state.error.is_none()
                        && state.effect_revision == *revision
                        && match phase {
                            Phase::Published => matches!(
                                state.phase,
                                MovePhase::Published | MovePhase::Parked | MovePhase::Removed
                            ),
                            Phase::Restored => state.phase == MovePhase::Restored,
                            _ => false,
                        }
                }
            },
        }
    }
}

impl Coordinator {
    /// `None` means the exact native owner is still busy. Missing or inconsistent
    /// evidence is an error, never abandonment. The caller supplies the generation
    /// it inspected so a stale recovery action cannot claim newer operation state.
    pub(in crate::files::recovery) fn try_claim(
        self: &Arc<Self>,
        id: &str,
        expected_generation: u64,
    ) -> Result<Option<DurableOperation>, AppError> {
        self.try_claim_with(id, expected_generation, || Ok(()))
    }

    fn try_claim_with(
        self: &Arc<Self>,
        id: &str,
        expected_generation: u64,
        after_commit: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<Option<DurableOperation>, AppError> {
        self.claim(id, Expected::Generation(expected_generation), after_commit)
    }

    /// Native history validates content revision and stable position atomically
    /// with ownership acquisition. Read-only Inspect claims do not stale history.
    pub(in crate::files::recovery) fn try_claim_history(
        self: &Arc<Self>,
        id: &str,
        revision: u64,
        position: HistoryPosition,
    ) -> Result<Option<DurableOperation>, AppError> {
        let phase = match position {
            HistoryPosition::Published => Phase::Published,
            HistoryPosition::Restored => Phase::Restored,
        };
        self.claim(id, Expected::StableEffect { revision, phase }, || Ok(()))
    }

    fn claim(
        self: &Arc<Self>,
        id: &str,
        expected: Expected,
        after_commit: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<Option<DurableOperation>, AppError> {
        self.admitted(|inner| {
            let evidence = inner.catalog.records()?;
            let intents = decode_catalog(&evidence, &inner.protected)?;
            let rows = inner.journal.records()?;
            let row = rows.iter().find(|row| row.id == id).ok_or_else(|| {
                invalid("Recovery checkpoint is missing; catalog evidence requires inspection")
            })?;
            if row.kind != RecordKind::Operation {
                return Err(invalid(
                    "Recovery checkpoint is unavailable or its generation changed",
                ));
            }
            let checkpoint = decode_checkpoint(row, &intents)?;
            if !expected.accepts(row.generation, &checkpoint) {
                return Err(invalid(
                    "Recovery checkpoint generation or history position changed",
                ));
            }
            let entry = intents
                .get(id)
                .expect("decoded checkpoint has a catalog entry");
            let captured = evidence
                .into_iter()
                .find(|item| item.id == id)
                .expect("decoded catalog retains its evidence");

            // Corrupt or overlapping authority elsewhere must not become a new
            // way around the same conflict policy used by mutation admission.
            let mut ownership = inner.operation_claims(&intents, &rows, Some(id))?;
            for other in &rows {
                match other.kind {
                    RecordKind::Operation => {}
                    RecordKind::Reservation => {
                        let reservation: ReservationRecord = decode(&other.payload)?;
                        validate_reservation(&other.id, &reservation)?;
                        // Claims never reclaim unrelated reservations. Preserve
                        // their ownership until ordinary admission settles them.
                        for resource in &reservation.resources {
                            ownership.index.insert(resource);
                        }
                    }
                }
            }
            let artifacts = super::claims::known_artifacts(&entry.intent, &checkpoint.state);
            if entry
                .intent
                .resources
                .iter()
                .chain(
                    artifacts
                        .iter()
                        .flat_map(super::claims::ArtifactClaims::iter),
                )
                .any(|resource| ownership.index.conflicts(resource))
            {
                return Err(invalid(
                    "Another recovery owner has overlapping file authority",
                ));
            }
            let owner = match OperationLock::acquire(&inner.locks, &entry.intent.lock)? {
                LockAttempt::Busy => return Ok(None),
                LockAttempt::Acquired(owner) => owner,
            };
            owner.verify(&inner.locks)?;
            inner.catalog.verify(&captured)?;
            let claimed = inner.journal.replace(id, row.generation, &row.payload)?;
            after_commit()?;
            owner.verify(&inner.locks)?;
            inner.catalog.verify(&captured)?;
            Ok(Some(DurableOperation {
                owner,
                coordinator: Arc::clone(self),
                generation: claimed.generation,
                record: OperationRecord {
                    intent: entry.intent.clone(),
                    state: checkpoint.state,
                },
                evidence: captured,
            }))
        })
    }
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_claim.rs"]
mod tests;
