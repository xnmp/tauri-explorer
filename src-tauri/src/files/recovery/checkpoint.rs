//! The durable checkpoint engine (ADR 0026): one pure write-ahead state
//! machine for every recovery kind. Each filesystem effect is bracketed by a
//! journaled intent and a journaled completion; a kind only declares its shape
//! and evidence through [`DurableKind`]. No filesystem or runtime operations.
use super::{
    artifact_layout::{ORIGINAL, PARKED, PUBLICATION},
    model::{EntryVersion, NativePath, ObjectId, StagedPayload, MAX_ERROR_BYTES},
    move_capability_model::{Event as ProbeEvent, Progress, Step as ProbeStep},
    move_cleanup::Plan,
    resources::Resource,
    retention::{Disposal, Retention},
};
use serde::{Deserialize, Serialize};
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    Planned,
    /// A capability preflight that removed its probes without any effect.
    Aborted,
    RootIntent,
    Rooted,
    ManifestIntent,
    Prepared,
    StageIntent,
    Staged,
    DisplaceIntent,
    Displaced,
    PublishIntent,
    Published,
    ParkIntent,
    Parked,
    RestoreIntent,
    Restored,
    ReapplyIntent,
}

impl Phase {
    /// Roots are planned before admission but observed only once created.
    fn roots_observed(self) -> bool {
        !matches!(self, Self::Planned | Self::Aborted | Self::RootIntent)
    }

    /// A staged payload is captured when staging completes and stays recorded
    /// for every later phase, including restoration.
    fn payload_staged(self) -> bool {
        use Phase::*;
        matches!(
            self,
            Staged
                | DisplaceIntent
                | Displaced
                | PublishIntent
                | Published
                | ParkIntent
                | Parked
                | RestoreIntent
                | Restored
                | ReapplyIntent
        )
    }
}

/// One journaled filesystem effect: its intent phase precedes the effect and
/// its completion phase follows the effect's durability barriers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Effect {
    Root,
    Manifest,
    Stage,
    Displace,
    Publish,
    Park,
    Restore,
    Reapply,
}

impl Effect {
    fn phases(self) -> (Phase, Phase) {
        use Phase::*;
        match self {
            Self::Root => (RootIntent, Rooted),
            Self::Manifest => (ManifestIntent, Prepared),
            Self::Stage => (StageIntent, Staged),
            Self::Displace => (DisplaceIntent, Displaced),
            Self::Publish => (PublishIntent, Published),
            Self::Park => (ParkIntent, Parked),
            Self::Restore => (RestoreIntent, Restored),
            Self::Reapply => (ReapplyIntent, Published),
        }
    }

    /// Public-content effects advance the history revision on completion.
    fn content(self) -> bool {
        matches!(
            self,
            Self::Publish | Self::Park | Self::Restore | Self::Reapply
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Side {
    Source,
    Target,
}

/// One value beside each endpoint. Source always precedes target.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Sides<T> {
    pub source: T,
    pub target: T,
}

impl<T> Sides<T> {
    pub(super) fn get(&self, side: Side) -> &T {
        match side {
            Side::Source => &self.source,
            Side::Target => &self.target,
        }
    }

    pub(super) fn get_mut(&mut self, side: Side) -> &mut T {
        match side {
            Side::Source => &mut self.source,
            Side::Target => &mut self.target,
        }
    }

    pub(super) fn iter(&self) -> impl Iterator<Item = (Side, &T)> {
        [(Side::Source, &self.source), (Side::Target, &self.target)].into_iter()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Decision {
    Automatic,
    Explicit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Step {
    Pending,
    Removing,
    Removed,
}

/// The retirement side-car (ADR 0023). One decision covers the immutable plan
/// of every root; each root has its own intent and completion, so the loss of
/// either volume cannot authorize skipping the other.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetirementState {
    pub decision: Decision,
    pub steps: Sides<Option<Step>>,
    pub plans: Sides<Option<Plan>>,
    pub completed: bool,
}

impl RetirementState {
    pub(super) fn roots_removed(&self) -> bool {
        self.steps
            .iter()
            .filter_map(|(_, step)| *step)
            .all(|step| step == Step::Removed)
    }
}

/// The mutable checkpoint, identical in shape for every kind. Immutable paths
/// and claims stay in the catalog intent the checkpoint's digest binds.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct State {
    pub phase: Phase,
    /// Capability probe progress, for kinds that plan probes.
    pub preflight: Option<Progress>,
    /// Confirmed public-content transitions, independent of ownership claims.
    pub effect_revision: u64,
    /// Observed artifact root identities beside each endpoint.
    pub roots: Sides<Option<ObjectId>>,
    /// Captured when staging completes. Identity alone does not prove that a
    /// later publication syscall completed.
    pub staged: Option<StagedPayload>,
    /// Measured retained bytes. Every phase change clears it: the retained
    /// artifact changes identity (ADR 0023).
    pub retained_bytes: Option<u64>,
    pub retirement: Option<RetirementState>,
    /// Why an automatic discard could not even be journaled (#760).
    pub deferred: Option<String>,
    pub error: Option<String>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            phase: Phase::Planned,
            preflight: None,
            effect_revision: 0,
            roots: Sides::default(),
            staged: None,
            retained_bytes: None,
            retirement: None,
            deferred: None,
            error: None,
        }
    }
}

impl State {
    /// A retirement that reported a failure waits for an explicit retry (ADR
    /// 0023): a journaled one that stopped, or an automatic discard that could
    /// not be journaled at all. Only a crash-interrupted retirement resumes.
    pub(super) fn awaits_retry(&self) -> bool {
        match &self.retirement {
            Some(retirement) => self.error.is_some() && !retirement.completed,
            None => self.deferred.is_some(),
        }
    }

