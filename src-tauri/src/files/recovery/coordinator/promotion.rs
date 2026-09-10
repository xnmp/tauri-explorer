//! Catalog-first conversion of a live reservation into durable ownership.
//! Publication is bounded private-storage IO; no user-file effects run here.
use super::*;
use crate::files::recovery::model::OperationSpec;
use crate::files::recovery::retention::{self, Budget, Usage};
use sha2::{Digest, Sha256};

pub(in crate::files::recovery) struct PromotionFailure {
    pub reservation: Reservation,
    pub error: AppError,
}

impl Reservation {
    fn planned(&self, operation: OperationSpec) -> OperationRecord {
        OperationRecord::planned(DurableIntent {
            version: 1,
            id: self.id.clone(),
            lock: self.owner.identity.clone(),
            resources: self.resources.clone(),
            operation,
        })
    }

    /// Pure preflight for a whole prepared group. Promotion repeats validation
    /// under admission; this check grants no catalog or filesystem effect.
    pub(in crate::files::recovery) fn validate_operation(
        &self,
        operation: OperationSpec,
    ) -> Result<(), AppError> {
        let record = self.planned(operation);
        record.validate()?;
        encode_intent(&record.intent, super::super::journal::MAX_RECORD_BYTES)?;
        Ok(())
    }

    pub(in crate::files::recovery) fn promote(
        self,
        operation: OperationSpec,
    ) -> Result<DurableOperation, Box<PromotionFailure>> {
        self.promote_with(operation, || Ok(()), || Ok(()))
    }

    /// Promote under an explicit retention budget. The budget is a parameter so
    /// the refusal branch itself is testable without the user's settings file.
    #[cfg(test)]
    pub(in crate::files::recovery) fn promote_within(
        self,
        operation: OperationSpec,
        budget: Budget,
    ) -> Result<DurableOperation, Box<PromotionFailure>> {
        self.promote_bounded(
            operation,
            || Ok(()),
            || Ok(()),
            super::super::journal::MAX_RECORD_BYTES,
            budget,
        )
    }

    fn promote_with(
        self,
        operation: OperationSpec,
        after_catalog: impl FnOnce() -> Result<(), AppError>,
        after_commit: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<DurableOperation, Box<PromotionFailure>> {
        // Read the configured budget before taking the gate; enforcement then
        // happens inside the same transaction that publishes the catalog, so
        // concurrent record creation cannot race past it (ADR 0023).
        let budget = crate::config::read_settings_value()
            .as_ref()
            .map_or_else(Budget::default, Budget::from_settings);
        self.promote_bounded(
            operation,
            after_catalog,
            after_commit,
            super::super::journal::MAX_RECORD_BYTES,
            budget,
        )
    }

    fn promote_bounded(
        self,
        operation: OperationSpec,
        after_catalog: impl FnOnce() -> Result<(), AppError>,
        after_commit: impl FnOnce() -> Result<(), AppError>,
        manifest_limit: usize,
        budget: Budget,
    ) -> Result<DurableOperation, Box<PromotionFailure>> {
        let record = self.planned(operation);
        let promoted = self.coordinator.admitted(|inner| {
            record.validate()?;
            self.owner.verify(&inner.locks)?;
            let intents = decode_catalog(&inner.catalog.records()?, &inner.protected)?;
            let rows = inner.journal.records()?;
            let row = rows
                .iter()
                .find(|row| row.id == self.id)
                .ok_or_else(|| invalid("Recovery reservation disappeared before promotion"))?;
            if row.kind == RecordKind::Operation {
                // The previous commit may have succeeded before its reply was
                // lost. Adopt only the exact initial record; never replay work
                // or rewrite a phase advanced by reconciliation.
                let indexed = decode_checkpoint(row, &intents)?;
                if indexed.state != record.state
                    || row.generation <= self.generation
                    || intents.get(&self.id).map(|entry| &entry.intent) != Some(&record.intent)
                {
                    return Err(invalid("Recovery operation changed during promotion retry"));
                }
                let payload = serde_json::to_vec(&record.intent)
                    .map_err(|error| invalid(&error.to_string()))?;
                let evidence = inner.catalog.ensure_exact(&self.id, &payload)?;
                return Ok((row.generation, evidence));
            }
            let reserved: ReservationRecord = decode(&row.payload)?;
            validate_reservation(&row.id, &reserved)?;
            if row.generation != self.generation
                || reserved.lock != self.owner.identity
                || reserved.resources != self.resources
            {
                return Err(invalid(
                    "Recovery reservation authority changed before promotion",
                ));
            }
            if intents
                .get(&self.id)
                .is_some_and(|existing| existing.intent != record.intent)
            {
                return Err(invalid(
                    "Recovery catalog disagrees with the planned operation",
                ));
            }
            // Budgets reject new work; they never evict unresolved recovery.
            if retained_usage(&intents, &rows)?.at_capacity(&budget) {
                return Err(invalid(
                    "File Recovery is holding its full retained-file budget; discard retained files in File Recovery before overwriting more",
                ));
            }
            let catalog_payload = encode_intent(&record.intent, manifest_limit)?;
            let checkpoint = OperationCheckpoint {
                intent_digest: Sha256::digest(&catalog_payload).into(),
                state: record.state.clone(),
            };
            let journal_payload =
                serde_json::to_vec(&checkpoint).map_err(|error| invalid(&error.to_string()))?;
            let mut evidence = None;
            // The SQLite write transaction prevents a second connection from
            // consuming the preflight budget between publication and promotion.
            let promoted = inner.journal.promote_with(
                &self.id,
                self.generation,
                &self.id,
                &journal_payload,
                || {
                    evidence = Some(inner.catalog.ensure_exact(&self.id, &catalog_payload)?);
                    after_catalog()
                },
            )?;
            after_commit()?;
            Ok((
                promoted.generation,
                evidence.expect("successful promotion published evidence"),
            ))
        });
        match promoted {
            Ok((generation, evidence)) => Ok(DurableOperation {
                owner: self.owner,
                coordinator: self.coordinator,
                generation,
                record,
                evidence,
            }),
            Err(error) => Err(Box::new(PromotionFailure {
                reservation: self,
                error,
            })),
        }
    }
}

/// Retention accounting from durable evidence only. Every input is already
/// decoded under this transaction, so no filesystem work happens under the
/// gate and no unrelated process can insert a record between check and commit.
fn retained_usage(
    intents: &HashMap<String, CatalogIntent>,
    rows: &[super::super::journal::Record],
) -> Result<Usage, AppError> {
    let mut usage = Usage::default();
    for row in rows.iter().filter(|row| row.kind == RecordKind::Operation) {
        let Some(entry) = intents.get(&row.id) else {
            continue;
        };
        let checkpoint = decode_checkpoint(row, intents)?;
        usage.add(
            retention::retention(&entry.intent.operation, &checkpoint.state),
            retention::measured_bytes(&checkpoint.state),
            true,
        );
    }
    Ok(usage)
}

fn encode_intent(intent: &DurableIntent, manifest_limit: usize) -> Result<Vec<u8>, AppError> {
    let payload = serde_json::to_vec(intent).map_err(|error| invalid(&error.to_string()))?;
    if super::super::model::LocalManifest::maximum_encoded_bytes(payload.len())
        .is_none_or(|bytes| bytes > manifest_limit)
    {
        return Err(invalid(
            "Recovery intent exceeds the local manifest storage limit",
        ));
    }
    Ok(payload)
}

impl DurableOperation {
    pub(in crate::files::recovery) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn intent(&self) -> &DurableIntent {
        &self.record.intent
    }

