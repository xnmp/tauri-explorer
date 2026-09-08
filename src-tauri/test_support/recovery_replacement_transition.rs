use super::*;
use crate::files::recovery::{
    model::{
        EntryVersion, LockIdentity, NativePath, OperationRecord, OperationSpec, ReplacementSpec,
        ReplacementState,
    },
    resources::{Access, Resource, Scope},
};

const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn object(inode: u64) -> ObjectId {
    ObjectId::unix(7, inode)
}

fn version(inode: u64) -> EntryVersion {
    EntryVersion {
        object: object(inode),
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

fn resource(path: &str, identity: Option<ObjectId>, access: Access) -> Resource {
    Resource {
        path: NativePath(path.into()),
        object: identity,
        ancestors: vec![object(10), object(1)],
        access,
        scope: Scope::Subtree,
    }
}

fn fixture() -> (DurableIntent, OperationState) {
    let intent = DurableIntent {
        version: 1,
        id: ID.into(),
        lock: LockIdentity {
            name: format!("{ID}.lock"),
            object: object(30),
            nonce: "b".repeat(64),
        },
        resources: vec![
            resource("/volume/source", Some(object(11)), Access::Read),
            resource("/volume/target", Some(object(12)), Access::Write),
            resource(
                "/volume/.tauri-explorer-recovery-artifact",
                None,
                Access::Write,
            ),
        ],
        operation: OperationSpec::CopyReplacement(ReplacementSpec {
            artifact_token: "artifact".into(),
            source: NativePath("/volume/source".into()),
            source_version: version(11),
            target: NativePath("/volume/target".into()),
            root: NativePath("/volume/.tauri-explorer-recovery-artifact".into()),
            parent: object(10),
            original: version(12),
        }),
    };
    let state = OperationRecord::planned(intent.clone()).state;
    intent.validate().unwrap();
    state.validate(&intent).unwrap();
    (intent, state)
}

fn replacement(state: &OperationState) -> &ReplacementState {
    let OperationState::Replacement(state) = state else {
        panic!("expected copy replacement fixture");
    };
    state
}

fn advance(
    intent: &DurableIntent,
    state: OperationState,
    event: ReplacementTransition,
) -> OperationState {
    transition(intent, &state, event).unwrap()
}

fn rooted() -> (DurableIntent, OperationState) {
    let (intent, state) = fixture();
    let state = advance(&intent, state, ReplacementTransition::BeginRoot);
    let state = advance(
        &intent,
        state,
        ReplacementTransition::RootObserved(object(13)),
    );
    (intent, state)
}

fn prepared() -> (DurableIntent, OperationState) {
    let (intent, state) = rooted();
    let state = advance(&intent, state, ReplacementTransition::BeginManifest);
    let state = advance(&intent, state, ReplacementTransition::ManifestCompleted);
    (intent, state)
}

fn staged() -> (DurableIntent, OperationState) {
    let (intent, state) = prepared();
    let state = advance(&intent, state, ReplacementTransition::BeginStaging);
    let state = advance(
        &intent,
        state,
        ReplacementTransition::StagingCompleted(payload(version(14))),
    );
    (intent, state)
}

fn displace_intent() -> (DurableIntent, OperationState) {
    let (intent, state) = staged();
    let state = advance(&intent, state, ReplacementTransition::BeginDisplacement);
    (intent, state)
}

fn displaced() -> (DurableIntent, OperationState) {
    let (intent, state) = displace_intent();
    let state = advance(&intent, state, ReplacementTransition::DisplacementCompleted);
    (intent, state)
}

fn publish_intent() -> (DurableIntent, OperationState) {
    let (intent, state) = displaced();
    let state = advance(&intent, state, ReplacementTransition::BeginPublication);
    (intent, state)
}

fn published() -> (DurableIntent, OperationState) {
    let (intent, state) = publish_intent();
    let state = advance(&intent, state, ReplacementTransition::PublicationCompleted);
    (intent, state)
}

#[test]
fn publication_and_discard_follow_the_complete_legal_sequence() {
    let (intent, mut current) = fixture();
    let original_intent = intent.clone();
    let sequence = [
        (ReplacementTransition::BeginRoot, Phase::RootIntent),
        (
            ReplacementTransition::RootObserved(object(13)),
            Phase::Rooted,
        ),
        (ReplacementTransition::BeginManifest, Phase::ManifestIntent),
        (ReplacementTransition::ManifestCompleted, Phase::Prepared),
        (ReplacementTransition::BeginStaging, Phase::StageIntent),
        (
            ReplacementTransition::StagingCompleted(payload(version(14))),
            Phase::Staged,
        ),
        (
            ReplacementTransition::BeginDisplacement,
            Phase::DisplaceIntent,
        ),
        (
            ReplacementTransition::DisplacementCompleted,
            Phase::Displaced,
        ),
        (
            ReplacementTransition::BeginPublication,
            Phase::PublishIntent,
        ),
        (
            ReplacementTransition::PublicationCompleted,
            Phase::Published,
        ),
        (ReplacementTransition::BeginDiscard, Phase::DiscardIntent),
        (ReplacementTransition::DiscardCompleted, Phase::Discarded),
    ];
    for (event, expected) in sequence {
        current = advance(&intent, current, event);
        assert_eq!(replacement(&current).phase, expected);
    }
    assert_eq!(intent, original_intent);
    assert_eq!(replacement(&current).root, Some(object(13)));
    assert_eq!(replacement(&current).published, Some(payload(version(14))));
}

#[test]
fn restoration_is_legal_from_each_phase_that_can_have_displaced_the_original() {
    for (intent, current) in [
        displace_intent(),
        displaced(),
        publish_intent(),
        published(),
    ] {
        let before = replacement(&current).clone();
        let restoring =
            transition(&intent, &current, ReplacementTransition::BeginRestoration).unwrap();
        assert_eq!(replacement(&restoring).phase, Phase::RestoreIntent);
        assert_eq!(replacement(&restoring).root, before.root);
        assert_eq!(replacement(&restoring).published, before.published);
        let restored = transition(
            &intent,
            &restoring,
            ReplacementTransition::RestorationCompleted,
        )
        .unwrap();
        assert_eq!(replacement(&restored).phase, Phase::Restored);
    }
}

#[test]
fn skips_repeats_and_backtracking_are_rejected_without_mutating_state() {
    let (planned_intent, planned_state) = fixture();
    let (rooted_intent, rooted_state) = rooted();
    let (prepared_intent, prepared_state) = prepared();
    let (staged_intent, staged_state) = staged();
    let (displaced_intent, displaced_state) = displaced();
    let (published_intent, published_state) = published();
    let cases = [
        (
            planned_intent.clone(),
            planned_state.clone(),
            ReplacementTransition::RootObserved(object(13)),
        ),
        (
            planned_intent,
            planned_state,
            ReplacementTransition::BeginDisplacement,
        ),
        (
            rooted_intent,
            rooted_state,
            ReplacementTransition::BeginRoot,
        ),
        (
            prepared_intent,
            prepared_state,
            ReplacementTransition::BeginPublication,
        ),
        (
            staged_intent,
            staged_state,
            ReplacementTransition::PublicationCompleted,
        ),
        (
            displaced_intent,
            displaced_state,
            ReplacementTransition::BeginDiscard,
        ),
        (
            published_intent.clone(),
            published_state.clone(),
            ReplacementTransition::BeginDisplacement,
        ),
        (
            published_intent,
            published_state,
            ReplacementTransition::DiscardCompleted,
        ),
    ];
    for (intent, current, event) in cases {
        let before = current.clone();
        assert!(transition(&intent, &current, event).is_err());
        assert_eq!(current, before);
    }
}

#[test]
fn transitions_reject_invalid_root_staged_version_and_error_evidence() {
    let (intent, state) = fixture();
    let root_intent = advance(&intent, state, ReplacementTransition::BeginRoot);
    assert!(transition(
        &intent,
        &root_intent,
        ReplacementTransition::RootObserved(ObjectId::unix(8, 13))
    )
    .is_err());
    assert!(transition(
        &intent,
        &root_intent,
        ReplacementTransition::RootObserved(object(10))
    )
    .is_err());

    let (intent, prepared) = prepared();
    let staging = advance(&intent, prepared, ReplacementTransition::BeginStaging);
    let mut invalid_version = version(14);
    invalid_version.modified_nanos = 1_000_000_000;
    assert!(transition(
        &intent,
        &staging,
        ReplacementTransition::StagingCompleted(payload(invalid_version))
    )
    .is_err());

    let (intent, state) = fixture();
    assert!(transition(
        &intent,
        &state,
        ReplacementTransition::ReportError("x".repeat(16 * 1024 + 1))
    )
    .is_err());
}

#[test]
fn report_error_preserves_phase_root_staged_evidence_and_intent() {
    let (intent, current) = published();
    let original_intent = intent.clone();
    let next = transition(
        &intent,
        &current,
        ReplacementTransition::ReportError("publication warning".into()),
    )
    .unwrap();
    assert_eq!(intent, original_intent);
    assert_eq!(replacement(&next).phase, Phase::Published);
    assert_eq!(replacement(&next).root, replacement(&current).root);
    assert_eq!(
        replacement(&next).published,
        replacement(&current).published
    );
    assert_eq!(
        replacement(&next).error.as_deref(),
        Some("publication warning")
    );
}

#[test]
fn retry_intents_preserve_the_latest_error_until_native_completion_clears_it() {
    let (intent, mut current) = fixture();
    let steps = [
        (
            ReplacementTransition::BeginRoot,
            ReplacementTransition::RootObserved(object(13)),
        ),
        (
            ReplacementTransition::BeginManifest,
            ReplacementTransition::ManifestCompleted,
        ),
        (
            ReplacementTransition::BeginStaging,
            ReplacementTransition::StagingCompleted(payload(version(14))),
        ),
        (
            ReplacementTransition::BeginDisplacement,
            ReplacementTransition::DisplacementCompleted,
        ),
        (
            ReplacementTransition::BeginPublication,
            ReplacementTransition::PublicationCompleted,
        ),
    ];

    for (begin, completed) in steps {
        current = advance(
            &intent,
            current,
            ReplacementTransition::ReportError("retryable failure".into()),
        );
        current = advance(&intent, current, begin);
        assert_eq!(
            replacement(&current).error.as_deref(),
            Some("retryable failure")
        );
        current = advance(&intent, current, completed);
        assert_eq!(replacement(&current).error, None);
    }

    for (begin, completed) in [
        (
            ReplacementTransition::BeginRestoration,
            ReplacementTransition::RestorationCompleted,
        ),
        (
            ReplacementTransition::BeginDiscard,
            ReplacementTransition::DiscardCompleted,
        ),
    ] {
        let (intent, published) = published();
        let failed = advance(
            &intent,
            published,
            ReplacementTransition::ReportError("resolution failure".into()),
        );
        let resolving = advance(&intent, failed, begin);
        assert_eq!(
            replacement(&resolving).error.as_deref(),
            Some("resolution failure")
        );
        let resolved = advance(&intent, resolving, completed);
        assert_eq!(replacement(&resolved).error, None);
    }
}

#[test]
fn staged_directory_requires_exact_permission_finalization_evidence() {
    let (intent, state) = prepared();
    let copying = advance(&intent, state, ReplacementTransition::BeginStaging);
    let mut directory = version(14);
    directory.directory = true;
    directory.mode = 0o40755;
    let valid = StagedPayload {
        version: directory.clone(),
        final_mode: Some(0o555),
    };
    let staged = transition(
        &intent,
        &copying,
        ReplacementTransition::StagingCompleted(valid.clone()),
    )
    .unwrap();
    assert_eq!(replacement(&staged).published, Some(valid));
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
            version: version(14),
            final_mode: Some(0o600),
        },
    ] {
        assert!(transition(
            &intent,
            &copying,
            ReplacementTransition::StagingCompleted(invalid)
        )
        .is_err());
    }
}

