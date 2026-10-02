use super::*;
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    native_directory::Directory,
    recovery::{
        checkpoint::{Sides, State},
        model::{DurableIntent, NativePath, OperationSpec, StagedPayload, RECORD_VERSION},
        move_model::{MoveSpec, Strategy},
        resources::{Access, Request, Scope},
    },
};

fn writing(path: &Path) -> Request {
    Request {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }
}

fn fixture() -> (tempfile::TempDir, Arc<Coordinator>, Reservation, MoveSpec) {
    let directory = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(directory.path()).unwrap();
    let source = base.join("source");
    let target = base.join("target");
    fs::write(&source, b"source payload").unwrap();

    let parent = of_file(&Directory::open(&base).unwrap().file).unwrap();
    let source_version = version_from_metadata(&fs::symlink_metadata(&source).unwrap()).unwrap();
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let probe = super::super::move_model::ArtifactPlan {
        token: "c".repeat(64),
        path: NativePath(base.join(format!(".tauri-explorer-recovery-{}", "c".repeat(64)))),
    };
    let reservation = coordinator
        .reserve(vec![
            writing(&source),
            writing(&target),
            writing(&probe.path.0),
        ])
        .unwrap();
    let spec = MoveSpec {
        rename_probes: super::super::move_capability_model::Plans {
            source: probe,
            target: None,
        },
        source: NativePath(source),
        source_parent: parent,
        source_version,
        target: NativePath(target),
        target_parent: parent,
        target_original: None,
        strategy: Strategy::Rename,
        source_root: None,
        target_root: None,
    };
    (directory, coordinator, reservation, spec)
}

fn assert_no_user_effects(directory: &Path) {
    assert_eq!(
        fs::read(directory.join("source")).unwrap(),
        b"source payload"
    );
    assert!(!directory.join("target").exists());
    assert!(fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .all(|entry| !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".tauri-explorer-recovery-")));
}

#[test]
fn rootless_same_volume_move_survives_reopen_as_intent_without_user_file_effects() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = reservation
        .promote(OperationSpec::Move(spec.clone()))
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let expected = operation.intent().clone();
    let generation = operation.generation();
    assert_eq!(expected.operation, OperationSpec::Move(spec));
    assert_eq!(operation.state(), &State::default());
    assert_no_user_effects(directory.path());

    drop(operation);
    drop(coordinator);
    let reopened = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let inventory = reopened.inventory().unwrap();
    assert_eq!(inventory.entries.len(), 1);
    assert_eq!(inventory.entries[0].intent, expected);
    assert_eq!(inventory.entries[0].generation, Some(generation));

    for path in [
        directory.path().join("source"),
        directory.path().join("target"),
    ] {
        assert!(
            reopened.reserve(vec![writing(&path)]).is_err(),
            "durable move failed to fence {}",
            path.display()
        );
    }
    assert_no_user_effects(directory.path());

    assert!(reopened
        .try_claim_history(&expected.id, 0, HistoryPosition::Published)
        .is_err());
    let claimed = reopened
        .try_claim(&expected.id, generation)
        .unwrap()
        .expect("abandoned move should be generically claimable");
    assert_eq!(claimed.intent(), &expected);
    assert_eq!(claimed.state(), &State::default());
    assert_no_user_effects(directory.path());
}

#[test]
fn move_intent_rejects_checkpoint_evidence_its_plan_never_names() {
    let (_directory, _coordinator, reservation, spec) = fixture();
    let intent = DurableIntent {
        version: RECORD_VERSION,
        id: reservation.id.clone(),
        lock: reservation.owner.identity.clone(),
        resources: reservation.resources.clone(),
        operation: OperationSpec::Move(spec.clone()),
    };
    // A rootless rename never observes an artifact root or stages a copy, so
    // a checkpoint carrying copy-replacement evidence cannot belong to it.
    let rooted = State {
        roots: Sides {
            source: None,
            target: Some(spec.source_parent),
        },
        ..State::default()
    };
    let staged = State {
        staged: Some(StagedPayload {
            version: spec.source_version.clone(),
            final_mode: None,
        }),
        ..State::default()
    };
    for state in [rooted, staged] {
        let mismatched = OperationRecord {
            intent: intent.clone(),
            state,
        };
        assert!(mismatched.validate().is_err());
    }
    // Earlier record versions are rejected, never migrated (ADR 0026).
    let legacy = OperationRecord {
        intent: DurableIntent {
            version: 2,
            ..intent
        },
        state: State::default(),
    };
    assert!(legacy.validate().is_err());
}
