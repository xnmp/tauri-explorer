//! Pure retention policy for durable recovery artifacts (ADR 0023).
//!
//! Nothing here performs filesystem work or grants cleanup authority. It
//! answers three questions from durable evidence alone: what a record retains,
//! whether that artifact may be removed automatically or only by an explicit
//! user decision, and whether retention is within its storage budget.

use serde::Serialize;

/// Kept at or below the catalog's 1,024-record cap so retention policy fails
/// before catalog exhaustion and can explain itself to the user.
pub(super) const DEFAULT_RECORD_BUDGET: usize = 256;
pub(super) const DEFAULT_BYTE_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
const MAX_RECORD_BUDGET: usize = super::journal::MAX_RECORDS;
const MAX_BYTE_BUDGET: u64 = 1024 * 1024 * 1024 * 1024;

const BYTE_BUDGET_KEY: &str = "recoveryRetainedBytesBudget";
const RECORD_BUDGET_KEY: &str = "recoveryRetainedRecordBudget";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Budget {
    pub bytes: u64,
    pub records: usize,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            bytes: DEFAULT_BYTE_BUDGET,
            records: DEFAULT_RECORD_BUDGET,
        }
    }
}

impl Budget {
    /// Read the two optional settings values. An absent, malformed or
    /// out-of-range value falls back to its default rather than removing the
    /// bound: a broken settings file must not disable retention accounting.
    pub(super) fn from_settings(settings: &serde_json::Value) -> Self {
        let default = Self::default();
        Self {
            bytes: settings
                .get(BYTE_BUDGET_KEY)
                .and_then(serde_json::Value::as_u64)
                .filter(|bytes| *bytes > 0 && *bytes <= MAX_BYTE_BUDGET)
                .unwrap_or(default.bytes),
            records: settings
                .get(RECORD_BUDGET_KEY)
                .and_then(serde_json::Value::as_u64)
                .and_then(|records| usize::try_from(records).ok())
                .filter(|records| *records > 0 && *records <= MAX_RECORD_BUDGET)
                .unwrap_or(default.records),
        }
    }
}

/// How a retained artifact may be disposed of.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Disposal {
    /// Destroying this artifact destroys the only known copy of its content.
    ExplicitOnly,
    /// Redundant once its recorded source is observed intact.
    AutomaticWhenSourceIntact,
}

/// The retention position of one durable record, derived from evidence only
/// by `Checkpoint::retention`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Retention {
    /// A settled record holding its own inverse and any retained bytes.
    Settled { disposal: Disposal },
    /// Retirement was journaled but has not completed. Resumable.
    Retiring,
    /// Removal completed; only the record itself remains.
    Residue,
    /// An interrupted or errored record. Never retired.
    Unresolved,
}

impl Retention {
    pub(super) fn settled(self) -> bool {
        matches!(self, Self::Settled { .. })
    }

    /// Only a settled or interrupted retirement has artifacts to remove.
    pub(super) fn retirable(self) -> bool {
        !matches!(self, Self::Unresolved)
    }
}

/// Aggregated retention across the whole bounded catalog.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Usage {
    /// Records holding, or believed to hold, private artifacts.
    pub records: usize,
    /// Total measured bytes across those records.
    pub bytes: u64,
    /// Settled records whose size has not been measured yet.
    pub unmeasured: usize,
    /// Records whose volume or artifact root could not be observed.
    pub unavailable: usize,
    /// Settled records whose retained artifact may be offered for discard.
    /// The native discard still re-verifies the live endpoint before removing
    /// anything, so this is an upper bound, not a promise.
    pub discardable: usize,
}

impl Usage {
    pub(super) fn add(&mut self, retention: Retention, bytes: Option<u64>, available: bool) {
        // Every durable record occupies the record bound, retirable or not: an
        // unresolved record retains artifacts too, and the bound exists so
        // retention policy refuses new work before the catalog exhausts itself
        // with an unexplained "catalog is full".
        self.records += 1;
        if !available {
            self.unavailable += 1;
            return;
        }
        if retention.settled() {
            self.discardable += 1;
        }
        match bytes {
            Some(bytes) => self.bytes = self.bytes.saturating_add(bytes),
            None if retention.settled() || retention == Retention::Retiring => self.unmeasured += 1,
            None => {}
        }
    }

    /// Retention is at capacity when either bound is reached. Unmeasured
    /// records cannot lower the count bound, so a record that has never been
    /// measured still consumes capacity.
    pub(super) fn at_capacity(&self, budget: &Budget) -> bool {
        self.records >= budget.records || self.bytes >= budget.bytes
    }
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_retention.rs"]
mod tests;
