//! Crash-safe retirement of durable recovery artifacts (ADR 0023, ADR 0026).
//!
//! One journaled lifecycle serves every kind. Intent precedes every effect and
//! completion follows every barrier, so a process killed at any checkpoint
//! resumes from durable evidence alone. Policy comes from the checkpoint
//! engine; public endpoints are only read, and the only bytes ever removed are
//! the planned descendants of an identity-verified private artifact root.
use super::{
    checkpoint::{Decision, Endpoint, Side, State, Step},
    coordinator::{Coordinator, DurableOperation},
    model::{DurableIntent, EntryVersion},
    move_cleanup::Plan,
    replacement_artifact::{Anchor, Root},
    retention::{Disposal, Retention, Usage},
};
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_at},
        native_directory::Directory,
    },
};
use std::{io, sync::Arc};

/// Journal bytes a new discard decision must leave free: the most its cleanup
/// plans can occupy together until it completes (ADR 0023).
const RETIREMENT_HEADROOM: usize = super::move_cleanup::DECISION_BYTES;

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

/// One claimed record's retirement: its observed roots beside each endpoint
/// and what that evidence permits.
pub(super) struct Retirement {
    pub(super) operation: DurableOperation,
    roots: Vec<(Side, Option<Root>)>,
    eligibility: Eligibility,
    headroom: usize,
}

impl Retirement {
    /// Reopen an already-claimed record tolerantly: retirement legitimately
    /// runs after an artifact root is gone, unlike execution.
    pub(super) fn open(operation: DurableOperation) -> Result<Self, AppError> {
        let intent = operation.intent();
        let state = operation.state();
        let Some(policy) = intent.checkpoint(state).disposal() else {
            return Ok(Self::preserved(
                operation,
                "This record still needs recovery; all evidence is preserved",
            ));
        };
        let mut roots = Vec::new();
        for side in planned(intent) {
            let identity = (*state.roots.get(side))
                .ok_or_else(|| invalid("Recovery artifact identity is missing"))?;
            roots.push((side, Anchor::open(intent, side)?.open_optional(identity)?));
        }
        let eligibility = if state.error.is_some() && state.retirement.is_none() {
            Eligibility::Preserved(
                "This record needs recovery; retained bytes are still accounted".into(),
            )
        } else if state.retirement.is_some() {
            Eligibility::Resume
        } else if policy == Disposal::AutomaticWhenSourceIntact && witnessed(intent) {
            Eligibility::Automatic
        } else {
            // Removing it may destroy the only known copy of some content, so
            // only an explicit user decision may authorize it.
            Eligibility::Discardable
        };
        let mut result = Self {
            operation,
            roots,
            eligibility,
            headroom: RETIREMENT_HEADROOM,
        };
        if let Err(error) = result.verify() {
            // An interrupted decision that removed nothing resumes only to
            // withdraw itself on its post-intent verification (below).
            if result.untouched() {
                return Ok(result);
            }
            result.eligibility = Eligibility::Preserved(if result.retiring() {
                format!(
                    "Discard stopped before finishing; its Undo history is gone and the \
                     remaining recovery files are preserved: {error}"
                )
            } else {
                error.to_string()
            });
        }
        Ok(result)
    }

    fn preserved(operation: DurableOperation, reason: &str) -> Self {
        Self {
            operation,
            roots: vec![],
            eligibility: Eligibility::Preserved(reason.into()),
            headroom: RETIREMENT_HEADROOM,
        }
    }

    /// Test seam: the journal headroom a new decision must leave free.
    #[cfg(all(test, target_os = "linux"))]
    fn leaving(mut self, headroom: usize) -> Self {
        self.headroom = headroom;
        self
    }

    pub(super) fn eligibility(&self) -> &Eligibility {
        &self.eligibility
    }

    pub(super) fn state(&self) -> &State {
        self.operation.state()
    }

