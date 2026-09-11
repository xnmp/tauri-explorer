//! Crash-safe retirement of durable recovery artifacts (ADR 0023).
//!
//! Intent precedes every effect and completion follows every barrier, so a
//! process killed at any checkpoint resumes from durable evidence alone. No
//! step here decides policy: eligibility comes from `retention`, and the only
//! bytes ever removed live inside an identity-verified private artifact root.

use super::{
    coordinator::{Coordinator, DurableOperation},
    model::{OperationSpec, OperationState, StagedPayload},
    replacement_artifact::{Anchor, RetirementStep, Root},
    replacement_transition::ReplacementTransition,
    retention::{measured_bytes, retention, Disposal, Retained, Retention, Usage},
};
use crate::error::AppError;
use std::sync::Arc;

/// What the observed record permits. `Preserved` always carries a reason the
/// user can read; it is never a silent refusal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Eligibility {
    /// An explicit user discard may proceed; automatic retirement may not.
    Discardable,
    /// Provably redundant: automatic retirement may reclaim it.
    Automatic,
    /// A journaled retirement to finish. The decision is already committed.
    Resume,
    /// Evidence is preserved; nothing was removed.
    Preserved(String),
}

impl Eligibility {
    fn preserved(reason: &str) -> Self {
        Self::Preserved(reason.to_owned())
    }
}

pub(super) struct Retirement {
    operation: DurableOperation,
    retention: Retention,
    root: Option<Root>,
    eligibility: Eligibility,
}

impl Retirement {
    /// Reopen an already-claimed record tolerantly: retirement legitimately
    /// runs after its artifact root is gone, unlike replacement execution.
    pub(super) fn open(operation: DurableOperation) -> Result<Self, AppError> {
        let retention = retention(&operation.intent().operation, operation.state());
        if !retention.retirable() {
            return Ok(Self {
                operation,
                retention,
                root: None,
                eligibility: Eligibility::preserved(
                    "This record still needs recovery; nothing is retired while it is unresolved",
                ),
            });
        }
        let root = match root_identity(operation.state()) {
            Some(identity) => Anchor::open(operation.intent())?.open_optional(identity)?,
            None => None,
        };
        let eligibility = classify(&operation, &retention, root.as_ref())?;
        Ok(Self {
            operation,
            retention,
            root,
            eligibility,
        })
    }

    pub(super) fn eligibility(&self) -> &Eligibility {
        &self.eligibility
    }

    pub(super) fn generation(&self) -> u64 {
        self.operation.generation()
    }

    pub(super) fn state(&self) -> &OperationState {
        self.operation.state()
    }

    /// Record the measured size of a settled artifact. Accounting only: it
    /// grants no cleanup authority and never advances the retention phase.
    pub(super) fn measure(&mut self) -> Result<Option<u64>, AppError> {
        let Some((retained, _)) = self.retention.settled() else {
            return Ok(None);
        };
        if measured_bytes(self.operation.state()).is_some() {
            return Ok(measured_bytes(self.operation.state()));
        }
        let Some(root) = &self.root else {
            return Ok(None);
        };
        let Some(bytes) = root.measure_retained(retained)? else {
            return Ok(None);
        };
        self.operation
            .advance(ReplacementTransition::RetentionMeasured(bytes))?;
        Ok(Some(bytes))
    }

    /// Run the complete journaled machine. Idempotent at every checkpoint.
    pub(super) fn retire(self) -> Result<(), AppError> {
        self.retire_with(|_| Ok(()))
    }

