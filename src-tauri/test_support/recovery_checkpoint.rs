//! The checkpoint engine's contract, parameterized over every durable kind:
//! a copy replacement and the three move shapes (same-volume fast path,
//! same-volume overwrite, cross-volume copy-and-park).
use super::*;
use crate::files::recovery::{
    model::{
        DurableIntent, LockIdentity, OperationCheckpoint, OperationRecord, OperationSpec,
        ReplacementSpec, RECORD_VERSION,
    },
    move_capability_model::Plans,
    move_cleanup::Plan,
    move_model::{ArtifactPlan, MoveSpec, Strategy},
    resources::{Access, Scope},
};
use std::path::Path;

const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TARGET_TOKEN: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const PROBE_TOKENS: [&str; 2] = [
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
];

fn object(device: u64, inode: u64) -> ObjectId {
    ObjectId::unix(device, inode)
}

fn version(device: u64, inode: u64) -> EntryVersion {
    EntryVersion {
        object: object(device, inode),
        size: 12,
        modified_seconds: 1_700_000_000,
        modified_nanos: 42,
        directory: false,
        symlink: false,
        mode: 0o100600,
        uid: 1000,
        gid: 1000,
    }
}

fn payload(version: EntryVersion) -> StagedPayload {
    StagedPayload {
        version,
        final_mode: None,
    }
}

fn resource(path: &str, identity: Option<ObjectId>, parent: ObjectId, access: Access) -> Resource {
    let depth = Path::new(path).parent().unwrap().ancestors().count();
    let mut ancestors = vec![parent];
    ancestors.extend((1..depth).map(|index| object(99, index as u64)));
    Resource {
        path: NativePath(path.into()),
        object: identity,
        ancestors,
        access,
        scope: Scope::Subtree,
    }
}

fn plan(path: &str, token: &str) -> ArtifactPlan {
    ArtifactPlan {
        path: NativePath(path.into()),
        token: token.into(),
    }
}

/// One planned record of one kind, with the native identities its effects
/// will observe and the exact phases its forward effects pass through.
struct Case {
    name: &'static str,
    intent: DurableIntent,
    planned: State,
    roots: Sides<Option<ObjectId>>,
    staged: StagedPayload,
    forward: Vec<Phase>,
}

impl Case {
    fn advance(&self, state: State, event: Event) -> State {
        self.intent
            .transition(&state, event)
            .unwrap_or_else(|error| panic!("{}: {error}", self.name))
    }

    fn attempt(&self, state: &State, event: Event) -> io::Result<State> {
        self.intent.transition(state, event)
    }

    fn kind(&self) -> &dyn DurableKind {
        self.intent.operation.kind()
    }

    /// The forward effect events this kind's shape takes, in order.
    fn events(&self) -> Vec<Event> {
        let shape = self.kind().shape();
        let mut events = Vec::new();
        if self.roots.source.is_some() || self.roots.target.is_some() {
            events.extend([
                Event::Begin(Effect::Root),
                Event::Rooted(self.roots.clone()),
                Event::Begin(Effect::Manifest),
                Event::Complete(Effect::Manifest),
            ]);
        }
        if shape.stages {
            events.extend([
                Event::Begin(Effect::Stage),
                Event::Staged(self.staged.clone()),
            ]);
        }
        if shape.overwrites {
            events.extend([
                Event::Begin(Effect::Displace),
                Event::Complete(Effect::Displace),
            ]);
        }
        events.extend([
            Event::Begin(Effect::Publish),
            Event::Complete(Effect::Publish),
        ]);
        if shape.parks {
            events.extend([Event::Begin(Effect::Park), Event::Complete(Effect::Park)]);
        }
        events
    }

    /// Every state the forward walk passes through, the planned one first.
    fn walk(&self) -> Vec<State> {
        let mut states = vec![self.planned.clone()];
        for event in self.events() {
            let next = self.advance(states.last().unwrap().clone(), event);
            states.push(next);
        }
        states
    }

    fn settled(&self) -> State {
        self.walk().pop().unwrap()
    }

    fn at(&self, phase: Phase) -> State {
        self.walk()
            .into_iter()
            .find(|state| state.phase == phase)
            .unwrap_or_else(|| panic!("{} never reaches {phase:?}", self.name))
    }

    fn restored(&self) -> State {
        let state = self.advance(self.settled(), Event::Begin(Effect::Restore));
        self.advance(state, Event::Complete(Effect::Restore))
    }

    /// The exact single-payload plan each root's retirement would capture.
    fn plans(&self, state: &State) -> Sides<Option<Plan>> {
        let checkpoint = self.intent.checkpoint(state);
        let plan = |side| {
            let root = self.kind().root(side)?;
            Some(match checkpoint.expected_payload(side).unwrap() {
                Some((name, versions)) => {
                    Plan::single(NativePath(root.path.0.join(name)), versions[0].clone())
                }
                None => Plan::default(),
            })
        };
        Sides {
            source: plan(Side::Source),
            target: plan(Side::Target),
        }
    }

    fn decide(&self, state: &State, decision: Decision) -> Event {
        let plans = match &state.retirement {
            Some(retirement) => retirement.plans.clone(),
            None => self.plans(state),
        };
        Event::BeginRetirement(decision, plans)
    }
}