    pub(super) fn position(&self) -> Retention {
        self.operation.intent().checkpoint(self.state()).retention()
    }

    fn retiring(&self) -> bool {
        self.state().retirement.is_some()
    }

    fn step(&self, side: Side) -> Option<Step> {
        self.state()
            .retirement
            .as_ref()?
            .steps
            .get(side)
            .as_ref()
            .copied()
    }

    fn plan(&self, side: Side) -> Option<&Plan> {
        self.state().retirement.as_ref()?.plans.get(side).as_ref()
    }

    fn expected(&self, side: Side) -> Result<Option<(&'static str, Vec<EntryVersion>)>, AppError> {
        Ok(self
            .operation
            .intent()
            .checkpoint(self.state())
            .expected_payload(side)?)
    }

    /// Observation that a journaled decision has removed nothing yet: no root
    /// is retired and every root still strictly matches its captured plan,
    /// manifest and exact payload version.
    fn untouched(&self) -> bool {
        let Some(retirement) = self.state().retirement.as_ref() else {
            return false;
        };
        !retirement.completed
            && self.roots.iter().all(|(side, root)| {
                self.step(*side) != Some(Step::Removed)
                    && root.as_ref().is_some_and(|root| {
                        self.expected(*side).is_ok_and(|expected| {
                            root.verify_retirement(
                                self.operation.intent(),
                                expected.as_ref(),
                                self.plan(*side),
                                false,
                            )
                            .is_ok()
                        })
                    })
            })
    }

    /// A verification refusal after the decision is journaled but before any
    /// unlink withdraws that decision rather than consuming Undo for nothing.
    fn refuse(&mut self, error: AppError) -> AppError {
        if !self.untouched() {
            return error;
        }
        match self
            .operation
            .advance(super::checkpoint::Event::WithdrawRetirement)
        {
            Ok(()) => invalid(&format!(
                "{error}. Discard was withdrawn before removing anything; Undo and every \
                 recovery file are kept"
            )),
            Err(persistence) => {
                log::warn!("Could not withdraw recovery retirement: {persistence}");
                error
            }
        }
    }

    /// Every public endpoint must still show what the settled record left
    /// there, or retiring its artifacts could destroy the only copy.
    fn verify_public(&self) -> Result<(), AppError> {
        let kind = self.operation.intent().operation.kind();
        for endpoint in kind.endpoints(self.state())? {
            if !holds(&endpoint)? {
                return Err(invalid(
                    "The recorded entries no longer match their locations; retained recovery \
                     files are preserved",
                ));
            }
        }
        Ok(())
    }

    fn verify(&self) -> Result<(), AppError> {
        self.verify_against(|side| self.plan(side))
    }