    fn retire_with(
        mut self,
        mut checkpoint: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if let Eligibility::Preserved(reason) = &self.eligibility {
            return Err(AppError::Other(reason.clone()));
        }
        // Durable intent first: nothing has been removed at this point, so a
        // failure or crash here leaves every artifact and the record intact.
        self.operation
            .advance(ReplacementTransition::BeginDiscard)?;
        if let Err(error) = checkpoint("intent") {
            return Err(self.retain_failure(error));
        }
        if let Some(root) = self.root.take() {
            // Journaling the intent took the admission gate, so the live
            // endpoint could have changed since it was classified. Re-observe
            // it against the retained artifact immediately before unlinking;
            // an artifact already gone is a completed step, a changed endpoint
            // preserves everything.
            if let Err(error) = self.reconfirm(&root) {
                self.root = Some(root);
                return Err(self.retain_failure(error));
            }
            if let Err(error) = root.retire_artifacts() {
                return Err(self.retain_failure(error));
            }
        }
        if let Err(error) = checkpoint("removed") {
            return Err(self.retain_failure(error));
        }
        // Completion follows the removal's directory barriers. A disk-full
        // failure here keeps `DiscardIntent`, which the tolerant reopen
        // resumes; the record is never lost.
        self.operation
            .advance(ReplacementTransition::DiscardCompleted)?;
        if let Err(error) = checkpoint("completed") {
            return Err(self.retain_failure(error));
        }
        self.operation.retire_record()
    }

    /// The last observation before anything is removed. A settled record must
    /// still show its live endpoint independently holding the payload; a
    /// journaled retirement being resumed must show that its artifacts are
    /// already partly gone, or that removal is still safe.
    fn reconfirm(&self, root: &Root) -> Result<(), AppError> {
        let Some(staged) = staged_payload(self.operation.state()) else {
            return Ok(());
        };
        let intent = self.operation.intent();
        let candidates = match self.retention.settled() {
            Some((retained, _)) => vec![retained],
            None => vec![Retained::Original, Retained::Publication],
        };
        for retained in candidates {
            match root.retirement_step(intent, staged, retained)? {
                RetirementStep::Remove | RetirementStep::Removed => return Ok(()),
                RetirementStep::Conflict => {}
            }
        }
        // A resumed retirement that has already destroyed its retained artifact
        // has nothing left to protect; only an untouched one may be refused.
        if self.retention.settled().is_none() && !root.retained_intact(intent, staged)? {
            return Ok(());
        }
        Err(AppError::Other(
            "The published entry no longer matches the recorded operation; all retained files are preserved".into(),
        ))
    }

