use super::*;
use crate::files::recovery::{
    model::{EntryVersion, LockIdentity, NativePath, OperationRecord, OperationSpec},
    move_model::{ArtifactPlan, MoveState},
    resources::{Access, Resource, Scope},
};
use std::path::Path;

const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TARGET_TOKEN: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

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

fn resource(path: &str, identity: Option<ObjectId>, parent: ObjectId) -> Resource {
    let depth = Path::new(path).parent().unwrap().ancestors().count();
    let mut ancestors = vec![parent];
    ancestors.extend((1..depth).map(|index| object(99, index as u64)));
    Resource {
        path: NativePath(path.into()),
        object: identity,
        ancestors,
        access: Access::Write,
        scope: Scope::Subtree,
    }
}

fn plan(path: &str, token: &str) -> ArtifactPlan {
    ArtifactPlan {
        path: NativePath(path.into()),
        token: token.into(),
    }
}

fn intent(spec: MoveSpec, resources: Vec<Resource>) -> DurableIntent {
    DurableIntent {
        version: 1,
        id: ID.into(),
        lock: LockIdentity {
            name: format!("{ID}.lock"),
            object: object(7, 30),
            nonce: "b".repeat(64),
        },
        resources,
        operation: OperationSpec::Move(spec),
    }
}

/// Same filesystem, no overwrite: one atomic no-replace rename, no artifacts.
fn fast_path() -> (DurableIntent, OperationState) {
    let parent = object(7, 10);
    let source_version = version(7, 11);
    let spec = MoveSpec {
        rename_probes: None,
        source: NativePath("/volume/source".into()),
        source_parent: parent,
        source_version: source_version.clone(),
        target: NativePath("/volume/target".into()),
        target_parent: parent,
        target_original: None,
        strategy: Strategy::Rename,
        source_root: None,
        target_root: None,
    };
    let resources = vec![
        resource("/volume/source", Some(source_version.object), parent),
        resource("/volume/target", None, parent),
    ];
    start(spec, resources)
}

/// Same filesystem, overwriting: the displaced original needs private storage.
fn same_volume_overwrite() -> (DurableIntent, OperationState) {
    let parent = object(7, 10);
    let source_version = version(7, 11);
    let original = version(7, 12);
    let root_path = format!("/volume/.tauri-explorer-recovery-{TARGET_TOKEN}");
    let spec = MoveSpec {
        rename_probes: None,
        source: NativePath("/volume/source".into()),
        source_parent: parent,
        source_version: source_version.clone(),
        target: NativePath("/volume/target".into()),
        target_parent: parent,
        target_original: Some(original.clone()),
        strategy: Strategy::Rename,
        source_root: None,
        target_root: Some(plan(&root_path, TARGET_TOKEN)),
    };
    let resources = vec![
        resource("/volume/source", Some(source_version.object), parent),
        resource("/volume/target", Some(original.object), parent),
        resource(&root_path, None, parent),
    ];
    start(spec, resources)
}

/// Cross filesystem, overwriting: stage a copy, displace, publish, then park.
fn cross_volume() -> (DurableIntent, OperationState) {
    let source_parent = object(7, 10);
    let target_parent = object(8, 20);
    let source_version = version(7, 11);
    let original = version(8, 21);
    let source_root = format!("/source-volume/.tauri-explorer-recovery-{SOURCE_TOKEN}");
    let target_root = format!("/target-volume/.tauri-explorer-recovery-{TARGET_TOKEN}");
    let spec = MoveSpec {
        rename_probes: None,
        source: NativePath("/source-volume/source".into()),
        source_parent,
        source_version: source_version.clone(),
        target: NativePath("/target-volume/target".into()),
        target_parent,
        target_original: Some(original.clone()),
        strategy: Strategy::CopyParked,
        source_root: Some(plan(&source_root, SOURCE_TOKEN)),
        target_root: Some(plan(&target_root, TARGET_TOKEN)),
    };
    let resources = vec![
        resource(
            "/source-volume/source",
            Some(source_version.object),
            source_parent,
        ),
        resource(
            "/target-volume/target",
            Some(original.object),
            target_parent,
        ),
        resource(&source_root, None, source_parent),
        resource(&target_root, None, target_parent),
    ];
    start(spec, resources)
}