fn record(operation: OperationSpec, resources: Vec<Resource>) -> DurableIntent {
    DurableIntent {
        version: RECORD_VERSION,
        id: ID.into(),
        lock: LockIdentity {
            name: format!("{ID}.lock"),
            object: object(7, 30),
            nonce: "b".repeat(64),
        },
        resources,
        operation,
    }
}

fn replacement() -> Case {
    let parent = object(7, 10);
    let root = "/volume/.tauri-explorer-recovery-artifact";
    let intent = record(
        OperationSpec::CopyReplacement(ReplacementSpec {
            artifact_token: "artifact".into(),
            source: NativePath("/volume/source".into()),
            source_version: version(7, 11),
            target: NativePath("/volume/target".into()),
            root: NativePath(root.into()),
            parent,
            original: version(7, 12),
        }),
        vec![
            resource("/volume/source", Some(object(7, 11)), parent, Access::Read),
            resource("/volume/target", Some(object(7, 12)), parent, Access::Write),
            resource(root, None, parent, Access::Write),
        ],
    );
    use Phase::*;
    planned(Case {
        name: "replacement",
        intent,
        planned: State::default(),
        roots: Sides {
            source: None,
            target: Some(object(7, 13)),
        },
        staged: payload(version(7, 14)),
        forward: vec![
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
        ],
    })
}

/// Rename probes beside each endpoint: a target probe exactly when the move
/// crosses volumes.
fn probes(source: &str, target: Option<&str>) -> Plans {
    let beside = |user: &str, token: &str| {
        let parent = Path::new(user).parent().unwrap();
        let path = parent.join(format!(".tauri-explorer-recovery-{token}"));
        plan(&path.to_string_lossy(), token)
    };
    Plans {
        source: beside(source, PROBE_TOKENS[0]),
        target: target.map(|target| beside(target, PROBE_TOKENS[1])),
    }
}

/// A move whose endpoint volumes have already proved exclusive rename, which
/// every move must do before any effect.
fn moved(
    name: &'static str,
    spec: MoveSpec,
    mut resources: Vec<Resource>,
    roots: Sides<Option<ObjectId>>,
    forward: Vec<Phase>,
) -> Case {
    resources.extend(spec.probe_plans().map(|(plan, _, parent)| {
        resource(&plan.path.0.to_string_lossy(), None, parent, Access::Write)
    }));
    let case = planned(Case {
        name,
        intent: record(OperationSpec::Move(spec), resources),
        planned: State::default(),
        roots,
        staged: payload(version(8, 60)),
        forward,
    });
    let mut state = case.planned.clone();
    for index in 0..case.kind().probes().len() {
        // The source probe shares volume 7; a target probe exists only on 8.
        let device = 7 + index as u64;
        let root = object(device, 40 + 2 * index as u64);
        let file = EntryVersion {
            size: 0,
            ..version(device, 41 + 2 * index as u64)
        };
        for event in [
            ProbeEvent::BeginRoot,
            ProbeEvent::RootObserved(root),
            ProbeEvent::FileObserved(file),
            ProbeEvent::BeginCleanup {
                renamed: true,
                supported: true,
            },
            ProbeEvent::Removed,
        ] {
            state = case.advance(state, Event::Probe(index, event));
        }
    }
    Case {
        planned: state,
        ..case
    }
}

fn planned(case: Case) -> Case {
    case.intent.validate().unwrap();
    let record = OperationRecord::planned(case.intent.clone());
    record.validate().unwrap();
    assert_eq!(record.state, case.planned);
    case
}

/// Same filesystem, no overwrite: one atomic no-replace rename, no artifacts.
fn fast_path() -> Case {
    let parent = object(7, 10);
    let spec = MoveSpec {
        rename_probes: probes("/volume/source", None),
        source: NativePath("/volume/source".into()),
        source_parent: parent,
        source_version: version(7, 11),
        target: NativePath("/volume/target".into()),
        target_parent: parent,
        target_original: None,
        strategy: Strategy::Rename,
        source_root: None,
        target_root: None,
    };
    let resources = vec![
        resource("/volume/source", Some(object(7, 11)), parent, Access::Write),
        resource("/volume/target", None, parent, Access::Write),
    ];
    use Phase::*;
    moved(
        "fast path",
        spec,
        resources,
        Sides::default(),
        vec![PublishIntent, Published],
    )
}

/// Same filesystem, overwriting: the displaced original needs private storage.
fn same_volume_overwrite() -> Case {
    let parent = object(7, 10);
    let root = format!("/volume/.tauri-explorer-recovery-{TARGET_TOKEN}");
    let spec = MoveSpec {
        rename_probes: probes("/volume/source", None),
        source: NativePath("/volume/source".into()),
        source_parent: parent,
        source_version: version(7, 11),
        target: NativePath("/volume/target".into()),
        target_parent: parent,
        target_original: Some(version(7, 12)),
        strategy: Strategy::Rename,
        source_root: None,
        target_root: Some(plan(&root, TARGET_TOKEN)),
    };
    let resources = vec![
        resource("/volume/source", Some(object(7, 11)), parent, Access::Write),
        resource("/volume/target", Some(object(7, 12)), parent, Access::Write),
        resource(&root, None, parent, Access::Write),
    ];
    use Phase::*;
    moved(
        "same-volume overwrite",
        spec,
        resources,
        Sides {
            source: None,
            target: Some(object(7, 51)),
        },
        vec![
            RootIntent,
            Rooted,
            ManifestIntent,
            Prepared,
            DisplaceIntent,
            Displaced,
            PublishIntent,
            Published,
        ],
    )
}

