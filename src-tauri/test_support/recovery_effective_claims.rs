use super::super::test_fixture::{fixture, writing};
use super::*;
use crate::files::recovery::{model::OperationSpec, replacement_execution::ReplacementExecution};

pub(super) fn published() -> (tempfile::TempDir, Arc<Coordinator>, ReplacementExecution) {
    let (directory, coordinator, reservation, spec) = fixture();
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
    (directory, coordinator, execution)
}

#[test]
fn completed_copy_releases_public_paths_only_after_its_worker_releases_ownership() {
    let (directory, coordinator, execution) = published();
    let base = directory.path();
    assert!(coordinator.reserve(writing(&base.join("target"))).is_err());
    assert!(coordinator.reserve(writing(&base.join("source"))).is_err());
    drop(execution);
    let restarted = Coordinator::open(&base.join("recovery")).unwrap();
    for name in ["source", "target"] {
        restarted
            .reserve(writing(&base.join(name)))
            .expect("completed copy must not freeze public entries")
            .finish()
            .unwrap();
    }
    for name in [
        ".tauri-explorer-recovery-artifacts",
        ".tauri-explorer-recovery-artifacts/original",
    ] {
        assert!(restarted.reserve(writing(&base.join(name))).is_err());
    }
    assert_eq!(fs::read(base.join("target")).unwrap(), b"new content");
    assert_eq!(
        fs::read(base.join(".tauri-explorer-recovery-artifacts/original")).unwrap(),
        b"original content"
    );
}

#[test]
fn recovery_claim_reacquires_full_authority_before_any_effect() {
    let (directory, coordinator, execution) = published();
    let id = execution.operation.intent().id.clone();
    let generation = execution.operation.generation();
    drop(execution);
    let writing_target = coordinator
        .reserve(writing(&directory.path().join("target")))
        .unwrap();
    assert!(coordinator.try_claim(&id, generation).is_err());
    writing_target.finish().unwrap();
    let claimed = coordinator.try_claim(&id, generation).unwrap().unwrap();
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    assert!(coordinator
        .reserve(writing(&directory.path().join("source")))
        .is_err());
    drop(claimed);
    coordinator
        .reserve(writing(&directory.path().join("target")))
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn restored_copy_releases_the_original_and_protects_the_private_publication_identity() {
    let (directory, coordinator, mut execution) = published();
    execution.restore_copy().unwrap();
    drop(execution);
    let base = directory.path();
    coordinator
        .reserve(writing(&base.join("target")))
        .unwrap()
        .finish()
        .unwrap();
    let alias = base.join("copied-hardlink");
    fs::hard_link(
        base.join(".tauri-explorer-recovery-artifacts/publication"),
        &alias,
    )
    .unwrap();
    assert!(
        coordinator.reserve(writing(&alias)).is_err(),
        "retained payload identity survives aliases"
    );
    assert_eq!(fs::read(base.join("target")).unwrap(), b"original content");
}

#[test]
fn retained_root_and_original_remain_protected_through_native_aliases() {
    let (directory, coordinator, execution) = published();
    let OperationSpec::CopyReplacement(spec) = execution.operation.intent().operation.clone()
    else {
        panic!("expected copy replacement fixture");
    };
    drop(execution);
    let alias = directory.path().join("original-hardlink");
    fs::hard_link(spec.root.0.join("original"), &alias).unwrap();
    assert!(coordinator.reserve(writing(&alias)).is_err());
    let relocated = directory.path().join("relocated-artifacts");
    fs::rename(&spec.root.0, &relocated).unwrap();
    assert!(
        coordinator.reserve(writing(&relocated)).is_err(),
        "known artifact root identity must remain protected"
    );
    assert!(coordinator
        .reserve(writing(&relocated.join("original")))
        .is_err());
}

#[test]
fn independent_process_sees_admission_exclusion_after_idle_owner_probe_is_closed() {
    let (directory, coordinator, execution) = published();
    let id = execution.operation.intent().id.clone();
    let generation = execution.operation.generation();
    let lock_name = execution.operation.intent().lock.name.clone();
    drop(execution);
    let revision = coordinator
        .admitted(|inner| inner.journal.revision())
        .unwrap();
    let requests = writing(&directory.path().join("target"));
    let resources = resources::capture_requests(&requests).unwrap();
    let reserved = coordinator
        .try_reserve_with(Ok(resources), revision, requests.len(), || {
            // The child probes the actual OS locks nonblockingly. This is not an
            // absence-of-response timing assertion: it positively reports Busy for
            // admission, while the short-lived idle owner probe is already closed.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "files::recovery::coordinator::claims::tests::independent_gate_probe",
                    "--ignored",
                ])
                .env("TAURI_TEST_EFFECTIVE_CLAIM_BASE", directory.path())
                .env("TAURI_TEST_EFFECTIVE_CLAIM_LOCK", &lock_name)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let report: serde_json::Value = serde_json::from_slice(
                &fs::read(directory.path().join("gate-report.json")).unwrap(),
            )
            .unwrap();
            assert_ne!(report["pid"], std::process::id());
            assert_eq!(report["admissionBusy"], true);
            assert_eq!(report["idleOwnerAvailable"], true);
        })
        .unwrap()
        .unwrap();
    let peer = Coordinator::open(&directory.path().join("recovery")).unwrap();
    assert!(
        peer.try_claim(&id, generation).is_err(),
        "reservation must be committed before admission reopens"
    );
    reserved.finish().unwrap();
    assert!(peer.try_claim(&id, generation).unwrap().is_some());
}

#[test]
#[ignore = "child-only nonblocking native lock probe, launched by its owning test"]
fn independent_gate_probe() {
    let base = PathBuf::from(std::env::var_os("TAURI_TEST_EFFECTIVE_CLAIM_BASE").unwrap());
    let lock_name = std::env::var_os("TAURI_TEST_EFFECTIVE_CLAIM_LOCK").unwrap();
    let admission =
        FileLock::try_acquire(File::open(base.join("recovery").join(GATE)).unwrap()).unwrap();
    let owner =
        FileLock::try_acquire(File::open(base.join("recovery/locks").join(lock_name)).unwrap())
            .unwrap();
    fs::write(base.join("gate-report.json"), serde_json::to_vec(&serde_json::json!({
        "pid":std::process::id(), "admissionBusy":admission.is_none(), "idleOwnerAvailable":owner.is_some(),
    })).unwrap()).unwrap();
}