    /// A committed discard that has not completed. Its Undo is already gone, so
    /// forgetting it loses no recovery authority, only the record and its locks.
    pub(super) fn forgettable(&self) -> bool {
        self.retirement
            .as_ref()
            .is_some_and(|retirement| !retirement.completed)
    }

    /// Only a completed retirement, or a preflight that removed every probe,
    /// may retire its durable record.
    pub(super) fn retirable_record(&self) -> bool {
        self.error.is_none()
            && match &self.retirement {
                Some(retirement) => retirement.completed,
                None => {
                    self.phase == Phase::Aborted
                        && self.preflight.as_ref().is_some_and(Progress::removed)
                }
            }
    }
}

pub(super) enum Event {
    Probe(usize, ProbeEvent),
    AbortPreflight,
    Begin(Effect),
    /// Completes an effect with no evidence of its own.
    Complete(Effect),
    Rooted(Sides<Option<ObjectId>>),
    Staged(StagedPayload),
    /// Accounting only; it grants no cleanup authority (ADR 0023).
    RetentionMeasured(u64),
    BeginRetirement(Decision, Sides<Option<Plan>>),
    BeginRootRetirement(Side),
    RootRetired(Side),
    RetirementCompleted,
    /// Return a journaled decision that removed nothing to its settled record.
    WithdrawRetirement,
    DeferRetirement(String),
    ReportError(String),
}

impl Event {
    /// Once a discard decision is durable, only these may touch the record.
    fn retires(&self) -> bool {
        matches!(
            self,
            Self::RetentionMeasured(_)
                | Self::BeginRetirement(..)
                | Self::BeginRootRetirement(_)
                | Self::RootRetired(_)
                | Self::RetirementCompleted
                | Self::WithdrawRetirement
                | Self::ReportError(_)
        )
    }
}

/// What a kind's effects look like. The legal-transition graph is the same for
/// every kind; the shape only removes edges a kind never takes.
#[derive(Clone, Copy, Debug)]
pub(super) struct Shape {
    /// An independent copy is staged privately before publication.
    pub stages: bool,
    /// An existing destination is displaced into the target root.
    pub overwrites: bool,
    /// The source is parked privately after publication.
    pub parks: bool,
    /// A restored record can publish its retained copy again.
    pub reapplies: bool,
}

/// A planned private namespace beside one user endpoint.
pub(super) struct PlannedRoot<'a> {
    pub path: &'a NativePath,
    pub token: &'a str,
    pub user: &'a NativePath,
    pub parent: ObjectId,
}

/// A public endpoint and the versions it may hold; none means absent. A
/// missing parent identity is observed by path only.
pub(super) struct Endpoint<'a> {
    pub path: &'a NativePath,
    pub parent: Option<ObjectId>,
    pub versions: Vec<EntryVersion>,
}