/// Cross filesystem, overwriting: stage a copy, displace, publish, then park.
fn cross_volume() -> Case {
    let source_parent = object(7, 10);
    let target_parent = object(8, 20);
    let source_root = format!("/source-volume/.tauri-explorer-recovery-{SOURCE_TOKEN}");
    let target_root = format!("/target-volume/.tauri-explorer-recovery-{TARGET_TOKEN}");
    let spec = MoveSpec {
        rename_probes: probes("/source-volume/source", Some("/target-volume/target")),
        source: NativePath("/source-volume/source".into()),
        source_parent,
        source_version: version(7, 11),
        target: NativePath("/target-volume/target".into()),
        target_parent,
        target_original: Some(version(8, 21)),
        strategy: Strategy::CopyParked,
        source_root: Some(plan(&source_root, SOURCE_TOKEN)),
        target_root: Some(plan(&target_root, TARGET_TOKEN)),
    };
    let resources = vec![
        resource(
            "/source-volume/source",
            Some(object(7, 11)),
            source_parent,
            Access::Write,
        ),
        resource(
            "/target-volume/target",
            Some(object(8, 21)),
            target_parent,
            Access::Write,
        ),
        resource(&source_root, None, source_parent, Access::Write),
        resource(&target_root, None, target_parent, Access::Write),
    ];
    use Phase::*;
    moved(
        "cross-volume",
        spec,
        resources,
        Sides {
            source: Some(object(7, 50)),
            target: Some(object(8, 51)),
        },
        vec![
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
        ],
    )
}

fn cases() -> [Case; 4] {
    [
        replacement(),
        fast_path(),
        same_volume_overwrite(),
        cross_volume(),
    ]
}

fn rooted(case: &Case) -> bool {
    case.roots.source.is_some() || case.roots.target.is_some()
}

#[test]
fn record_version_three_is_the_only_accepted_format() {
    // ADR 0026: one format serves every kind. Version 1 copy replacements
    // and version 2 moves are rejected, never migrated or guessed at.
    for case in cases() {
        assert_eq!(case.intent.version, 3);
        for version in [0, 1, 2, 4, u32::MAX] {
            let other = DurableIntent {
                version,
                ..case.intent.clone()
            };
            assert!(other.validate().is_err(), "{} v{version}", case.name);
            assert!(
                other
                    .transition(&case.planned, Event::Begin(Effect::Publish))
                    .is_err(),
                "{} v{version} must not drive a transition",
                case.name
            );
        }
    }
}

#[test]
fn checkpoints_of_earlier_record_versions_are_rejected() {
    // A v1 replacement and a v2 move both nested their state under a kind
    // tag; the unified checkpoint has no such field and denies it.
    let legacy = [
        r#"{"kind":"copyReplacement","state":{"phase":"published","root":null,"published":null,"error":null}}"#,
        r#"{"kind":"move","state":{"effect_revision":0,"source_root":null,"target_root":null,"phase":"planned","staged":null,"error":null}}"#,
        r#"{"effect_revision":0,"source_root":null,"target_root":null,"phase":"planned","staged":null,"error":null}"#,
    ];
    for encoded in legacy {
        assert!(serde_json::from_str::<State>(encoded).is_err(), "{encoded}");
    }
}

#[test]
fn planned_records_begin_without_effects_or_evidence() {
    for case in cases() {
        let state = &case.planned;
        assert_eq!(state.phase, Phase::Planned, "{}", case.name);
        assert_eq!(state.effect_revision, 0);
        assert_eq!(state.roots, Sides::default());
        assert_eq!(state.staged, None);
        assert_eq!(state.retirement, None);
    }
}

#[test]
fn forward_effects_follow_the_one_legal_sequence_for_each_shape() {
    for case in cases() {
        let original = case.intent.clone();
        let walk = case.walk();
        let phases: Vec<Phase> = walk[1..].iter().map(|state| state.phase).collect();
        assert_eq!(phases, case.forward, "{}", case.name);
        let settled = walk.last().unwrap();
        assert_eq!(case.intent, original);
        assert_eq!(settled.roots, case.roots, "{}", case.name);
        assert_eq!(
            settled.staged.is_some(),
            case.kind().shape().stages,
            "{}",
            case.name
        );
        assert!(case.intent.checkpoint(settled).completed(), "{}", case.name);
    }
}

#[test]
fn no_artifact_phase_is_reachable_without_a_planned_root() {
    let case = fast_path();
    let published = case.settled();
    assert_eq!(published.effect_revision, 1);
    assert_eq!(published.staged, None);
    assert_eq!(published.roots, Sides::default());
    for effect in [Effect::Root, Effect::Stage, Effect::Displace, Effect::Park] {
        assert!(case.attempt(&case.planned, Event::Begin(effect)).is_err());
    }
    // A rootless record publishes directly; a rooted one never does.
    for case in cases() {
        assert_eq!(
            case.attempt(&case.planned, Event::Begin(Effect::Publish))
                .is_ok(),
            !rooted(&case),
            "{}",
            case.name
        );
    }
}