#[test]
fn publication_version_restores_only_the_recorded_directory_permissions() {
    let mut directory = version(14);
    directory.directory = true;
    directory.mode = 0o40755;
    let directory_payload = StagedPayload {
        version: directory.clone(),
        final_mode: Some(0o555),
    };
    let mut expected = directory;
    expected.mode = 0o40555;
    assert_eq!(directory_payload.published_version().unwrap(), expected);
    let file = payload(version(14));
    assert_eq!(file.published_version().unwrap(), file.version);
    assert!(StagedPayload {
        final_mode: Some(0o100555),
        ..directory_payload
    }
    .published_version()
    .is_err());
}

#[test]
fn durable_copy_intent_cannot_be_decoded_as_an_ambiguous_replacement() {
    let (intent, _) = fixture();
    let mut encoded = serde_json::to_value(&intent).unwrap();
    assert_eq!(encoded["operation"]["kind"], "copyReplacement");
    encoded["operation"]["kind"] = "replacement".into();
    assert!(serde_json::from_value::<DurableIntent>(encoded).is_err());
}

#[test]
fn copy_payload_cannot_share_the_source_object() {
    let (intent, prepared) = prepared();
    let staging = advance(&intent, prepared, ReplacementTransition::BeginStaging);
    let OperationSpec::CopyReplacement(spec) = &intent.operation else {
        panic!("expected copy replacement fixture");
    };
    assert!(transition(
        &intent,
        &staging,
        ReplacementTransition::StagingCompleted(payload(spec.source_version.clone()))
    )
    .is_err());
}