    /// A cleanup failure is reportable inventory, never a completed retirement.
    fn retain_failure(&mut self, error: AppError) -> AppError {
        let mut message = error.to_string();
        if message.len() > super::model::MAX_ERROR_BYTES {
            let mut end = super::model::MAX_ERROR_BYTES;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        if let Err(persistence) = self
            .operation
            .advance(ReplacementTransition::ReportError(message))
        {
            log::warn!("Could not persist recovery retirement failure: {persistence}");
        }
        error
    }
}

fn root_identity(state: &OperationState) -> Option<super::model::ObjectId> {
    match state {
        OperationState::Replacement(state) => state.root,
        _ => None,
    }
}

fn staged_payload(state: &OperationState) -> Option<&StagedPayload> {
    match state {
        OperationState::Replacement(state) => state.published.as_ref(),
        _ => None,
    }
}

fn classify(
    operation: &DurableOperation,
    retention: &Retention,
    root: Option<&Root>,
) -> Result<Eligibility, AppError> {
    let Some((retained, disposal)) = retention.settled() else {
        // Retirement is already journaled. The user's decision is committed,
        // so a partially removed artifact must not block its own completion —
        // unless nothing has been removed yet and the live payload is gone.
        if let (Some(root), Some(staged)) = (root, staged_payload(operation.state())) {
            let held = matches!(*retention, Retention::Retiring)
                && root.retirement_step(operation.intent(), staged, Retained::Original)?
                    == RetirementStep::Conflict
                && root.retirement_step(operation.intent(), staged, Retained::Publication)?
                    == RetirementStep::Conflict
                && root.retained_intact(operation.intent(), staged)?;
            if held {
                return Ok(Eligibility::preserved(
                    "Retirement was interrupted before removing anything and the published entry no longer matches; all evidence is preserved",
                ));
            }
        }
        return Ok(Eligibility::Resume);
    };
    let Some(root) = root else {
        return Ok(Eligibility::preserved(
            "The retained recovery files are missing; this record is preserved for inspection",
        ));
    };
    let Some(staged) = staged_payload(operation.state()) else {
        return Ok(Eligibility::preserved(
            "This record has no staged evidence; all files are preserved",
        ));
    };
    match root.retirement_step(operation.intent(), staged, retained)? {
        RetirementStep::Remove => Ok(match disposal {
            // Removing this destroys the only known copy of the previous
            // content, so only an explicit user decision may authorize it.
            Disposal::ExplicitOnly => Eligibility::Discardable,
            Disposal::AutomaticWhenSourceIntact => {
                if root.source_intact(operation.intent()) {
                    Eligibility::Automatic
                } else {
                    Eligibility::Discardable
                }
            }
        }),
        RetirementStep::Removed => Ok(Eligibility::preserved(
            "The retained recovery files are missing; this record is preserved for inspection",
        )),
        RetirementStep::Conflict => Ok(Eligibility::preserved(
            "The recorded entries no longer match; all files are preserved for inspection",
        )),
    }
}

/// One bounded enforcement pass. Called only from recovery-session activity or
/// immediately after a record is created — never from application startup.
///
/// Records are examined from durable evidence first; only a record that needs
/// measuring or is actually eligible for retirement is claimed, so an ordinary
/// listing neither advances generations nor probes user volumes.
pub(super) fn enforce(coordinator: &Arc<Coordinator>) -> Result<Usage, AppError> {
    let mut usage = Usage::default();
    let entries = coordinator.inventory()?.entries;
    // Catalog order. Record ids are random, so this is not an age order and
    // nothing here may depend on one; every record is examined independently.
    for entry in entries {
        let Some(generation) = entry.generation else {
            // Catalog-only residue is retirable exactly when its artifact root
            // is verifiably absent; otherwise it stays visible for inspection.
            if orphan_root_absent(&entry.intent).unwrap_or(false)
                && coordinator
                    .retire_orphan_catalog(&entry.intent.id, entry.digest)
                    .is_ok()
            {
                continue;
            }
            usage.add(Retention::Unresolved, None, true);
            continue;
        };
        let Some(state) = entry.state else {
            usage.add(Retention::Unresolved, None, true);
            continue;
        };
        let position = retention(&entry.intent.operation, &state);
        let bytes = measured_bytes(&state);
        if matches!(position, Retention::Unsupported) {
            // Measured, counted, never claimed and never retired.
            match measure_unsupported(&entry.intent, &state) {
                Ok(measured) => usage.add(position, measured, true),
                Err(error) => {
                    log::debug!(
                        "Recovery retention could not measure {}: {error}",
                        entry.intent.id
                    );
                    usage.add(position, None, false);
                }
            }
            continue;
        }
        if !position.retirable() {
            usage.add(position, bytes, true);
            continue;
        }
        // A settled record is claimed only when ownership can actually
        // accomplish something: journal a first measurement, or reclaim a
        // redundant artifact. Claiming advances the generation, which
        // invalidates the generation the user is looking at, so a record with
        // nothing to do must never be claimed by an enforcement pass.
        if position.settled().is_some() {
            if bytes.is_some() {
                usage.add(position, bytes, true);
                continue;
            }
            match artifact_present(&entry.intent, &state) {
                // Nothing to measure and nothing to remove.
                Ok(false) => {
                    usage.add(position, None, true);
                    continue;
                }
                // The volume or artifact parent could not be observed.
                Err(error) => {
                    log::debug!("Recovery retention could not observe {}: {error}", entry.intent.id);
                    usage.add(position, None, false);
                    continue;
                }
                Ok(true) => {}
            }
        }
        match settle(coordinator, &entry.intent.id, generation) {
            // A reclaimed record holds nothing and is no longer in the catalog.
            Ok(Settled::Retired) => continue,
            Ok(Settled::Counted(position, bytes, available)) => usage.add(position, bytes, available),
            Ok(Settled::Busy) => usage.add(position, bytes, true),
            // A busy or changed record is neither lost nor reclaimable now.
            Err(error) => {
                log::debug!("Recovery retention pass skipped {}: {error}", entry.intent.id);
                usage.add(position, bytes, false);
            }
        }
    }
    Ok(usage)
}

/// The outcome of examining one claimed record during an enforcement pass.
enum Settled {
    /// Reclaimed: the record and its artifacts are gone.
    Retired,
    /// Owned by another worker right now.
    Busy,
    Counted(Retention, Option<u64>, bool),
}

/// Claim one record, measure it, and finish any retirement it is already
/// committed to. Returns the settled accounting for that record.
fn settle(coordinator: &Arc<Coordinator>, id: &str, generation: u64) -> Result<Settled, AppError> {
    let Some(operation) = coordinator.try_claim(id, generation)? else {
        return Ok(Settled::Busy);
    };
    let mut retirement = match Retirement::open(operation) {
        Ok(retirement) => retirement,
        // A missing volume or unreadable parent is unavailable, not disposable.
        Err(error) => {
            log::debug!("Recovery retention could not observe {id}: {error}");
            return Ok(Settled::Counted(Retention::Unresolved, None, false));
        }
    };
    match retirement.eligibility() {
        // Automatic retirement only ever reclaims a provably redundant copy,
        // or finishes a retirement whose decision is already committed.
        Eligibility::Automatic | Eligibility::Resume => {
            retirement.retire()?;
            Ok(Settled::Retired)
        }
        _ => {
            let bytes = retirement.measure()?;
            Ok(Settled::Counted(retirement.retention, bytes, true))
        }
    }
}

/// Read-only measurement of every artifact root a record retains when its
/// operation kind has no retirement plan yet (durable moves, #685). Ownership
/// is never claimed and nothing is journaled, so the bytes are recomputed on
/// each pass instead of being cached on a checkpoint — the record still counts
/// against both bounds even though nothing may remove it.
fn measure_unsupported(
    intent: &super::model::DurableIntent,
    state: &OperationState,
) -> Result<Option<u64>, AppError> {
    let (OperationSpec::Move(spec), OperationState::Move(move_state)) =
        (&intent.operation, state)
    else {
        return Ok(None);
    };
    let mut total = 0u64;
    for (is_source, plan) in super::move_execution::MoveExecution::plans(spec) {
        let identity = if is_source {
            move_state.source_root
        } else {
            move_state.target_root
        };
        let Some(identity) = identity else { continue };
        let Some(root) = Anchor::open_plan(intent, plan)?.open_optional(identity)? else {
            continue;
        };
        let Some(bytes) = root.measure_all()? else {
            return Ok(None);
        };
        total = total.saturating_add(bytes);
    }
    Ok(Some(total))
}

/// Read-only observation outside admission and without ownership: is the
/// recorded artifact root still there? Used to decide whether claiming a
/// settled record could accomplish anything at all.
fn artifact_present(
    intent: &super::model::DurableIntent,
    state: &OperationState,
) -> Result<bool, AppError> {
    let Some(identity) = root_identity(state) else {
        return Ok(false);
    };
    Ok(Anchor::open(intent)?.open_optional(identity)?.is_some())
}

/// Read-only observation outside admission: does the recorded artifact root
/// exist? An unreadable parent answers `Err`, never "absent".
fn orphan_root_absent(intent: &super::model::DurableIntent) -> Result<bool, AppError> {
    let identity = match &intent.operation {
        super::model::OperationSpec::CopyReplacement(spec) => spec,
        _ => return Ok(false),
    };
    let parent = crate::files::native_directory::Directory::open(
        identity
            .root
            .0
            .parent()
            .ok_or_else(|| AppError::Other("Recovery artifact root has no parent".into()))?,
    )?;
    if crate::files::file_identity::of_file(&parent.file)? != identity.parent {
        return Err(AppError::Other(
            "Recovery artifact parent identity changed".into(),
        ));
    }
    let name = identity
        .root
        .0
        .file_name()
        .ok_or_else(|| AppError::Other("Recovery artifact root has no name".into()))?;
    Ok(!parent.entry_exists(name)?)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_retirement.rs"]
mod tests;