#[test]
fn every_kind_publishes_before_it_parks_and_only_a_copying_move_parks() {
    for case in cases() {
        for state in case.walk() {
            let published = matches!(state.phase, Phase::Published | Phase::ParkIntent);
            assert_eq!(
                case.attempt(&state, Event::Begin(Effect::Park)).is_ok(),
                published && case.kind().shape().parks,
                "{} at {:?}",
                case.name,
                state.phase
            );
            if state.phase != Phase::ParkIntent {
                assert!(case.attempt(&state, Event::Complete(Effect::Park)).is_err());
            }
        }
    }
}

#[test]
fn restoration_is_legal_exactly_once_something_was_displaced_or_published() {
    use Phase::*;
    for case in cases() {
        for state in case.walk() {
            let legal = matches!(
                state.phase,
                DisplaceIntent | Displaced | PublishIntent | Published | ParkIntent | Parked
            );
            let restoring = case.attempt(&state, Event::Begin(Effect::Restore));
            assert_eq!(
                restoring.is_ok(),
                legal,
                "{} at {:?}",
                case.name,
                state.phase
            );
            let Ok(restoring) = restoring else { continue };
            assert_eq!(restoring.phase, RestoreIntent);
            assert_eq!(restoring.roots, state.roots);
            assert_eq!(restoring.staged, state.staged);
            // An interrupted restoration is reassertable, not terminal.
            let retried = case.advance(restoring.clone(), Event::Begin(Effect::Restore));
            assert_eq!(retried, restoring);
            let restored = case.advance(restoring, Event::Complete(Effect::Restore));
            assert_eq!(restored.phase, Restored);
            assert!(case
                .attempt(&restored, Event::Begin(Effect::Restore))
                .is_err());
        }
    }
}

#[test]
fn skips_repeats_and_backtracking_are_rejected_without_mutating_state() {
    for case in cases() {
        let walk = case.walk();
        for (index, state) in walk.iter().enumerate() {
            let next = walk.get(index + 1).map(|state| state.phase);
            for effect in [
                Effect::Root,
                Effect::Manifest,
                Effect::Stage,
                Effect::Displace,
                Effect::Publish,
                Effect::Park,
            ] {
                let (intent, completion) = effect.phases();
                let reasserted = state.phase == intent
                    && matches!(effect, Effect::Displace | Effect::Publish | Effect::Park);
                let before = state.clone();
                let begun = case.attempt(state, Event::Begin(effect));
                // Only the next forward intent, a transfer reassertion, or
                // the inverse may begin; nothing skips or backtracks.
                assert_eq!(
                    begun.is_ok(),
                    Some(intent) == next || reasserted,
                    "{} {effect:?} from {:?}",
                    case.name,
                    state.phase
                );
                assert_eq!(*state, before);
                if state.phase != intent && completion != state.phase {
                    assert!(case.attempt(state, Event::Complete(effect)).is_err());
                }
            }
        }
    }
}

#[test]
fn root_observations_must_match_the_plan_and_never_alias_a_subject() {
    for case in cases().into_iter().filter(rooted) {
        let intent = case.advance(case.planned.clone(), Event::Begin(Effect::Root));
        let observe = |source, target| Event::Rooted(Sides { source, target });
        let roots = case.roots.clone();
        // Missing or extra sides disagree with the immutable plan. Identities
        // are observed, not planned, so only which sides exist is compared.
        let planned =
            |sides: &Sides<Option<ObjectId>>| (sides.source.is_some(), sides.target.is_some());
        for (source, target) in [
            (None, None),
            (roots.source, None),
            (None, roots.target),
            (Some(object(7, 77)), roots.target),
            (roots.source, Some(object(7, 78))),
        ] {
            let observed = Sides { source, target };
            if planned(&observed) != planned(&roots) {
                assert!(
                    case.attempt(&intent, observe(source, target)).is_err(),
                    "{} accepted {observed:?}",
                    case.name
                );
            }
        }
        // Each root must be a private sibling of its own endpoint: never a
        // subject, its parent, or an object on another device.
        for (side, _) in roots.iter().filter(|(_, root)| root.is_some()) {
            let parent = case.kind().root(side).unwrap().parent;
            let aliases = case
                .kind()
                .subjects()
                .into_iter()
                .chain([parent, object(9, 51)]);
            for aliased in aliases {
                let mut sides = roots.clone();
                *sides.get_mut(side) = Some(aliased);
                assert!(
                    case.attempt(&intent, Event::Rooted(sides)).is_err(),
                    "{} accepted {aliased:?} beside {side:?}",
                    case.name
                );
            }
        }
        case.advance(intent, Event::Rooted(roots));
    }
}