/// One durable operation kind. Implementations answer from immutable intent
/// evidence; the engine owns every transition, retention and retirement rule.
pub(super) trait DurableKind {
    fn shape(&self) -> Shape;
    fn root(&self, side: Side) -> Option<PlannedRoot<'_>>;
    /// Capability probes that must prove support before any effect.
    fn probes(&self) -> Vec<PlannedRoot<'_>>;
    /// User objects an artifact may never alias: the source and any original.
    fn subjects(&self) -> Vec<ObjectId>;
    fn source_version(&self) -> &EntryVersion;
    /// The destination entry an overwrite displaces into the target root.
    fn displaced(&self) -> Option<&EntryVersion>;
    fn validate(&self, resources: &[Resource]) -> io::Result<()>;
    /// Whether a restored record's retained copy is provably redundant.
    fn restored_disposal(&self) -> Disposal;
    /// The public endpoints a settled record must still show before retiring.
    fn endpoints(&self, state: &State) -> io::Result<Vec<Endpoint<'_>>>;
    /// An endpoint that must also hold before an automatic discard.
    fn witness(&self) -> Option<Endpoint<'_>> {
        None
    }
    /// The user path a recovery item is listed under.
    fn listed_path(&self) -> &NativePath;
}

/// A checkpoint interpreted under its immutable kind evidence.
pub(super) struct Checkpoint<'a, K: ?Sized> {
    pub spec: &'a K,
    pub state: &'a State,
}

