//! Pure retention policy for durable recovery artifacts (ADR 0023).
//!
//! Nothing here performs filesystem work or grants cleanup authority. It
//! answers three questions from durable evidence alone: what a record retains,
//! whether that artifact may be removed automatically or only by an explicit
//! user decision, and whether retention is within its storage budget.

use super::model::{OperationSpec, OperationState, Phase};
use serde::Serialize;

/// Names of the private children an artifact root may hold. Both are removed
/// by retirement; only one of them exists in a settled retention phase.
pub(super) const ORIGINAL: &str = "original";
pub(super) const PUBLICATION: &str = "publication";

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

/// Which private child a settled record is currently holding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Retained {
    /// The displaced original of a completed overwrite: the only known copy of
    /// the previous content. Explicit user discard only.
    Original,
    /// The independent copy parked by a completed restoration. Automatically
    /// retirable only while its recorded source is verifiably intact.
    Publication,
}

impl Retained {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Original => ORIGINAL,
            Self::Publication => PUBLICATION,
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

/// The retention position of one durable record, derived from evidence only.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Retention {
    /// A settled record holding user bytes.
    Settled {
        retained: Retained,
        disposal: Disposal,
    },
    /// Retirement was journaled but has not completed. Resumable.
    Retiring,
    /// Removal completed; only the record itself remains.
    Residue,
    /// An interrupted, errored or unsupported record. Never retired.
    Unresolved,
}

impl Retention {
    pub(super) fn settled(self) -> Option<(Retained, Disposal)> {
        match self {
            Self::Settled { retained, disposal } => Some((retained, disposal)),
            _ => None,
        }
    }

    /// Only a settled or interrupted retirement has artifacts to remove.
    pub(super) fn retirable(self) -> bool {
        matches!(self, Self::Settled { .. } | Self::Retiring | Self::Residue)
    }
}

/// Retention dispatches on operation kind. A kind without a plan is listed and
/// reported, never retired, so new kinds (Move, #685) are safe by default.
pub(super) fn retention(operation: &OperationSpec, state: &OperationState) -> Retention {
    match (operation, state) {
        (OperationSpec::CopyReplacement(_), OperationState::Replacement(state)) => {
            if state.error.is_some() {
                // Unverified evidence: an error is a reason to preserve, never
                // a reason to remove. A retirement already under way still
                // reports its error while remaining resumable.
                return match state.phase {
                    Phase::DiscardIntent => Retention::Retiring,
                    Phase::Discarded => Retention::Residue,
                    _ => Retention::Unresolved,
                };
            }
            match state.phase {
                Phase::Published => Retention::Settled {
                    retained: Retained::Original,
                    disposal: Disposal::ExplicitOnly,
                },
                Phase::Restored => Retention::Settled {
                    retained: Retained::Publication,
                    disposal: Disposal::AutomaticWhenSourceIntact,
                },
                Phase::DiscardIntent => Retention::Retiring,
                Phase::Discarded => Retention::Residue,
                _ => Retention::Unresolved,
            }
        }
        _ => Retention::Unresolved,
    }
}

/// The measured size a record contributes, or `None` when it has not been
/// measured yet. An unmeasured record is never reported as empty.
pub(super) fn measured_bytes(state: &OperationState) -> Option<u64> {
    match state {
        OperationState::Replacement(state) => state.retained_bytes,
        _ => None,
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
        if retention.settled().is_some() {
            self.discardable += 1;
        }
        match bytes {
            Some(bytes) => self.bytes = self.bytes.saturating_add(bytes),
            None if retention.settled().is_some() => self.unmeasured += 1,
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