fn start(spec: MoveSpec, resources: Vec<Resource>) -> (DurableIntent, OperationState) {
    let intent = intent(spec, resources);
    intent.validate().unwrap();
    let record = OperationRecord::planned(intent);
    record.validate().unwrap();
    (record.intent, record.state)
}

fn advance(intent: &DurableIntent, state: OperationState, event: MoveTransition) -> OperationState {
    transition(intent, &state, event).unwrap()
}

fn state_of(state: &OperationState) -> MoveState {
    state.move_state().unwrap().clone()
}

fn to_published(intent: &DurableIntent, state: OperationState) -> OperationState {
    let spec = intent.operation.move_spec().unwrap().clone();
    let mut state = state;
    if spec.source_root.is_some() || spec.target_root.is_some() {
        state = advance(intent, state, MoveTransition::BeginRoots);
        state = advance(
            intent,
            state,
            MoveTransition::RootsObserved {
                source: spec.source_root.as_ref().map(|_| object(7, 50)),
                // An artifact root always shares its owning parent's volume.
                target: spec.target_root.as_ref().map(|_| {
                    if spec.strategy == Strategy::CopyParked {
                        object(8, 51)
                    } else {
                        object(7, 51)
                    }
                }),
            },
        );
        state = advance(intent, state, MoveTransition::BeginManifests);
        state = advance(intent, state, MoveTransition::ManifestsCompleted);
    }
    if spec.strategy == Strategy::CopyParked {
        state = advance(intent, state, MoveTransition::BeginStaging);
        state = advance(
            intent,
            state,
            MoveTransition::StagingCompleted(payload(version(8, 60))),
        );
    }
    if spec.target_original.is_some() {
        state = advance(intent, state, MoveTransition::BeginDisplacement);
        state = advance(intent, state, MoveTransition::DisplacementCompleted);
    }
    state = advance(intent, state, MoveTransition::BeginPublication);
    advance(intent, state, MoveTransition::PublicationCompleted)
}

#[test]
fn planned_move_begins_unpublished_with_no_artifact_evidence() {
    for (intent, state) in [fast_path(), same_volume_overwrite(), cross_volume()] {
        let state = state_of(&state);
        assert_eq!(state.phase, MovePhase::Planned);
        assert_eq!(state.effect_revision, 0);
        assert_eq!(state.source_root, None);
        assert_eq!(state.target_root, None);
        assert_eq!(state.staged, None);
        assert!(intent.validate().is_ok());
    }
}

#[test]
fn same_filesystem_fast_path_publishes_without_private_storage() {
    let (intent, state) = fast_path();
    let published = to_published(&intent, state.clone());
    let published = state_of(&published);
    assert_eq!(published.phase, MovePhase::Published);
    assert_eq!(published.effect_revision, 1);
    assert_eq!(published.staged, None);
    assert_eq!(published.source_root, None);

    // No artifact-bearing phase is reachable without a planned root.
    for event in [
        MoveTransition::BeginRoots,
        MoveTransition::BeginStaging,
        MoveTransition::BeginDisplacement,
    ] {
        assert!(transition(&intent, &state, event).is_err());
    }
}

#[test]
fn every_move_publishes_before_it_parks_or_removes_its_source() {
    let (intent, planned) = cross_volume();
    // Parking and removal are unreachable from every pre-publication phase.
    let mut state = planned;
    for step in [
        MoveTransition::BeginRoots,
        MoveTransition::RootsObserved {
            source: Some(object(7, 50)),
            target: Some(object(8, 51)),
        },
        MoveTransition::BeginManifests,
        MoveTransition::ManifestsCompleted,
        MoveTransition::BeginStaging,
        MoveTransition::StagingCompleted(payload(version(8, 60))),
        MoveTransition::BeginDisplacement,
        MoveTransition::DisplacementCompleted,
        MoveTransition::BeginPublication,
    ] {
        for forbidden in [
            MoveTransition::BeginPark,
            MoveTransition::ParkCompleted,
            MoveTransition::BeginSourceRemoval,
            MoveTransition::SourceRemoved,
        ] {
            assert!(
                transition(&intent, &state, forbidden).is_err(),
                "parking or removal was legal at {:?}",
                state_of(&state).phase
            );
        }
        state = advance(&intent, state, step);
    }
    let state = advance(&intent, state, MoveTransition::PublicationCompleted);
    assert_eq!(state_of(&state).phase, MovePhase::Published);

    // Removal is legal only after parking is durably recorded.
    assert!(transition(&intent, &state, MoveTransition::BeginSourceRemoval).is_err());
    let state = advance(&intent, state, MoveTransition::BeginPark);
    assert!(transition(&intent, &state, MoveTransition::BeginSourceRemoval).is_err());
    let state = advance(&intent, state, MoveTransition::ParkCompleted);
    let state = advance(&intent, state, MoveTransition::BeginSourceRemoval);
    let state = advance(&intent, state, MoveTransition::SourceRemoved);
    assert_eq!(state_of(&state).phase, MovePhase::Removed);
}