/// Admission records each symlink an endpoint traverses as an entry-scoped
/// read carrying the link's inode. The operation neither keeps that link
/// alive nor forbids retargeting it, so ext4 and XFS can give its freed number
/// to the new artifact root (#788). Only the subjects may disqualify a root.
#[test]
fn a_reused_parent_alias_identity_does_not_disqualify_an_observed_root() {
    for mut case in [replacement(), same_volume_overwrite()] {
        let reused = case.roots.target.unwrap();
        let mut link = resource(
            "/volume/retargeted-link",
            Some(reused),
            object(7, 10),
            Access::Read,
        );
        link.scope = Scope::Entry;
        case.intent.resources.push(link);
        case.intent.validate().unwrap();
        let intent = case.advance(case.planned.clone(), Event::Begin(Effect::Root));
        case.advance(intent.clone(), Event::Rooted(case.roots.clone()));
        // The displaced original is a subject, so its identity still disqualifies.
        let original = case.kind().displaced().unwrap().object;
        let aliased = Sides {
            source: None,
            target: Some(original),
        };
        assert!(case.attempt(&intent, Event::Rooted(aliased)).is_err());
    }
}

#[test]
fn a_staged_payload_may_not_alias_evidence_or_lie_on_another_device() {
    for case in cases()
        .into_iter()
        .filter(|case| case.kind().shape().stages)
    {
        let staging = case.at(Phase::StageIntent);
        let parent = case.kind().root(Side::Target).unwrap().parent;
        let mut aliases = case.kind().subjects();
        aliases.push(parent);
        aliases.extend(case.roots.source);
        aliases.extend(case.roots.target);
        for aliased in aliases {
            let staged = payload(EntryVersion {
                object: aliased,
                ..case.staged.version.clone()
            });
            assert!(
                case.attempt(&staging, Event::Staged(staged)).is_err(),
                "{} staged {aliased:?}",
                case.name
            );
        }
        let elsewhere = payload(EntryVersion {
            object: object(9, 60),
            ..case.staged.version.clone()
        });
        assert!(case.attempt(&staging, Event::Staged(elsewhere)).is_err());
        let mut malformed = case.staged.version.clone();
        malformed.modified_nanos = 1_000_000_000;
        assert!(case
            .attempt(&staging, Event::Staged(payload(malformed)))
            .is_err());
        case.advance(staging, Event::Staged(case.staged.clone()));
    }
}

#[test]
fn staged_directory_requires_exact_permission_finalization_evidence() {
    for case in cases()
        .into_iter()
        .filter(|case| case.kind().shape().stages)
    {
        let copying = case.at(Phase::StageIntent);
        let mut directory = case.staged.version.clone();
        directory.directory = true;
        directory.mode = 0o40755;
        let valid = StagedPayload {
            version: directory.clone(),
            final_mode: Some(0o555),
        };
        let staged = case.advance(copying.clone(), Event::Staged(valid.clone()));
        assert_eq!(staged.staged, Some(valid));
        for invalid in [
            StagedPayload {
                version: directory.clone(),
                final_mode: None,
            },
            StagedPayload {
                version: directory.clone(),
                final_mode: Some(0o100555),
            },
            StagedPayload {
                version: directory,
                final_mode: Some(0o700),
            },
            StagedPayload {
                version: case.staged.version.clone(),
                final_mode: Some(0o600),
            },
        ] {
            assert!(case.attempt(&copying, Event::Staged(invalid)).is_err());
        }
    }
}

#[test]
fn publication_version_restores_only_the_recorded_directory_permissions() {
    let mut directory = version(7, 14);
    directory.directory = true;
    directory.mode = 0o40755;
    let directory_payload = StagedPayload {
        version: directory.clone(),
        final_mode: Some(0o555),
    };
    let mut expected = directory;
    expected.mode = 0o40555;
    assert_eq!(directory_payload.published_version().unwrap(), expected);
    let file = payload(version(7, 14));
    assert_eq!(file.published_version().unwrap(), file.version);
    assert!(StagedPayload {
        final_mode: Some(0o100555),
        ..directory_payload
    }
    .published_version()
    .is_err());
}

#[test]
fn errors_are_retained_through_retried_intents_until_a_completion_clears_them() {
    for case in cases() {
        let mut state = case.planned.clone();
        for event in case.events() {
            let begins = matches!(event, Event::Begin(_));
            if begins {
                state = case.advance(state, Event::ReportError("retryable failure".into()));
            }
            state = case.advance(state, event);
            let expected = begins.then_some("retryable failure");
            assert_eq!(
                state.error.as_deref(),
                expected,
                "{} at {:?}",
                case.name,
                state.phase
            );
        }
        // A report preserves every piece of evidence it is attached to.
        let reported = case.advance(state.clone(), Event::ReportError("warning".into()));
        assert_eq!(
            State {
                error: None,
                ..reported.clone()
            },
            state
        );
        // Restoration from a failed settled record clears it the same way.
        let resolving = case.advance(reported, Event::Begin(Effect::Restore));
        assert_eq!(resolving.error.as_deref(), Some("warning"));
        let resolved = case.advance(resolving, Event::Complete(Effect::Restore));
        assert_eq!(resolved.error, None);
        // An oversized diagnostic is rejected rather than silently stored.
        let oversized = "x".repeat(crate::files::recovery::model::MAX_ERROR_BYTES + 1);
        assert!(case
            .attempt(&resolved, Event::ReportError(oversized))
            .is_err());
    }
}

#[test]
fn reasserted_transfer_intents_are_idempotent_but_completions_are_not() {
    for case in cases() {
        for state in case.walk() {
            let effect = match state.phase {
                Phase::DisplaceIntent => Effect::Displace,
                Phase::PublishIntent => Effect::Publish,
                Phase::ParkIntent => Effect::Park,
                _ => continue,
            };
            let failed = case.advance(state, Event::ReportError("retry pending".into()));
            assert_eq!(case.advance(failed.clone(), Event::Begin(effect)), failed);
            let completed = case.advance(failed, Event::Complete(effect));
            assert!(case.attempt(&completed, Event::Complete(effect)).is_err());
        }
    }
}

