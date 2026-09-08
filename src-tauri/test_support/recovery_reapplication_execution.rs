use super::{
    tests::{checkpoint, fixture, fixture_at_with_initializer, generation, phase},
    *,
};
use crate::files::{
    file_identity::version_from_metadata,
    recovery::{
        coordinator::{Coordinator, HistoryPosition},
        model::{OperationState, Phase},
    },
};
use std::{fs, path::Path};

fn publish(operation: DurableOperation) -> ReplacementExecution {
    let mut execution = ReplacementExecution::prepare(operation).unwrap();
    let mut progress =
        crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None);
    execution.stage_copy(&mut progress).unwrap();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    execution
}

fn reclaim(directory: &Path, id: &str) -> ReplacementExecution {
    let coordinator = Coordinator::open(&directory.join("recovery")).unwrap();
    let operation = coordinator
        .try_claim(id, generation(directory))
        .unwrap()
        .unwrap();
    ReplacementExecution::reopen(operation).unwrap()
}

#[test]
fn repeated_reapplication_preserves_both_objects_after_source_deletion() {
    let (directory, coordinator, operation) = fixture();
    let mut execution = publish(operation);
    let base = directory.path();
    let target = base.join("target");
    let root = base.join(".tauri-explorer-recovery-artifacts");
    let copied = version_from_metadata(&fs::symlink_metadata(&target).unwrap()).unwrap();
    fs::remove_file(base.join("source")).unwrap();
    let id = execution.operation.intent().id.clone();
    for _ in 0..3 {
        execution.restore_copy().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"original bytes");
        assert_eq!(fs::read(root.join("publication")).unwrap(), b"new bytes");
        drop(execution);
        execution = reclaim(base, &id);
        assert_eq!(execution.reapply_copy().unwrap(), copied);
        assert_eq!(phase(base), Phase::Published);
        assert_eq!(fs::read(&target).unwrap(), b"new bytes");
        assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
        assert!(!root.join("publication").exists());
    }
    drop(execution);
    drop(coordinator);
}

#[test]
fn interrupted_reapplication_can_resume_or_restore_after_reclaiming() {
    for boundary in ["park", "publish"] {
        for restore_instead in [false, true] {
            let (directory, coordinator, operation) = fixture();
            let mut execution = publish(operation);
            execution.restore_copy().unwrap();
            let id = execution.operation.intent().id.clone();
            assert!(execution
                .reapply_with(|effect| {
                    assert_eq!(phase(directory.path()), Phase::ReapplyIntent);
                    if effect == boundary {
                        Err(AppError::Other("interrupted reapplication".into()))
                    } else {
                        Ok(())
                    }
                })
                .is_err());
            let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
                panic!("expected copy replacement fixture");
            };
            assert_eq!(state.phase, Phase::ReapplyIntent);
            assert!(state.error.is_some());
            drop(execution);
            drop(coordinator);
            let mut execution = reclaim(directory.path(), &id);
            let root = directory.path().join(".tauri-explorer-recovery-artifacts");
            if restore_instead {
                execution.restore_copy().unwrap();
                assert_eq!(phase(directory.path()), Phase::Restored);
                assert_eq!(
                    fs::read(directory.path().join("target")).unwrap(),
                    b"original bytes"
                );
                assert_eq!(fs::read(root.join("publication")).unwrap(), b"new bytes");
            } else {
                execution.reapply_copy().unwrap();
                assert_eq!(phase(directory.path()), Phase::Published);
                assert_eq!(
                    fs::read(directory.path().join("target")).unwrap(),
                    b"new bytes"
                );
                assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
            }
            let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
                panic!("expected copy replacement fixture");
            };
            assert!(state.error.is_none());
        }
    }
}

#[test]
fn foreign_target_created_after_parking_is_never_overwritten() {
    let (directory, _coordinator, operation) = fixture();
    let mut execution = publish(operation);
    execution.restore_copy().unwrap();
    let target = directory.path().join("target");
    assert!(execution
        .reapply_with(|effect| {
            if effect == "park" {
                fs::write(&target, b"foreign occupant")?;
            }
            Ok(())
        })
        .is_err());
    assert_eq!(fs::read(target).unwrap(), b"foreign occupant");
    let root = directory.path().join(".tauri-explorer-recovery-artifacts");
    assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
    assert_eq!(fs::read(root.join("publication")).unwrap(), b"new bytes");
}