#[test]
fn a_removed_source_has_no_exact_original_left_to_restore() {
    let (intent, state) = cross_volume();
    let state = to_published(&intent, state);
    let state = advance(&intent, state, MoveTransition::BeginPark);
    let parked = advance(&intent, state, MoveTransition::ParkCompleted);
    // Restoration is offered while the parked source still exists.
    assert!(transition(&intent, &parked, MoveTransition::BeginRestoration).is_ok());

    let removed = advance(&intent, parked, MoveTransition::BeginSourceRemoval);
    let removed = advance(&intent, removed, MoveTransition::SourceRemoved);
    assert!(transition(&intent, &removed, MoveTransition::BeginRestoration).is_err());
}

#[test]
fn the_restoration_origin_survives_an_interrupted_restoration() {
    let (intent, state) = cross_volume();
    let spec = intent.operation.move_spec().unwrap();
    // A cross-filesystem restoration always reaches the source through private
    // storage, including when retried from `RestoreIntent`. Deriving it from
    // the phase would forget the parked source and strand it permanently.
    assert_eq!(restoration_source(spec), RestorationSource::Parked);
    let published = to_published(&intent, state);
    let parked = advance(&intent, published, MoveTransition::BeginPark);
    let parked = advance(&intent, parked, MoveTransition::ParkCompleted);
    let restoring = advance(&intent, parked, MoveTransition::BeginRestoration);
    assert_eq!(state_of(&restoring).phase, MovePhase::RestoreIntent);
    assert_eq!(restoration_source(spec), RestorationSource::Parked);
    // The interrupted restoration is reassertable, not terminal.
    let retried = advance(&intent, restoring, MoveTransition::BeginRestoration);
    assert_eq!(state_of(&retried).phase, MovePhase::RestoreIntent);

    let (rename, state) = same_volume_overwrite();
    let published = to_published(&rename, state);
    assert_eq!(state_of(&published).phase, MovePhase::Published);
    assert_eq!(
        restoration_source(rename.operation.move_spec().unwrap()),
        RestorationSource::Published
    );
}

#[test]
fn source_removal_advances_the_revision_so_a_position_names_one_state() {
    let (intent, state) = cross_volume();
    let state = to_published(&intent, state);
    let state = advance(&intent, state, MoveTransition::BeginPark);
    let parked = advance(&intent, state, MoveTransition::ParkCompleted);
    let completed = state_of(&parked).effect_revision;

    let removing = advance(&intent, parked, MoveTransition::BeginSourceRemoval);
    let removed = advance(&intent, removing, MoveTransition::SourceRemoved);
    assert!(
        state_of(&removed).effect_revision > completed,
        "a caller holding the completed move's revision must not match a removed record"
    );
}

#[test]
fn public_effects_advance_the_revision_monotonically_and_intents_do_not() {
    let (intent, state) = cross_volume();
    let mut observed = Vec::new();
    let mut state = to_published(&intent, state);
    observed.push(state_of(&state).effect_revision);
    for step in [
        MoveTransition::BeginPark,
        MoveTransition::ParkCompleted,
        MoveTransition::BeginRestoration,
        MoveTransition::RestorationCompleted,
    ] {
        state = advance(&intent, state, step);
        observed.push(state_of(&state).effect_revision);
    }
    // publish, begin-park, park, begin-restore, restore
    assert_eq!(observed, vec![1, 1, 2, 2, 3]);
}