#[test]
fn content_revision_advances_only_when_public_content_is_confirmed() {
    let case = cross_volume();
    let mut state = case.at(Phase::Published);
    let mut observed = vec![state.effect_revision];
    for event in [
        Event::Begin(Effect::Park),
        Event::Complete(Effect::Park),
        Event::Begin(Effect::Restore),
        Event::Complete(Effect::Restore),
    ] {
        state = case.advance(state, event);
        observed.push(state.effect_revision);
    }
    // publish, begin-park, park, begin-restore, restore
    assert_eq!(observed, vec![1, 1, 2, 2, 3]);

    let case = replacement();
    let mut state = case.settled();
    assert_eq!(state.effect_revision, 1);
    for revision in [2, 4, 6] {
        state = case.advance(state, Event::Begin(Effect::Restore));
        assert_eq!(state.effect_revision, revision - 1);
        state = case.advance(state, Event::Complete(Effect::Restore));
        assert_eq!(state.effect_revision, revision);
        state = case.advance(state, Event::Begin(Effect::Reapply));
        state = case.advance(state, Event::ReportError("retry".into()));
        state = case.advance(state, Event::Begin(Effect::Reapply));
        assert_eq!(state.effect_revision, revision);
        state = case.advance(state, Event::Complete(Effect::Reapply));
        assert_eq!(state.effect_revision, revision + 1);
        assert_eq!(state.phase, Phase::Published);
        assert!(state.error.is_none());
    }
    // Only a kind whose restored copy can be published again reapplies.
    for case in [fast_path(), same_volume_overwrite(), cross_volume()] {
        assert!(case
            .attempt(&case.restored(), Event::Begin(Effect::Reapply))
            .is_err());
    }
}

#[test]
fn exhausted_content_revision_prevents_intent_before_native_effects() {
    for case in cases() {
        // The last content intent cannot complete into an unrepresentable
        // revision, and a settled record cannot even begin its inverse.
        let mut completing = case.at(case.forward[case.forward.len() - 2]);
        completing.effect_revision = u64::MAX;
        let effect = match completing.phase {
            Phase::PublishIntent => Effect::Publish,
            Phase::ParkIntent => Effect::Park,
            phase => panic!("{} settles from {phase:?}", case.name),
        };
        assert!(case.attempt(&completing, Event::Complete(effect)).is_err());
        let mut settled = case.settled();
        settled.effect_revision = u64::MAX;
        assert!(case
            .attempt(&settled, Event::Begin(Effect::Restore))
            .is_err());
    }
    let case = replacement();
    let mut restored = case.restored();
    restored.effect_revision = u64::MAX;
    assert!(case
        .attempt(&restored, Event::Begin(Effect::Reapply))
        .is_err());
    let mut reapplying = case.advance(case.restored(), Event::Begin(Effect::Reapply));
    reapplying.effect_revision = u64::MAX;
    assert!(case
        .attempt(&reapplying, Event::Complete(Effect::Reapply))
        .is_err());
}

#[test]
fn durable_copy_intent_cannot_be_decoded_as_an_ambiguous_replacement() {
    let case = replacement();
    let mut encoded = serde_json::to_value(&case.intent).unwrap();
    assert_eq!(encoded["operation"]["kind"], "copyReplacement");
    encoded["operation"]["kind"] = "replacement".into();
    assert!(serde_json::from_value::<DurableIntent>(encoded).is_err());
}

#[test]
fn checkpoints_roundtrip_through_their_journal_encoding() {
    for case in cases() {
        for state in [case.settled(), case.restored()] {
            let encoded = serde_json::to_vec(&state).unwrap();
            let decoded: State = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(decoded, state);
            case.intent.checkpoint(&decoded).validate().unwrap();
        }
    }
}

#[test]
fn a_checkpoint_is_only_valid_under_the_kind_evidence_it_was_built_for() {
    // The checkpoint shape is shared; its meaning is not. Artifact and
    // staging evidence one kind recorded is illegal under any other plan.
    let all = cases();
    for (index, case) in all.iter().enumerate() {
        let settled = case.settled();
        for (other_index, other) in all.iter().enumerate() {
            let valid = other.intent.checkpoint(&settled).validate().is_ok();
            assert_eq!(
                valid,
                index == other_index,
                "{} under {}",
                case.name,
                other.name
            );
        }
    }
}