#[test]
fn reasserted_transfer_intents_preserve_evidence_and_errors_for_native_reconciliation() {
    let (intent, state) = displace_intent();
    let state = advance(
        &intent,
        state,
        ReplacementTransition::ReportError("retry pending".into()),
    );
    assert_eq!(
        transition(&intent, &state, ReplacementTransition::BeginDisplacement).unwrap(),
        state
    );
    let (intent, state) = publish_intent();
    let state = advance(
        &intent,
        state,
        ReplacementTransition::ReportError("retry pending".into()),
    );
    assert_eq!(
        transition(&intent, &state, ReplacementTransition::BeginPublication).unwrap(),
        state
    );
    let restoring = advance(&intent, state, ReplacementTransition::BeginRestoration);
    assert_eq!(
        transition(&intent, &restoring, ReplacementTransition::BeginRestoration).unwrap(),
        restoring
    );
    let restored = advance(
        &intent,
        restoring,
        ReplacementTransition::RestorationCompleted,
    );
    assert!(replacement(&restored).error.is_none());
    assert!(transition(&intent, &restored, ReplacementTransition::BeginRestoration).is_err());
}

#[test]
fn content_revision_advances_only_when_public_content_is_confirmed() {
    let (intent, mut state) = published();
    assert_eq!(replacement(&state).effect_revision, 1);
    for revision in [2, 4, 6] {
        state = advance(&intent, state, ReplacementTransition::BeginRestoration);
        assert_eq!(replacement(&state).effect_revision, revision - 1);
        state = advance(&intent, state, ReplacementTransition::RestorationCompleted);
        assert_eq!(replacement(&state).effect_revision, revision);
        state = advance(&intent, state, ReplacementTransition::BeginReapplication);
        state = advance(
            &intent,
            state,
            ReplacementTransition::ReportError("retry".into()),
        );
        state = advance(&intent, state, ReplacementTransition::BeginReapplication);
        assert_eq!(replacement(&state).effect_revision, revision);
        state = advance(
            &intent,
            state,
            ReplacementTransition::ReapplicationCompleted,
        );
        assert_eq!(replacement(&state).effect_revision, revision + 1);
        assert!(replacement(&state).error.is_none());
    }
}

