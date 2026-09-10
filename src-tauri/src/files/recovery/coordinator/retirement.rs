//! Durable record retirement: the commit point of ADR 0023's state machine.
//! Artifact removal has already completed and been journaled before any of
//! this runs. Nothing here touches a user volume.
use super::super::model::{OperationState, Phase};
use super::*;

impl DurableOperation {
    /// Retire a completed retirement's durable evidence under exact ownership.
    ///
    /// The journal row is removed before the catalog record, because a journal
    /// row without catalog evidence fences every managed mutation, while a
    /// catalog record without a journal row stays discoverable and is retired
    /// by `retire_orphan_catalog` once its artifact root is verifiably absent.
    pub(in crate::files::recovery) fn retire_record(self) -> Result<(), AppError> {
        let Self {
            owner,
            coordinator,
            generation,
            record,
            evidence,
        } = self;
        coordinator.admitted(move |inner| {
            owner.verify(&inner.locks)?;
            inner.catalog.verify(&evidence)?;
            let intents = decode_catalog(&inner.catalog.records()?, &inner.protected)?;
            let rows = inner.journal.records()?;
            let row = rows
                .iter()
                .find(|row| row.id == record.intent.id)
                .ok_or_else(|| invalid("Recovery record disappeared before retirement"))?;
            if row.kind != RecordKind::Operation || row.generation != generation {
                return Err(invalid(
                    "Recovery record generation changed before retirement",
                ));
            }
            let checkpoint = decode_checkpoint(row, &intents)?;
            if !completed_retirement(&checkpoint.state) {
                return Err(invalid(
                    "Recovery record is not a completed retirement; evidence is preserved",
                ));
            }
            inner.journal.remove(&record.intent.id, generation)?;
            inner.catalog.retire(&evidence)?;
            retire_owner(inner, owner, &intents, &rows, &record.intent.id)
        })
    }
}

impl Coordinator {
    /// Retire catalog evidence that no journal row references and whose
    /// artifact root the caller has verified absent outside this gate. Both
    /// interpretations of such a record — an interrupted retirement, or an
    /// operation whose index was lost before it created any artifact — hold no
    /// user bytes once the root is gone, and its stale claims would otherwise
    /// fence the recorded paths permanently.
    pub(in crate::files::recovery) fn retire_orphan_catalog(
        &self,
        id: &str,
        digest: [u8; 32],
    ) -> Result<(), AppError> {
        self.admitted(|inner| {
            let evidence = inner
                .catalog
                .records()?
                .into_iter()
                .find(|item| item.id == id)
                .ok_or_else(|| invalid("Recovery catalog evidence is already retired"))?;
            if evidence.digest() != digest {
                return Err(invalid(
                    "Recovery catalog evidence changed since it was inspected",
                ));
            }
            let intents = decode_catalog(&inner.catalog.records()?, &inner.protected)?;
            let rows = inner.journal.records()?;
            if rows.iter().any(|row| row.id == id) {
                return Err(invalid(
                    "Recovery record is indexed and cannot be retired as orphaned evidence",
                ));
            }
            let lock = intents
                .get(id)
                .ok_or_else(|| invalid("Recovery catalog evidence is already retired"))?
                .intent
                .lock
                .clone();
            inner.catalog.retire(&evidence)?;
            // The owner is only reclaimable when nothing else references it and
            // its OS lock is actually free; a busy owner stays untouched.
            if !referenced(&intents, &rows, id, &lock) {
                if let LockAttempt::Acquired(owner) =
                    OperationLock::acquire(&inner.locks, &lock).or_else(|error| {
                        if error.kind() == std::io::ErrorKind::NotFound {
                            Ok(LockAttempt::Busy)
                        } else {
                            Err(error)
                        }
                    })?
                {
                    owner.retire(&inner.locks)?;
                }
            }
            Ok(())
        })
    }
}

fn completed_retirement(state: &OperationState) -> bool {
    match state {
        OperationState::Replacement(state) => {
            state.phase == Phase::Discarded && state.error.is_none()
        }
        _ => false,
    }
}

/// Release the retired record's owner when no surviving record names it. An
/// undecodable neighbour is treated as a reference: unreadable evidence never
/// authorizes removing ownership.
fn referenced(
    intents: &HashMap<String, CatalogIntent>,
    rows: &[super::super::journal::Record],
    retired: &str,
    lock: &LockIdentity,
) -> bool {
    intents
        .iter()
        .any(|(id, entry)| id != retired && entry.intent.lock == *lock)
        || rows
            .iter()
            .filter(|row| row.id != retired)
            .any(|row| match row.kind {
                RecordKind::Operation => intents
                    .get(&row.id)
                    .is_none_or(|entry| entry.intent.lock == *lock),
                RecordKind::Reservation => decode::<ReservationRecord>(&row.payload)
                    .map_or(true, |record| record.lock == *lock),
            })
}

fn retire_owner(
    inner: &mut Inner,
    owner: OperationLock,
    intents: &HashMap<String, CatalogIntent>,
    rows: &[super::super::journal::Record],
    retired: &str,
) -> Result<(), AppError> {
    if referenced(intents, rows, retired, &owner.identity) {
        return Ok(());
    }
    owner.retire(&inner.locks).map_err(AppError::from)
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_record_retirement.rs"]
mod tests;