#[test]
fn disposal_never_automatically_consumes_undo_of_a_forward_record() {
    for case in cases() {
        let settled = case.settled();
        // Every position before settling is an interrupted operation.
        for state in case.walk().iter().filter(|state| **state != settled) {
            assert_eq!(case.intent.checkpoint(state).disposal(), None);
            assert!(case
                .attempt(state, case.decide(state, Decision::Explicit))
                .is_err());
        }
        assert_eq!(
            case.intent.checkpoint(&settled).disposal(),
            Some(Disposal::ExplicitOnly),
            "{}",
            case.name
        );
        assert!(case
            .attempt(&settled, case.decide(&settled, Decision::Automatic))
            .is_err());
        let discarding = case.advance(settled.clone(), case.decide(&settled, Decision::Explicit));
        // A journaled decision consumed the record's inverse.
        assert!(case
            .attempt(&discarding, Event::Begin(Effect::Restore))
            .is_err());
        assert!(case
            .attempt(&discarding, case.decide(&settled, Decision::Automatic))
            .is_err());
        // An unchanged decision may be reasserted after a crash.
        assert_eq!(
            case.advance(
                discarding.clone(),
                case.decide(&discarding, Decision::Explicit)
            ),
            discarding
        );
    }
}

#[test]
fn restored_disposal_is_automatic_only_when_the_retained_copy_is_provably_redundant() {
    let expectations = [
        (replacement(), Disposal::AutomaticWhenSourceIntact),
        (fast_path(), Disposal::AutomaticWhenSourceIntact),
        (same_volume_overwrite(), Disposal::AutomaticWhenSourceIntact),
        (cross_volume(), Disposal::AutomaticWhenSourceIntact),
    ];
    for (case, expected) in expectations {
        assert_eq!(
            case.intent.checkpoint(&case.restored()).disposal(),
            Some(expected),
            "{}",
            case.name
        );
    }
    // A directory or symlink payload has no recursive version that could
    // prove the retained copy redundant, so it needs an explicit decision.
    for (mut case, directory) in [
        (replacement(), true),
        (cross_volume(), true),
        (cross_volume(), false),
    ] {
        match &mut case.intent.operation {
            OperationSpec::CopyReplacement(spec) => spec.source_version.directory = directory,
            OperationSpec::Move(spec) => {
                spec.source_version.directory = directory;
                spec.source_version.symlink = !directory;
            }
        }
        assert_eq!(
            case.kind().restored_disposal(),
            Disposal::ExplicitOnly,
            "{}",
            case.name
        );
    }
}

#[test]
fn retirement_requires_each_root_intent_and_completion_in_order() {
    for case in cases().into_iter().filter(rooted) {
        let settled = case.settled();
        let state = case.advance(settled.clone(), case.decide(&settled, Decision::Explicit));
        assert!(case.attempt(&state, Event::RetirementCompleted).is_err());
        let sides: Vec<Side> = [Side::Source, Side::Target]
            .into_iter()
            .filter(|side| case.kind().root(*side).is_some())
            .collect();
        let mut state = state;
        for (index, side) in sides.iter().enumerate() {
            assert!(case.attempt(&state, Event::RootRetired(*side)).is_err());
            // A later root never begins before an earlier one is removed.
            for later in &sides[index + 1..] {
                assert!(case
                    .attempt(&state, Event::BeginRootRetirement(*later))
                    .is_err());
            }
            state = case.advance(state, Event::BeginRootRetirement(*side));
            state = case.advance(state, Event::RootRetired(*side));
            if index + 1 < sides.len() {
                assert!(case.attempt(&state, Event::RetirementCompleted).is_err());
            }
        }
        let completed = case.advance(state, Event::RetirementCompleted);
        case.intent.checkpoint(&completed).validate().unwrap();
        assert!(completed.retirable_record());
        assert_eq!(completed.retained_bytes, Some(0));
    }
}

#[test]
fn cleanup_plan_rejects_duplicate_foreign_and_non_directory_child_authority() {
    let case = cross_volume();
    let state = case.settled();
    let plan = case.plans(&state).source.unwrap();
    let MoveSpec {
        source_root,
        source_version,
        ..
    } = case.intent.operation.move_spec().unwrap().clone();
    let root = &source_root.unwrap().path.0;
    for suffix in ["parked", "foreign", "parked/child"] {
        let mut encoded = serde_json::to_value(&plan).unwrap();
        let entries = encoded["entries"].as_array_mut().unwrap();
        let mut extra = entries[0].clone();
        extra["path"] = serde_json::to_value(NativePath(root.join(suffix))).unwrap();
        entries.push(extra);
        let forged: Plan = serde_json::from_value(encoded).unwrap();
        assert!(
            forged
                .validate(
                    root,
                    Some(("parked", std::slice::from_ref(&source_version)))
                )
                .is_err(),
            "{suffix}"
        );
    }
}

#[test]
fn cleanup_plan_budget_bounds_encoded_checkpoint_and_completed_roots_release_it() {
    let case = cross_volume();
    let settled = case.settled();
    let state = case.advance(settled.clone(), case.decide(&settled, Decision::Explicit));
    let state = case.advance(state, Event::BeginRootRetirement(Side::Source));
    let state = case.advance(state, Event::RootRetired(Side::Source));
    let encoded = serde_json::to_value(&state).unwrap();
    assert!(
        encoded["retirement"]["plans"]["source"].is_null(),
        "completed root must not grow the next root's checkpoint"
    );
    let state = case.advance(state, Event::BeginRootRetirement(Side::Target));
    let bytes = serde_json::to_vec(&OperationCheckpoint {
        intent_digest: [0; 32],
        state,
    })
    .unwrap();
    assert!(bytes.len() < crate::files::recovery::journal::MAX_RECORD_BYTES);

    // Entry count alone is not a byte bound: long native paths must exhaust
    // the plan budget well before reaching 65,536 entries.
    let root = Path::new("/volume/private");
    let mut top = version(7, 10);
    top.directory = true;
    top.mode = 0o40700;
    let mut encoded =
        serde_json::to_value(Plan::single(NativePath(root.join("parked")), top.clone())).unwrap();
    let entries = encoded["entries"].as_array_mut().unwrap();
    let long = "x".repeat(2000);
    for index in 0..4200 {
        let child = Plan::single(
            NativePath(root.join("parked").join(format!("{long}{index}"))),
            version(7, 20 + index),
        );
        entries.push(serde_json::to_value(child).unwrap()["entries"][0].clone());
    }
    let plan: Plan = serde_json::from_value(encoded).unwrap();
    let error = plan.validate(root, Some(("parked", &[top]))).unwrap_err();
    assert!(error.to_string().contains("byte budget"), "{error}");
}

