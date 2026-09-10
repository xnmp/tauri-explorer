use super::*;
use crate::files::recovery::{ReplacementDirection, Runtime};
use std::{fs, path::PathBuf};

struct Fixture {
    _directory: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    storage: PathBuf,
    operations: NativeOperations,
    action: Action,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(directory.path()).unwrap();
        fs::create_dir(base.join("source")).unwrap();
        fs::create_dir(base.join("target")).unwrap();
        let source = base.join("source/item.txt");
        let target = base.join("target/item.txt");
        fs::write(&source, b"copied bytes").unwrap();
        fs::write(&target, b"original bytes").unwrap();
        let runtime = Runtime::default();
        let storage = base.join("app/recovery");
        let mut progress = crate::progress::ProgressTracker::new(
            None,
            "copy-progress",
            "Copy cancelled",
            0,
            0,
            None,
        );
        let receipt = runtime
            .replace_copy(storage.clone(), &source, &target, &mut progress)
            .unwrap();
        let action = Action::Replacement {
            path: receipt.path,
            recovery: Some(receipt.replacement.unwrap().history),
        };
        Self {
            _directory: directory,
            source,
            target,
            storage: storage.clone(),
            operations: NativeOperations {
                recovery: Some((runtime, storage)),
            },
            action,
        }
    }

    fn token(&self) -> crate::files::recovery::ReplacementHistory {
        let Action::Replacement {
            recovery: Some(token),
            ..
        } = &self.action
        else {
            panic!("native replacement receipt");
        };
        token.clone()
    }

    fn runtime(&self) -> &Runtime {
        &self.operations.recovery.as_ref().unwrap().0
    }
}

#[test]
fn native_history_cycles_restore_both_versions_and_replace_the_opposite_revision() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let id = fixture.token().id;
        let mut histories = Histories::default();
        histories.register(1);
        let forward = histories.begin_forward(1, false).unwrap();
        histories.finish_forward(
            forward,
            ForwardEffect::Changed(Some(fixture.action.clone())),
        );
        fs::remove_file(&fixture.source).unwrap();
        for _ in 0..3 {
            for direction in [Direction::Undo, Direction::Redo] {
                fixture
                    .runtime()
                    .inspect(fixture.storage.clone(), id.clone())
                    .await
                    .unwrap();
                let summary = histories.summary(1);
                let entry = match direction {
                    Direction::Undo => summary.undo_id,
                    Direction::Redo => summary.redo_id,
                }
                .unwrap();
                let reservation = histories.begin(1, direction, entry).unwrap();
                let before = reservation.action.clone();
                let result =
                    execution::execute(before.clone(), &fixture.operations, direction).await;
                assert!(result.error.is_none(), "{:?}", result.error);
                assert_eq!(result.completed, Some(before.clone()));
                assert!(result.remaining.is_none() && result.uncertain.is_none());
                let Action::Replacement {
                    recovery: Some(old),
                    ..
                } = before
                else {
                    panic!("native history");
                };
                let Action::Replacement {
                    recovery: Some(next),
                    ..
                } = result.opposite.as_ref().unwrap()
                else {
                    panic!("native opposite");
                };
                assert!(next.revision > old.revision);
                assert_eq!(next.id, old.id);
                histories.finish(reservation, &result);
                assert_eq!(
                    fs::read(&fixture.target).unwrap(),
                    match direction {
                        Direction::Undo => b"original bytes".as_slice(),
                        Direction::Redo => b"copied bytes".as_slice(),
                    }
                );
            }
        }
    });
}

#[test]
fn explicit_recovery_stales_history_without_repeating_the_effect() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let token = fixture.token();
        fixture
            .runtime()
            .execute_history(
                fixture.storage.clone(),
                token,
                ReplacementDirection::Restore,
            )
            .await
            .unwrap();
        let result =
            execution::execute(fixture.action.clone(), &fixture.operations, Direction::Undo).await;
        assert!(result.error.is_some());
        assert_eq!(result.remaining, Some(fixture.action));
        assert!(
            result.opposite.is_none() && result.completed.is_none() && result.uncertain.is_none()
        );
        assert_eq!(fs::read(fixture.target).unwrap(), b"original bytes");
    });
}

#[test]
fn changed_public_file_retains_evidence_and_consumes_the_uncertain_inverse() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        fs::write(&fixture.target, b"external edit").unwrap();
        let result =
            execution::execute(fixture.action.clone(), &fixture.operations, Direction::Undo).await;
        assert!(result.error.is_some());
        assert_eq!(result.uncertain, Some(fixture.action.clone()));
        assert!(
            result.opposite.is_none() && result.remaining.is_none() && result.completed.is_none()
        );
        assert_eq!(fs::read(&fixture.target).unwrap(), b"external edit");
        let root = fs::read_dir(fixture.target.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tauri-explorer-recovery-")
            })
            .unwrap()
            .path();
        assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
        assert_eq!(
            execution_affected(&result),
            vec![fixture
                .target
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
    });
}

#[test]
fn history_eviction_and_clear_do_not_retire_recovery_artifacts() {
    tauri::async_runtime::block_on(async {
        for clear in [false, true] {
            let fixture = Fixture::new();
            let token = fixture.token();
            let mut histories = Histories::default();
            histories.register(1);
            histories
                .push(1, Some(fixture.action.clone()), false)
                .unwrap();
            if clear {
                histories.clear(1);
            } else {
                for index in 0..300 {
                    histories
                        .push(
                            1,
                            Some(Action::Rename {
                                path: fixture.target.to_string_lossy().into_owned(),
                                old_name: format!("old{index}"),
                                new_name: "new".into(),
                            }),
                            false,
                        )
                        .unwrap();
                }
            }
            let inventory = fixture
                .runtime()
                .list(fixture.storage.clone())
                .await
                .unwrap();
            assert!(inventory.items.iter().any(|item| item.id == token.id));
            fixture
                .runtime()
                .execute_history(
                    fixture.storage.clone(),
                    token,
                    ReplacementDirection::Restore,
                )
                .await
                .unwrap();
            assert_eq!(fs::read(fixture.target).unwrap(), b"original bytes");
        }
    });
}
