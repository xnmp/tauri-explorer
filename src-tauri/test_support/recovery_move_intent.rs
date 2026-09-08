use super::*;
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    native_directory::Directory,
    recovery::{
        model::{
            DurableIntent, NativePath, OperationSpec, OperationState, Phase, ReplacementState,
        },
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
    let reservation = coordinator
        .reserve(vec![writing(&source), writing(&target)])
        .unwrap();
    let spec = MoveSpec {
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
    assert_eq!(operation.state(), &OperationState::Move(Default::default()));
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
    assert_eq!(claimed.state(), &OperationState::Move(Default::default()));
    assert_no_user_effects(directory.path());
}

#[test]
fn move_intent_rejects_a_copy_replacement_checkpoint_kind() {
    let (_directory, _coordinator, reservation, spec) = fixture();
    let intent = DurableIntent {
        version: 1,
        id: reservation.id.clone(),
        lock: reservation.owner.identity.clone(),
        resources: reservation.resources.clone(),
        operation: OperationSpec::Move(spec),
    };
    let mismatched = OperationRecord {
        intent,
        state: OperationState::Replacement(ReplacementState {
            effect_revision: 0,
            root: None,
            phase: Phase::Planned,
            published: None,
            error: None,
        }),
    };
    assert!(mismatched.validate().is_err());
}
