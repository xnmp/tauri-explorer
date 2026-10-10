use super::{model::*, Store};
use std::{fs, path::Path, sync::atomic::Ordering};
fn owner(id: &str, incarnation: u64) -> PackageGeneration {
    PackageGeneration {
        package_id: id.into(),
        digest: "a".repeat(64),
        incarnation,
    }
}
fn admission(op: &str, inputs: Vec<ArtifactDescriptor>) -> Admission {
    Admission {
        consumer: owner("consumer", 1),
        provider: owner("provider", 1),
        target: ServiceTarget {
            package_id: "provider".into(),
            service_id: "image-generation".into(),
            major: 1,
        },
        operation_id: op.into(),
        fingerprint: "b".repeat(64),
        phase: AdmissionPhase::Reserved,
        inputs,
        output: None,
        needs_attention: false,
        disposition: None,
        transfer_receipt: None,
    }
}
fn store() -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("service"), Limits::default()).unwrap();
    (root, store)
}
fn png(path: &Path) {
    let image = image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]));
    image.save(path).unwrap();
}
fn capture(s: &Store, root: &Path, op: &str) -> Vec<CapturedArtifact> {
    let path = root.join(format!("{op}.png"));
    png(&path);
    s.capture(
        &owner("consumer", 1),
        op,
        vec![CaptureInput {
            path: path.to_string_lossy().into(),
            expected_digest: None,
        }],
    )
    .unwrap()
}
fn output(s: &Store, op: &str) -> ArtifactDescriptor {
    s.reserve(admission(op, vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), op).unwrap();
    s.accepted(&owner("provider", 1), "consumer", op).unwrap();
    let stage = s.stage(&owner("provider", 1), "consumer", op).unwrap();
    png(Path::new(&stage.path));
    let d = s
        .seal(
            &owner("provider", 1),
            "consumer",
            op,
            &stage.handle,
            "image/png",
        )
        .unwrap();
    s.terminal(
        &owner("provider", 1),
        "consumer",
        op,
        Some(d.clone()),
        false,
    )
    .unwrap();
    d
}
#[test]
fn durable_admission_idempotency_and_forwarding_never_reverts() {
    let (root, s) = store();
    let a = admission("op", vec![]);
    s.reserve(a.clone()).unwrap();
    s.forwarding(&a.consumer, "op").unwrap();
    let replay = s.reserve(a.clone()).unwrap();
    assert_eq!(replay.phase, AdmissionPhase::Forwarding);
    let mut bad = a.clone();
    bad.fingerprint = "c".repeat(64);
    assert!(s.reserve(bad).is_err());
    assert!(s.release_unaccepted(&a.consumer, "op").is_err());
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(s.claims().unwrap()[0].phase, AdmissionPhase::Forwarding);
    assert!(s.busy("provider").unwrap());
    assert_eq!(
        s.verify_provider(&owner("provider", 2), "consumer", "op")
            .unwrap()
            .provider
            .incarnation,
        1
    );
}
#[test]
fn capture_is_one_immutable_snapshot_and_exact_descriptors_are_authoritative() {
    let (root, s) = store();
    let captured = capture(&s, root.path(), "capture");
    let source = root.path().join("capture.png");
    fs::write(&source, "replacement").unwrap();
    let cached = s
        .capture(
            &owner("consumer", 2),
            "capture",
            vec![CaptureInput {
                path: source.to_string_lossy().into(),
                expected_digest: None,
            }],
        )
        .unwrap();
    assert_eq!(cached[0].artifact, captured[0].artifact);
    let path = s
        .read(
            &owner("consumer", 2),
            "consumer",
            "capture",
            &captured[0].artifact,
        )
        .unwrap();
    assert_eq!(
        image::load_from_memory(&fs::read(path.path).unwrap())
            .unwrap()
            .width(),
        2
    );
    let mut forged = captured[0].artifact.clone();
    forged.byte_length += 1;
    assert!(s
        .read(&owner("consumer", 1), "consumer", "capture", &forged)
        .is_err());
    assert!(s
        .read(
            &owner("provider", 1),
            "consumer",
            "capture",
            &captured[0].artifact
        )
        .is_err());
    s.reserve(admission("capture", vec![captured[0].artifact.clone()]))
        .unwrap();
    s.forwarding(&owner("consumer", 1), "capture").unwrap();
    assert!(s
        .read(
            &owner("provider", 2),
            "consumer",
            "capture",
            &captured[0].artifact
        )
        .is_ok());
}
#[test]
fn handoff_requires_consumer_copy_and_provider_ack_before_bytes_release() {
    let (root, s) = store();
    let d = output(&s, "output");
    assert!(s.busy("provider").unwrap());
    let consumer = root.path().join("consumer-data");
    fs::create_dir(&consumer).unwrap();
    s.register_consumer_root("consumer", consumer.clone())
        .unwrap();
    let original = s
        .read(&owner("consumer", 1), "consumer", "output", &d)
        .unwrap();
    assert!(s
        .acquired(&owner("consumer", 1), "output", &d, &original.path)
        .is_err());
    let copy = consumer.join("owned.png");
    fs::copy(&original.path, &copy).unwrap();
    let receipt = s
        .acquired(&owner("consumer", 2), "output", &d, copy.to_str().unwrap())
        .unwrap();
    assert!(Path::new(&original.path).exists());
    assert!(s
        .release(
            &owner("provider", 1),
            "consumer",
            "output",
            "acquired",
            Some("wrong")
        )
        .is_err());
    s.release(
        &owner("provider", 2),
        "consumer",
        "output",
        "acquired",
        Some(&receipt.transfer_receipt),
    )
    .unwrap();
    assert!(!Path::new(&original.path).exists());
    assert!(copy.exists());
    assert!(!s.busy("provider").unwrap());
    assert_eq!(
        s.get("consumer", "output").unwrap().unwrap().output,
        Some(d.clone())
    );
    assert!(s
        .release(
            &owner("provider", 1),
            "consumer",
            "output",
            "discarded",
            None
        )
        .is_err());
    assert_eq!(
        s.acquired(&owner("consumer", 2), "output", &d, "already-gone")
            .unwrap()
            .transfer_receipt,
        receipt.transfer_receipt
    );
}
#[test]
fn failure_after_sealed_bytes_preserves_reservation_and_retry_is_local() {
    let (_root, s) = store();
    s.reserve(admission("seal", vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), "seal").unwrap();
    let stage = s.stage(&owner("provider", 1), "consumer", "seal").unwrap();
    png(Path::new(&stage.path));
    s.fail_next_commit.store(true, Ordering::Relaxed);
    assert!(s
        .seal(
            &owner("provider", 1),
            "consumer",
            "seal",
            &stage.handle,
            "image/png"
        )
        .is_err());
    assert!(s.busy("provider").unwrap());
    assert!(Path::new(&stage.path).exists());
    let d = s
        .seal(
            &owner("provider", 2),
            "consumer",
            "seal",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    assert!(s
        .read(&owner("provider", 2), "consumer", "seal", &d)
        .is_ok());
}
#[test]
fn quotas_are_reserved_before_forwarding_or_byte_copy() {
    let root = tempfile::tempdir().unwrap();
    let s = Store::open(
        root.path().join("service"),
        Limits {
            disk_bytes: 100,
            operations: 1,
            per_consumer: 1,
        },
    )
    .unwrap();
    assert!(s.reserve(admission("no-space", vec![])).is_err());
    assert!(s.get("consumer", "no-space").unwrap().is_none());
    assert!(fs::read_dir(s.root.join("bytes")).unwrap().next().is_none());
    let (root, s) = store();
    s.reserve(admission("a", vec![])).unwrap();
    let s = Store::open(
        root.path().join("service"),
        Limits {
            disk_bytes: 2 * 1024 * 1024 * 1024,
            operations: 1,
            per_consumer: 1,
        },
    )
    .unwrap();
    assert!(s.reserve(admission("b", vec![])).is_err());
    assert!(s.get("consumer", "b").unwrap().is_none());
}
#[test]
fn corrupt_newer_and_missing_ledgers_never_create_defaults() {
    let (root, s) = store();
    drop(s);
    let ledger = root.path().join("service/ledger.sqlite");
    let conn = rusqlite::Connection::open(&ledger).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);
    assert!(Store::open(root.path().join("service"), Limits::default()).is_err());
    fs::remove_file(&ledger).unwrap();
    assert!(Store::open(root.path().join("service"), Limits::default()).is_err());
    let other = tempfile::tempdir().unwrap();
    fs::create_dir(other.path().join("service")).unwrap();
    fs::write(other.path().join("service/ledger.sqlite"), "corrupt bytes").unwrap();
    assert!(Store::open(other.path().join("service"), Limits::default()).is_err());
}
#[test]
fn terminal_attention_can_release_execution_only_with_explicit_worker_proof() {
    let (_root, s) = store();
    s.reserve(admission("unknown", vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), "unknown").unwrap();
    s.terminal(&owner("provider", 1), "consumer", "unknown", None, true)
        .unwrap();
    assert!(s
        .release_execution_after_attention(&owner("provider", 1), "consumer", "unknown", false)
        .is_err());
    assert!(s.busy("provider").unwrap());
    s.release_execution_after_attention(&owner("provider", 2), "consumer", "unknown", true)
        .unwrap();
    assert!(!s.busy("provider").unwrap());
    assert_eq!(
        s.get("consumer", "unknown").unwrap().unwrap().phase,
        AdmissionPhase::Terminal
    );
}
#[test]
fn stop_recovery_commits_execution_release_and_presentation_policy_together() {
    use super::job::{JobRecord,JobState};
    let (root,s)=store();let op="atomic-stop";
    s.reserve(admission(op,vec![])).unwrap();s.forwarding(&owner("consumer",1),op).unwrap();
    s.terminal(&owner("provider",1),"consumer",op,None,true).unwrap();
    let job=s.register_job(JobRecord{job_key:"1".repeat(48),owner:owner("consumer",1),operation_id:op.into(),job_id:1,kind:"openai-image".into(),label:"generated.png".into(),origin_window:"main".into(),revision:0,source_revision:0,created_at_ms:1,updated_at_ms:1,state:JobState::Accepting,phase:None,output_path:None,run_id:None,error:None}).unwrap();
    s.fail_next_commit.store(true,Ordering::Relaxed);
    assert!(s.stop_recovery(&owner("provider",1),"consumer",op,true).is_err());
    assert!(!s.execution_released("consumer",op).unwrap());assert_eq!(s.job(&job.job_key).unwrap(),Some(job.clone()));assert!(s.busy("consumer").unwrap());
    let (_,updated)=s.stop_recovery(&owner("provider",1),"consumer",op,true).unwrap();
    let stopped=updated.unwrap();assert_eq!(stopped.state,JobState::NeedsAttention);assert_eq!(stopped.phase.as_deref(),Some("stopped"));
    assert!(s.execution_released("consumer",op).unwrap());assert!(!s.busy("consumer").unwrap());
    assert!(s.stop_recovery(&owner("provider",1),"consumer",op,true).unwrap().1.is_none());
    drop(s);let reopened=Store::open(root.path().join("service"),Limits::default()).unwrap();
    assert!(reopened.execution_released("consumer",op).unwrap());assert_eq!(reopened.job(&job.job_key).unwrap(),Some(stopped));
}
#[test]
fn unaccepted_release_cannot_reuse_or_remove_other_operations() {
    let (root, s) = store();
    let a = capture(&s, root.path(), "a");
    let b = capture(&s, root.path(), "b");
    let path = s
        .read(&owner("consumer", 1), "consumer", "a", &a[0].artifact)
        .unwrap()
        .path;
    s.release_unaccepted(&owner("consumer", 2), "a").unwrap();
    assert!(!Path::new(&path).exists());
    assert!(s
        .read(&owner("consumer", 1), "consumer", "b", &b[0].artifact)
        .is_ok());
    assert!(s.reserve(admission("a", vec![])).is_err());
}
#[cfg(unix)]
#[test]
fn special_files_substitutions_and_escaped_evidence_fail_without_hanging() {
    use std::os::unix::ffi::OsStrExt;
    let (root, s) = store();
    let fifo = root.path().join("fifo.png");
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(s
        .capture(
            &owner("consumer", 1),
            "fifo",
            vec![CaptureInput {
                path: fifo.to_string_lossy().into(),
                expected_digest: None
            }]
        )
        .is_err());
    let d = output(&s, "tamper");
    let path = s
        .read(&owner("consumer", 1), "consumer", "tamper", &d)
        .unwrap()
        .path;
    fs::remove_file(&path).unwrap();
    let outside = root.path().join("outside.png");
    png(&outside);
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(s
        .read(&owner("consumer", 1), "consumer", "tamper", &d)
        .is_err());
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    std::os::unix::fs::symlink(&outside, data.join("evidence.png")).unwrap();
    assert!(s
        .acquired(
            &owner("consumer", 1),
            "tamper",
            &d,
            data.join("evidence.png").to_str().unwrap()
        )
        .is_err());
    assert!(s.busy("provider").unwrap());
}
#[test]
fn malformed_logical_ledger_does_not_silently_release_claims() {
    let (root, s) = store();
    s.reserve(admission("broken", vec![])).unwrap();
    let conn = s.connect().unwrap();
    conn.execute(
        "UPDATE operations SET phase='released' WHERE operation='broken'",
        [],
    )
    .unwrap();
    assert!(s.claims().is_err());
    assert!(s.busy("provider").is_err());
    drop(conn);
    drop(s);
    assert!(Store::open(root.path().join("service"), Limits::default()).is_err());
}
#[test]
fn wrong_kind_and_unowned_handles_do_not_create_files() {
    let (root, s) = store();
    s.reserve(admission("bad-handle", vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), "bad-handle").unwrap();
    let before = fs::read_dir(s.root.join("leases")).unwrap().count();
    assert!(s
        .seal(
            &owner("provider", 1),
            "consumer",
            "bad-handle",
            "../../escaped",
            "image/png"
        )
        .is_err());
    assert!(!root.path().join("escaped.lock").exists());
    assert_eq!(fs::read_dir(s.root.join("leases")).unwrap().count(), before);
    let inputs = capture(&s, root.path(), "input-kind");
    s.reserve(admission("input-kind", vec![inputs[0].artifact.clone()]))
        .unwrap();
    s.forwarding(&owner("consumer", 1), "input-kind").unwrap();
    assert!(s
        .seal(
            &owner("provider", 1),
            "consumer",
            "input-kind",
            &inputs[0].artifact.handle,
            "image/png"
        )
        .is_err());
}
#[test]
fn acquisition_and_ack_commit_failures_preserve_output_until_retry() {
    let (root, s) = store();
    let d = output(&s, "failure");
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    let original = s
        .read(&owner("consumer", 1), "consumer", "failure", &d)
        .unwrap();
    let copy = data.join("copy.png");
    fs::copy(&original.path, &copy).unwrap();
    s.fail_next_commit.store(true, Ordering::Relaxed);
    assert!(s
        .acquired(&owner("consumer", 1), "failure", &d, copy.to_str().unwrap())
        .is_err());
    assert!(Path::new(&original.path).exists());
    let receipt = s
        .acquired(&owner("consumer", 1), "failure", &d, copy.to_str().unwrap())
        .unwrap();
    assert!(s
        .verify_acquisition(
            &owner("consumer", 2),
            "failure",
            &d.sha256,
            &receipt.transfer_receipt
        )
        .is_ok());
    assert!(s
        .verify_acquisition(
            &owner("consumer", 2),
            "failure",
            &"c".repeat(64),
            &receipt.transfer_receipt
        )
        .is_err());
    s.fail_next_commit.store(true, Ordering::Relaxed);
    assert!(s
        .release(
            &owner("provider", 1),
            "consumer",
            "failure",
            "acquired",
            Some(&receipt.transfer_receipt)
        )
        .is_err());
    assert_eq!(
        s.get("consumer", "failure").unwrap().unwrap().phase,
        AdmissionPhase::Terminal
    );
    assert!(Path::new(&original.path).exists());
    s.release(
        &owner("provider", 2),
        "consumer",
        "failure",
        "acquired",
        Some(&receipt.transfer_receipt),
    )
    .unwrap();
    assert!(!Path::new(&original.path).exists());
}
#[test]
fn startup_resumes_durable_released_cleanup_without_replaying() {
    let (root, s) = store();
    let d = output(&s, "released");
    let original = s
        .read(&owner("consumer", 1), "consumer", "released", &d)
        .unwrap();
    let lease = s.lease(&d.handle).unwrap();
    s.release(
        &owner("provider", 1),
        "consumer",
        "released",
        "discarded",
        None,
    )
    .unwrap();
    assert!(Path::new(&original.path).exists());
    assert!(!s.busy("provider").unwrap());
    drop(lease);
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert!(!Path::new(&original.path).exists());
    assert_eq!(
        s.get("consumer", "released").unwrap().unwrap().phase,
        AdmissionPhase::Released
    );
    assert_eq!(
        s.reserve(admission("released", vec![])).unwrap().phase,
        AdmissionPhase::Released
    );
}
#[test]
fn seal_retry_finalizes_stage_and_quota_after_committed_metadata() {
    let (_root, s) = store();
    s.reserve(admission("stage-retry", vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), "stage-retry").unwrap();
    let stage = s
        .stage(&owner("provider", 1), "consumer", "stage-retry")
        .unwrap();
    png(Path::new(&stage.path));
    let d = s
        .seal(
            &owner("provider", 1),
            "consumer",
            "stage-retry",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    png(Path::new(&stage.path));
    s.connect()
        .unwrap()
        .execute(
            "UPDATE artifacts SET bytes=?2 WHERE handle=?1",
            rusqlite::params![stage.handle, 100 * 1024 * 1024i64],
        )
        .unwrap();
    let retry = s
        .seal(
            &owner("provider", 2),
            "consumer",
            "stage-retry",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    assert_eq!(retry, d);
    assert!(!Path::new(&stage.path).exists());
    let allocated: i64 = s
        .connect()
        .unwrap()
        .query_row(
            "SELECT bytes FROM artifacts WHERE handle=?1",
            [&stage.handle],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(allocated, d.byte_length as i64);
}
#[test]
fn store_child_reserve() {
    let Some(root) = std::env::var_os("TE_SERVICE_CHILD_ROOT") else {
        return;
    };
    let store = Store::open(root.into(), Limits::default()).unwrap();
    if std::env::var_os("TE_SERVICE_CHILD_CRASH").is_some() {
        store.reserve(admission("crashed", vec![])).unwrap();
        assert!(
            store
                .claim_forwarding(&owner("consumer", 1), "crashed")
                .unwrap()
                .1
        );
        // No destructor or provider response: durable forwarding must survive.
        std::process::exit(91);
    }
    match store.reserve(admission("same", vec![])) {
        Ok(record) => assert_eq!(record.fingerprint, "b".repeat(64)),
        Err(error) => panic!("{error}"),
    };
}
#[test]
fn cross_process_same_id_has_one_durable_reservation() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("service");
    Store::open(path.clone(), Limits::default()).unwrap();
    let exe = std::env::current_exe().unwrap();
    let mut children: Vec<_> = (0..2)
        .map(|_| {
            std::process::Command::new(&exe)
                .args(["--exact", "service_state::tests::store_child_reserve"])
                .env("TE_SERVICE_CHILD_ROOT", &path)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let s = Store::open(path, Limits::default()).unwrap();
    assert_eq!(s.claims().unwrap().len(), 1);
    let artifacts: i64 = s
        .connect()
        .unwrap()
        .query_row("SELECT count(*) FROM artifacts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(artifacts, 1);
}
#[test]
fn large_and_malformed_images_fail_before_provider_dispatch() {
    let (root, s) = store();
    let huge = root.path().join("huge.png");
    let file = fs::File::create(&huge).unwrap();
    file.set_len(20 * 1024 * 1024 + 1).unwrap();
    assert!(s
        .capture(
            &owner("consumer", 1),
            "huge",
            vec![CaptureInput {
                path: huge.to_string_lossy().into(),
                expected_digest: None
            }]
        )
        .is_err());
    assert!(s.get("consumer", "huge").unwrap().is_none());
    let malformed = root.path().join("bad.png");
    fs::write(&malformed, b"not an image").unwrap();
    assert!(s
        .capture(
            &owner("consumer", 1),
            "bad",
            vec![CaptureInput {
                path: malformed.to_string_lossy().into(),
                expected_digest: None
            }]
        )
        .is_err());
    assert!(!s.busy("consumer").unwrap());
    let count: i64 = s
        .connect()
        .unwrap()
        .query_row("SELECT count(*) FROM artifacts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
#[test]
fn concurrent_dispatch_claim_has_exactly_one_winner() {
    let (_root, s) = store();
    s.reserve(admission("dispatch", vec![])).unwrap();
    let s = std::sync::Arc::new(s);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let s = s.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                s.claim_forwarding(&owner("consumer", 1), "dispatch")
                    .unwrap()
                    .1
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .filter(|won| *won)
            .count(),
        1
    );
    s.accepted(&owner("provider", 2), "consumer", "dispatch")
        .unwrap();
    assert!(
        !s.claim_forwarding(&owner("consumer", 3), "dispatch")
            .unwrap()
            .1
    );
    assert!(s.claim_forwarding(&owner("other", 1), "dispatch").is_err());
}
#[test]
fn stale_recovery_candidate_preserves_completed_capture() {
    let (root, s) = store();
    // A startup scan may observe this operation before capture commits. Drive
    // the same candidate after completion without timing-dependent sleeps.
    let captured = capture(&s, root.path(), "ready");
    s.recover_candidate(&owner("consumer", 1), "ready").unwrap();
    let path = s
        .read(
            &owner("consumer", 2),
            "consumer",
            "ready",
            &captured[0].artifact,
        )
        .unwrap();
    assert!(Path::new(&path.path).is_file());
    s.reserve(admission("ready", vec![captured[0].artifact.clone()]))
        .unwrap();
    assert!(
        s.claim_forwarding(&owner("consumer", 1), "ready")
            .unwrap()
            .1
    );
}
#[test]
fn oversized_durable_metadata_fails_closed() {
    let (_root, s) = store();
    s.reserve(admission("oversized", vec![])).unwrap();
    let conn = rusqlite::Connection::open(s.root.join("ledger.sqlite")).unwrap();
    conn.execute(
        "UPDATE operations SET admission=?1 WHERE operation='oversized'",
        ["x".repeat(1024 * 1024)],
    )
    .unwrap();
    drop(conn);
    assert!(s.claims().is_err());
    assert!(s.busy("consumer").is_err());
}
#[test]
fn abrupt_process_loss_keeps_forwarding_and_forbids_redispatch() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("service");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "service_state::tests::store_child_reserve"])
        .env("TE_SERVICE_CHILD_ROOT", &path)
        .env("TE_SERVICE_CHILD_CRASH", "1")
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(91));
    let s = Store::open(path, Limits::default()).unwrap();
    assert_eq!(
        s.reserve(admission("crashed", vec![])).unwrap().phase,
        AdmissionPhase::Forwarding
    );
    assert!(
        !s.claim_forwarding(&owner("consumer", 2), "crashed")
            .unwrap()
            .1
    );
    assert!(s.busy("provider").unwrap());
    assert!(s
        .release_unaccepted(&owner("consumer", 2), "crashed")
        .is_err());
}
#[test]
fn concurrent_first_open_does_not_replace_the_ledger() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("service");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Store::open(path, Limits::default())
                    .unwrap()
                    .reserve(admission("same", vec![]))
                    .unwrap();
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    assert_eq!(
        Store::open(path, Limits::default())
            .unwrap()
            .claims()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn preparation_release_cannot_rewrite_a_provider_disposition() {
    let (_root, s) = store();
    output(&s, "finished");
    let tombstone = s
        .release(
            &owner("provider", 1),
            "consumer",
            "finished",
            "discarded",
            None,
        )
        .unwrap();
    assert!(s
        .release_unaccepted(&owner("consumer", 2), "finished")
        .is_err());
    assert_eq!(s.get("consumer", "finished").unwrap(), Some(tombstone));
    assert!(s.claims().unwrap().is_empty());
}
#[test]
fn unavailable_delivery_can_restore_exact_output_without_redispatch() {
    let (_root, s) = store();
    s.reserve(admission("restored", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "restored")
        .unwrap();
    s.accepted(&owner("provider", 1), "consumer", "restored")
        .unwrap();
    let stage = s
        .stage(&owner("provider", 1), "consumer", "restored")
        .unwrap();
    png(Path::new(&stage.path));
    let d = s
        .seal(
            &owner("provider", 1),
            "consumer",
            "restored",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    s.terminal(&owner("provider", 1), "consumer", "restored", None, false)
        .unwrap();
    assert!(s
        .read(&owner("consumer", 1), "consumer", "restored", &d)
        .is_err());
    let mut forged = d.clone();
    forged.sha256 = "c".repeat(64);
    assert!(s
        .terminal(
            &owner("provider", 1),
            "consumer",
            "restored",
            Some(forged),
            false
        )
        .is_err());
    s.terminal(
        &owner("provider", 2),
        "consumer",
        "restored",
        Some(d.clone()),
        false,
    )
    .unwrap();
    assert!(s
        .read(&owner("consumer", 2), "consumer", "restored", &d)
        .is_ok());
    assert!(
        !s.claim_forwarding(&owner("consumer", 2), "restored")
            .unwrap()
            .1
    );
    assert!(s
        .terminal(&owner("provider", 2), "consumer", "restored", None, false)
        .is_err());
}
#[test]
fn unresolved_attention_retains_execution_until_authoritative_outcome() {
    let (_root, s) = store();
    s.reserve(admission("attention", vec![])).unwrap();
    assert!(s
        .mark_attention(&owner("provider", 1), "consumer", "attention")
        .is_err());
    s.claim_forwarding(&owner("consumer", 1), "attention")
        .unwrap();
    assert!(
        s.mark_attention(&owner("provider", 2), "consumer", "attention")
            .unwrap()
            .needs_attention
    );
    assert!(s
        .release_execution_after_attention(&owner("provider", 2), "consumer", "attention", true)
        .is_err());
    assert!(s.busy("provider").unwrap());
    let a = s
        .terminal(&owner("provider", 2), "consumer", "attention", None, false)
        .unwrap();
    assert!(!a.needs_attention);
    assert_eq!(a.phase, AdmissionPhase::Terminal);
}
#[test]
fn aggregate_input_pixel_and_output_format_bounds_are_enforced() {
    let (root, s) = store();
    let inputs: Vec<_> = (0..4)
        .map(|n| {
            let p = root.path().join(format!("large-{n}.png"));
            fs::File::create(&p)
                .unwrap()
                .set_len(17 * 1024 * 1024)
                .unwrap();
            CaptureInput {
                path: p.to_string_lossy().into(),
                expected_digest: None,
            }
        })
        .collect();
    assert!(s.capture(&owner("consumer", 1), "total", inputs).is_err());
    assert!(!s.busy("consumer").unwrap());
    let pixel = root.path().join("pixels.png");
    png(&pixel);
    let mut bytes = fs::read(&pixel).unwrap();
    bytes[16..20].copy_from_slice(&4097u32.to_be_bytes());
    bytes[20..24].copy_from_slice(&4096u32.to_be_bytes());
    let mut crc = !0u32;
    for byte in &bytes[12..29] {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
    fs::write(&pixel, &bytes).unwrap();
    assert!(s
        .capture(
            &owner("consumer", 1),
            "pixels",
            vec![CaptureInput {
                path: pixel.to_string_lossy().into(),
                expected_digest: None
            }]
        )
        .is_err());
    assert!(!s.busy("consumer").unwrap());
    s.reserve(admission("format", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "format").unwrap();
    let stage = s
        .stage(&owner("provider", 1), "consumer", "format")
        .unwrap();
    let image = image::RgbImage::from_pixel(2, 2, image::Rgb([12, 34, 56]));
    image
        .save_with_format(&stage.path, image::ImageFormat::Jpeg)
        .unwrap();
    assert!(s
        .seal(
            &owner("provider", 1),
            "consumer",
            "format",
            &stage.handle,
            "image/png"
        )
        .is_err());
    assert_eq!(
        s.get("consumer", "format").unwrap().unwrap().phase,
        AdmissionPhase::Forwarding
    );
    assert!(s.busy("provider").unwrap());
}
#[cfg(unix)]
#[test]
fn ancestor_symlink_cannot_redirect_a_sealed_artifact_read() {
    use std::os::unix::fs::symlink;
    let (root, s) = store();
    let d = output(&s, "ancestor");
    fs::rename(s.root.join("bytes"), root.path().join("relocated")).unwrap();
    symlink(root.path().join("relocated"), s.root.join("bytes")).unwrap();
    assert!(s
        .read(&owner("consumer", 1), "consumer", "ancestor", &d)
        .is_err());
    assert!(s.busy("provider").unwrap());
}
#[test]
fn startup_collects_crash_left_temporary_bytes_only_after_durable_release() {
    let (root, s) = store();
    let d = output(&s, "pending");
    let pending = s.root.join("bytes").join(format!("{}.pending", d.handle));
    fs::write(&pending, b"crash-left temporary bytes").unwrap();
    let lease = s.lease(&d.handle).unwrap();
    s.release(
        &owner("provider", 1),
        "consumer",
        "pending",
        "discarded",
        None,
    )
    .unwrap();
    assert!(pending.exists());
    drop(lease);
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert!(!pending.exists());
    assert!(s.claims().unwrap().is_empty());
    assert_eq!(
        s.get("consumer", "pending").unwrap().unwrap().phase,
        AdmissionPhase::Released
    );
}
#[test]
fn dead_owner_completed_capture_without_admission_releases_busy_and_bytes() {
    let (root, s) = store();
    let captured = capture(&s, root.path(), "unreserved");
    let path = s
        .read(
            &owner("consumer", 1),
            "consumer",
            "unreserved",
            &captured[0].artifact,
        )
        .unwrap()
        .path;
    assert_eq!(s.list_preparations().unwrap(), vec![owner("consumer", 1)]);
    assert!(s.claims().unwrap().is_empty());
    assert!(s.busy("consumer").unwrap());
    assert_eq!(s.release_preparations(&owner("consumer", 2)).unwrap(), 0);
    assert!(Path::new(&path).is_file());
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 1);
    assert!(!Path::new(&path).exists());
    assert!(!s.busy("consumer").unwrap());
    assert!(s.list_preparations().unwrap().is_empty());
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 0);
    assert!(s.reserve(admission("unreserved", vec![])).is_err());
}
#[test]
fn dead_owner_cleanup_defers_live_snapshot_io_until_retry() {
    let (root, s) = store();
    let captured = capture(&s, root.path(), "io-owned");
    let lease = s.lease(&captured[0].artifact.handle).unwrap();
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 0);
    assert!(s.busy("consumer").unwrap());
    assert!(s
        .read(
            &owner("consumer", 1),
            "consumer",
            "io-owned",
            &captured[0].artifact
        )
        .is_ok());
    drop(lease);
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 1);
    assert!(!s.busy("consumer").unwrap());
}
#[test]
fn capture_preparation_cannot_be_adopted_by_another_live_incarnation() {
    let (root, s) = store();
    let captured = capture(&s, root.path(), "expired");
    let mut a = admission("expired", vec![captured[0].artifact.clone()]);
    a.consumer.incarnation = 2;
    assert!(s.reserve_intent(a, &"c".repeat(64)).is_err());
    assert!(s.get("consumer", "expired").unwrap().is_none());
    assert_eq!(s.list_preparations().unwrap(), vec![owner("consumer", 1)]);
    assert_eq!(s.release_preparations(&owner("consumer", 2)).unwrap(), 0);
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 1);
}
#[test]
fn preparation_cleanup_never_releases_forwarded_or_provider_disposed_operations() {
    let (_root, s) = store();
    s.reserve(admission("forwarded", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "forwarded")
        .unwrap();
    s.reserve(admission("accepted", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "accepted")
        .unwrap();
    s.accepted(&owner("provider", 1), "consumer", "accepted")
        .unwrap();
    let d = output(&s, "succeeded");
    output(&s, "disposed");
    let disposed = s
        .release(
            &owner("provider", 1),
            "consumer",
            "disposed",
            "discarded",
            None,
        )
        .unwrap();
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 0);
    assert!(s.list_preparations().unwrap().is_empty());
    assert_eq!(s.claims().unwrap().len(), 3);
    assert!(s
        .read(&owner("consumer", 1), "consumer", "succeeded", &d)
        .is_ok());
    assert_eq!(s.get("consumer", "disposed").unwrap(), Some(disposed));
}
#[test]
fn preparation_cleanup_commit_failure_preserves_original_snapshot_until_retry() {
    let (root, s) = store();
    let captured = capture(&s, root.path(), "commit");
    s.fail_next_commit.store(true, Ordering::Relaxed);
    assert!(s.release_preparations(&owner("consumer", 1)).is_err());
    assert!(s.busy("consumer").unwrap());
    assert!(s
        .read(
            &owner("consumer", 1),
            "consumer",
            "commit",
            &captured[0].artifact
        )
        .is_ok());
    assert_eq!(s.release_preparations(&owner("consumer", 1)).unwrap(), 1);
}
#[test]
fn concurrent_owner_death_and_dispatch_preserve_the_durable_winner() {
    for _ in 0..8 {
        let (_root, s) = store();
        s.reserve(admission("race", vec![])).unwrap();
        let s = std::sync::Arc::new(s);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let dispatch = {
            let s = s.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                s.claim_forwarding(&owner("consumer", 1), "race").unwrap().1
            })
        };
        barrier.wait();
        let released = s.release_preparations(&owner("consumer", 1)).unwrap();
        let dispatched = dispatch.join().unwrap();
        assert_eq!(released == 1, !dispatched);
        let a = s.get("consumer", "race").unwrap().unwrap();
        if dispatched {
            assert_eq!(a.phase, AdmissionPhase::Forwarding);
            assert!(s.busy("provider").unwrap());
        } else {
            assert_eq!(a.disposition.as_deref(), Some("never_forwarded"));
            assert!(!s.busy("provider").unwrap());
        }
    }
}
fn provider_receipt(
    op: &str,
    revision: u64,
    output: Option<ArtifactDescriptor>,
) -> serde_json::Value {
    let (execution, delivery) = match output {
        Some(output) => (
            serde_json::json!({"state":"succeeded","metadata":{"adapter":"openai-images","endpointIdentity":"https://fixture.test/images","requestedModel":"fixture","actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}}),
            serde_json::json!({"state":"available","output":output}),
        ),
        None => (
            serde_json::json!({"state":"running"}),
            serde_json::json!({"state":"none"}),
        ),
    };
    serde_json::json!({"version":1,"operationId":op,"requestFingerprint":"b".repeat(64),"provider":{"packageId":"provider","serviceId":"image-generation","major":1},"revision":revision,"execution":execution,"delivery":delivery})
}
#[test]
fn durable_observation_retries_interrupted_phase_transition_without_regressing() {
    let (root, s) = store();
    s.reserve(admission("observed", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "observed")
        .unwrap();
    s.accepted(&owner("provider", 1), "consumer", "observed")
        .unwrap();
    let stage = s
        .stage(&owner("provider", 1), "consumer", "observed")
        .unwrap();
    png(Path::new(&stage.path));
    let d = s
        .seal(
            &owner("provider", 1),
            "consumer",
            "observed",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    let receipt = provider_receipt("observed", 2, Some(d.clone()));
    let latest = s
        .observe_receipt(
            &owner("provider", 2),
            "consumer",
            "observed",
            2,
            receipt.clone(),
        )
        .unwrap();
    s.fail_next_commit.store(true, Ordering::Relaxed);
    assert!(s
        .terminal(
            &owner("provider", 1),
            "consumer",
            "observed",
            Some(d.clone()),
            false
        )
        .is_err());
    assert_eq!(
        s.get("consumer", "observed").unwrap().unwrap().phase,
        AdmissionPhase::Accepted
    );
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        s.observe_receipt(
            &owner("provider", 3),
            "consumer",
            "observed",
            1,
            provider_receipt("observed", 1, None)
        )
        .unwrap(),
        latest
    );
    assert_eq!(
        s.observe_receipt(&owner("provider", 3), "consumer", "observed", 2, receipt)
            .unwrap(),
        latest
    );
    s.terminal(
        &owner("provider", 3),
        "consumer",
        "observed",
        Some(d),
        false,
    )
    .unwrap();
    assert_eq!(
        s.get("consumer", "observed").unwrap().unwrap().phase,
        AdmissionPhase::Terminal
    );
    assert!(
        !s.claim_forwarding(&owner("consumer", 2), "observed")
            .unwrap()
            .1
    );
}
#[test]
fn receipt_conflicts_bounds_and_ownership_preserve_the_last_observation() {
    let (_root, s) = store();
    s.reserve(admission("receipt", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "receipt")
        .unwrap();
    let good = provider_receipt("receipt", 1, None);
    let latest = s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "receipt",
            1,
            good.clone(),
        )
        .unwrap();
    let mut conflict = good.clone();
    conflict["execution"]["state"] = serde_json::json!("accepted");
    assert!(s
        .observe_receipt(&owner("provider", 1), "consumer", "receipt", 1, conflict)
        .is_err());
    let mut wrong = owner("provider", 1);
    wrong.digest = "c".repeat(64);
    assert!(s
        .observe_receipt(&wrong, "consumer", "receipt", 1, good.clone())
        .is_err());
    assert!(s
        .observe_receipt(&owner("provider", 1), "other", "receipt", 1, good.clone())
        .is_err());
    for revision in [0, 9_007_199_254_740_992] {
        assert!(s
            .observe_receipt(
                &owner("provider", 1),
                "consumer",
                "receipt",
                revision,
                provider_receipt("receipt", revision, None)
            )
            .is_err());
    }
    let mut huge = provider_receipt("receipt", 2, None);
    huge["prompt"] = serde_json::json!("x".repeat(16 * 1024));
    assert!(s
        .observe_receipt(&owner("provider", 1), "consumer", "receipt", 2, huge)
        .is_err());
    assert_eq!(
        s.observe_receipt(&owner("provider", 2), "consumer", "receipt", 1, good)
            .unwrap(),
        latest
    );
}
#[test]
fn missing_receipt_ledger_or_changed_receipt_owner_fails_closed_on_startup() {
    for corruption in ["missing", "owner", "digest"] {
        let (root, s) = store();
        s.reserve(admission("corrupt-receipt", vec![])).unwrap();
        s.claim_forwarding(&owner("consumer", 1), "corrupt-receipt")
            .unwrap();
        s.observe_receipt(
            &owner("provider", 1),
            "consumer",
            "corrupt-receipt",
            1,
            provider_receipt("corrupt-receipt", 1, None),
        )
        .unwrap();
        let conn = s.connect().unwrap();
        match corruption {
            "missing" => conn.execute_batch("DROP TABLE provider_receipts").unwrap(),
            "owner" => {
                conn.execute(
                    "UPDATE provider_receipts SET provider=?1",
                    [super::store::encode(&owner("different", 1)).unwrap()],
                )
                .unwrap();
            }
            _ => {
                conn.execute("UPDATE provider_receipts SET digest=?1", ["0".repeat(64)])
                    .unwrap();
            }
        }
        drop(conn);
        drop(s);
        assert!(Store::open(root.path().join("service"), Limits::default()).is_err());
    }
}
#[test]
fn known_schema_one_receipt_extension_migrates_atomically_without_replacing_claims() {
    let (root, s) = store();
    s.reserve(admission("old-schema", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "old-schema")
        .unwrap();
    let conn = s.connect().unwrap();
    conn.execute_batch(
        "DROP TABLE provider_receipts; DROP TABLE operation_intents; DROP TABLE presentation_jobs; DROP TABLE presentation_sequence; ALTER TABLE operations DROP COLUMN created_at_ms; PRAGMA application_id=0;",
    )
    .unwrap();
    drop(conn);
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        s.get("consumer", "old-schema").unwrap().unwrap().phase,
        AdmissionPhase::Forwarding
    );
    s.observe_receipt(
        &owner("provider", 2),
        "consumer",
        "old-schema",
        1,
        provider_receipt("old-schema", 1, None),
    )
    .unwrap();
}
#[test]
fn semantic_intent_is_atomic_immutable_and_input_handles_are_incidental() {
    let (root, s) = store();
    let captured = capture(&s, root.path(), "intent");
    let a = admission("intent", vec![captured[0].artifact.clone()]);
    s.fail_next_commit.store(true, Ordering::Relaxed);
    assert!(s.reserve_intent(a.clone(), &"c".repeat(64)).is_err());
    assert!(s.get("consumer", "intent").unwrap().is_none());
    let admitted = s.reserve_intent(a.clone(), &"c".repeat(64)).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "intent").unwrap();
    let mut recreated = a.clone();
    recreated.inputs[0].handle = "d".repeat(48);
    let replay = s.reserve_intent(recreated, &"c".repeat(64)).unwrap();
    assert_eq!(replay.inputs, admitted.inputs);
    assert_eq!(replay.phase, AdmissionPhase::Forwarding);
    assert!(s.reserve_intent(a.clone(), &"d".repeat(64)).is_err());
    s.reserve(a.clone()).unwrap(); // helper cannot rotate the stored intent
    assert!(s.reserve_intent(a, &"d".repeat(64)).is_err());
}
#[test]
fn legacy_semantic_intent_can_attach_only_before_forwarding() {
    let (_root, s) = store();
    s.reserve(admission("attach", vec![])).unwrap();
    s.reserve_intent(admission("attach", vec![]), &"c".repeat(64))
        .unwrap();
    s.claim_forwarding(&owner("consumer", 1), "attach").unwrap();
    assert!(s
        .reserve_intent(admission("attach", vec![]), &"d".repeat(64))
        .is_err());
    s.reserve(admission("unknown-intent", vec![])).unwrap();
    s.claim_forwarding(&owner("consumer", 1), "unknown-intent")
        .unwrap();
    assert!(matches!(
        s.reserve_intent(admission("unknown-intent", vec![]), &"c".repeat(64)),
        Err(crate::error::AppError::MutationUncertain(_))
    ));
    assert_eq!(
        s.get("consumer", "unknown-intent").unwrap().unwrap().phase,
        AdmissionPhase::Forwarding
    );
}
#[test]
fn missing_or_corrupt_semantic_intent_metadata_is_not_healed_as_defaults() {
    for corruption in ["missing", "digest", "orphan"] {
        let (root, s) = store();
        s.reserve_intent(admission("intent-ledger", vec![]), &"c".repeat(64))
            .unwrap();
        let conn = s.connect().unwrap();
        match corruption {
            "missing" => conn.execute_batch("DROP TABLE operation_intents").unwrap(),
            "digest" => {
                conn.execute("UPDATE operation_intents SET semantic_digest='invalid'", [])
                    .unwrap();
            }
            _ => {
                conn.execute("UPDATE operation_intents SET operation='other'", [])
                    .unwrap();
            }
        }
        drop(conn);
        drop(s);
        assert!(Store::open(root.path().join("service"), Limits::default()).is_err());
    }
}
#[test]
fn newer_receipt_cannot_rewrite_terminal_execution_or_disposed_delivery() {
    let (_root, s) = store();
    let d = output(&s, "immutable-receipt");
    let succeeded = provider_receipt("immutable-receipt", 2, Some(d.clone()));
    let latest = s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "immutable-receipt",
            2,
            succeeded.clone(),
        )
        .unwrap();
    let mut failed = provider_receipt("immutable-receipt", 3, None);
    failed["execution"] = serde_json::json!({"state":"failed","error":{"code":"fixture_failure","message":"fake provider failure","correlationId":null}});
    assert!(s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "immutable-receipt",
            3,
            failed
        )
        .is_err());
    let mut discarded = succeeded.clone();
    discarded["revision"] = serde_json::json!(3);
    discarded["delivery"] = serde_json::json!({"state":"discarded"});
    let discarded = s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "immutable-receipt",
            3,
            discarded,
        )
        .unwrap();
    let mut resurrect = succeeded.clone();
    resurrect["revision"] = serde_json::json!(4);
    assert!(s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "immutable-receipt",
            4,
            resurrect
        )
        .is_err());
    assert_eq!(
        s.observe_receipt(
            &owner("provider", 2),
            "consumer",
            "immutable-receipt",
            2,
            latest
        )
        .unwrap(),
        discarded
    );
    assert_eq!(
        s.get("consumer", "immutable-receipt")
            .unwrap()
            .unwrap()
            .output,
        Some(d)
    );
}
#[test]
fn invalid_output_observation_does_not_poison_corrected_same_or_next_revision() {
    let (_root, s) = store();
    s.reserve(admission("proof", vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), "proof").unwrap();
    let stage = s.stage(&owner("provider", 1), "consumer", "proof").unwrap();
    png(Path::new(&stage.path));
    let d = s
        .seal(
            &owner("provider", 1),
            "consumer",
            "proof",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    let old = s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            1,
            provider_receipt("proof", 1, None),
        )
        .unwrap();
    let mut forged = d.clone();
    forged.handle = "e".repeat(48);
    assert!(s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            2,
            provider_receipt("proof", 2, Some(forged))
        )
        .is_err());
    assert_eq!(
        s.observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            1,
            provider_receipt("proof", 1, None)
        )
        .unwrap(),
        old
    );
    let foreign = output(&s, "foreign-proof");
    assert!(s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            2,
            provider_receipt("proof", 2, Some(foreign))
        )
        .is_err());
    let good = s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            2,
            provider_receipt("proof", 2, Some(d.clone())),
        )
        .unwrap();
    s.terminal(
        &owner("provider", 1),
        "consumer",
        "proof",
        Some(d.clone()),
        false,
    )
    .unwrap();
    let mut changed = d.clone();
    changed.sha256 = "e".repeat(64);
    assert!(s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            3,
            provider_receipt("proof", 3, Some(changed))
        )
        .is_err());
    assert_eq!(
        s.observe_receipt(&owner("provider", 1), "consumer", "proof", 2, good)
            .unwrap()["revision"],
        2
    );
    assert_eq!(
        s.observe_receipt(
            &owner("provider", 1),
            "consumer",
            "proof",
            3,
            provider_receipt("proof", 3, Some(d))
        )
        .unwrap()["revision"],
        3
    );
}
#[test]
fn acquisition_observation_requires_exact_durable_evidence_before_advance() {
    let (root, s) = store();
    let d = output(&s, "receipt-evidence");
    let available = provider_receipt("receipt-evidence", 2, Some(d.clone()));
    s.observe_receipt(
        &owner("provider", 1),
        "consumer",
        "receipt-evidence",
        2,
        available.clone(),
    )
    .unwrap();
    let mut acquired = available.clone();
    acquired["revision"] = serde_json::json!(3);
    acquired["delivery"] = serde_json::json!({"state":"acquired","transferReceipt":"f".repeat(48)});
    assert!(s
        .observe_receipt(
            &owner("provider", 1),
            "consumer",
            "receipt-evidence",
            3,
            acquired.clone()
        )
        .is_err());
    assert_eq!(
        s.observe_receipt(
            &owner("provider", 1),
            "consumer",
            "receipt-evidence",
            2,
            available
        )
        .unwrap()["delivery"]["state"],
        "available"
    );
    let consumer_root = root.path().join("consumer-evidence");
    fs::create_dir(&consumer_root).unwrap();
    s.register_consumer_root("consumer", consumer_root.clone())
        .unwrap();
    let copy = consumer_root.join("copy.png");
    fs::copy(
        s.read(&owner("consumer", 1), "consumer", "receipt-evidence", &d)
            .unwrap()
            .path,
        &copy,
    )
    .unwrap();
    let receipt = s
        .acquired(
            &owner("consumer", 1),
            "receipt-evidence",
            &d,
            copy.to_str().unwrap(),
        )
        .unwrap();
    acquired["delivery"]["transferReceipt"] = serde_json::json!(receipt.transfer_receipt);
    s.observe_receipt(
        &owner("provider", 1),
        "consumer",
        "receipt-evidence",
        3,
        acquired.clone(),
    )
    .unwrap();
    s.release(
        &owner("provider", 1),
        "consumer",
        "receipt-evidence",
        "acquired",
        Some(&receipt.transfer_receipt),
    )
    .unwrap();
    assert_eq!(
        s.observe_receipt(
            &owner("provider", 2),
            "consumer",
            "receipt-evidence",
            3,
            acquired
        )
        .unwrap()["delivery"]["state"],
        "acquired"
    );
    drop(s);
    Store::open(root.path().join("service"), Limits::default()).unwrap();
}
#[test]
fn reserved_incarnations_expire_but_forwarded_lookup_retains_original_owners() {
    let (_root, s) = store();
    let a = admission("expired-reserved", vec![]);
    let intent = "c".repeat(64);
    s.reserve_intent(a.clone(), &intent).unwrap();
    for (c, p) in [(2, 1), (1, 2), (2, 2)] {
        let mut replacement = a.clone();
        replacement.consumer.incarnation = c;
        replacement.provider.incarnation = p;
        assert!(s.reserve_intent(replacement, &intent).is_err());
    }
    assert!(s
        .claim_forwarding(&owner("consumer", 2), "expired-reserved")
        .is_err());
    assert_eq!(
        s.get("consumer", "expired-reserved").unwrap(),
        Some(a.clone())
    );
    s.claim_forwarding(&owner("consumer", 1), "expired-reserved")
        .unwrap();
    let mut recovery = a;
    recovery.consumer.incarnation = 2;
    recovery.provider.incarnation = 2;
    let original = s.reserve_intent(recovery, &intent).unwrap();
    assert_eq!(original.consumer.incarnation, 1);
    assert_eq!(original.provider.incarnation, 1);
    assert!(
        !s.claim_forwarding(&owner("consumer", 2), "expired-reserved")
            .unwrap()
            .1
    );
}
#[cfg(unix)]
#[test]
fn acquisition_requires_all_nested_and_registered_root_namespace_syncs() {
    let (root, s) = store();
    let d = output(&s, "ancestor-sync");
    let profile = root.path().join("new-profile");
    let consumer_root = profile.join("plugin-data/consumer");
    let leaf = consumer_root.join("publication/pending/job");
    fs::create_dir_all(&leaf).unwrap();
    s.register_consumer_root("consumer", consumer_root.clone())
        .unwrap();
    let copy = leaf.join("copy.png");
    fs::copy(
        s.read(&owner("consumer", 1), "consumer", "ancestor-sync", &d)
            .unwrap()
            .path,
        &copy,
    )
    .unwrap();
    for ancestor in [
        &consumer_root.join("publication"),
        &consumer_root,
        &consumer_root.parent().unwrap().to_path_buf(),
        &profile,
    ] {
        *s.fail_evidence_sync_at.lock().unwrap() = Some(ancestor.clone());
        assert!(s
            .acquired(
                &owner("consumer", 1),
                "ancestor-sync",
                &d,
                copy.to_str().unwrap()
            )
            .is_err());
        assert!(s
            .verify_acquisition(
                &owner("consumer", 1),
                "ancestor-sync",
                &d.sha256,
                &"f".repeat(48)
            )
            .is_err());
        assert!(s.busy("provider").unwrap());
        assert!(copy.is_file());
    }
    *s.fail_evidence_sync_at.lock().unwrap() = None;
    let receipt = s
        .acquired(
            &owner("consumer", 1),
            "ancestor-sync",
            &d,
            copy.to_str().unwrap(),
        )
        .unwrap();
    s.verify_acquisition(
        &owner("consumer", 1),
        "ancestor-sync",
        &d.sha256,
        &receipt.transfer_receipt,
    )
    .unwrap();
}
#[test]
fn committed_seal_lost_reply_recovers_same_descriptor_after_terminal_unavailable() {
    let (root, s) = store();
    s.reserve(admission("lost-seal", vec![])).unwrap();
    s.forwarding(&owner("consumer", 1), "lost-seal").unwrap();
    let stage = s
        .stage(&owner("provider", 1), "consumer", "lost-seal")
        .unwrap();
    png(Path::new(&stage.path));
    let d = s
        .seal(
            &owner("provider", 1),
            "consumer",
            "lost-seal",
            &stage.handle,
            "image/png",
        )
        .unwrap();
    s.terminal(&owner("provider", 1), "consumer", "lost-seal", None, false)
        .unwrap();
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    fs::write(&stage.path, b"this stage is no longer the sealed result").unwrap();
    assert_eq!(
        s.seal(
            &owner("provider", 2),
            "consumer",
            "lost-seal",
            &stage.handle,
            "image/png"
        )
        .unwrap(),
        d
    );
    assert!(!Path::new(&stage.path).exists());
    assert!(s
        .seal(
            &owner("provider", 2),
            "consumer",
            "lost-seal",
            &"f".repeat(48),
            "image/png"
        )
        .is_err());
    s.terminal(
        &owner("provider", 2),
        "consumer",
        "lost-seal",
        Some(d.clone()),
        false,
    )
    .unwrap();
    assert_eq!(
        s.seal(
            &owner("provider", 2),
            "consumer",
            "lost-seal",
            &stage.handle,
            "image/png"
        )
        .unwrap(),
        d
    );
    assert!(s
        .read(&owner("consumer", 2), "consumer", "lost-seal", &d)
        .is_ok());
    s.release(
        &owner("provider", 2),
        "consumer",
        "lost-seal",
        "discarded",
        None,
    )
    .unwrap();
    assert!(s
        .seal(
            &owner("provider", 2),
            "consumer",
            "lost-seal",
            &stage.handle,
            "image/png"
        )
        .is_err());
}