    /// Verify endpoints and roots against the cleanup plan `plan` names for
    /// each root: the journaled ones, or, before the decision, those just
    /// captured.
    fn verify_against<'plan>(
        &self,
        plan: impl Fn(Side) -> Option<&'plan Plan>,
    ) -> Result<(), AppError> {
        // A rootless record (a same-volume rename) retains nothing, so there is
        // nothing public-endpoint proof could protect: forgetting it removes no
        // file. Requiring exact endpoints would pin it forever after any edit.
        if self.roots.is_empty() {
            return Ok(());
        }
        let retiring = self.state().retirement.as_ref();
        let artifacts_gone = self.roots.iter().all(|(_, root)| root.is_none());
        if retiring.is_none() || (!artifacts_gone && !retiring.is_some_and(|state| state.completed))
        {
            self.verify_public()?;
        }
        for (side, root) in &self.roots {
            let step = self.step(*side);
            match (root, step) {
                (None, Some(Step::Removing | Step::Removed)) => {}
                (None, _) => {
                    return Err(invalid(
                        "Recovery artifact root is missing before its removal intent",
                    ))
                }
                (Some(_), Some(Step::Removed)) => {
                    return Err(invalid("A retired recovery artifact root reappeared"))
                }
                (Some(root), _) => root.verify_retirement(
                    self.operation.intent(),
                    self.expected(*side)?.as_ref(),
                    plan(*side),
                    step == Some(Step::Removing),
                )?,
            }
        }
        Ok(())
    }

    /// Record the measured size of a settled record's artifacts. Accounting
    /// only: it grants no cleanup authority and never advances the phase.
    pub(super) fn measure(&mut self) -> Result<Option<u64>, AppError> {
        if self.state().retained_bytes.is_some() {
            return Ok(self.state().retained_bytes);
        }
        if self
            .operation
            .intent()
            .checkpoint(self.state())
            .disposal()
            .is_none()
        {
            return Ok(None);
        }
        let mut bytes = 0u64;
        for (side, root) in &self.roots {
            if root.is_none() && !matches!(self.step(*side), Some(Step::Removing | Step::Removed)) {
                return Ok(None);
            }
            if let Some(root) = root {
                root.verify_namespace()?;
                let Some(size) = root.measure_payload()? else {
                    return Ok(None);
                };
                bytes = bytes.saturating_add(size);
            }
        }
        self.operation
            .advance(super::checkpoint::Event::RetentionMeasured(bytes))?;
        Ok(Some(bytes))
    }

    pub(super) fn retire(self) -> Result<(), AppError> {
        self.retire_with(|_| Ok(()))
    }

    pub(super) fn retire_with(
        mut self,
        mut checkpoint: impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        if let Eligibility::Preserved(reason) = &self.eligibility {
            return Err(invalid(reason));
        }
        if let Err(error) = self.remove(&mut checkpoint) {
            if !self.retiring() {
                // A read-only preflight failure did not consume the inverse.
                if self.eligibility == Eligibility::Automatic {
                    self.defer(&error.to_string());
                }
                return Err(error);
            }
            self.report(&error.to_string());
            return Err(error);
        }
        self.operation.retire_record()
    }

    /// Record why an automatic discard could not be journaled, and its size,
    /// so enforcement leaves it for an explicit retry instead of claiming it
    /// again on every pass (ADR 0023). Nothing was removed and Undo is kept.
    fn defer(&mut self, reason: &str) {
        if let Err(persistence) = self
            .operation
            .advance(super::checkpoint::Event::DeferRetirement(
                super::model::bounded_error(reason.to_owned()),
            ))
        {
            log::warn!("Could not persist a deferred recovery cleanup: {persistence}");
            return;
        }
        if let Err(error) = self.measure() {
            log::debug!("Deferred recovery cleanup could not be measured: {error}");
        }
    }

    /// Record why a journaled retirement stopped. A reported failure waits
    /// for an explicit retry; enforcement never claims it again (ADR 0023).
    pub(super) fn report(&mut self, reason: &str) {
        self.operation
            .retain_failure(AppError::Other(reason.to_owned()));
    }

    /// Capture every root's plan before the global decision and persist them
    /// together. Restart must not adopt new descendants in a later root;
    /// neither may it discover an unrepresentable target after removing source.
    fn plans(&self) -> Result<Vec<Option<Plan>>, AppError> {
        self.roots
            .iter()
            .map(|(side, root)| {
                if self.step(*side) == Some(Step::Removed) {
                    return Ok(None);
                }
                if let Some(plan) = self.plan(*side) {
                    return Ok(Some(plan.clone()));
                }
                let root = root
                    .as_ref()
                    .ok_or_else(|| invalid("Recovery root vanished before cleanup planning"))?;
                root.plan_retirement(self.operation.intent(), self.expected(*side)?.as_ref())
                    .map(Some)
            })
            .collect()
    }

    fn remove(
        &mut self,
        checkpoint: &mut impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let fresh = !self.retiring();
        let decision = match (&self.state().retirement, &self.eligibility) {
            (Some(retirement), _) => retirement.decision,
            (None, Eligibility::Automatic) => Decision::Automatic,
            (None, _) => Decision::Explicit,
        };
        let plans = self.plans()?;
        // Before the decision consumes Undo: a cleanup this user cannot
        // perform must be refused while nothing is journaled or removed.
        for ((_, root), plan) in self.roots.iter().zip(&plans) {
            if let (Some(root), Some(plan)) = (root, plan) {
                root.preflight_retirement(plan)?;
            }
        }
        checkpoint("planned")?;
        let planned = |side| {
            self.roots
                .iter()
                .position(|(candidate, _)| *candidate == side)
                .and_then(|index| plans[index].as_ref())
        };
        // The last read-only proof before the decision consumes Undo, of
        // exactly what verification after it repeats: public endpoints, each
        // root's namespace and manifest, and every captured plan. Planning a
        // large tree takes time in which any of them can change. The
        // post-decision withdrawal cannot cover this: it proves the decision
        // removed nothing by matching each root against its plan, so a root
        // that drifted from its plan during planning would keep a decision
        // that can never finish, and with it consume Undo (#760).
        if fresh {
            self.verify_against(planned)?;
        }
        // A decision holds its plans in the journal until it completes; one
        // that could never finish must not starve every later operation.
        let event = super::checkpoint::Event::BeginRetirement(
            decision,
            super::checkpoint::Sides {
                source: planned(Side::Source).cloned(),
                target: planned(Side::Target).cloned(),
            },
        );
        if !self.operation.advance_leaving(event, self.headroom)? {
            return Err(invalid(
                "File Recovery is holding too many unfinished discards to record another. \
                 Finish or forget one of them first; nothing was removed and Undo is kept",
            ));
        }
        checkpoint("intent")?;
        if let Err(error) = self.verify() {
            return Err(self.refuse(error));
        }
        for (index, plan) in plans.iter().enumerate() {
            let side = self.roots[index].0;
            if self.step(side) != Some(Step::Removed) {
                let plan = plan
                    .as_ref()
                    .ok_or_else(|| invalid("Recovery root has no preflighted cleanup plan"))?;
                self.remove_root(index, plan, checkpoint)?;
            }
        }
        self.operation
            .advance(super::checkpoint::Event::RetirementCompleted)?;
        checkpoint("completed")
    }

    /// One root's own intent, removal and completion.
    fn remove_root(
        &mut self,
        index: usize,
        plan: &Plan,
        checkpoint: &mut impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        use super::checkpoint::Event::{BeginRootRetirement, RootRetired};
        let side = self.roots[index].0;
        let label = |source, target| match side {
            Side::Source => source,
            Side::Target => target,
        };
        self.operation.advance(BeginRootRetirement(side))?;
        checkpoint(label("source-intent", "target-intent"))?;
        // Re-observe every public endpoint after journaling, before touching this root.
        if self.roots[index].1.is_some() {
            if let Err(error) = self.verify_public() {
                return Err(self.refuse(error));
            }
        }
        if let Some(root) = self.roots[index].1.take() {
            root.retire_artifacts(
                self.operation.intent(),
                self.expected(side)?.as_ref(),
                plan,
                checkpoint,
            )?;
        }
        checkpoint(label("source-removed", "target-removed"))?;
        self.operation.advance(RootRetired(side))?;
        checkpoint(label("source-completed", "target-completed"))
    }
}