#[test]
fn reasserting_a_transfer_intent_is_idempotent_but_completion_is_not() {
    let (intent, state) = cross_volume();
    let mut state = state;
    for step in [
        MoveTransition::BeginRoots,
        MoveTransition::RootsObserved {
            source: Some(object(7, 50)),
            target: Some(object(8, 51)),
        },
        MoveTransition::BeginManifests,
        MoveTransition::ManifestsCompleted,
        MoveTransition::BeginStaging,
        MoveTransition::StagingCompleted(payload(version(8, 60))),
        MoveTransition::BeginDisplacement,
    ] {
        state = advance(&intent, state, step);
    }
    let repeated = advance(&intent, state.clone(), MoveTransition::BeginDisplacement);
    assert_eq!(state_of(&repeated), state_of(&state));

    let displaced = advance(&intent, state, MoveTransition::DisplacementCompleted);
    // A completion cannot run twice from its completed phase.
    assert!(transition(&intent, &displaced, MoveTransition::DisplacementCompleted).is_err());

    let publishing = advance(&intent, displaced, MoveTransition::BeginPublication);
    let repeated = advance(
        &intent,
        publishing.clone(),
        MoveTransition::BeginPublication,
    );
    assert_eq!(state_of(&repeated), state_of(&publishing));
    assert_eq!(state_of(&repeated).effect_revision, 0);
}

#[test]
fn root_observations_must_match_the_immutable_plan() {
    let (intent, state) = cross_volume();
    let state = advance(&intent, state, MoveTransition::BeginRoots);
    for wrong in [
        MoveTransition::RootsObserved {
            source: None,
            target: Some(object(8, 51)),
        },
        MoveTransition::RootsObserved {
            source: Some(object(7, 50)),
            target: None,
        },
        MoveTransition::RootsObserved {
            source: None,
            target: None,
        },
    ] {
        assert!(transition(&intent, &state, wrong).is_err());
    }
    // An artifact root may not alias the moved source object.
    assert!(transition(
        &intent,
        &state,
        MoveTransition::RootsObserved {
            source: Some(object(7, 11)),
            target: Some(object(8, 51)),
        }
    )
    .is_err());
    // Nor may it live on another device than its own parent.
    assert!(transition(
        &intent,
        &state,
        MoveTransition::RootsObserved {
            source: Some(object(9, 50)),
            target: Some(object(8, 51)),
        }
    )
    .is_err());
}

#[test]
fn a_rename_never_stages_a_payload() {
    for (intent, state) in [fast_path(), same_volume_overwrite()] {
        let published = to_published(&intent, state);
        assert_eq!(state_of(&published).staged, None);
        assert!(transition(&intent, &published, MoveTransition::BeginStaging).is_err());
        assert!(transition(&intent, &published, MoveTransition::BeginPark).is_err());
    }
}

#[test]
fn a_staged_payload_may_not_alias_the_source_target_or_its_artifact_roots() {
    let (intent, state) = cross_volume();
    let mut state = state;
    for step in [
        MoveTransition::BeginRoots,
        MoveTransition::RootsObserved {
            source: Some(object(7, 50)),
            target: Some(object(8, 51)),
        },
        MoveTransition::BeginManifests,
        MoveTransition::ManifestsCompleted,
        MoveTransition::BeginStaging,
    ] {
        state = advance(&intent, state, step);
    }
    for aliased in [
        object(8, 20), // the target parent
        object(8, 21), // the displaced original
        object(8, 51), // the target artifact root
        object(7, 11), // the moved source
        object(9, 60), // another device entirely
    ] {
        assert!(transition(
            &intent,
            &state,
            MoveTransition::StagingCompleted(payload(EntryVersion {
                object: aliased,
                ..version(8, 60)
            }))
        )
        .is_err());
    }
    assert!(transition(
        &intent,
        &state,
        MoveTransition::StagingCompleted(payload(version(8, 60)))
    )
    .is_ok());
}