#[test]
fn missing_or_modified_copy_cannot_displace_the_original() {
    for missing in [false, true] {
        let (directory, _coordinator, operation) = fixture();
        let mut execution = publish(operation);
        execution.restore_copy().unwrap();
        let root = directory.path().join(".tauri-explorer-recovery-artifacts");
        let copy = root.join("publication");
        if missing {
            fs::remove_file(&copy).unwrap();
        } else {
            fs::write(&copy, b"externally modified copy").unwrap();
        }
        assert!(execution.reapply_copy().is_err());
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original bytes"
        );
        assert!(!root.join("original").exists());
        if !missing {
            assert_eq!(fs::read(copy).unwrap(), b"externally modified copy");
        }
    }
}

#[test]
fn directory_and_dangling_link_reapplication_preserve_the_copied_payload() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for directory_source in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let (_coordinator, operation) = fixture_at_with_initializer(temporary.path(), |source| {
            if directory_source {
                fs::create_dir(source).unwrap();
                fs::write(source.join("child"), b"copied child").unwrap();
                fs::set_permissions(source, fs::Permissions::from_mode(0o500)).unwrap();
            } else {
                symlink("missing-literal", source).unwrap();
            }
        });
        let mut execution = publish(operation);
        for _ in 0..3 {
            execution.restore_copy().unwrap();
            execution.reapply_copy().unwrap();
            let target = temporary.path().join("target");
            if directory_source {
                assert_eq!(fs::read(target.join("child")).unwrap(), b"copied child");
                assert_eq!(
                    fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
                    0o500
                );
            } else {
                assert_eq!(fs::read_link(target).unwrap(), Path::new("missing-literal"));
            }
        }
        execution.restore_copy().unwrap();
    }
}

#[test]
fn history_revision_survives_inspection_but_rejects_earlier_content_cycles() {
    let (directory, coordinator, operation) = fixture();
    let execution = publish(operation);
    let id = execution.operation.intent().id.clone();
    let OperationState::Replacement(state) = execution.operation.state() else {
        panic!("expected copy replacement fixture");
    };
    let initial_revision = state.effect_revision;
    let initial_generation = execution.operation.generation();
    drop(execution);
    for _ in 0..3 {
        super::super::service::inspect(&coordinator, &id).unwrap();
    }
    assert!(generation(directory.path()) > initial_generation);
    let claimed = coordinator
        .try_claim_history(&id, initial_revision, HistoryPosition::Published)
        .unwrap()
        .unwrap();
    let mut execution = ReplacementExecution::reopen(claimed).unwrap();
    execution.restore_copy().unwrap();
    let OperationState::Replacement(state) = execution.operation.state() else {
        panic!("expected copy replacement fixture");
    };
    assert!(state.effect_revision > initial_revision);
    let restored_revision = state.effect_revision;
    drop(execution);
    assert!(coordinator
        .try_claim_history(&id, initial_revision, HistoryPosition::Published)
        .is_err());
    super::super::service::inspect(&coordinator, &id).unwrap();
    let claimed = coordinator
        .try_claim_history(&id, restored_revision, HistoryPosition::Restored)
        .unwrap()
        .unwrap();
    let mut execution = ReplacementExecution::reopen(claimed).unwrap();
    execution.reapply_copy().unwrap();
    drop(execution);
    // The position cycles back to Published, but its old history token cannot.
    let before = generation(directory.path());
    assert!(coordinator
        .try_claim_history(&id, initial_revision, HistoryPosition::Published)
        .is_err());
    assert_eq!(generation(directory.path()), before);
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"new bytes"
    );
}