#[test]
fn exhausted_content_revision_prevents_intent_before_native_effects() {
    let (intent, mut state) = published();
    let OperationState::Replacement(value) = &mut state else {
        panic!("expected copy replacement fixture");
    };
    value.effect_revision = u64::MAX;
    assert!(transition(&intent, &state, ReplacementTransition::BeginRestoration).is_err());
    let OperationState::Replacement(value) = &mut state else {
        panic!("expected copy replacement fixture");
    };
    value.phase = Phase::Restored;
    assert!(transition(&intent, &state, ReplacementTransition::BeginReapplication).is_err());
    let OperationState::Replacement(value) = &mut state else {
        panic!("expected copy replacement fixture");
    };
    value.phase = Phase::ReapplyIntent;
    assert!(transition(
        &intent,
        &state,
        ReplacementTransition::ReapplicationCompleted
    )
    .is_err());
}

#[test]
fn legacy_checkpoint_without_content_revision_retains_its_evidence() {
    let (_, state) = published();
    let mut encoded = serde_json::to_value(&state).unwrap();
    encoded["state"]
        .as_object_mut()
        .unwrap()
        .remove("effect_revision");
    let decoded: OperationState = serde_json::from_value(encoded).unwrap();
    assert_eq!(replacement(&decoded).effect_revision, 0);
    assert_eq!(replacement(&decoded).root, replacement(&state).root);
    assert_eq!(
        replacement(&decoded).published,
        replacement(&state).published
    );
    assert_eq!(replacement(&decoded).phase, Phase::Published);
}