    pub(crate) fn state(&self) -> &super::super::model::OperationState {
        &self.record.state
    }

    /// Persist a legal transition after the executor has established its native
    /// evidence. No user-volume effects run under the coordinator's admission.
    pub(in crate::files::recovery) fn advance(
        &mut self,
        event: super::super::replacement_transition::ReplacementTransition,
    ) -> Result<(), AppError> {
        self.advance_with(event, || Ok(()))
    }

    fn advance_with(
        &mut self,
        event: super::super::replacement_transition::ReplacementTransition,
        after_commit: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let state = super::super::replacement_transition::transition(
            &self.record.intent,
            &self.record.state,
            event,
        )?;
        let checkpoint = OperationCheckpoint {
            intent_digest: self.evidence.digest(),
            state,
        };
        let payload =
            serde_json::to_vec(&checkpoint).map_err(|error| invalid(&error.to_string()))?;
        let generation = self.coordinator.admitted(|inner| {
            self.owner.verify(&inner.locks)?;
            inner.catalog.verify(&self.evidence)?;
            let rows = inner.journal.records()?;
            let row = rows
                .iter()
                .find(|row| row.id == self.record.intent.id && row.kind == RecordKind::Operation)
                .ok_or_else(|| invalid("Durable operation disappeared before its transition"))?;
            let current: OperationCheckpoint = decode(&row.payload)?;
            current.validate(&self.record.intent, self.evidence.digest())?;
            if row.generation != self.generation {
                // An exact retry can acknowledge a commit whose reply was lost;
                // changed evidence or any different phase stays fenced.
                if row.generation > self.generation && current == checkpoint {
                    return Ok(row.generation);
                }
                return Err(invalid("Durable operation generation changed"));
            }
            if current.state != self.record.state {
                return Err(invalid(
                    "Durable operation state changed without its generation",
                ));
            }
            if current == checkpoint {
                return Ok(row.generation);
            }
            let row = inner.journal.replace(&row.id, row.generation, &payload)?;
            after_commit()?;
            Ok(row.generation)
        })?;
        self.generation = generation;
        self.record.state = checkpoint.state;
        Ok(())
    }
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_promotion.rs"]
mod tests;
