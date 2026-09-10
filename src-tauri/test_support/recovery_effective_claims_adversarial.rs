use super::super::test_fixture::writing;
use super::tests::published;
use super::*;
use crate::files::{
    file_identity::version_from_metadata,
    recovery::{
        model::{NativePath, OperationSpec, ReplacementSpec},
        replacement_execution::ReplacementExecution,
        replacement_transition::ReplacementTransition,
        resources::{Access, Request, Scope},
    },
};

fn publish_successor(coordinator: &Arc<Coordinator>, base: &Path) -> ReplacementExecution {
    let source = base.join("source");
    let target = base.join("target");
    let root = base.join(".tauri-explorer-recovery-successor");
    let reservation = coordinator
        .reserve(vec![
            Request {
                path: source.clone(),
                access: Access::Read,
                scope: Scope::Subtree,
            },
            Request {
                path: target.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
            Request {
                path: root.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
        ])
        .unwrap();
    let spec = OperationSpec::CopyReplacement(ReplacementSpec {
        artifact_token: "successor".into(),
        source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap()).unwrap(),
        source: NativePath(source),
        target: NativePath(target.clone()),
        root: NativePath(root),
        parent: of_file(&Directory::open(base).unwrap().file).unwrap(),
        original: version_from_metadata(&fs::symlink_metadata(target).unwrap()).unwrap(),
    });
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let mut execution = ReplacementExecution::prepare(operation).unwrap();
    execution
        .stage_copy(&mut crate::progress::ProgressTracker::new(
            None,
            "copy",
            "cancelled",
            0,
            0,
            None,
        ))
        .unwrap();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    execution
}

#[test]
fn damaged_completed_evidence_fails_closed_without_touching_public_files() {
    for damage in [
        "checkpoint-missing",
        "checkpoint-malformed",
        "lock-missing",
        "lock-substituted",
    ] {
        let (directory, coordinator, execution) = published();
        let base = directory.path();
        let id = execution.operation.intent().id.clone();
        let generation = execution.operation.generation();
        let lock = base
            .join("recovery/locks")
            .join(&execution.operation.intent().lock.name);
        drop(execution);

        match damage {
            "checkpoint-missing" => coordinator
                .admitted(|inner| inner.journal.remove(&id, generation).map(|_| ()))
                .unwrap(),
            "checkpoint-malformed" => coordinator
                .admitted(|inner| {
                    inner.journal.replace(&id, generation, b"{}")?;
                    Ok(())
                })
                .unwrap(),
            "lock-missing" => fs::remove_file(lock).unwrap(),
            "lock-substituted" => {
                fs::rename(&lock, base.join("retained-owner-lock")).unwrap();
                fs::write(lock, [0_u8; 32]).unwrap();
            }
            _ => unreachable!(),
        }

        assert!(
            coordinator.reserve(writing(&base.join("target"))).is_err(),
            "{damage}"
        );
        let unrelated = coordinator.reserve(writing(&base.join("unrelated")));
        if damage == "checkpoint-missing" {
            unrelated
                .expect("catalog-only authority should remain scoped to its declared resources")
                .finish()
                .unwrap();
        } else {
            assert!(
                unrelated.is_err(),
                "{damage} must fence admission rather than ignore uncertain authority"
            );
        }
        assert_eq!(fs::read(base.join("target")).unwrap(), b"new content");
        assert_eq!(
            fs::read(base.join(".tauri-explorer-recovery-artifacts/original")).unwrap(),
            b"original content"
        );
    }
}

#[test]
fn transfer_intent_and_terminal_error_keep_full_declared_authority() {
    for terminal_error in [false, true] {
        let (directory, coordinator, mut execution) = published();
        let base = directory.path();
        if terminal_error {
            execution
                .operation
                .advance(ReplacementTransition::ReportError(
                    "terminal transfer failure".into(),
                ))
                .unwrap();
        } else {
            execution
                .operation
                .advance(ReplacementTransition::BeginRestoration)
                .unwrap();
        }
        drop(execution);

        for name in ["source", "target"] {
            assert!(
                coordinator.reserve(writing(&base.join(name))).is_err(),
                "{} must retain authority over {name}",
                if terminal_error {
                    "a terminal error"
                } else {
                    "an incomplete transfer intent"
                }
            );
        }
        coordinator
            .reserve(writing(&base.join("unrelated")))
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!(fs::read(base.join("target")).unwrap(), b"new content");
        assert_eq!(
            fs::read(base.join(".tauri-explorer-recovery-artifacts/original")).unwrap(),
            b"original content"
        );
    }
}

#[test]
fn obsolete_completed_replacement_cannot_restore_over_a_successor_publication() {
    let (directory, coordinator, first) = published();
    let base = directory.path();
    let first_id = first.operation.intent().id.clone();
    let first_generation = first.operation.generation();
    drop(first);

    fs::write(base.join("source"), b"successor content").unwrap();
    let successor = publish_successor(&coordinator, base);
    let successor_original = base.join(".tauri-explorer-recovery-successor/original");
    assert_eq!(fs::read(&successor_original).unwrap(), b"new content");
    drop(successor);

    assert!(
        coordinator.try_claim(&first_id, first_generation).is_err(),
        "the first publication identity is now the successor's retained original"
    );
    assert_eq!(fs::read(base.join("target")).unwrap(), b"successor content");
    assert_eq!(fs::read(successor_original).unwrap(), b"new content");
}

#[test]
fn restored_successor_then_restored_predecessor_preserve_both_copied_payloads() {
    let (directory, coordinator, first) = published();
    let base = directory.path();
    let first_id = first.operation.intent().id.clone();
    let first_generation = first.operation.generation();
    drop(first);

    fs::write(base.join("source"), b"successor content").unwrap();
    let mut successor = publish_successor(&coordinator, base);
    successor.restore_copy().unwrap();
    drop(successor);
    assert_eq!(fs::read(base.join("target")).unwrap(), b"new content");
    assert_eq!(
        fs::read(base.join(".tauri-explorer-recovery-successor/publication")).unwrap(),
        b"successor content"
    );

    let claimed = coordinator
        .try_claim(&first_id, first_generation)
        .unwrap()
        .expect("a restored successor no longer owns the predecessor publication");
    let mut predecessor = ReplacementExecution::reopen(claimed).unwrap();
    predecessor.restore_copy().unwrap();
    drop(predecessor);

    assert_eq!(fs::read(base.join("target")).unwrap(), b"original content");
    assert_eq!(
        fs::read(base.join(".tauri-explorer-recovery-artifacts/publication")).unwrap(),
        b"new content"
    );
    assert_eq!(
        fs::read(base.join(".tauri-explorer-recovery-successor/publication")).unwrap(),
        b"successor content"
    );
}