#[test]
fn proven_success_can_finish_its_original_stage_after_unavailable_status_wins_race() {
    use sha2::Digest;
    let (root,s)=store();
    s.reserve(admission("stage-race",vec![])).unwrap();
    s.forwarding(&owner("consumer",1),"stage-race").unwrap();
    let stage=s.stage(&owner("provider",1),"consumer","stage-race").unwrap();
    png(Path::new(&stage.path));
    let bytes=fs::read(&stage.path).unwrap();
    s.terminal(&owner("provider",1),"consumer","stage-race",None,true).unwrap();
    // Terminal alone is not a proof that a paid image was generated.
    assert!(s.seal(&owner("provider",1),"consumer","stage-race",&stage.handle,"image/png").is_err());
    let mut status=provider_receipt("stage-race",1,Some(ArtifactDescriptor{handle:stage.handle.clone(),sha256:"a".repeat(64),byte_length:bytes.len() as u64,media_type:"image/png".into()}));
    status["delivery"]=serde_json::json!({"state":"unavailable","reason":"storage_unavailable"});
    s.observe_receipt(&owner("provider",1),"consumer","stage-race",1,status).unwrap();
    drop(s);
    let s=Store::open(root.path().join("service"),Limits::default()).unwrap();
    let sealed=s.seal(&owner("provider",2),"consumer","stage-race",&stage.handle,"image/png").unwrap();
    assert_eq!(sealed.handle,stage.handle);
    assert_eq!(sealed.sha256,hex::encode(sha2::Sha256::digest(&bytes)));
    s.terminal(&owner("provider",2),"consumer","stage-race",Some(sealed.clone()),false).unwrap();
    let path=s.read(&owner("consumer",2),"consumer","stage-race",&sealed).unwrap();
    assert_eq!(fs::read(path.path).unwrap(),bytes);
}
#[test]
fn proven_success_can_begin_its_original_reserved_stage_after_remote_checkpoint() {
    let (_root,s)=store();let op="success-before-stage";
    s.reserve(admission(op,vec![])).unwrap();s.forwarding(&owner("consumer",1),op).unwrap();
    s.terminal(&owner("provider",1),"consumer",op,None,true).unwrap();
    assert!(s.stage(&owner("provider",1),"consumer",op).is_err());
    let mut receipt=provider_receipt(op,1,Some(ArtifactDescriptor{handle:"proof-only".into(),sha256:"a".repeat(64),byte_length:1,media_type:"image/png".into()}));
    receipt["delivery"]=serde_json::json!({"state":"unavailable","reason":"storage_unavailable"});
    s.observe_receipt(&owner("provider",1),"consumer",op,1,receipt).unwrap();
    let stage=s.stage(&owner("provider",1),"consumer",op).unwrap();
    assert_eq!(s.stage(&owner("provider",2),"consumer",op).unwrap().handle,stage.handle);
    png(Path::new(&stage.path));let sealed=s.seal(&owner("provider",1),"consumer",op,&stage.handle,"image/png").unwrap();
    s.terminal(&owner("provider",1),"consumer",op,Some(sealed),false).unwrap();
    s.release(&owner("provider",1),"consumer",op,"discarded",None).unwrap();
    assert!(s.stage(&owner("provider",1),"consumer",op).is_err());
}
