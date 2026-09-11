//! Bounded index/catalog discovery. This never probes user-volume paths or
//! reclaims owners; an inventory entry is not permission to perform recovery.
use super::*;

pub(in crate::files::recovery) struct Inventory {
    pub revision: u64,
    pub entries: Vec<InventoryEntry>,
}

pub(in crate::files::recovery) struct InventoryEntry {
    pub intent: DurableIntent,
    /// Catalog-only evidence must remain visible without inventing a checkpoint.
    pub generation: Option<u64>,
    /// The validated checkpoint state, retained so retention policy can be
    /// evaluated without claiming ownership of every record (ADR 0023).
    pub state: Option<super::super::model::OperationState>,
    /// Immutable evidence digest, required to retire catalog-only residue.
    pub digest: [u8; 32],
}

impl Coordinator {
    pub(in crate::files::recovery) fn inventory(&self) -> Result<Inventory, AppError> {
        self.admitted(|inner| {
            let intents = decode_catalog(&inner.catalog.records()?, &inner.protected)?;
            let rows = inner.journal.records()?;
            let mut checkpoints = HashMap::new();
            for row in &rows {
                match row.kind {
                    RecordKind::Operation => {
                        let checkpoint = decode_checkpoint(row, &intents)?;
                        checkpoints.insert(row.id.clone(), (row.generation, checkpoint.state));
                    }
                    RecordKind::Reservation => {
                        let reservation: ReservationRecord = decode(&row.payload)?;
                        validate_reservation(&row.id, &reservation)?;
                    }
                }
            }
            let mut entries: Vec<_> = intents
                .into_values()
                .map(|entry| {
                    let checkpoint = checkpoints.remove(&entry.intent.id);
                    InventoryEntry {
                        generation: checkpoint.as_ref().map(|(generation, _)| *generation),
                        state: checkpoint.map(|(_, state)| state),
                        digest: entry.digest,
                        intent: entry.intent,
                    }
                })
                .collect();
            entries.sort_by(|left, right| left.intent.id.cmp(&right.intent.id));
            Ok(Inventory {
                revision: inner.journal.revision()?,
                entries,
            })
        })
    }
}

#[cfg(test)]
#[path = "../../../../test_support/recovery_inventory.rs"]
mod tests;