#[test]
fn errors_are_retained_until_the_next_completion_clears_them() {
    let (intent, state) = cross_volume();
    let state = advance(&intent, state, MoveTransition::BeginRoots);
    let failed = advance(
        &intent,
        state,
        MoveTransition::ReportError("root creation failed".into()),
    );
    assert_eq!(
        state_of(&failed).error.as_deref(),
        Some("root creation failed")
    );
    let retried = advance(
        &intent,
        failed,
        MoveTransition::RootsObserved {
            source: Some(object(7, 50)),
            target: Some(object(8, 51)),
        },
    );
    assert_eq!(state_of(&retried).error, None);

    // An oversized diagnostic is rejected rather than silently stored.
    assert!(transition(
        &intent,
        &retried,
        MoveTransition::ReportError("x".repeat(crate::files::recovery::model::MAX_ERROR_BYTES + 1))
    )
    .is_err());
}

#[test]
fn a_move_checkpoint_cannot_be_driven_as_a_copy_replacement() {
    let (intent, state) = fast_path();
    assert!(state.replacement().is_err());
    assert!(intent.operation.replacement().is_err());
    assert!(crate::files::recovery::replacement_transition::transition(
        &intent,
        &state,
        crate::files::recovery::replacement_transition::ReplacementTransition::BeginRoot,
    )
    .is_err());
}

#[test]
fn move_checkpoints_roundtrip_through_their_journal_encoding() {
    let (intent, state) = cross_volume();
    let state = to_published(&intent, state);
    let state = advance(&intent, state, MoveTransition::BeginPark);
    let parked = advance(&intent, state, MoveTransition::ParkCompleted);
    let encoded = serde_json::to_vec(&parked).unwrap();
    let decoded: OperationState = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded, parked);
    decoded.validate(&intent).unwrap();
}

#[test]
fn move_disposal_never_automatically_consumes_undo() {
    for (intent, state) in [fast_path(), same_volume_overwrite(), cross_volume()] {
        let mut state = to_published(&intent, state);
        if intent.operation.move_spec().unwrap().strategy == Strategy::CopyParked {
            // Published is still an interrupted cross-volume move.
            assert!(transition(
                &intent,
                &state,
                retirement_event(&intent, &state, Decision::Explicit)
            )
            .is_err());
            state = advance(&intent, state, MoveTransition::BeginPark);
            state = advance(&intent, state, MoveTransition::ParkCompleted);
        }
        assert!(transition(
            &intent,
            &state,
            retirement_event(&intent, &state, Decision::Automatic)
        )
        .is_err());
        let discarding = advance(
            &intent,
            state.clone(),
            retirement_event(&intent, &state, Decision::Explicit),
        );
        assert!(transition(&intent, &discarding, MoveTransition::BeginRestoration).is_err());
        assert!(transition(
            &intent,
            &discarding,
            retirement_event(&intent, &state, Decision::Automatic)
        )
        .is_err());
    }
}

#[test]
fn retirement_requires_each_root_intent_and_completion_in_order() {
    let (intent, state) = cross_volume();
    let state = to_published(&intent, state);
    let state = advance(&intent, state, MoveTransition::BeginPark);
    let state = advance(&intent, state, MoveTransition::ParkCompleted);
    let state = advance(
        &intent,
        state.clone(),
        retirement_event(&intent, &state, Decision::Explicit),
    );
    assert!(transition(&intent, &state, MoveTransition::RetirementCompleted).is_err());
    assert!(transition(
        &intent,
        &state,
        MoveTransition::RootRetired(RootSide::Source)
    )
    .is_err());
    assert!(transition(
        &intent,
        &state,
        MoveTransition::BeginRootRetirement(RootSide::Target)
    )
    .is_err());
    let state = advance(
        &intent,
        state.clone(),
        MoveTransition::BeginRootRetirement(RootSide::Source),
    );
    let state = advance(
        &intent,
        state,
        MoveTransition::RootRetired(RootSide::Source),
    );
    assert!(transition(&intent, &state, MoveTransition::RetirementCompleted).is_err());
    let state = advance(
        &intent,
        state.clone(),
        MoveTransition::BeginRootRetirement(RootSide::Target),
    );
    let state = advance(
        &intent,
        state,
        MoveTransition::RootRetired(RootSide::Target),
    );
    advance(&intent, state, MoveTransition::RetirementCompleted)
        .validate(&intent)
        .unwrap();
}