#[test]
fn simultaneous_history_claims_have_one_owner_and_pending_effects_require_recovery() {
    let (directory, coordinator, operation) = fixture();
    let execution = publish(operation);
    let id = execution.operation.intent().id.clone();
    let OperationState::Replacement(state) = execution.operation.state() else {
        panic!("expected copy replacement fixture");
    };
    let revision = state.effect_revision;
    drop(execution);
    let peer = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = [coordinator.clone(), peer]
        .into_iter()
        .map(|coordinator| {
            let barrier = barrier.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let claimed = coordinator
                    .try_claim_history(&id, revision, HistoryPosition::Published)
                    .unwrap();
                barrier.wait(); // Keep the winner alive until both attempts finish.
                claimed.is_some()
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>(),
        1
    );
    let claimed = coordinator
        .try_claim_history(&id, revision, HistoryPosition::Published)
        .unwrap()
        .unwrap();
    let mut execution = ReplacementExecution::reopen(claimed).unwrap();
    execution
        .operation
        .advance(ReplacementTransition::BeginRestoration)
        .unwrap();
    drop(execution);
    assert!(coordinator
        .try_claim_history(&id, revision, HistoryPosition::Published)
        .is_err());
    assert!(coordinator
        .try_claim_history(&id, revision, HistoryPosition::Restored)
        .is_err());
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"new bytes"
    );
    let mut recovered = reclaim(directory.path(), &id);
    recovered.restore_copy().unwrap();
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original bytes"
    );
}

#[test]
fn native_process_death_during_reapplication_retains_both_versions() {
    use std::os::unix::fs::PermissionsExt;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for boundary in ["park-rename", "publish-rename", "publish"] {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("reapply-ready");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "files::recovery::replacement_execution::reapplication_tests::subprocess_reapplication", "--ignored", "--nocapture"])
            .env("EXPLORER_REAPPLICATION_FIXTURE", directory.path())
            .env("EXPLORER_REAPPLICATION_BOUNDARY", boundary)
            .stdout(Stdio::null()).stderr(Stdio::inherit()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("reapplication child did not reach {boundary}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let catalog = Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap();
        assert_eq!(catalog.len(), 1);
        let coordinator = Coordinator::open(&directory.path().join("recovery")).unwrap();
        assert!(coordinator
            .try_claim(&catalog[0].id, generation(directory.path()))
            .unwrap()
            .is_none());
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(phase(directory.path()), Phase::ReapplyIntent);
        let mut execution = reclaim(directory.path(), &catalog[0].id);
        execution.reapply_copy().unwrap();
        let target = directory.path().join("target");
        assert_eq!(fs::read(target.join("child")).unwrap(), b"copied child");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o500
        );
        let root = directory.path().join(".tauri-explorer-recovery-artifacts");
        assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
        execution.restore_copy().unwrap();
        assert_eq!(fs::read(target).unwrap(), b"original bytes");
        assert_eq!(
            fs::read(root.join("publication/child")).unwrap(),
            b"copied child"
        );
    }
}

#[test]
#[ignore = "subprocess helper invoked by native_process_death_during_reapplication"]
fn subprocess_reapplication() {
    use std::os::unix::fs::PermissionsExt;
    let base =
        std::path::PathBuf::from(std::env::var_os("EXPLORER_REAPPLICATION_FIXTURE").unwrap());
    let boundary = std::env::var("EXPLORER_REAPPLICATION_BOUNDARY").unwrap();
    assert!(matches!(
        boundary.as_str(),
        "park-rename" | "publish-rename" | "publish"
    ));
    let (_coordinator, operation) = fixture_at_with_initializer(&base, |source| {
        fs::create_dir(source).unwrap();
        fs::write(source.join("child"), b"copied child").unwrap();
        fs::set_permissions(source, fs::Permissions::from_mode(0o500)).unwrap();
    });
    let mut execution = publish(operation);
    execution.restore_copy().unwrap();
    execution
        .reapply_with(|effect| {
            if effect == boundary {
                fs::write(base.join("reapply-ready"), boundary.as_bytes())?;
                loop {
                    std::thread::park();
                }
            }
            Ok(())
        })
        .unwrap();
    panic!("child must stop at the requested effect boundary");
}