#[test]
fn an_untouched_discard_decision_withdraws_to_the_exact_prior_history_position() {
    for case in cases().into_iter().filter(rooted) {
        let settled = case.settled();
        let deciding = case.advance(settled.clone(), case.decide(&settled, Decision::Explicit));
        let first = if case.kind().root(Side::Source).is_some() {
            Side::Source
        } else {
            Side::Target
        };
        // Both a pure decision and one whose first root intent is journaled
        // return to the same stable position, revision and Undo eligibility.
        let removing = case.advance(deciding.clone(), Event::BeginRootRetirement(first));
        for retiring in [deciding, removing.clone()] {
            let errored = case.advance(retiring, Event::ReportError("endpoint changed".into()));
            let withdrawn = case.advance(errored, Event::WithdrawRetirement);
            assert_eq!(withdrawn, settled, "{}", case.name);
            // History-eligible again: the same decision can be journaled anew.
            case.advance(
                withdrawn.clone(),
                case.decide(&withdrawn, Decision::Explicit),
            );
            assert!(case
                .attempt(&withdrawn, Event::Begin(Effect::Restore))
                .is_ok());
        }
        // Once any root is retired the decision can only be completed.
        let mut retired = case.advance(removing, Event::RootRetired(first));
        assert!(case.attempt(&retired, Event::WithdrawRetirement).is_err());
        if first == Side::Source {
            retired = case.advance(retired, Event::BeginRootRetirement(Side::Target));
            retired = case.advance(retired, Event::RootRetired(Side::Target));
        }
        let completed = case.advance(retired, Event::RetirementCompleted);
        assert!(case.attempt(&completed, Event::WithdrawRetirement).is_err());
        // Without a decision there is nothing to withdraw.
        assert!(case.attempt(&settled, Event::WithdrawRetirement).is_err());
    }
}

#[test]
fn only_an_automatically_retirable_record_defers_cleanup_and_a_decision_clears_it() {
    let defer = |reason: &str| Event::DeferRetirement(reason.into());
    for case in cases().into_iter().filter(rooted) {
        let settled = case.settled();
        // Nothing discards an explicit-only record automatically, so it has
        // nothing to defer; neither has a restoration still under way.
        assert!(case.attempt(&settled, defer("read-only")).is_err());
        let restoring = case.advance(settled, Event::Begin(Effect::Restore));
        assert!(case.attempt(&restoring, defer("read-only")).is_err());
        let restored = case.advance(restoring, Event::Complete(Effect::Restore));
        assert!(!restored.awaits_retry());
        let oversized = "x".repeat(crate::files::recovery::model::MAX_ERROR_BYTES + 1);
        assert!(case.attempt(&restored, defer(&oversized)).is_err());
        let deferred = case.advance(restored, defer("read-only"));
        assert_eq!(deferred.deferred.as_deref(), Some("read-only"));
        assert!(deferred.awaits_retry(), "enforcement would claim it again");
        // The user's retry journals a decision, which supersedes the deferral.
        let deciding = case.advance(
            deferred.clone(),
            case.decide(&deferred, Decision::Automatic),
        );
        assert_eq!(deciding.deferred, None);
        assert!(!deciding.awaits_retry());
        assert!(case.attempt(&deciding, defer("read-only")).is_err());
        // A decoded checkpoint carrying a deferral it could never have
        // reached is rejected rather than trusted.
        let explicit = State {
            deferred: Some("read-only".into()),
            ..case.settled()
        };
        let decided = State {
            deferred: Some("read-only".into()),
            ..deciding
        };
        for forged in [explicit, decided] {
            assert!(
                case.intent.checkpoint(&forged).validate().is_err(),
                "{}",
                case.name
            );
        }
    }
}

#[test]
fn measurement_is_accounting_for_settled_records_only_and_any_phase_change_clears_it() {
    for case in cases() {
        for state in case.walk() {
            let measured = case.attempt(&state, Event::RetentionMeasured(7));
            let settled = case.intent.checkpoint(&state).disposal().is_some();
            assert_eq!(
                measured.is_ok(),
                settled,
                "{} at {:?}",
                case.name,
                state.phase
            );
            let Ok(measured) = measured else { continue };
            assert_eq!(measured.retained_bytes, Some(7));
            assert_eq!(measured.phase, state.phase);
            let restoring = case.advance(measured, Event::Begin(Effect::Restore));
            assert_eq!(restoring.retained_bytes, None);
        }
    }
}