impl<K: DurableKind + ?Sized> Checkpoint<'_, K> {
    /// The settled forward position: a record that parks is not finished
    /// until parking is durable.
    fn forward(&self) -> Phase {
        if self.spec.shape().parks {
            Phase::Parked
        } else {
            Phase::Published
        }
    }

    /// Native observations still have to prove the expected endpoints and
    /// artifacts. This policy never grants filesystem authority by itself.
    pub(super) fn disposal(&self) -> Option<Disposal> {
        match self.state.phase {
            Phase::Restored => Some(self.spec.restored_disposal()),
            phase if phase == self.forward() => Some(Disposal::ExplicitOnly),
            _ => None,
        }
    }

    /// A finished, idle-releasable position: settled, unerrored, undecided.
    pub(super) fn completed(&self) -> bool {
        self.state.error.is_none() && self.state.retirement.is_none() && self.disposal().is_some()
    }

    /// The retention position of this record, derived from evidence only.
    pub(super) fn retention(&self) -> Retention {
        if let Some(retirement) = &self.state.retirement {
            return if retirement.completed {
                Retention::Residue
            } else {
                Retention::Retiring
            };
        }
        if self.state.error.is_some() {
            return Retention::Unresolved;
        }
        self.disposal()
            .map_or(Retention::Unresolved, |disposal| Retention::Settled {
                disposal,
            })
    }

    /// The one expected child of a settled root, shared by journal validation
    /// and native observation.
    pub(super) fn expected_payload(
        &self,
        side: Side,
    ) -> io::Result<Option<(&'static str, Vec<EntryVersion>)>> {
        Ok(match (side, self.state.phase) {
            (Side::Source, Phase::Parked) => {
                Some((PARKED, vec![self.spec.source_version().clone()]))
            }
            (Side::Target, Phase::Published | Phase::Parked) => self
                .spec
                .displaced()
                .map(|version| (ORIGINAL, vec![version.clone()])),
            (Side::Target, Phase::Restored) if self.spec.shape().stages => {
                let staged = self
                    .state
                    .staged
                    .as_ref()
                    .ok_or_else(|| invalid("Record has no staged evidence"))?;
                Some((
                    PUBLICATION,
                    vec![staged.version.clone(), staged.published_version()?],
                ))
            }
            _ => None,
        })
    }

    fn ready(&self) -> bool {
        self.spec.probes().is_empty()
            || self
                .state
                .preflight
                .as_ref()
                .is_some_and(Progress::supported)
    }

    /// The one legal-transition graph. Reasserting a transfer intent lets the
    /// executor reconcile a lost effect or reply from native endpoints.
    fn may_begin(&self, effect: Effect) -> bool {
        use Phase::*;
        let shape = self.spec.shape();
        let rooted =
            self.spec.root(Side::Source).is_some() || self.spec.root(Side::Target).is_some();
        let phase = self.state.phase;
        match effect {
            Effect::Root => phase == Planned && rooted && self.ready(),
            Effect::Manifest => phase == Rooted,
            Effect::Stage => phase == Prepared && shape.stages,
            Effect::Displace => {
                shape.overwrites
                    && match phase {
                        Prepared => !shape.stages,
                        Staged => shape.stages,
                        DisplaceIntent => true,
                        _ => false,
                    }
            }
            Effect::Publish => match phase {
                // A rootless kind publishes with one atomic no-replace rename.
                Planned => !rooted && self.ready(),
                Prepared => !shape.stages && !shape.overwrites,
                Staged => shape.stages && !shape.overwrites,
                Displaced | PublishIntent => true,
                _ => false,
            },
            // Parking follows a published destination, never precedes it.
            Effect::Park => shape.parks && matches!(phase, Published | ParkIntent),
            Effect::Restore => matches!(
                phase,
                DisplaceIntent
                    | Displaced
                    | PublishIntent
                    | Published
                    | ParkIntent
                    | Parked
                    | RestoreIntent
                    | ReapplyIntent
            ),
            Effect::Reapply => shape.reapplies && matches!(phase, Restored | ReapplyIntent),
        }
    }

    /// The pure transition function. The result is validated before it can be
    /// journaled, so an illegal checkpoint is never persisted.
    pub(super) fn next(&self, event: Event) -> io::Result<State> {
        self.validate()?;
        let mut state = self.state.clone();
        if state.retirement.is_some() && !event.retires() {
            return Err(invalid(
                "Recovery retirement has consumed its execution authority",
            ));
        }
        match event {
            Event::Probe(index, event) if state.phase == Phase::Planned => state
                .preflight
                .get_or_insert_with(|| Progress::new(self.spec.probes().len()))
                .advance(index, event)?,
            Event::AbortPreflight
                if state.phase == Phase::Planned
                    && state.preflight.as_ref().is_some_and(Progress::removed) =>
            {
                state.phase = Phase::Aborted;
                state.error = None;
            }
            Event::Begin(effect) if self.may_begin(effect) => {
                if effect.content() {
                    next_effect_revision(state.effect_revision)?;
                }
                state.phase = effect.phases().0;
            }
            Event::Complete(effect)
                if state.phase == effect.phases().0
                    && !matches!(effect, Effect::Root | Effect::Stage) =>
            {
                complete(&mut state, effect)?;
            }
            Event::Rooted(roots)
                if state.phase == Phase::RootIntent
                    && roots.source.is_some() == self.spec.root(Side::Source).is_some()
                    && roots.target.is_some() == self.spec.root(Side::Target).is_some() =>
            {
                state.roots = roots;
                complete(&mut state, Effect::Root)?;
            }
            Event::Staged(payload) if state.phase == Phase::StageIntent => {
                state.staged = Some(payload);
                complete(&mut state, Effect::Stage)?;
            }
            Event::RetentionMeasured(bytes) if self.disposal().is_some() => {
                state.retained_bytes = Some(bytes);
            }
            Event::BeginRetirement(decision, plans) => {
                if let Some(retirement) = &state.retirement {
                    if retirement.decision != decision || retirement.plans != plans {
                        return Err(invalid("Recovery disposal decision cannot change"));
                    }
                } else {
                    if state.error.is_some() {
                        return Err(invalid("Errored record requires recovery before disposal"));
                    }
                    let pending = |side| self.spec.root(side).map(|_| Step::Pending);
                    state.retirement = Some(RetirementState {
                        decision,
                        steps: Sides {
                            source: pending(Side::Source),
                            target: pending(Side::Target),
                        },
                        plans,
                        completed: false,
                    });
                    state.retained_bytes = None;
                    state.deferred = None;
                }
            }
            Event::BeginRootRetirement(side) => {
                let retirement = decided(&mut state)?;
                if retirement.completed
                    || !matches!(
                        retirement.steps.get(side),
                        Some(Step::Pending | Step::Removing)
                    )
                {
                    return Err(invalid("Recovery root is not awaiting retirement"));
                }
                *retirement.steps.get_mut(side) = Some(Step::Removing);
                state.retained_bytes = None;
            }
            Event::RootRetired(side) => {
                let retirement = decided(&mut state)?;
                if *retirement.steps.get(side) != Some(Step::Removing) {
                    return Err(invalid("Recovery root removal lacks intent"));
                }
                *retirement.steps.get_mut(side) = Some(Step::Removed);
                // A completed root needs only its identity and absence; later
                // roots keep the plan captured by the same durable decision.
                *retirement.plans.get_mut(side) = None;
                state.retained_bytes = None;
                state.error = None;
            }
            Event::RetirementCompleted => {
                let retirement = decided(&mut state)?;
                if !retirement.roots_removed() {
                    return Err(invalid("Recovery record still retains artifact roots"));
                }
                retirement.completed = true;
                state.retained_bytes = Some(0);
                state.error = None;
            }
            Event::WithdrawRetirement => {
                let retirement = decided(&mut state)?;
                if retirement.completed
                    || retirement
                        .steps
                        .iter()
                        .any(|(_, step)| *step == Some(Step::Removed))
                {
                    return Err(invalid(
                        "A discard that removed a root can only be completed",
                    ));
                }
                // The effect revision is untouched: the history entry that
                // named this record before the decision names it again.
                state.retirement = None;
                state.retained_bytes = None;
                state.error = None;
            }
            Event::DeferRetirement(reason)
                if self.disposal() == Some(Disposal::AutomaticWhenSourceIntact) =>
            {
                state.deferred = Some(reason);
            }
            Event::ReportError(error) => state.error = Some(error),
            _ => return Err(invalid("Illegal recovery phase transition")),
        }
        if state.phase != self.state.phase {
            state.retained_bytes = None;
            state.deferred = None;
        }
        Checkpoint {
            spec: self.spec,
            state: &state,
        }
        .validate()?;
        Ok(state)
    }

    /// Validate durable evidence without probing a possibly missing volume.
    pub(super) fn validate(&self) -> io::Result<()> {
        let (spec, state) = (self.spec, self.state);
        self.validate_preflight()?;
        if let Some(retirement) = &state.retirement {
            self.validate_retirement(retirement)?;
        }
        let bounded = |text: &Option<String>| {
            text.as_ref()
                .is_none_or(|text| text.len() <= MAX_ERROR_BYTES)
        };
        if !bounded(&state.error) || !bounded(&state.deferred) {
            return Err(invalid("Recovery checkpoint exceeds its error budget"));
        }
        if state.deferred.is_some()
            && (state.retirement.is_some()
                || self.disposal() != Some(Disposal::AutomaticWhenSourceIntact))
        {
            return Err(invalid(
                "Only a settled, automatically retirable record can defer its cleanup",
            ));
        }
        if state.retained_bytes.is_some() && self.disposal().is_none() {
            return Err(invalid("Only a settled record holds measurable artifacts"));
        }
        let observed = state.phase.roots_observed();
        for (side, identity) in state.roots.iter() {
            let planned = spec.root(side);
            if identity.is_some() != (observed && planned.is_some()) {
                return Err(invalid(
                    "Recovery phase lacks its required artifact root evidence",
                ));
            }
            if let (Some(identity), Some(planned)) = (identity, planned) {
                self.validate_root(planned.parent, *identity)?;
            }
        }
        let rooted = spec.root(Side::Source).is_some() || spec.root(Side::Target).is_some();
        if !rooted
            && !matches!(
                state.phase,
                Phase::Planned
                    | Phase::Aborted
                    | Phase::PublishIntent
                    | Phase::Published
                    | Phase::RestoreIntent
                    | Phase::Restored
            )
        {
            return Err(invalid(
                "A record without private storage cannot reach an artifact-bearing phase",
            ));
        }
        // Staging evidence must not appear before its phase or survive a phase
        // that has not observed it, and a kind that never stages has none.
        if state.staged.is_some() != (state.phase.payload_staged() && spec.shape().stages) {
            return Err(invalid(
                "Recovery staging evidence disagrees with its kind and phase",
            ));
        }
        if let Some(staged) = &state.staged {
            staged.validate()?;
            let object = staged.version.object;
            let parent = spec
                .root(Side::Target)
                .ok_or_else(|| invalid("A staged record has no target root"))?
                .parent;
            if !object.same_volume(parent)
                || object == parent
                || spec.subjects().contains(&object)
                || state.roots.iter().any(|(_, root)| *root == Some(object))
            {
                return Err(invalid(
                    "Recovery staged payload aliases retained evidence or lies on another device",
                ));
            }
        }
        Ok(())
    }

    /// An observed artifact or probe root must be a private sibling of its
    /// owning user entry: same volume as that parent, never user data. Only the
    /// operation's subjects are compared: other intent resources, such as the
    /// parent-alias entries recorded for traversed symlinks, are not kept
    /// alive, so a fresh root can reuse their freed inode numbers (#788).
    pub(super) fn validate_root(&self, parent: ObjectId, root: ObjectId) -> io::Result<()> {
        if !root.same_volume(parent) || root == parent || self.spec.subjects().contains(&root) {
            return Err(invalid(
                "Recovery artifact root aliases a user object or lies on another device",
            ));
        }
        Ok(())
    }

    fn validate_retirement(&self, retirement: &RetirementState) -> io::Result<()> {
        let policy = self
            .disposal()
            .ok_or_else(|| invalid("An unsettled record cannot authorize retirement"))?;
        let steps = &retirement.steps;
        if steps
            .iter()
            .any(|(side, step)| step.is_some() != self.spec.root(side).is_some())
            || (retirement.decision == Decision::Automatic && policy == Disposal::ExplicitOnly)
            || (retirement.completed && !retirement.roots_removed())
            // A fixed source-then-target order makes interruption unambiguous.
            || (steps.target.is_some_and(|step| step != Step::Pending)
                && steps.source.is_some_and(|step| step != Step::Removed))
        {
            return Err(invalid(
                "Recovery retirement disagrees with its disposal authority or root order",
            ));
        }
        for (side, step) in steps.iter() {
            let plan = retirement.plans.get(side);
            if plan.is_some() != step.is_some_and(|step| step != Step::Removed) {
                return Err(invalid(
                    "Recovery root removal lacks its exact descendant plan",
                ));
            }
            if let (Some(root), Some(plan)) = (self.spec.root(side), plan) {
                let expected = self.expected_payload(side)?;
                plan.validate(
                    &root.path.0,
                    expected
                        .as_ref()
                        .map(|(name, versions)| (*name, versions.as_slice())),
                )?;
            }
        }
        Ok(())
    }

    fn validate_preflight(&self) -> io::Result<()> {
        let state = self.state;
        let probes = self.spec.probes();
        let Some(progress) = &state.preflight else {
            if (!probes.is_empty() && state.phase != Phase::Planned)
                || state.phase == Phase::Aborted
            {
                return Err(invalid(
                    "Recovery record has no completed capability evidence",
                ));
            }
            return Ok(());
        };
        if progress.steps.len() != probes.len() {
            return Err(invalid(
                "Capability probe progress differs from its immutable plans",
            ));
        }
        if state.phase == Phase::Aborted {
            if !progress.removed()
                || state.effect_revision != 0
                || state.retirement.is_some()
                || state.error.is_some()
            {
                return Err(invalid(
                    "Aborted preflight still owns probe effects or user history",
                ));
            }
        } else if state.phase != Phase::Planned && !progress.supported() {
            return Err(invalid(
                "Recovery effects require completed capability probes",
            ));
        }
        let mut objects: std::collections::HashSet<ObjectId> =
            probes.iter().map(|probe| probe.parent).collect();
        objects.extend(self.spec.subjects());
        // Removed probe identities may be reused by later artifact creation;
        // they cannot be compared against newly created root identities.
        let mut prior_removed = true;
        for (probe, step) in probes.iter().zip(&progress.steps) {
            if !prior_removed && !matches!(step, ProbeStep::Planned) {
                return Err(invalid("Capability probes must execute in order"));
            }
            prior_removed &= matches!(step, ProbeStep::Absent | ProbeStep::Removed { .. });
            let (root, file) = match step {
                ProbeStep::Planned | ProbeStep::RootIntent | ProbeStep::Absent => continue,
                ProbeStep::FileIntent { root } => (*root, None),
                ProbeStep::RenameIntent { root, file } => (*root, Some(file)),
                ProbeStep::CleanupIntent {
                    root,
                    file,
                    renamed,
                    supported,
                }
                | ProbeStep::Removed {
                    root,
                    file,
                    renamed,
                    supported,
                } => {
                    if (*supported && !*renamed) || (file.is_none() && (*renamed || *supported)) {
                        return Err(invalid("Probe cleanup cannot infer rename support"));
                    }
                    (*root, file.as_ref())
                }
            };
            self.validate_root(probe.parent, root)?;
            if !objects.insert(root) {
                return Err(invalid("Probe root aliases other evidence"));
            }
            if let Some(file) = file {
                file.validate()?;
                if file.size != 0
                    || file.mode != 0o100600
                    || !file.object.same_volume(root)
                    || !objects.insert(file.object)
                {
                    return Err(invalid("Probe file is not its own empty private file"));
                }
            }
        }
        Ok(())
    }
}

fn complete(state: &mut State, effect: Effect) -> io::Result<()> {
    if effect.content() {
        state.effect_revision = next_effect_revision(state.effect_revision)?;
    }
    state.phase = effect.phases().1;
    state.error = None;
    Ok(())
}

fn decided(state: &mut State) -> io::Result<&mut RetirementState> {
    state
        .retirement
        .as_mut()
        .ok_or_else(|| invalid("Recovery record has no disposal decision"))
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
#[path = "../../../test_support/recovery_checkpoint.rs"]
mod tests;