#[test]
fn legacy_move_checkpoints_decode_without_retirement_authority() {
    let (intent, state) = fast_path();
    let state = to_published(&intent, state);
    let mut value = serde_json::to_value(&state).unwrap();
    // Strip new optional fields recursively, like an older release's journal.
    fn legacy(value: &mut serde_json::Value) {
        if let serde_json::Value::Object(fields) = value {
            fields.remove("retirement");
            fields.remove("retained_bytes");
            for child in fields.values_mut() {
                legacy(child);
            }
        }
    }
    legacy(&mut value);
    let decoded: OperationState = serde_json::from_value(value).unwrap();
    decoded.validate(&intent).unwrap();
    assert!(transition(&intent, &decoded, MoveTransition::BeginRestoration).is_ok());
    assert!(transition(
        &intent,
        &decoded,
        retirement_event(&intent, &state, Decision::Automatic)
    )
    .is_err());
}

fn removal_plan(
    intent: &DurableIntent,
    state: &OperationState,
    side: RootSide,
) -> crate::files::recovery::move_cleanup::Plan {
    use crate::files::recovery::{move_cleanup::Plan, move_retention::expected_payload};
    let spec = intent.operation.move_spec().unwrap();
    let root = match side {
        RootSide::Source => &spec.source_root,
        RootSide::Target => &spec.target_root,
    }
    .as_ref()
    .unwrap();
    match expected_payload(spec, state.move_state().unwrap(), side).unwrap() {
        Some((name, versions)) => {
            Plan::single(NativePath(root.path.0.join(name)), versions[0].clone())
        }
        None => Plan::default(),
    }
}

#[test]
fn cleanup_plan_rejects_duplicate_foreign_and_non_directory_child_authority() {
    use crate::files::recovery::move_cleanup::Plan;
    let (intent, state) = cross_volume();
    let state = to_published(&intent, state);
    let state = advance(&intent, state, MoveTransition::BeginPark);
    let state = advance(&intent, state, MoveTransition::ParkCompleted);
    let plan = removal_plan(&intent, &state, RootSide::Source);
    let spec = intent.operation.move_spec().unwrap();
    let root = &spec.source_root.as_ref().unwrap().path.0;
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
                    Some(("parked", std::slice::from_ref(&spec.source_version)))
                )
                .is_err(),
            "{suffix}"
        );
    }
}

#[test]
fn cleanup_plan_budget_bounds_encoded_checkpoint_and_completed_roots_release_it() {
    use crate::files::recovery::{model::OperationCheckpoint, move_cleanup::Plan};
    let (intent, state) = cross_volume();
    let state = to_published(&intent, state);
    let state = advance(&intent, state, MoveTransition::BeginPark);
    let state = advance(&intent, state, MoveTransition::ParkCompleted);
    let state = advance(
        &intent,
        state.clone(),
        retirement_event(&intent, &state, Decision::Explicit),
    );
    let state = advance(
        &intent,
        state,
        MoveTransition::BeginRootRetirement(RootSide::Source),
    );
    let state = advance(
        &intent,
        state,
        MoveTransition::RootRetired(RootSide::Source),
    );
    let encoded = serde_json::to_value(&state).unwrap();
    assert!(
        encoded["state"]["retirement"]["source_plan"].is_null(),
        "completed root must not grow the next root's checkpoint"
    );
    let state = advance(
        &intent,
        state,
        MoveTransition::BeginRootRetirement(RootSide::Target),
    );
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

fn retirement_event(
    intent: &DurableIntent,
    state: &OperationState,
    decision: Decision,
) -> MoveTransition {
    let spec = intent.operation.move_spec().unwrap();
    let existing = state.move_state().unwrap().retirement.as_ref();
    let plan = |side: RootSide, present: bool| {
        if let Some(existing) = existing {
            existing.plan(side).cloned()
        } else {
            present.then(|| removal_plan(intent, state, side))
        }
    };
    MoveTransition::BeginRetirement(
        decision,
        plan(RootSide::Source, spec.source_root.is_some()),
        plan(RootSide::Target, spec.target_root.is_some()),
    )
}