/// The sides whose private roots the immutable intent planned, source first.
fn planned(intent: &DurableIntent) -> impl Iterator<Item = Side> + '_ {
    [Side::Source, Side::Target]
        .into_iter()
        .filter(|side| intent.operation.kind().root(*side).is_some())
}

/// A kind's automatic disposal also requires its independent witness to hold.
/// Any doubt, including an unreadable parent, answers no.
fn witnessed(intent: &DurableIntent) -> bool {
    intent
        .operation
        .kind()
        .witness()
        .is_none_or(|witness| holds(&witness).unwrap_or(false))
}

/// Does the endpoint hold one of its recorded versions (or stay absent when
/// it records none)? A recorded parent identity must hold before and after.
fn holds(endpoint: &Endpoint) -> Result<bool, AppError> {
    let path = &endpoint.path.0;
    let parent_path = path
        .parent()
        .ok_or_else(|| invalid("Recovery endpoint has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| invalid("Recovery endpoint has no name"))?;
    let unchanged = |directory: &Directory| -> Result<(), AppError> {
        match endpoint.parent {
            Some(parent) if of_file(&directory.file)? != parent => {
                Err(invalid("Recovery endpoint parent identity changed"))
            }
            _ => Ok(()),
        }
    };
    let directory = Directory::open(parent_path)?;
    unchanged(&directory)?;
    let entry = match version_at(&directory, name) {
        Ok(version) => Some(version),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    unchanged(&Directory::open(parent_path)?)?;
    Ok(entry.map_or(endpoint.versions.is_empty(), |entry| {
        endpoint.versions.contains(&entry)
    }))
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
        let position = entry.intent.checkpoint(&state).retention();
        let bytes = state.retained_bytes;
        let observable = match unclaimed(&entry.intent, &state, position) {
            Some(observable) => observable,
            None => match settle(coordinator, &entry.intent.id, generation) {
                // A reclaimed record holds nothing and is no longer in the catalog.
                Ok(Settled::Retired) => continue,
                Ok(Settled::Counted(position, bytes, available)) => {
                    usage.add(position, bytes, available);
                    continue;
                }
                Ok(Settled::Busy) => true,
                // A busy or changed record is neither lost nor reclaimable now.
                Err(error) => {
                    log::debug!(
                        "Recovery retention pass skipped {}: {error}",
                        entry.intent.id
                    );
                    false
                }
            },
        };
        usage.add(position, bytes, observable);
    }
    Ok(usage)
}

/// Decide from durable evidence and read-only observation whether claiming
/// this record could accomplish anything. `Some(available)` leaves it
/// unclaimed: claiming advances the generation, which invalidates the
/// generation the user is looking at.
fn unclaimed(intent: &DurableIntent, state: &State, position: Retention) -> Option<bool> {
    // Only a crash-interrupted retirement resumes automatically. A reported
    // failure waits for the user's explicit retry, whether its decision was
    // journaled or an automatic one could not start.
    if !position.retirable() || state.awaits_retry() {
        return Some(true);
    }
    if position == Retention::Retiring {
        // One whose volume is away cannot progress.
        return anchors_observable(intent)
            .inspect_err(|error| {
                log::debug!(
                    "Recovery retirement could not observe {}: {error}",
                    intent.id
                )
            })
            .err()
            .map(|_| false);
    }
    // A settled record is claimed only to journal a first measurement or to
    // reclaim a redundant artifact.
    if position.settled() {
        if state.retained_bytes.is_some() {
            return Some(true);
        }
        return match artifact_present(intent, state) {
            // Nothing to measure and nothing to remove.
            Ok(false) => Some(true),
            Ok(true) => None,
            // The volume or artifact parent could not be observed.
            Err(error) => {
                log::debug!(
                    "Recovery retention could not observe {}: {error}",
                    intent.id
                );
                Some(false)
            }
        };
    }
    None
}

/// The outcome of examining one claimed record during an enforcement pass.
pub(super) enum Settled {
    /// Reclaimed: the record and its artifacts are gone.
    Retired,
    /// Owned by another worker right now.
    Busy,
    Counted(Retention, Option<u64>, bool),
}

/// Claim one record, measure it, and finish any retirement it is already
/// committed to. Returns the settled accounting for that record.
pub(super) fn settle(
    coordinator: &Arc<Coordinator>,
    id: &str,
    generation: u64,
) -> Result<Settled, AppError> {
    // Keep the read-only availability check inside this primitive as well as
    // the enforcement loop. Direct callers that already selected a record may
    // claim it, but must persist an unavailable automatic cleanup as deferred
    // rather than re-claiming it on every later pass (#760).
    let mut unavailable: Option<(Retention, String)> = None;
    if let Some(entry) = coordinator
        .inventory()?
        .entries
        .into_iter()
        .find(|entry| entry.intent.id == id && entry.generation == Some(generation))
    {
        if let Some(state) = entry.state {
            let position = entry.intent.checkpoint(&state).retention();
            if position.settled() && state.retained_bytes.is_none() {
                match artifact_present(&entry.intent, &state) {
                    Ok(true) => {}
                    Ok(false) => return Ok(Settled::Counted(position, None, true)),
                    Err(_) if position != automatic() => {
                        return Ok(Settled::Counted(position, None, false))
                    }
                    Err(error) => unavailable = Some((position, error.to_string())),
                }
            }
        }
    }
    let Some(mut operation) = coordinator.try_claim(id, generation)? else {
        return Ok(Settled::Busy);
    };
    if let Some((position, reason)) = unavailable {
        operation.advance(super::checkpoint::Event::DeferRetirement(
            super::model::bounded_error(reason),
        ))?;
        return Ok(Settled::Counted(position, None, false));
    }
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
        Eligibility::Preserved(reason) if retirement.position() == Retention::Retiring => {
            let reason = reason.clone();
            retirement.report(&reason);
            let bytes = retirement.measure()?;
            Ok(Settled::Counted(retirement.position(), bytes, true))
        }
        _ => {
            let bytes = retirement.measure()?;
            Ok(Settled::Counted(retirement.position(), bytes, true))
        }
    }
}

fn automatic() -> Retention {
    Retention::Settled {
        disposal: Disposal::AutomaticWhenSourceIntact,
    }
}

/// Read-only observation outside admission and without ownership: is any
/// recorded artifact root still there? Every root is observed, never just the
/// first present one: claiming cannot measure or remove a record any of whose
/// roots is unobservable. A rootless record still retains Undo authority and
/// needs its first zero-byte measurement.
fn artifact_present(intent: &DurableIntent, state: &State) -> Result<bool, AppError> {
    let mut named_root = false;
    let mut present = false;
    for side in planned(intent) {
        named_root = true;
        let identity = (*state.roots.get(side))
            .ok_or_else(|| invalid("Recovery artifact identity is missing"))?;
        present |= Anchor::open(intent, side)?
            .open_optional(identity)?
            .is_some();
    }
    Ok(!named_root || present)
}

/// Read-only observation outside admission and without ownership: can every
/// artifact parent this record names be opened with its recorded identity?
fn anchors_observable(intent: &DurableIntent) -> Result<(), AppError> {
    for side in planned(intent) {
        Anchor::open(intent, side)?;
    }
    Ok(())
}

/// Read-only observation outside admission: are every planned artifact and
/// probe root absent? An unreadable parent answers `Err`, never "absent".
fn orphan_root_absent(intent: &DurableIntent) -> Result<bool, AppError> {
    let kind = intent.operation.kind();
    let roots = [Side::Source, Side::Target]
        .into_iter()
        .filter_map(|side| kind.root(side))
        .chain(kind.probes());
    for root in roots {
        let parent = Directory::open(
            root.path
                .0
                .parent()
                .ok_or_else(|| invalid("Recovery artifact root has no parent"))?,
        )?;
        if of_file(&parent.file)? != root.parent {
            return Err(invalid("Recovery artifact parent identity changed"));
        }
        let name = root
            .path
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery artifact root has no name"))?;
        if parent.entry_exists(name)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn invalid(message: &str) -> AppError {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned()).into()
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_retirement.rs"]
mod tests;

#[cfg(all(test, target_os = "linux"))]
#[path = "../../../test_support/recovery_move_retirement/mod.rs"]
mod move_tests;
