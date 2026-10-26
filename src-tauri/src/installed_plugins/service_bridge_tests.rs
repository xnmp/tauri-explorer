//! Business-boundary fixtures execute the exact real-router handler with a
//! private durable Store and fake provider transport. They do not exercise
//! broker stdout scheduling, lifecycle leases, or native worker saturation.
use super::service_bridge::{image_call, reconcile_at};
use crate::{
    error::AppError,
    service_state::{model::*, Store},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{Arc, Barrier, Mutex},
};
fn generation(id: &str, digest: char) -> PackageGeneration {
    PackageGeneration {
        package_id: id.into(),
        digest: digest.to_string().repeat(64),
        incarnation: 1,
    }
}
fn consumer() -> PackageGeneration {
    generation("consumer", 'a')
}
fn provider() -> PackageGeneration {
    generation("provider", 'b')
}
fn target() -> ServiceTarget {
    ServiceTarget {
        package_id: "provider".into(),
        service_id: "image-generation".into(),
        major: 1,
    }
}
// These business fixtures share the host's process-wide package admission
// identities and AI action gate. Keep unrelated private profiles out of each
// other's fences; threads inside one fixture still exercise the real
// interleavings.
struct FixtureRoot {
    directory: tempfile::TempDir,
    _profile: super::ai_operations::HostProfile,
}
impl FixtureRoot {
    fn path(&self) -> &Path {
        self.directory.path()
    }
}
fn fixture_root() -> FixtureRoot {
    let profile = super::ai_operations::exclusive_host_profile();
    FixtureRoot {
        directory: tempfile::tempdir().unwrap(),
        _profile: profile,
    }
}
fn fixture() -> (FixtureRoot, Store) {
    let root = fixture_root();
    let store = Store::open(root.path().join("service"), Limits::default()).unwrap();
    (root, store)
}

#[test]
fn lifecycle_change_releases_cancelled_service_capacity_without_releasing_live_ownership() {
    use super::backend::{begin_change, CallLease, IdleCallFence};
    let id = "fixture.cancelled-service-capacity";
    let old = (0..16)
        .map(|_| CallLease::acquire_lane(id, false).unwrap())
        .collect::<Vec<_>>();
    assert!(CallLease::acquire_lane(id, false).is_err());
    drop(begin_change(id).unwrap());
    // Cancelling eligibility must not assert that existing workers/callbacks
    // finished: the old owners still prevent an automatic idle proof.
    assert!(IdleCallFence::acquire(&[id]).is_err());
    let fresh = (0..16)
        .map(|_| {
            CallLease::acquire_lane(id, false)
                .expect("cancelled service admissions still consume replacement capacity")
        })
        .collect::<Vec<_>>();
    assert!(CallLease::acquire_lane(id, false).is_err());
    drop(old);
    assert!(
        CallLease::acquire_lane(id, false).is_err(),
        "a stale lease drop released a current admission"
    );
    assert!(IdleCallFence::acquire(&[id]).is_err());
    drop(fresh);
    let _idle = IdleCallFence::acquire(&[id]).unwrap();
}
fn request(op: &str) -> Value {
    json!({"operationId":op,"connectionId":"fixture-profile","expectedConnectionRevision":"fixture-revision","model":null,"prompt":"test","inputs":[],"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"preparationToken":"fake-local-token","effectiveRecipeDigest":"c".repeat(64)})
}
fn status(op: &str, execution: &str, delivery: Value) -> Value {
    let revision = if execution == "succeeded" {
        if matches!(delivery["state"].as_str(), Some("acquired" | "discarded")) {
            3
        } else {
            2
        }
    } else {
        1
    };
    let execution = if execution == "succeeded" {
        json!({"state":"succeeded","metadata":{"adapter":"openai-images","endpointIdentity":"https://fixture.test/v1/images","requestedModel":"fixture-image","actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}})
    } else {
        json!({"state":execution})
    };
    json!({"version":1,"operationId":op,"requestFingerprint":"c".repeat(64),"provider":{"packageId":"provider","serviceId":"image-generation","major":1},"revision":revision,"execution":execution,"delivery":delivery})
}
fn call(
    store: &Store,
    method: &str,
    params: Value,
    invoke: impl Fn(&str, Value) -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    image_call(
        store,
        &consumer(),
        &provider(),
        &target(),
        method,
        params,
        || true,
        invoke,
    )
}
fn running(op: &str) -> Value {
    status(op, "running", json!({"state":"none"}))
}
fn start(store: &Store, op: &str) {
    call(store, "start", request(op), |_, _| Ok(running(op))).unwrap();
}
fn sealed(store: &Store, op: &str) -> ArtifactDescriptor {
    try_sealed(store, op).unwrap()
}
fn try_sealed(store: &Store, op: &str) -> Result<ArtifactDescriptor, AppError> {
    let stage = store.stage(&provider(), "consumer", op)?;
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .map_err(|error| AppError::Other(error.to_string()))?;
    store.seal(&provider(), "consumer", op, &stage.handle, "image/png")
}
fn ready(store: &Store, op: &str) -> ArtifactDescriptor {
    start(store, op);
    let d = sealed(store, op);
    call(store, "status", json!({"operationId":op}), |_, _| {
        Ok(status(
            op,
            "succeeded",
            json!({"state":"available","output":d}),
        ))
    })
    .unwrap();
    d
}
#[test]
fn review_sealed_unpublished_success_never_settles_and_recovers_next_healthy_status() {
    use crate::service_state::job::{JobRecord, JobState};
    for legacy_marker in [false, true] {
        let (root, s) = fixture();
        let op = "sealed-unpublished";
        let registered = s.register_job(job(op, 911)).unwrap();
        start(&s, op);
        let d = sealed(&s, op);
        if legacy_marker {
            let db = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
            db.execute(
                "UPDATE operations SET exec_released=1 WHERE consumer='consumer' AND operation=?1",
                [op],
            )
            .unwrap();
            db.execute("INSERT INTO dismissed_operations(consumer,operation,revision,dismissed_at_ms)VALUES('consumer',?1,1,1)", [op]).unwrap();
        }
        // Sealing committed, but the provider's success publisher never reached
        // the host. No session success witness exists; idle proofs still pass.
        for _ in 0..5 {
            super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
        }
        assert_eq!(
            s.dismissed_revision("consumer", op).unwrap(),
            legacy_marker.then_some(1)
        );
        assert_eq!(s.auto_settlement_operations().unwrap().len(), 1);
        assert!(s.auto_settle_operation("consumer", op, true).is_err());
        let data = root.path().join("consumer-data");
        fs::create_dir(&data).unwrap();
        s.register_consumer_root("consumer", data.clone()).unwrap();
        struct Healthy<'a> {
            store: &'a Store,
            descriptor: &'a ArtifactDescriptor,
            copy: std::path::PathBuf,
        }
        impl super::ai_operations::AutomaticPort for Healthy<'_> {
            fn active(
                &self,
                a: &Admission,
                _: Option<&JobRecord>,
                _: bool,
                _: &str,
            ) -> Result<bool, AppError> {
                reconcile_at(
                    self.store,
                    &provider(),
                    a,
                    &status(
                        &a.operation_id,
                        "succeeded",
                        json!({"state":"available","output":self.descriptor}),
                    ),
                )?;
                Ok(false)
            }
            fn recover(&self, a: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
                fs::copy(
                    self.store
                        .read(&consumer(), "consumer", &a.operation_id, self.descriptor)?
                        .path,
                    &self.copy,
                )
                .unwrap();
                let transfer = self.store.acquired(
                    &consumer(),
                    &a.operation_id,
                    self.descriptor,
                    self.copy.to_str().unwrap(),
                )?;
                call(
                    self.store,
                    "acknowledge",
                    json!({"operationId":a.operation_id,"outputSha256":self.descriptor.sha256,"disposition":"acquired","transferReceipt":transfer.transfer_receipt}),
                    |method, _| {
                        assert!(
                            method.ends_with(".acknowledge"),
                            "never replay an execution"
                        );
                        Ok(status(
                            &a.operation_id,
                            "succeeded",
                            json!({"state":"acquired","transferReceipt":transfer.transfer_receipt}),
                        ))
                    },
                )?;
                self.store
                    .complete_acquired_job("consumer", &a.operation_id)?;
                Ok(())
            }
        }
        let healthy = Healthy {
            store: &s,
            descriptor: &d,
            copy: data.join("recovered.png"),
        };
        super::ai_operations::auto_reconcile_in(&s, &healthy).unwrap();
        assert_eq!(
            s.job(&registered.job_key).unwrap().unwrap().state,
            JobState::Completed
        );
        assert_eq!(fs::metadata(&healthy.copy).unwrap().len(), d.byte_length);
        assert_eq!(
            s.get("consumer", op)
                .unwrap()
                .unwrap()
                .disposition
                .as_deref(),
            Some("acquired")
        );
    }
}

#[test]
fn review_removal_at_exact_journal_limits_evicts_history_and_commits_once() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    for n in 1..=384 {
        let mut record = job(&format!("unrelated-{n}"), n);
        record.owner = generation("unrelated", 'd');
        let record = s.register_job(record).unwrap();
        if n <= 256 {
            s.update_job(
                &record.owner,
                &record.job_key,
                JobState::Cancelled,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        }
    }
    let d = ready(&s, "unpresented-success");
    assert_eq!(s.snapshot_jobs().unwrap().jobs.len(), 384);
    let notices = s
        .abandon_package_outputs("provider")
        .expect("history capacity never vetoes removal");
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].state, JobState::Error);
    assert_eq!(
        s.get("consumer", "unpresented-success")
            .unwrap()
            .unwrap()
            .phase,
        AdmissionPhase::Released
    );
    assert!(s.abandon_package_outputs("provider").unwrap().is_empty());
    assert!(!root
        .path()
        .join("service/bytes")
        .join(format!("{}.bin", d.handle))
        .exists());
    let snapshot = s.snapshot_jobs().unwrap();
    assert_eq!(
        snapshot.jobs.iter().filter(|j| !j.state.terminal()).count(),
        128
    );
    assert_eq!(
        snapshot.jobs.iter().filter(|j| j.state.terminal()).count(),
        256
    );
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert!(reopened
        .abandon_package_outputs("provider")
        .unwrap()
        .is_empty());
}
#[test]
fn review_automatic_sweep_collects_pending_bytes_without_recovery_candidates() {
    let (root, s) = fixture();
    let d = ready(&s, "pending-collection");
    let path = root
        .path()
        .join("service/bytes")
        .join(format!("{}.bin", d.handle));
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("held"), b"image").unwrap();
    s.abandon_package_outputs("provider").unwrap();
    assert!(s.auto_settlement_operations().unwrap().is_empty());
    fs::remove_dir_all(&path).unwrap();
    fs::write(&path, b"image").unwrap();
    // Run exactly the entry point used by the existing periodic worker.
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert!(
        !path.exists(),
        "timer sweeps retry deletion even with no AI work"
    );
}

#[test]
fn simultaneous_same_id_dispatches_start_once_and_reconciles_other_calls() {
    let (_root, s) = fixture();
    let s = Arc::new(s);
    let barrier = Arc::new(Barrier::new(8));
    let methods = Arc::new(Mutex::new(Vec::new()));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let s = s.clone();
            let barrier = barrier.clone();
            let methods = methods.clone();
            std::thread::spawn(move || {
                barrier.wait();
                call(&s, "start", request("same"), |method, params| {
                    methods.lock().unwrap().push(method.to_owned());
                    assert_eq!(params["caller"]["packageId"], "consumer");
                    assert_eq!(params["caller"]["packageDigest"], consumer().digest);
                    Ok(running("same"))
                })
                .unwrap();
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let methods = methods.lock().unwrap();
    assert_eq!(methods.iter().filter(|m| m.ends_with(".start")).count(), 1);
    assert_eq!(methods.iter().filter(|m| m.ends_with(".status")).count(), 7);
    assert_eq!(
        s.get("consumer", "same").unwrap().unwrap().phase,
        AdmissionPhase::Accepted
    );
}
#[test]
fn explicit_stop_retains_original_unknown_and_refuses_automatic_or_duplicate_dispatch() {
    let (_root, store) = fixture();
    let op = "stopped";
    start(&store, op);
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
    call(&store, "status", json!({"operationId":op}), |_, _| {
        Ok(unknown.clone())
    })
    .unwrap();
    let original = store.get("consumer", op).unwrap().unwrap();
    store
        .stop_recovery(&provider(), "consumer", op, true)
        .unwrap();
    assert_eq!(
        super::service_bridge::recovery_retained_status(&store, &original).unwrap(),
        Some(unknown.clone())
    );
    for (method, request) in [
        ("status", json!({"operationId":op})),
        ("start", request(op)),
    ] {
        assert!(
            matches!(call(&store,method,request,|_,_|panic!("stopped operation reached provider")),Err(AppError::Service{ref code,..}) if code=="recovery_stopped")
        );
    }
    assert_eq!(
        store.provider_receipt("consumer", op).unwrap(),
        Some(unknown)
    );
    assert!(store.claims().unwrap().is_empty());
    // Execution release allows compatible package changes, not an old
    // consumer that would relabel the original unknown as interrupted.
    assert!(super::service_host::require_legacy_consumer_compatible(&store, "consumer").is_err());
    assert!(super::service_host::require_legacy_consumer_compatible(&store, "provider").is_ok());
    assert!(super::service_host::require_legacy_consumer_compatible(&store, "unrelated").is_ok());
}
fn stopped_unknown(store: &Store, op: &str) -> Value {
    start(store, op);
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
    call(store, "status", json!({"operationId":op}), |_, _| {
        Ok(unknown.clone())
    })
    .unwrap();
    store
        .stop_recovery(&provider(), "consumer", op, true)
        .unwrap();
    unknown
}
#[test]
fn dismissing_a_stopped_unknown_operation_clears_it_durably_and_keeps_its_evidence() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let (op, other) = ("dismissed", "kept");
    s.register_job(job(op, 5)).unwrap();
    let unknown = stopped_unknown(&s, op);
    ready(&s, other);
    let rows = super::ai_operations::operation_rows(&s, |_| true).unwrap();
    let row = rows.iter().find(|r| r["operationId"] == op).unwrap();
    assert_eq!(row["canDismiss"], true);
    assert_eq!(row["canStop"], false);
    assert_eq!(row["canResume"], false);
    assert_eq!(
        rows.iter().find(|r| r["operationId"] == other).unwrap()["canDismiss"],
        false
    );
    let settled = s.dismiss_operation("consumer", op).unwrap().unwrap();
    assert_eq!(settled.state, JobState::Discarded);
    assert!(s.dismiss_operation("consumer", op).unwrap().is_none());
    let visible = |s: &Store| {
        super::ai_operations::operation_rows(s, |_| true)
            .unwrap()
            .iter()
            .map(|r| r["operationId"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(visible(&s), [other]);
    // Evidence is retained, not deleted, and nothing can replay it.
    assert_eq!(s.provider_receipt("consumer", op).unwrap(), Some(unknown));
    assert!(s.get("consumer", op).unwrap().is_some());
    assert!(s.execution_released("consumer", op).unwrap());
    assert!(
        matches!(call(&s,"start",request(op),|_,_|panic!("dismissed operation reached provider")),Err(AppError::Service{ref code,..}) if code=="recovery_stopped")
    );
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(visible(&reopened), [other]);
    assert_eq!(
        reopened.job(&settled.job_key).unwrap().unwrap().state,
        JobState::Discarded
    );
}
#[test]
fn only_a_stopped_unknown_operation_can_be_dismissed() {
    let (_root, s) = fixture();
    start(&s, "running");
    ready(&s, "succeeded");
    let mut unknown = status("live", "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
    start(&s, "live");
    call(&s, "status", json!({"operationId":"live"}), |_, _| {
        Ok(unknown.clone())
    })
    .unwrap();
    for op in ["running", "succeeded", "live", "missing"] {
        assert!(s.dismiss_operation("consumer", op).is_err(), "{op}");
    }
    let rows = super::ai_operations::operation_rows(&s, |_| true).unwrap();
    assert!(rows.iter().all(|r| r["canDismiss"] == false));
    assert_eq!(rows.len(), 3);
}
#[test]
fn a_dismissed_operation_resurfaces_when_the_provider_reports_newer_evidence() {
    let (_root, s) = fixture();
    let op = "resurface";
    let unknown = stopped_unknown(&s, op);
    s.dismiss_operation("consumer", op).unwrap();
    assert!(super::ai_operations::operation_rows(&s, |_| true)
        .unwrap()
        .is_empty());
    let mut newer = unknown;
    newer["revision"] = json!(3);
    s.observe_receipt(&provider(), "consumer", op, 3, newer)
        .unwrap();
    let rows = super::ai_operations::operation_rows(&s, |_| true).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["operationId"], op);
    assert_eq!(rows[0]["canDismiss"], true);
    // Dismissing again pins the newer revision.
    s.dismiss_operation("consumer", op).unwrap();
    assert!(super::ai_operations::operation_rows(&s, |_| true)
        .unwrap()
        .is_empty());
}
#[test]
fn explicit_discard_is_authoritative_for_a_previously_queued_recovery_snapshot() {
    let (_root, store) = fixture();
    let op = "discarded-recovery";
    ready(&store, op);
    let original = store.get("consumer", op).unwrap().unwrap();
    let receipt = status(op, "succeeded", json!({"state":"discarded"}));
    reconcile_at(&store, &provider(), &original, &receipt).unwrap();
    assert_eq!(
        super::service_bridge::recovery_retained_status(&store, &original).unwrap(),
        Some(receipt)
    );
    assert!(store.claims().unwrap().is_empty());
}
#[test]
fn altered_same_id_digest_and_input_set_conflict_before_provider_dispatch() {
    let (_root, s) = fixture();
    start(&s, "changed");
    let mut changed = request("changed");
    changed["effectiveRecipeDigest"] = json!("d".repeat(64));
    assert!(call(&s, "start", changed, |_, _| panic!(
        "conflicting recipe dispatched"
    ))
    .is_err());
    let mut changed = request("changed");
    changed["inputs"] = json!([{"handle":"e".repeat(48),"sha256":"f".repeat(64),"byteLength":1,"mediaType":"image/png"}]);
    assert!(call(&s, "start", changed, |_, _| panic!(
        "conflicting inputs dispatched"
    ))
    .is_err());
    assert_eq!(s.claims().unwrap().len(), 1);
}
#[test]
fn restart_replay_and_control_calls_never_repeat_provider_start() {
    let (root, s) = fixture();
    assert!(call(&s, "start", request("lost"), |method, _| {
        assert!(method.ends_with(".start"));
        Err(AppError::Other("fake lost response".into()))
    })
    .is_err());
    assert_eq!(
        s.get("consumer", "lost").unwrap().unwrap().phase,
        AdmissionPhase::Forwarding
    );
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    call(&s, "start", request("lost"), |method, params| {
        assert!(method.ends_with(".status"));
        assert_eq!(params["request"], json!({"operationId":"lost"}));
        Ok(running("lost"))
    })
    .unwrap();
    for control in ["status", "cancel"] {
        call(&s, control, json!({"operationId":"lost"}), |method, _| {
            assert!(method.ends_with(&format!(".{control}")));
            Ok(running("lost"))
        })
        .unwrap();
    }
    assert_eq!(s.claims().unwrap().len(), 1);
}
#[test]
fn wrong_generations_and_receipt_identities_preserve_original_claim() {
    let (_root, s) = fixture();
    start(&s, "owned");
    let bad_consumer = generation("consumer", 'd');
    assert!(image_call(
        &s,
        &bad_consumer,
        &provider(),
        &target(),
        "status",
        json!({"operationId":"owned"}),
        || true,
        |_, _| panic!("wrong consumer invoked")
    )
    .is_err());
    let bad_provider = generation("provider", 'd');
    assert!(image_call(
        &s,
        &consumer(),
        &bad_provider,
        &target(),
        "status",
        json!({"operationId":"owned"}),
        || true,
        |_, _| panic!("wrong provider invoked")
    )
    .is_err());
    for (field, value) in [
        ("operationId", json!("different")),
        ("requestFingerprint", json!("d".repeat(64))),
        (
            "provider",
            json!({"packageId":"different","serviceId":"image-generation","major":1}),
        ),
        ("version", json!(2)),
    ] {
        let mut malformed = running("owned");
        malformed[field] = value;
        assert!(
            call(&s, "status", json!({"operationId":"owned"}), |_, _| Ok(
                malformed.clone()
            ))
            .is_err()
        );
        assert_eq!(
            s.get("consumer", "owned").unwrap().unwrap().phase,
            AdmissionPhase::Accepted
        );
    }
}
#[test]
fn acquired_ack_requires_durable_copy_receipt_before_provider_invocation() {
    let (root, s) = fixture();
    let d = ready(&s, "handoff");
    let ack = json!({"operationId":"handoff","outputSha256":d.sha256,"disposition":"acquired","transferReceipt":"forged"});
    assert!(call(&s, "acknowledge", ack, |_, _| panic!(
        "forged acquisition reached provider"
    ))
    .is_err());
    let consumer_root = root.path().join("consumer-data");
    fs::create_dir(&consumer_root).unwrap();
    s.register_consumer_root("consumer", consumer_root.clone())
        .unwrap();
    let copy = consumer_root.join("durable.png");
    fs::copy(
        s.read(&consumer(), "consumer", "handoff", &d).unwrap().path,
        &copy,
    )
    .unwrap();
    let receipt = s
        .acquired(&consumer(), "handoff", &d, copy.to_str().unwrap())
        .unwrap();
    call(&s,"acknowledge",json!({"operationId":"handoff","outputSha256":d.sha256,"disposition":"acquired","transferReceipt":receipt.transfer_receipt}),|method,_| {
        assert!(method.ends_with(".acknowledge"));Ok(status("handoff","succeeded",json!({"state":"acquired","transferReceipt":receipt.transfer_receipt})))
    }).unwrap();
    assert!(copy.is_file());
    assert!(s.claims().unwrap().is_empty());
    assert_eq!(
        s.get("consumer", "handoff")
            .unwrap()
            .unwrap()
            .transfer_receipt,
        Some(receipt.transfer_receipt)
    );
}
#[test]
fn acknowledgement_transport_and_host_write_failures_retain_claims_until_reconciled() {
    let (root, s) = fixture();
    let d = ready(&s, "ack-failure");
    let ack =
        json!({"operationId":"ack-failure","outputSha256":d.sha256,"disposition":"discarded"});
    assert!(
        call(&s, "acknowledge", ack.clone(), |_, _| Err(AppError::Other(
            "fake response lost".into()
        )))
        .is_err()
    );
    assert!(s.read(&consumer(), "consumer", "ack-failure", &d).is_ok());
    let db = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_release BEFORE UPDATE ON operations WHEN NEW.phase='released' BEGIN SELECT RAISE(ABORT,'fake disk failure'); END;").unwrap();
    assert!(call(&s, "acknowledge", ack.clone(), |_, _| Ok(status(
        "ack-failure",
        "succeeded",
        json!({"state":"discarded"})
    )))
    .is_err());
    assert!(s.busy("provider").unwrap());
    assert!(s.read(&consumer(), "consumer", "ack-failure", &d).is_ok());
    db.execute_batch("DROP TRIGGER fail_release;").unwrap();
    drop(db);
    call(&s, "acknowledge", ack, |method, _| {
        assert!(method.ends_with(".acknowledge"));
        Ok(status(
            "ack-failure",
            "succeeded",
            json!({"state":"discarded"}),
        ))
    })
    .unwrap();
    assert!(s.claims().unwrap().is_empty());
}
#[test]
fn unavailable_output_restores_the_same_success_without_another_start() {
    let (_root, s) = fixture();
    start(&s, "restore");
    let d = sealed(&s, "restore");
    call(
        &s,
        "status",
        json!({"operationId":"restore"}),
        |method, _| {
            assert!(method.ends_with(".status"));
            Ok(status(
                "restore",
                "succeeded",
                json!({"state":"unavailable","reason":"missing"}),
            ))
        },
    )
    .unwrap();
    assert!(s
        .get("consumer", "restore")
        .unwrap()
        .unwrap()
        .output
        .is_none());
    call(&s, "start", request("restore"), |method, _| {
        assert!(method.ends_with(".status"));
        let mut restored = status(
            "restore",
            "succeeded",
            json!({"state":"available","output":d}),
        );
        restored["revision"] = json!(3);
        Ok(restored)
    })
    .unwrap();
    assert_eq!(
        s.get("consumer", "restore").unwrap().unwrap().output,
        Some(d.clone())
    );
    assert!(Path::new(&s.read(&consumer(), "consumer", "restore", &d).unwrap().path).is_file());
    let a = s.get("consumer", "restore").unwrap().unwrap();
    reconcile_at(&s, &provider(), &a, &{
        let mut unavailable = status(
            "restore",
            "succeeded",
            json!({"state":"unavailable","reason":"corrupt"}),
        );
        unavailable["revision"] = json!(4);
        unavailable
    })
    .unwrap();
    assert_eq!(
        s.get("consumer", "restore").unwrap().unwrap().output,
        Some(d)
    );
}
#[test]
fn dead_consumer_never_invokes_provider_paid_start() {
    let (_root, s) = fixture();
    assert!(image_call(
        &s,
        &consumer(),
        &provider(),
        &target(),
        "start",
        request("dead"),
        || false,
        |_, _| panic!("dead caller dispatched")
    )
    .is_err());
    assert!(s.get("consumer", "dead").unwrap().is_none());
}
#[test]
fn death_before_new_admission_cannot_leave_an_unscheduled_claim() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_root, store) = fixture();
    let checks = AtomicUsize::new(0);
    assert!(image_call(
        &store,
        &consumer(),
        &provider(),
        &target(),
        "start",
        request("creation-gap"),
        || {
            if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                // The first check precedes the death scan. It saw no claim.
                assert!(store.claims().unwrap().is_empty());
                true
            } else {
                false
            }
        },
        |_, _| panic!("disconnected owner dispatched paid work")
    )
    .is_err());
    assert!(store.get("consumer", "creation-gap").unwrap().is_none());
    assert!(!store.busy("consumer").unwrap());
}
#[test]
fn malformed_execution_delivery_and_metadata_never_mutate_admission() {
    let (_root, s) = fixture();
    start(&s, "malformed");
    let before = s.get("consumer", "malformed").unwrap().unwrap();
    let mut cases = vec![];
    let mut value = running("malformed");
    value["revision"] = json!(2);
    value["execution"] = json!({"state":"succeeded"});
    cases.push(value);
    let mut value = running("malformed");
    value["revision"] = json!(2);
    value["execution"] = json!({"state":"unknown"});
    cases.push(value);
    let mut value = running("malformed");
    value["revision"] = json!(2);
    value["delivery"] = json!({"state":"available","output":{"handle":"a".repeat(48),"sha256":"b".repeat(64),"byteLength":1,"mediaType":"image/png"}});
    cases.push(value);
    let mut value = running("malformed");
    value["revision"] = json!(2);
    value["delivery"] = json!({"state":"unexpected"});
    cases.push(value);
    let mut value = status("malformed", "succeeded", json!({"state":"none"}));
    value["execution"]["metadata"]["key"] = json!("fake-private-key");
    cases.push(value);
    for malformed in cases {
        assert!(
            call(&s, "status", json!({"operationId":"malformed"}), |_, _| Ok(
                malformed.clone()
            ))
            .is_err()
        );
        assert_eq!(
            s.get("consumer", "malformed").unwrap(),
            Some(before.clone())
        );
    }
}
#[test]
fn lower_revision_reply_returns_latest_receipt_and_equal_conflict_is_rejected() {
    let (_root, s) = fixture();
    let d = ready(&s, "versioned");
    let latest = call(&s, "status", json!({"operationId":"versioned"}), |_, _| {
        Ok(running("versioned"))
    })
    .unwrap();
    assert_eq!(latest["revision"], 2);
    assert_eq!(latest["execution"]["state"], "succeeded");
    assert_eq!(
        s.get("consumer", "versioned").unwrap().unwrap().output,
        Some(d.clone())
    );
    let mut conflicting = status(
        "versioned",
        "succeeded",
        json!({"state":"available","output":d}),
    );
    conflicting["execution"]["metadata"]["actualModel"] = json!("changed-at-same-revision");
    assert!(
        call(&s, "status", json!({"operationId":"versioned"}), |_, _| Ok(
            conflicting.clone()
        ))
        .is_err()
    );
}
#[test]
fn forged_same_recipe_digest_with_changed_prompt_never_returns_replay_success() {
    let (_root, s) = fixture();
    start(&s, "semantic");
    let mut changed = request("semantic");
    changed["prompt"] = json!("a different paid request");
    assert!(call(&s, "start", changed, |_, _| panic!(
        "changed semantic request reached provider"
    ))
    .is_err());
    assert_eq!(
        s.get("consumer", "semantic").unwrap().unwrap().phase,
        AdmissionPhase::Accepted
    );
}
#[test]
fn identical_input_content_with_recreated_handle_replays_original_status() {
    let (root, s) = fixture();
    let input = root.path().join("same-content.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let captured = s
        .capture(
            &consumer(),
            "content",
            vec![CaptureInput {
                path: input.to_string_lossy().into(),
                expected_digest: None,
            }],
        )
        .unwrap();
    let mut first = request("content");
    first["inputs"] = json!([captured[0].artifact]);
    call(&s, "start", first.clone(), |method, _| {
        assert!(method.ends_with(".start"));
        Ok(running("content"))
    })
    .unwrap();
    let mut replay = first;
    replay["preparationToken"] = json!("different-incidental-token");
    replay["inputs"][0]["handle"] = json!("d".repeat(48));
    call(&s, "start", replay, |method, params| {
        assert!(method.ends_with(".status"));
        assert_eq!(params["request"], json!({"operationId":"content"}));
        Ok(running("content"))
    })
    .unwrap();
    assert_eq!(
        s.get("consumer", "content").unwrap().unwrap().inputs,
        vec![captured[0].artifact.clone()]
    );
}
#[test]
fn malformed_start_never_reserves_or_invokes_provider() {
    let (_root, s) = fixture();
    let mut malformed = request("invalid");
    malformed["prompt"] = json!("");
    assert!(call(&s, "start", malformed, |_, _| panic!(
        "malformed start invoked provider"
    ))
    .is_err());
    assert!(s.get("consumer", "invalid").unwrap().is_none());
    assert!(!s.busy("provider").unwrap());
}
#[test]
fn reserved_cross_incarnation_start_expires_before_provider_dispatch() {
    let (_root, s) = fixture();
    let body = request("expired-router");
    let intent = crate::service_state::request::semantic(&body).unwrap();
    let a = Admission {
        consumer: consumer(),
        provider: provider(),
        target: target(),
        operation_id: "expired-router".into(),
        fingerprint: "c".repeat(64),
        phase: AdmissionPhase::Reserved,
        inputs: vec![],
        output: None,
        needs_attention: false,
        disposition: None,
        transfer_receipt: None,
    };
    s.reserve_intent(a.clone(), &intent).unwrap();
    let mut next_consumer = consumer();
    next_consumer.incarnation = 2;
    let mut next_provider = provider();
    next_provider.incarnation = 2;
    assert!(image_call(
        &s,
        &next_consumer,
        &next_provider,
        &target(),
        "start",
        body,
        || true,
        |_, _| panic!("expired preparation forwarded start")
    )
    .is_err());
    assert_eq!(s.get("consumer", "expired-router").unwrap(), Some(a));
    assert_eq!(s.release_preparations(&consumer()).unwrap(), 1);
}
#[test]
fn invalid_owned_output_receipt_can_be_corrected_at_same_revision() {
    let (_root, s) = fixture();
    start(&s, "corrected");
    let d = sealed(&s, "corrected");
    let mut forged = d.clone();
    forged.handle = "e".repeat(48);
    assert!(
        call(&s, "status", json!({"operationId":"corrected"}), |_, _| Ok(
            status(
                "corrected",
                "succeeded",
                json!({"state":"available","output":forged})
            )
        ))
        .is_err()
    );
    assert_eq!(
        s.get("consumer", "corrected").unwrap().unwrap().phase,
        AdmissionPhase::Accepted
    );
    call(&s, "status", json!({"operationId":"corrected"}), |_, _| {
        Ok(status(
            "corrected",
            "succeeded",
            json!({"state":"available","output":d}),
        ))
    })
    .unwrap();
    assert_eq!(
        s.get("consumer", "corrected").unwrap().unwrap().output,
        Some(d)
    );
}

// ---- Recovery ownership: the real recovery policy against a durable Store
// and a fake provider port that records every provider call it receives.
use super::service_bridge::{recover_owned, startup_owners, RecoveryPort};
use crate::recovery_actor::Mode;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
type Reply = Box<dyn Fn(&Admission, &str) -> Result<Value, AppError> + Send + Sync>;
struct FakeRecovery {
    answering: PackageGeneration,
    available: AtomicBool,
    closing: AtomicBool,
    calls: Mutex<Vec<(String, String, String)>>,
    signals: Mutex<Vec<String>>,
    reply: Reply,
}
impl FakeRecovery {
    fn new(
        reply: impl Fn(&Admission, &str) -> Result<Value, AppError> + Send + Sync + 'static,
    ) -> Self {
        let mut answering = provider();
        answering.incarnation = 2;
        Self {
            answering,
            available: AtomicBool::new(true),
            closing: AtomicBool::new(false),
            calls: Mutex::new(vec![]),
            signals: Mutex::new(vec![]),
            reply: Box::new(reply),
        }
    }
    /// (consumer, operation, method) for every authoritative provider call.
    fn calls(&self) -> Vec<(String, String, String)> {
        self.calls.lock().unwrap().clone()
    }
    fn methods_for(&self, op: &str) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|(_, o, _)| o == op)
            .map(|(_, _, m)| m)
            .collect()
    }
}
impl RecoveryPort for FakeRecovery {
    fn closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
    fn signal_cancel(&self, admission: &Admission) {
        self.signals
            .lock()
            .unwrap()
            .push(admission.operation_id.clone());
    }
    fn control(
        &self,
        admission: &Admission,
        method: &str,
        settle: &mut dyn FnMut(&PackageGeneration, &Value) -> Result<(), AppError>,
    ) -> Result<Value, AppError> {
        if !self.available.load(Ordering::SeqCst) {
            return Err(AppError::Other("Recovery provider is unavailable".into()));
        }
        self.calls.lock().unwrap().push((
            admission.consumer.package_id.clone(),
            admission.operation_id.clone(),
            method.into(),
        ));
        let response = (self.reply)(admission, method)?;
        settle(&self.answering, &response)?;
        Ok(response)
    }
}
fn recover(store: &Store, port: &FakeRecovery, dead: &PackageGeneration, attempt: Duration) {
    // Begin the bounded recovery clock after owning the shared action lane;
    // another test's lifecycle matrix is not simulated provider latency.
    let _action = super::ai_operations::action_guard().unwrap();
    let now = Instant::now();
    recover_owned(
        store,
        port,
        dead,
        Mode::Attempt,
        now + attempt,
        now + attempt + Duration::from_millis(50),
    )
    .unwrap();
}
fn second() -> PackageGeneration {
    generation("second.consumer", 'e')
}
fn call_as(
    store: &Store,
    caller: &PackageGeneration,
    method: &str,
    params: Value,
    invoke: impl Fn(&str, Value) -> Result<Value, AppError>,
) -> Result<Value, AppError> {
    image_call(
        store,
        caller,
        &provider(),
        &target(),
        method,
        params,
        || true,
        invoke,
    )
}
fn sealed_for(store: &Store, consumer: &str, op: &str) -> ArtifactDescriptor {
    let stage = store.stage(&provider(), consumer, op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    store
        .seal(&provider(), consumer, op, &stage.handle, "image/png")
        .unwrap()
}
fn with_revision(mut receipt: Value, revision: u64) -> Value {
    receipt["revision"] = json!(revision);
    receipt
}
fn available(op: &str, d: &ArtifactDescriptor) -> Value {
    status(op, "succeeded", json!({"state":"available","output":d}))
}
fn cancelled(op: &str) -> Value {
    with_revision(status(op, "cancelled", json!({"state":"none"})), 2)
}
fn incarnation(mut g: PackageGeneration, n: u64) -> PackageGeneration {
    g.incarnation = n;
    g
}
/// Counts provider `start` dispatches across every path in a test.
fn starts(log: &Mutex<Vec<String>>) -> usize {
    log.lock()
        .unwrap()
        .iter()
        .filter(|m| m.ends_with(".start"))
        .count()
}
fn logged<'a>(
    log: &'a Mutex<Vec<String>>,
    reply: impl Fn(&str) -> Result<Value, AppError> + 'a,
) -> impl Fn(&str, Value) -> Result<Value, AppError> + 'a {
    move |method, _| {
        log.lock().unwrap().push(method.to_owned());
        reply(method)
    }
}
/// §21.3 #3 (transport loss): the provider's transport dies while two
/// independent consumers each own an accepted operation. One recovery task
/// owns both: each is reconciled through status only, neither consumer's work
/// is cancelled, and nothing is started again.
#[test]
fn provider_transport_loss_puts_both_consumers_operations_under_one_status_recovery() {
    let (_root, s) = fixture();
    let log = Mutex::new(vec![]);
    call_as(
        &s,
        &consumer(),
        "start",
        request("first-op"),
        logged(&log, |_| Ok(running("first-op"))),
    )
    .unwrap();
    call_as(
        &s,
        &second(),
        "start",
        request("second-op"),
        logged(&log, |_| Ok(running("second-op"))),
    )
    .unwrap();
    let first = sealed_for(&s, "consumer", "first-op");
    let second_output = sealed_for(&s, "second.consumer", "second-op");
    let polls = std::sync::atomic::AtomicUsize::new(0);
    let (first_reply, second_reply) = (first.clone(), second_output.clone());
    let port = FakeRecovery::new(move |a, _| {
        Ok(match a.operation_id.as_str() {
            "first-op" => available("first-op", &first_reply),
            // The second operation is still running on the first poll.
            _ if polls.fetch_add(1, Ordering::SeqCst) == 0 => running("second-op"),
            _ => available("second-op", &second_reply),
        })
    });
    recover(&s, &port, &provider(), Duration::from_secs(5));
    let calls = port.calls();
    assert!(
        calls.iter().all(|(_, _, method)| method == "status"),
        "{calls:?}"
    );
    assert_eq!(port.methods_for("first-op"), ["status"]);
    assert_eq!(port.methods_for("second-op"), ["status", "status"]);
    assert!(
        port.signals.lock().unwrap().is_empty(),
        "live consumers were cancelled"
    );
    assert_eq!(starts(&log), 2);
    for (consumer, op, output) in [
        ("consumer", "first-op", first),
        ("second.consumer", "second-op", second_output),
    ] {
        let a = s.get(consumer, op).unwrap().unwrap();
        assert_eq!(a.phase, AdmissionPhase::Terminal, "{op}");
        assert_eq!(a.output, Some(output), "{op}");
        assert!(!a.needs_attention, "{op}");
    }
    // Both retained outputs await their own consumer's handoff.
    assert_eq!(s.claims().unwrap().len(), 2);
}
/// §21.3 #3: one consumer's transport loss transfers only its own operation
/// to recovery. The other consumer's operation on the same provider is not
/// signalled, cancelled, polled or changed.
#[test]
fn one_consumers_transport_loss_never_cancels_another_consumers_operation() {
    let (_root, s) = fixture();
    let log = Mutex::new(vec![]);
    call_as(
        &s,
        &consumer(),
        "start",
        request("lost-op"),
        logged(&log, |_| Ok(running("lost-op"))),
    )
    .unwrap();
    call_as(
        &s,
        &second(),
        "start",
        request("kept-op"),
        logged(&log, |_| Ok(running("kept-op"))),
    )
    .unwrap();
    let kept = s.get("second.consumer", "kept-op").unwrap().unwrap();
    let port = FakeRecovery::new(|a, method| {
        assert_eq!(
            a.operation_id, "lost-op",
            "unrelated operation reached recovery"
        );
        Ok(if method == "cancel" {
            cancelled("lost-op")
        } else {
            running("lost-op")
        })
    });
    recover(&s, &port, &consumer(), Duration::from_secs(5));
    assert_eq!(*port.signals.lock().unwrap(), ["lost-op"]);
    assert_eq!(port.methods_for("lost-op"), ["cancel"]);
    assert!(port.methods_for("kept-op").is_empty());
    assert_eq!(s.get("second.consumer", "kept-op").unwrap(), Some(kept));
    let lost = s.get("consumer", "lost-op").unwrap().unwrap();
    assert_eq!(lost.phase, AdmissionPhase::Released);
    assert_eq!(
        s.provider_receipt("consumer", "lost-op").unwrap().unwrap()["execution"]["state"],
        "cancelled"
    );
    assert_eq!(starts(&log), 2);
}
fn ready_logged(store: &Store, log: &Mutex<Vec<String>>, op: &str) -> ArtifactDescriptor {
    call_as(
        store,
        &consumer(),
        "start",
        request(op),
        logged(log, |_| Ok(running(op))),
    )
    .unwrap();
    let d = sealed_for(store, "consumer", op);
    call_as(
        store,
        &consumer(),
        "status",
        json!({"operationId":op}),
        logged(log, |_| Ok(available(op, &d))),
    )
    .unwrap();
    d
}
fn job(op: &str, n: u64) -> crate::service_state::job::JobRecord {
    use crate::service_state::job::{JobRecord, JobState};
    JobRecord {
        job_key: format!("{n:048x}"),
        owner: consumer(),
        operation_id: op.into(),
        job_id: n,
        kind: "openai-image".into(),
        label: "generated.png".into(),
        origin_window: "main".into(),
        revision: 0,
        source_revision: 0,
        ownership_epoch: 0,
        created_at_ms: 1_000 + n,
        updated_at_ms: 1_000 + n,
        settled_at_ms: None,
        estimate_key: None,
        state: JobState::Accepting,
        phase: Some("preparing".into()),
        output_path: None,
        cost: None,
        reveal: None,
        run_id: None,
        error: None,
    }
}
/// §14.3 host shutdown: an image operation is in flight when the host shuts
/// down. Shutdown performs no provider IO; the durable claim survives the
/// restart; startup recovery reaches the provider through controls only; the
/// restarted consumer reattaches through status; and the job keeps its
/// original creation time, which bounds its attention deadline.
#[test]
fn host_restart_with_inflight_image_reattaches_without_start_or_renewed_deadline() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let log = Mutex::new(vec![]);
    let op = "inflight";
    let accepted = s.register_job(job(op, 7)).unwrap();
    let registered = s
        .update_job(
            &accepted.owner,
            &accepted.job_key,
            JobState::Running,
            Some("running".into()),
            None,
            None,
            None,
        )
        .unwrap();
    call_as(
        &s,
        &consumer(),
        "start",
        request(op),
        logged(&log, |_| Ok(running(op))),
    )
    .unwrap();
    // The provider sealed its result just before the host began shutting down.
    let d = sealed_for(&s, "consumer", op);
    let shutdown = FakeRecovery::new(|_, _| panic!("shutdown reached the provider"));
    shutdown.closing.store(true, Ordering::SeqCst);
    recover(&s, &shutdown, &consumer(), Duration::from_secs(5));
    assert!(shutdown.calls().is_empty() && shutdown.signals.lock().unwrap().is_empty());
    let before = s.get("consumer", op).unwrap().unwrap();
    assert_eq!(before.phase, AdmissionPhase::Accepted);
    assert!(!before.needs_attention);
    drop(s);

    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(s.get("consumer", op).unwrap(), Some(before));
    assert_eq!(startup_owners(&s).unwrap(), vec![consumer()]);
    let recovered = s.recover_jobs(None).unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, JobState::Recovering);
    assert_eq!(recovered[0].created_at_ms, registered.created_at_ms);
    let reply = d.clone();
    let port = FakeRecovery::new(move |_, _| Ok(available(op, &reply)));
    recover(&s, &port, &consumer(), Duration::from_secs(5));
    // Startup cancels-and-reconciles the dead incarnation; it never starts.
    assert_eq!(port.methods_for(op), ["cancel"]);
    let a = s.get("consumer", op).unwrap().unwrap();
    assert_eq!(a.phase, AdmissionPhase::Terminal);
    assert_eq!(a.output, Some(d.clone()));
    // The restarted consumer replays its original start; only status leaves.
    let restarted = incarnation(consumer(), 2);
    let replayed = call_as(
        &s,
        &restarted,
        "start",
        request(op),
        logged(&log, |method| {
            assert!(method.ends_with(".status"), "{method}");
            Ok(available(op, &d))
        }),
    )
    .unwrap();
    assert_eq!(replayed["execution"]["state"], "succeeded");
    assert!(s.read(&restarted, "consumer", op, &d).is_ok());
    assert_eq!(starts(&log), 1);
    let current = s.job(&registered.job_key).unwrap().unwrap();
    assert!(!current.state.terminal());
    assert_eq!(current.created_at_ms, registered.created_at_ms);
}
/// §14.3 caller death while the provider is live. The dead consumer's three
/// running operations meet three gate orders: success before cancel, cancel
/// before success, and cancel not yet effective at the recovery deadline.
/// The host records each authoritative outcome, never fabricates a failure,
/// keeps the unresolved one recoverable, and never starts provider work.
#[test]
fn consumer_death_during_provider_execution_settles_each_gate_order_without_failure_or_replay() {
    let (root, s) = fixture();
    let log = Mutex::new(vec![]);
    for op in ["success-first", "cancel-first", "still-running"] {
        call_as(
            &s,
            &consumer(),
            "start",
            request(op),
            logged(&log, |_| Ok(running(op))),
        )
        .unwrap();
    }
    let won = sealed_for(&s, "consumer", "success-first");
    let reply = won.clone();
    let port = FakeRecovery::new(move |a, method| {
        Ok(match (a.operation_id.as_str(), method) {
            ("success-first", _) => available("success-first", &reply),
            ("cancel-first", _) => cancelled("cancel-first"),
            (op, _) => running(op),
        })
    });
    recover(&s, &port, &consumer(), Duration::from_millis(1500));
    let mut signalled = port.signals.lock().unwrap().clone();
    signalled.sort();
    assert_eq!(
        signalled,
        ["cancel-first", "still-running", "success-first"]
    );
    for op in ["success-first", "cancel-first", "still-running"] {
        let methods = port.methods_for(op);
        assert_eq!(methods[0], "cancel", "{op}");
        assert!(
            methods[1..].iter().all(|m| m == "status"),
            "{op}: {methods:?}"
        );
    }
    assert_eq!(starts(&log), 3);

    // Success won: the result stays pinned for the next consumer incarnation.
    let success = s.get("consumer", "success-first").unwrap().unwrap();
    assert_eq!(success.phase, AdmissionPhase::Terminal);
    assert_eq!(success.output, Some(won.clone()));
    // Cancellation won: an authoritative cancel, not a failure.
    let cancel = s.get("consumer", "cancel-first").unwrap().unwrap();
    assert_eq!(cancel.phase, AdmissionPhase::Released);
    assert_eq!(
        s.provider_receipt("consumer", "cancel-first")
            .unwrap()
            .unwrap()["execution"]["state"],
        "cancelled"
    );
    // Unresolved: needs attention, still provider-owned, never terminal.
    let pending = s.get("consumer", "still-running").unwrap().unwrap();
    assert_eq!(pending.phase, AdmissionPhase::Accepted);
    assert!(pending.needs_attention);
    assert_eq!(
        s.provider_receipt("consumer", "still-running")
            .unwrap()
            .unwrap()["execution"]["state"],
        "running"
    );
    let mut retained: Vec<_> = s
        .claims()
        .unwrap()
        .into_iter()
        .map(|a| a.operation_id)
        .collect();
    retained.sort();
    assert_eq!(retained, ["still-running", "success-first"]);

    // The restarted consumer adopts both results through status and handoff.
    let restarted = incarnation(consumer(), 2);
    let late = sealed_for(&s, "consumer", "still-running");
    let data = root.path().join("consumer-data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    for (op, d) in [("success-first", won), ("still-running", late)] {
        let observed = call_as(
            &s,
            &restarted,
            "start",
            request(op),
            logged(&log, |method| {
                assert!(method.ends_with(".status"), "{method}");
                Ok(available(op, &d))
            }),
        )
        .unwrap();
        assert_eq!(observed["delivery"]["output"], json!(d));
        let copy = data.join(format!("{op}.png"));
        fs::copy(s.read(&restarted, "consumer", op, &d).unwrap().path, &copy).unwrap();
        let receipt = s
            .acquired(&restarted, op, &d, copy.to_str().unwrap())
            .unwrap();
        call_as(&s, &restarted, "acknowledge", json!({"operationId":op,"outputSha256":d.sha256,"disposition":"acquired","transferReceipt":receipt.transfer_receipt}), logged(&log, |_| {
            Ok(status(op, "succeeded", json!({"state":"acquired","transferReceipt":receipt.transfer_receipt})))
        }))
        .unwrap();
    }
    assert!(s.claims().unwrap().is_empty());
    assert_eq!(starts(&log), 3);
}
/// §14.3 missing provider on restart. The pinned provider package is absent
/// when the host restarts with a running operation. Recovery reaches no
/// provider, fabricates no failure, keeps the claim (which pins the package
/// against mutation) and reports why. A different provider version cannot
/// adopt it; re-enabling the pinned version recovers the original result.
#[test]
fn missing_pinned_provider_on_restart_keeps_operation_unresolved_until_that_version_returns() {
    let (root, s) = fixture();
    let log = Mutex::new(vec![]);
    let op = "orphaned-provider";
    call_as(
        &s,
        &consumer(),
        "start",
        request(op),
        logged(&log, |_| Ok(running(op))),
    )
    .unwrap();
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    let port = FakeRecovery::new(|_, _| panic!("missing provider was invoked"));
    port.available.store(false, Ordering::SeqCst);
    recover(&s, &port, &consumer(), Duration::from_millis(300));
    assert!(port.calls().is_empty());
    let a = s.get("consumer", op).unwrap().unwrap();
    assert_eq!(a.phase, AdmissionPhase::Accepted);
    assert!(a.needs_attention);
    assert_eq!(
        s.provider_receipt("consumer", op).unwrap(),
        Some(running(op)),
        "no failure or unknown outcome was fabricated"
    );
    assert!(s.busy("provider").unwrap());
    let rows = super::ai_operations::operation_rows(&s, |g| g.package_id != "provider").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["execution"], "running");
    assert_eq!(
        rows[0]["reason"],
        "Install or enable the original provider package to recover this operation"
    );
    assert_eq!(rows[0]["canDiscard"], false);
    assert_eq!(rows[0]["canStop"], false);

    // Another version of the provider package cannot adopt the operation.
    let restarted = incarnation(consumer(), 2);
    let upgraded = generation("provider", 'd');
    assert!(image_call(
        &s,
        &restarted,
        &upgraded,
        &target(),
        "status",
        json!({"operationId":op}),
        || true,
        |_, _| panic!("different provider version was invoked")
    )
    .is_err());
    assert_eq!(s.get("consumer", op).unwrap(), Some(a));

    // Re-enabling the pinned version: the original result is reconciled.
    let d = sealed_for(&s, "consumer", op);
    call_as(
        &s,
        &restarted,
        "start",
        request(op),
        logged(&log, |method| {
            assert!(method.ends_with(".status"), "{method}");
            Ok(available(op, &d))
        }),
    )
    .unwrap();
    let recovered = s.get("consumer", op).unwrap().unwrap();
    assert_eq!(recovered.phase, AdmissionPhase::Terminal);
    assert_eq!(recovered.output, Some(d));
    let rows = super::ai_operations::operation_rows(&s, |_| true).unwrap();
    assert_eq!(rows[0]["execution"], "succeeded");
    assert_eq!(rows[0]["delivery"], "available");
    assert_eq!(starts(&log), 1);
}
/// §21.3 #13: an orphan result (its consumer incarnation died) is imported,
/// acknowledged and, separately, discarded. Each action is attempted twice
/// after its first durable write fails. Bytes and claims are released only
/// after the committed disposition, and tombstones keep refusing replay.
#[test]
fn orphan_import_acknowledge_and_discard_release_only_after_durable_evidence() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let log = Mutex::new(vec![]);
    let adopter = incarnation(consumer(), 2);
    let data = root.path().join("consumer-data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    let retained = |op: &str, d: &ArtifactDescriptor| {
        s.read(&adopter, "consumer", op, d).is_ok()
            && s.claims().unwrap().iter().any(|a| a.operation_id == op)
    };

    // Import (adopt): the consumer's durable copy evidence.
    let d = ready_logged(&s, &log, "import");
    let copy = data.join("import.png");
    fs::copy(
        s.read(&adopter, "consumer", "import", &d).unwrap().path,
        &copy,
    )
    .unwrap();
    s.fail_next_write();
    assert!(s
        .acquired(&adopter, "import", &d, copy.to_str().unwrap())
        .is_err());
    assert!(retained("import", &d));
    let receipt = s
        .acquired(&adopter, "import", &d, copy.to_str().unwrap())
        .unwrap();
    assert_eq!(
        s.acquired(&adopter, "import", &d, copy.to_str().unwrap())
            .unwrap()
            .transfer_receipt,
        receipt.transfer_receipt
    );
    // Acknowledge: the provider's acquired receipt journal write fails once.
    let acquired = status(
        "import",
        "succeeded",
        json!({"state":"acquired","transferReceipt":receipt.transfer_receipt}),
    );
    let ack = json!({"operationId":"import","outputSha256":d.sha256,"disposition":"acquired","transferReceipt":receipt.transfer_receipt});
    s.fail_next_write();
    assert!(call_as(
        &s,
        &adopter,
        "acknowledge",
        ack.clone(),
        logged(&log, |_| Ok(acquired.clone()))
    )
    .is_err());
    assert!(retained("import", &d));
    assert_eq!(
        s.provider_receipt("consumer", "import").unwrap().unwrap()["delivery"]["state"],
        "available"
    );
    for _ in 0..2 {
        call_as(
            &s,
            &adopter,
            "acknowledge",
            ack.clone(),
            logged(&log, |_| Ok(acquired.clone())),
        )
        .unwrap();
        let a = s.get("consumer", "import").unwrap().unwrap();
        assert_eq!(a.phase, AdmissionPhase::Released);
        assert_eq!(
            a.transfer_receipt.as_deref(),
            Some(receipt.transfer_receipt.as_str())
        );
        assert!(!retained("import", &d));
    }
    assert!(copy.is_file());
    // A late immutable provider discard converges to the verified acquired
    // winner. Repeated replies preserve its receipt, bytes and released custody.
    let a = s.get("consumer", "import").unwrap().unwrap();
    let imported_bytes = fs::read(&copy).unwrap();
    for _ in 0..2 {
        reconcile_at(
            &s,
            &provider(),
            &a,
            &status("import", "succeeded", json!({"state":"discarded"})),
        )
        .unwrap();
        let current = s.get("consumer", "import").unwrap().unwrap();
        assert_eq!(current.phase, AdmissionPhase::Released);
        assert_eq!(current.disposition.as_deref(), Some("acquired"));
        assert_eq!(
            current.transfer_receipt.as_deref(),
            Some(receipt.transfer_receipt.as_str())
        );
        let observed = s.provider_receipt("consumer", "import").unwrap().unwrap();
        assert_eq!(observed["delivery"]["state"], "acquired");
        assert_eq!(
            observed["delivery"]["transferReceipt"],
            receipt.transfer_receipt
        );
        assert_eq!(fs::read(&copy).unwrap(), imported_bytes);
        assert!(s
            .claims()
            .unwrap()
            .iter()
            .all(|claim| claim.operation_id != "import"));
        assert!(s.read(&adopter, "consumer", "import", &d).is_err());
        assert!(!retained("import", &d));
    }
    call_as(
        &s,
        &adopter,
        "start",
        request("import"),
        logged(&log, |method| {
            assert!(method.ends_with(".status"), "{method}");
            Ok(acquired.clone())
        }),
    )
    .unwrap();

    // Discard: the explicit disposition's journal write fails once.
    let d = ready_logged(&s, &log, "discard");
    let registered = s.register_job(job("discard", 9)).unwrap();
    let a = s.get("consumer", "discard").unwrap().unwrap();
    let discarded = status("discard", "succeeded", json!({"state":"discarded"}));
    s.fail_next_write();
    assert!(super::ai_operations::commit_discard(&s, &provider(), &a, &discarded).is_err());
    assert!(retained("discard", &d));
    assert_eq!(
        s.get("consumer", "discard").unwrap().unwrap().disposition,
        None
    );
    assert_eq!(s.job(&registered.job_key).unwrap().unwrap(), registered);
    let job = super::ai_operations::commit_discard(&s, &provider(), &a, &discarded)
        .unwrap()
        .unwrap();
    assert_eq!(job.state, JobState::NeedsAttention);
    assert_eq!(job.phase.as_deref(), Some("provider_result_discarded"));
    assert!(!retained("discard", &d));
    assert_eq!(
        s.get("consumer", "discard")
            .unwrap()
            .unwrap()
            .disposition
            .as_deref(),
        Some("discarded")
    );
    // Repeating the discard is idempotent; import and acquisition are refused.
    assert_eq!(
        super::ai_operations::commit_discard(&s, &provider(), &a, &discarded).unwrap(),
        Some(job.clone()),
        "a repeated discard changes nothing"
    );
    let late_copy = data.join("late.png");
    fs::write(&late_copy, b"not the output").unwrap();
    assert!(s
        .acquired(&adopter, "discard", &d, late_copy.to_str().unwrap())
        .is_err());
    assert!(call_as(&s, &adopter, "acknowledge", json!({"operationId":"discard","outputSha256":d.sha256,"disposition":"acquired","transferReceipt":receipt.transfer_receipt}), |_, _| panic!("acquisition after discard reached the provider")).is_err());
    call_as(
        &s,
        &adopter,
        "start",
        request("discard"),
        logged(&log, |method| {
            assert!(method.ends_with(".status"), "{method}");
            Ok(discarded.clone())
        }),
    )
    .unwrap();
    assert_eq!(starts(&log), 2);
    assert!(s.claims().unwrap().is_empty());
}
fn corrupt_in_place(path: &str) {
    let mut bytes = fs::read(path).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    fs::write(path, &bytes).unwrap();
}
/// §21.3 #7 (host): the sealed artifact is corrupted in place (same length,
/// different bytes) after a succeeded receipt, and separately after an
/// acknowledged handoff whose byte collection is still deferred. Execution
/// stays succeeded; delivery is unavailable in the first case and remains
/// acquired in the second; corrupted bytes are never handed off; no replay.
#[test]
fn corrupted_sealed_output_keeps_success_and_distinguishes_unavailable_from_acquired() {
    let (root, s) = fixture();
    let log = Mutex::new(vec![]);
    let restarted = incarnation(consumer(), 2);
    let data = root.path().join("consumer-data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    // The fake provider derives delivery from the host's verified read, as
    // the real provider does before reporting an available output.
    let observe = |op: &str, d: &ArtifactDescriptor| {
        if s.read(&provider(), "consumer", op, d).is_ok() {
            available(op, d)
        } else {
            with_revision(
                status(
                    op,
                    "succeeded",
                    json!({"state":"unavailable","reason":"corrupt"}),
                ),
                3,
            )
        }
    };

    // After a succeeded receipt, before any handoff.
    let op = "corrupt-success";
    let d = ready_logged(&s, &log, op);
    let path = s.read(&consumer(), "consumer", op, &d).unwrap().path;
    corrupt_in_place(&path);
    assert_eq!(fs::metadata(&path).unwrap().len(), d.byte_length);
    assert!(s.read(&restarted, "consumer", op, &d).is_err());
    let receipt = call_as(
        &s,
        &restarted,
        "start",
        request(op),
        logged(&log, |method| {
            assert!(method.ends_with(".status"), "{method}");
            Ok(observe(op, &d))
        }),
    )
    .unwrap();
    assert_eq!(receipt["execution"]["state"], "succeeded");
    assert_eq!(
        receipt["delivery"],
        json!({"state":"unavailable","reason":"corrupt"})
    );
    let a = s.get("consumer", op).unwrap().unwrap();
    assert_eq!(a.phase, AdmissionPhase::Terminal);
    assert_eq!(
        a.output,
        Some(d.clone()),
        "the proven output identity stays pinned"
    );
    let copy = data.join("corrupt.png");
    fs::copy(&path, &copy).unwrap();
    assert!(s
        .acquired(&restarted, op, &d, copy.to_str().unwrap())
        .is_err());
    assert!(s.claims().unwrap().iter().any(|a| a.operation_id == op));
    let rows = super::ai_operations::operation_rows(&s, |_| true).unwrap();
    let row = rows.iter().find(|row| row["operationId"] == op).unwrap();
    assert_eq!(
        (row["execution"].as_str(), row["delivery"].as_str()),
        (Some("succeeded"), Some("unavailable"))
    );
    assert_eq!(row["canDiscard"], true);

    // After an acknowledged handoff whose byte collection is deferred.
    let op = "corrupt-acquired";
    let d = ready_logged(&s, &log, op);
    let path = s.read(&restarted, "consumer", op, &d).unwrap().path;
    let copy = data.join("acquired.png");
    fs::copy(&path, &copy).unwrap();
    let transfer = s
        .acquired(&restarted, op, &d, copy.to_str().unwrap())
        .unwrap();
    let acquired = status(
        op,
        "succeeded",
        json!({"state":"acquired","transferReceipt":transfer.transfer_receipt}),
    );
    let reader = s.hold_artifact_io(&d.handle).unwrap();
    call_as(&s, &restarted, "acknowledge", json!({"operationId":op,"outputSha256":d.sha256,"disposition":"acquired","transferReceipt":transfer.transfer_receipt}), logged(&log, |_| Ok(acquired.clone()))).unwrap();
    assert!(
        Path::new(&path).is_file(),
        "collection is deferred while IO is owned"
    );
    let original = fs::read(&path).unwrap();
    corrupt_in_place(&path);
    assert!(s.read(&restarted, "consumer", op, &d).is_err());
    assert_eq!(
        s.acquired(&restarted, op, &d, copy.to_str().unwrap())
            .unwrap()
            .transfer_receipt,
        transfer.transfer_receipt,
        "already acquired, not unavailable"
    );
    let replay = call_as(
        &s,
        &restarted,
        "start",
        request(op),
        logged(&log, |method| {
            assert!(method.ends_with(".status"), "{method}");
            Ok(acquired.clone())
        }),
    )
    .unwrap();
    assert_eq!(replay["execution"]["state"], "succeeded");
    assert_eq!(replay["delivery"]["state"], "acquired");
    let a = s.get("consumer", op).unwrap().unwrap();
    assert!(reconcile_at(
        &s,
        &provider(),
        &a,
        &with_revision(
            status(
                op,
                "succeeded",
                json!({"state":"unavailable","reason":"corrupt"})
            ),
            4
        )
    )
    .is_err());
    assert_eq!(
        fs::read(&copy).unwrap(),
        original,
        "the acquired copy is unaffected"
    );
    drop(reader);
    drop(s);
    let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert!(
        !Path::new(&path).exists(),
        "startup collects the released bytes"
    );
    assert_eq!(
        s.get("consumer", op).unwrap().unwrap().phase,
        AdmissionPhase::Released
    );
    assert_eq!(starts(&log), 2);
}

struct IdleAutomatic;
impl super::ai_operations::AutomaticPort for IdleAutomatic {
    fn active(
        &self,
        _: &Admission,
        _: Option<&crate::service_state::job::JobRecord>,
        _: bool,
        _: &str,
    ) -> Result<bool, AppError> {
        Ok(false)
    }
    fn recover(
        &self,
        _: &Admission,
        _: Option<&crate::service_state::job::JobRecord>,
    ) -> Result<(), AppError> {
        // Validated original bytes can arrive while provider knowledge is
        // still Unknown. This port defers their unpaid handoff; paid replay is
        // rejected by the production start path exercised by these tests.
        Ok(())
    }
}
#[test]
fn automatic_delayed_success_restores_recovery_ownership_across_restart() {
    use crate::service_state::job::JobState;
    for parked in [false, true] {
        let (root, s) = fixture();
        let op = "auto-delayed-success";
        if parked {
            let registered = s.register_job(job(op, 77)).unwrap();
            s.update_job(
                &registered.owner,
                &registered.job_key,
                JobState::NeedsAttention,
                Some("needs_attention".into()),
                None,
                None,
                Some("Lost reply".into()),
            )
            .unwrap();
        }
        start(&s, op);
        let descriptor = sealed(&s, op);
        super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
        assert!(!s.execution_released("consumer", op).unwrap());
        // The separate host publisher arrives after unsuccessful idle probes.
        let admission = s.get("consumer", op).unwrap().unwrap();
        reconcile_at(
            &s,
            &provider(),
            &admission,
            &status(
                op,
                "succeeded",
                json!({"state":"available","output":descriptor}),
            ),
        )
        .unwrap();
        drop(s);
        let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
        assert!(!reopened.execution_released("consumer", op).unwrap());
        assert_eq!(
            reopened.get("consumer", op).unwrap().unwrap().output,
            Some(descriptor.clone())
        );
        assert!(reopened
            .read(&consumer(), "consumer", op, &descriptor)
            .is_ok());
        assert_eq!(reopened.auto_settlement_operations().unwrap().len(), 1);
    }
}

#[test]
fn automatic_delayed_failure_keeps_the_store_openable() {
    let (root, s) = fixture();
    let op = "auto-delayed-failure";
    start(&s, op);
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    let mut failed = status(op, "failed", json!({"state":"none"}));
    failed["revision"] = json!(2);
    failed["execution"]["error"] =
        json!({"code":"rejected","message":"Provider rejected request","correlationId":null});
    let a = s.get("consumer", op).unwrap().unwrap();
    reconcile_at(&s, &provider(), &a, &failed).unwrap();
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        reopened.provider_receipt("consumer", op).unwrap(),
        Some(failed)
    );
}

#[test]
fn automatic_late_success_publication_is_atomic_and_repairs_legacy_flags() {
    for legacy in [false, true] {
        let (root, s) = fixture();
        let op = "auto-publication";
        start(&s, op);
        let d = sealed(&s, op);
        if !legacy {
            super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
        }
        let receipt = status(op, "succeeded", json!({"state":"available","output":d}));
        if !legacy {
            s.fail_next_write();
            assert!(s
                .observe_receipt(&provider(), "consumer", op, 2, receipt.clone())
                .is_err());
            assert!(!s.execution_released("consumer", op).unwrap());
            assert_eq!(
                s.provider_receipt("consumer", op).unwrap().unwrap(),
                running(op)
            );
        }
        // Crash after publication but before the bridge's phase reconciliation.
        s.observe_receipt(&provider(), "consumer", op, 2, receipt)
            .unwrap();
        if legacy {
            let a = s.get("consumer", op).unwrap().unwrap();
            s.terminal(&provider(), "consumer", op, Some(d.clone()), false)
                .unwrap();
            let db = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
            db.execute(
                "UPDATE operations SET exec_released=1 WHERE consumer='consumer' AND operation=?1",
                [op],
            )
            .unwrap();
            assert_eq!(a.operation_id, op);
        }
        drop(s);
        let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
        assert!(!reopened.execution_released("consumer", op).unwrap());
        assert!(reopened.read(&consumer(), "consumer", op, &d).is_ok());
        assert_eq!(reopened.auto_settlement_operations().unwrap().len(), 1);
    }
}

#[test]
fn review_failed_late_success_publication_remains_in_automatic_recovery() {
    let (_root, s) = fixture();
    let op = "review-failed-late-publication";
    start(&s, op);
    let output = sealed(&s, op);
    let a = s.get("consumer", op).unwrap().unwrap();
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Unconfirmed","correlationId":null});
    reconcile_at(&s, &provider(), &a, &unknown).unwrap();
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert_eq!(s.auto_settlement_operations().unwrap().len(), 1);
    assert_eq!(s.dismissed_revision("consumer", op).unwrap(), None);
    let mut success = status(
        op,
        "succeeded",
        json!({"state":"available","output":output}),
    );
    success["revision"] = json!(3);
    s.fail_next_write();
    assert!(reconcile_at(&s, &provider(), &a, &success).is_err());
    assert_eq!(s.provider_receipt("consumer", op).unwrap(), Some(unknown));
    assert_eq!(
        s.auto_settlement_operations().unwrap().len(),
        1,
        "a failed publication must not hide the authoritative success from the next recovery pass"
    );
    super::ai_operations::auto_reconcile_in(&s, &super::ai_operations::LiveAutomatic).unwrap();
    assert_eq!(s.provider_receipt("consumer", op).unwrap(), Some(success));
    assert_eq!(s.get("consumer", op).unwrap().unwrap().output, Some(output));
    assert!(!s.execution_released("consumer", op).unwrap());
    assert!(call(&s, "start", request(op), |method, _| {
        assert!(
            method.ends_with(".status"),
            "Unknown must never be replayed"
        );
        Ok(s.provider_receipt("consumer", op).unwrap().unwrap())
    })
    .is_ok());
}

#[test]
fn review_settled_output_recovery_obeys_quota_and_retries_after_capacity_release() {
    use crate::service_state::job::{JobRecord, JobState};
    for original_stage in [false, true] {
        let root = fixture_root();
        let s = Store::open(
            root.path().join("service"),
            Limits {
                disk_bytes: 101 * 1024 * 1024,
                ..Limits::default()
            },
        )
        .unwrap();
        let op = "review-quota-recovery";
        let registered = s.register_job(job(op, 93)).unwrap();
        start(&s, op);
        let stage = s.stage(&provider(), "consumer", op).unwrap();
        let a = s.get("consumer", op).unwrap().unwrap();
        let mut unknown = status(op, "unknown", json!({"state":"none"}));
        unknown["revision"] = json!(2);
        unknown["execution"]["error"] =
            json!({"code":"interrupted","message":"Unconfirmed","correlationId":null});
        reconcile_at(&s, &provider(), &a, &unknown).unwrap();
        s.auto_settle_operation("consumer", op, true).unwrap();
        if original_stage {
            // The provider's original late copy arrives after empty settlement.
            image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
                .save_with_format(&stage.path, image::ImageFormat::Png)
                .unwrap();
        }
        start(&s, "occupies-capacity");
        let _recovery = s.output_recovery_guard(&a).unwrap();
        let denied = if original_stage {
            s.seal(&provider(), "consumer", op, &stage.handle, "image/png")
                .map(|_| ())
        } else {
            s.stage(&provider(), "consumer", op).map(|_| ())
        };
        assert!(
            matches!(denied,Err(AppError::Service {ref code,..}) if code=="storage_full"),
            "stage and seal must both reacquire normal capacity"
        );
        let waiting = s.job(&registered.job_key).unwrap().unwrap();
        assert_eq!(waiting.phase.as_deref(), Some("storage_full"));
        assert!(waiting.error.unwrap().contains("storage is full"));
        let mut success = status(
            op,
            "succeeded",
            json!({"state":"unavailable","reason":"storage_unavailable"}),
        );
        success["revision"] = json!(3);
        reconcile_at(&s, &provider(), &a, &success).unwrap();
        struct Recover<'a>(&'a Store);
        impl super::ai_operations::AutomaticPort for Recover<'_> {
            fn active(
                &self,
                a: &Admission,
                _: Option<&JobRecord>,
                _: bool,
                _: &str,
            ) -> Result<bool, AppError> {
                Ok(a.operation_id == "occupies-capacity")
            }
            fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
                let output = self
                    .0
                    .get(&a.consumer.package_id, &a.operation_id)?
                    .unwrap()
                    .output;
                let d = match output {
                    Some(output) => output,
                    None => try_sealed(self.0, &a.operation_id)?,
                };
                let mut receipt = status(
                    &a.operation_id,
                    "succeeded",
                    json!({"state":"available","output":d}),
                );
                receipt["revision"] = json!(4);
                reconcile_at(self.0, &provider(), a, &receipt)?;
                let copy = self
                    .0
                    .read(&consumer(), "consumer", &a.operation_id, &d)?
                    .path;
                let data = std::path::Path::new(&copy)
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("consumer-output");
                fs::create_dir_all(&data).unwrap();
                self.0.register_consumer_root("consumer", data.clone())?;
                let output = data.join("original.png");
                fs::copy(&copy, &output).unwrap();
                let proof =
                    self.0
                        .acquired(&consumer(), &a.operation_id, &d, output.to_str().unwrap())?;
                receipt["revision"] = json!(5);
                receipt["delivery"] =
                    json!({"state":"acquired","transferReceipt":proof.transfer_receipt});
                reconcile_at(self.0, &provider(), a, &receipt)?;
                let job = job.unwrap();
                super::job_bridge::observe_in(
                    self.0,
                    job,
                    &json!({"jobId":job.job_id,"operationId":a.operation_id,"revision":1,"status":"succeeded","recoveryState":"complete","outputPath":output.to_str().unwrap(),"runId":7}),
                )?;
                Ok(())
            }
        }
        let updates = super::ai_operations::auto_reconcile_in(&s, &Recover(&s)).unwrap();
        assert!(
            updates
                .iter()
                .any(|j| j.phase.as_deref() == Some("storage_full")),
            "automatic pass must publish storage-full presentation"
        );
        assert_eq!(
            s.get("consumer", op).unwrap().unwrap().phase,
            AdmissionPhase::Terminal
        );
        let mut failed = status("occupies-capacity", "failed", json!({"state":"none"}));
        failed["revision"] = json!(2);
        failed["execution"]["error"] =
            json!({"code":"rejected","message":"Rejected","correlationId":null});
        let other = s.get("consumer", "occupies-capacity").unwrap().unwrap();
        reconcile_at(&s, &provider(), &other, &failed).unwrap();
        if !original_stage {
            struct MissingConsumer;
            impl super::ai_operations::AutomaticPort for MissingConsumer {
                fn active(
                    &self,
                    _: &Admission,
                    _: Option<&JobRecord>,
                    _: bool,
                    _: &str,
                ) -> Result<bool, AppError> {
                    Ok(false)
                }
                fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
                    Err(AppError::Other("consumer unavailable".into()))
                }
            }
            super::ai_operations::auto_reconcile_in(&s, &MissingConsumer).unwrap();
            assert_eq!(
                s.job(&registered.job_key)
                    .unwrap()
                    .unwrap()
                    .phase
                    .as_deref(),
                Some("delivery_failed"),
                "once capacity is free, missing output must not keep a stale storage-full reason"
            );
        }
        super::ai_operations::auto_reconcile_in(&s, &Recover(&s)).unwrap();
        let completed = s.job(&registered.job_key).unwrap().unwrap();
        assert_eq!(completed.state, JobState::Completed);
        assert!(std::path::Path::new(&completed.output_path.unwrap()).is_file());
        assert_eq!(
            s.get("consumer", op)
                .unwrap()
                .unwrap()
                .disposition
                .as_deref(),
            Some("acquired")
        );
        assert!(s.auto_settlement_operations().unwrap().is_empty());
    }
}

#[test]
fn review_success_witness_survives_a_write_transaction_admission_timeout() {
    let (root, s) = fixture();
    let op = "review-begin-timeout";
    start(&s, op);
    let d = sealed(&s, op);
    let a = s.get("consumer", op).unwrap().unwrap();
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    let mut success = status(op, "succeeded", json!({"state":"available","output":d}));
    success["revision"] = json!(2);
    let blocker = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(30);
    assert!(crate::native_deadline::scoped(deadline, || reconcile_at(
        &s,
        &provider(),
        &a,
        &success
    ))
    .is_err());
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(s.auto_settlement_operations().unwrap().len(), 1);
    assert!(super::lifecycle::drain_idle(&s, "provider").is_ok());
    super::ai_operations::auto_reconcile_in(&s, &super::ai_operations::LiveAutomatic).unwrap();
    assert_eq!(s.get("consumer", op).unwrap().unwrap().output, Some(d));
}

#[test]
fn review_provider_upgrade_recovers_fenced_unknown_after_session_witness_expires() {
    let (root, s) = fixture();
    let op = "review-upgrade-restart";
    start(&s, op);
    let stage = s.stage(&provider(), "consumer", op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    let bytes = fs::read(&stage.path).unwrap();
    use sha2::Digest;
    let output = ArtifactDescriptor {
        handle: stage.handle.clone(),
        sha256: hex::encode(sha2::Sha256::digest(&bytes)),
        byte_length: bytes.len() as u64,
        media_type: "image/png".into(),
    };
    let a = s.get("consumer", op).unwrap().unwrap();
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Unconfirmed","correlationId":null});
    reconcile_at(&s, &provider(), &a, &unknown).unwrap();
    fs::remove_file(&stage.path).unwrap();
    s.auto_settle_operation("consumer", op, true).unwrap();
    fs::write(&stage.path, bytes).unwrap();
    let mut success = status(
        op,
        "succeeded",
        json!({"state":"available","output":output}),
    );
    success["revision"] = json!(3);
    assert!(reconcile_at(&s, &provider(), &a, &success).is_err());
    assert!(super::lifecycle::drain_idle(&s, "provider").is_ok());
    let manifest:super::package::Manifest=serde_json::from_value(json!({"formatVersion":1,"id":"provider","name":"Provider","description":"Provider","version":"2.0.0","sdkVersion":3,"svelteVersion":super::package::SVELTE_VERSION,"target":format!("{}-unknown-linux-gnu",std::env::consts::ARCH),"frontend":"index.js","styles":"index.css","backend":"worker","contributions":["provider"],"services":[{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}],"files":{}})).unwrap();
    let upgraded = generation("provider", 'd');
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert!(reopened.pending_success(&a).unwrap().is_none());
    reopened.revisit_uncertain_settlements().unwrap();
    let pinned =
        super::service_bridge::recovery_provider(&reopened, &manifest, &upgraded, "consumer", op)
            .unwrap();
    assert_eq!(pinned.digest, provider().digest);
    let _permit = reopened.output_recovery_guard(&a).unwrap();
    assert_eq!(
        reopened
            .seal(&pinned, "consumer", op, &stage.handle, "image/png")
            .unwrap(),
        output
    );
    reconcile_at(&reopened, &pinned, &a, &success).unwrap();
    assert_eq!(
        reopened.get("consumer", op).unwrap().unwrap().output,
        Some(output)
    );
}

#[test]
fn review_explicit_provider_removal_preserves_legacy_partial_success_on_reopen() {
    let (root, s) = fixture();
    let op = "review-partial-success-removal";
    let output = ready(&s, op);
    let db = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
    db.execute("UPDATE operations SET phase='accepted',admission=json_set(admission,'$.phase','accepted','$.output',NULL) WHERE operation=?1",[op]).unwrap();
    drop(db);
    assert!(super::lifecycle::drain_idle(&s, "provider").is_ok());
    let notices = s.abandon_package_outputs("provider").unwrap();
    assert_eq!(notices.len(), 1);
    assert!(s.abandon_package_outputs("provider").unwrap().is_empty());
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        reopened.get("consumer", op).unwrap().unwrap().output,
        Some(output)
    );
    assert!(reopened.claims().unwrap().is_empty());
    assert_eq!(reopened.snapshot_jobs().unwrap().jobs.len(), 1);
}

#[test]
fn automatic_missing_output_recovers_restored_bytes_or_original_stage() {
    use crate::service_state::job::JobRecord;
    for (finish_stage, refresh_to_available) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let (_root, s) = fixture();
        let op = "auto-restored-missing";
        start(&s, op);
        let stage = s.stage(&provider(), "consumer", op).unwrap();
        image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
            .save_with_format(&stage.path, image::ImageFormat::Png)
            .unwrap();
        let restored = if finish_stage {
            None
        } else {
            let d = s
                .seal(&provider(), "consumer", op, &stage.handle, "image/png")
                .unwrap();
            let path = s.read(&provider(), "consumer", op, &d).unwrap().path;
            let bytes = fs::read(&path).unwrap();
            fs::remove_file(&path).unwrap();
            Some((path, bytes))
        };
        let admission = s.get("consumer", op).unwrap().unwrap();
        reconcile_at(
            &s,
            &provider(),
            &admission,
            &status(
                op,
                "succeeded",
                json!({"state":"unavailable","reason":"missing"}),
            ),
        )
        .unwrap();
        if let Some((path, bytes)) = restored {
            fs::write(path, bytes).unwrap();
        }
        struct Restored<'a> {
            store: &'a Store,
            handle: &'a str,
            refresh_to_available: bool,
            recovered: std::cell::Cell<bool>,
        }
        impl super::ai_operations::AutomaticPort for Restored<'_> {
            fn active(
                &self,
                a: &Admission,
                _: Option<&JobRecord>,
                _: bool,
                _: &str,
            ) -> Result<bool, AppError> {
                if !self.refresh_to_available {
                    return Ok(false);
                }
                // Authoritative status performs the original seal, without generation.
                let d = self.store.seal(
                    &provider(),
                    "consumer",
                    &a.operation_id,
                    self.handle,
                    "image/png",
                )?;
                let mut receipt = status(
                    &a.operation_id,
                    "succeeded",
                    json!({"state":"available","output":d}),
                );
                receipt["revision"] = json!(3);
                reconcile_at(self.store, &provider(), a, &receipt)?;
                Ok(false)
            }
            fn recover(&self, a: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
                let d = a
                    .output
                    .as_ref()
                    .expect("latest output must be used for recovery");
                self.store
                    .read(&consumer(), "consumer", &a.operation_id, d)?;
                self.recovered.set(true);
                Ok(())
            }
        }
        let port = Restored {
            store: &s,
            handle: &stage.handle,
            refresh_to_available,
            recovered: std::cell::Cell::new(false),
        };
        super::ai_operations::auto_reconcile_in(&s, &port).unwrap();
        assert!(port.recovered.get());
        assert!(!s.execution_released("consumer", op).unwrap());
    }
}

#[test]
fn automatic_original_stage_repairs_a_missing_or_corrupt_sealed_copy() {
    for (corrupt, pending) in [(false, false), (true, false), (false, true), (true, true)] {
        let (_root, s) = fixture();
        let op = "auto-original-stage";
        let descriptor = ready(&s, op);
        let path = s
            .read(&consumer(), "consumer", op, &descriptor)
            .unwrap()
            .path;
        let bytes = fs::read(&path).unwrap();
        // Retain the exact original copy as after interrupted seal cleanup.
        let stage_path = if pending {
            std::path::Path::new(&path).with_extension("pending")
        } else {
            std::path::Path::new(&path)
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("stages")
                .join(format!("{}.png", descriptor.handle))
        };
        fs::write(stage_path, bytes).unwrap();
        if corrupt {
            corrupt_in_place(&path);
        } else {
            fs::remove_file(&path).unwrap();
        }
        let mut receipt = status(
            op,
            "succeeded",
            json!({"state":"unavailable","reason":if corrupt {"corrupt"} else {"missing"}}),
        );
        receipt["revision"] = json!(3);
        let a = s.get("consumer", op).unwrap().unwrap();
        reconcile_at(&s, &provider(), &a, &receipt).unwrap();
        assert_eq!(
            s.recover_original_output(&provider(), "consumer", op)
                .unwrap(),
            Some(descriptor.clone())
        );
        assert_eq!(
            fs::read(
                s.read(&consumer(), "consumer", op, &descriptor)
                    .unwrap()
                    .path
            )
            .unwrap()
            .len() as u64,
            descriptor.byte_length
        );
    }
}

#[test]
fn automatic_unsealed_publication_recovers_every_original_copy() {
    for case in 0..6 {
        let immutable = matches!(case, 2..=4);
        let (root, s) = fixture();
        let op = "auto-unsealed-copy";
        start(&s, op);
        let stage = s.stage(&provider(), "consumer", op).unwrap();
        image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
            .save_with_format(&stage.path, image::ImageFormat::Png)
            .unwrap();
        let bytes = fs::read(&stage.path).unwrap();
        let copy = root.path().join("service/bytes").join(format!(
            "{}.{}",
            stage.handle,
            if immutable { "bin" } else { "pending" }
        ));
        fs::write(&copy, &bytes).unwrap();
        if case >= 4 {
            // A valid committed candidate wins over a differing later stage.
            image::RgbaImage::from_pixel(3, 2, image::Rgba([255, 0, 0, 255]))
                .save_with_format(&stage.path, image::ImageFormat::Png)
                .unwrap();
            if case == 5 {
                fs::write(
                    root.path()
                        .join("service/bytes")
                        .join(format!("{}.bin", stage.handle)),
                    b"interrupted corrupt publication",
                )
                .unwrap();
            }
        } else if case % 2 == 1 {
            corrupt_in_place(&stage.path);
        } else {
            fs::remove_file(&stage.path).unwrap();
        }
        // Publication survived, but its descriptor transaction did not.
        let a = s.get("consumer", op).unwrap().unwrap();
        reconcile_at(
            &s,
            &provider(),
            &a,
            &status(
                op,
                "succeeded",
                json!({"state":"unavailable","reason":"missing"}),
            ),
        )
        .unwrap();
        let descriptor = s
            .recover_original_output(&provider(), "consumer", op)
            .unwrap()
            .expect("original publication must remain recoverable");
        assert_eq!(
            fs::read(
                s.read(&consumer(), "consumer", op, &descriptor)
                    .unwrap()
                    .path
            )
            .unwrap(),
            bytes
        );
    }
}

#[test]
fn automatic_pending_copy_sync_failure_preserves_original_for_retry() {
    let (root, s) = fixture();
    let op = "auto-pending-sync";
    start(&s, op);
    let stage = s.stage(&provider(), "consumer", op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    let bytes = fs::read(&stage.path).unwrap();
    let pending = root
        .path()
        .join("service/bytes")
        .join(format!("{}.pending", stage.handle));
    fs::write(&pending, &bytes).unwrap();
    fs::remove_file(&stage.path).unwrap();
    let a = s.get("consumer", op).unwrap().unwrap();
    let receipt = status(
        op,
        "succeeded",
        json!({"state":"unavailable","reason":"missing"}),
    );
    reconcile_at(&s, &provider(), &a, &receipt).unwrap();
    s.fail_next_original_sync();
    assert!(
        s.recover_original_output(&provider(), "consumer", op)
            .is_err(),
        "pending data must be flushed before publishing its descriptor"
    );
    assert_eq!(fs::read(&pending).unwrap(), bytes);
    assert_eq!(s.get("consumer", op).unwrap().unwrap().output, None);
    assert_eq!(s.provider_receipt("consumer", op).unwrap(), Some(receipt));
    let descriptor = s
        .recover_original_output(&provider(), "consumer", op)
        .unwrap()
        .unwrap();
    assert_eq!(
        fs::read(
            s.read(&consumer(), "consumer", op, &descriptor)
                .unwrap()
                .path
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn automatic_missing_original_stage_retains_success_and_retries_recovery() {
    use crate::service_state::job::JobRecord;
    let (_root, s) = fixture();
    let op = "auto-absent-stage";
    start(&s, op);
    let a = s.get("consumer", op).unwrap().unwrap();
    reconcile_at(
        &s,
        &provider(),
        &a,
        &status(
            op,
            "succeeded",
            json!({"state":"unavailable","reason":"missing"}),
        ),
    )
    .unwrap();
    struct Missing(std::cell::Cell<usize>);
    impl super::ai_operations::AutomaticPort for Missing {
        fn active(
            &self,
            _: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            Ok(false)
        }
        fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
            self.0.set(self.0.get() + 1);
            Err(AppError::Other("original output is still missing".into()))
        }
    }
    let port = Missing(std::cell::Cell::new(0));
    for _ in 0..2 {
        assert!(super::ai_operations::auto_reconcile_in(&s, &port)
            .unwrap()
            .is_empty());
    }
    assert_eq!(port.0.get(), 2, "later passes must retry original recovery");
    assert!(s.execution_released("consumer", op).unwrap());
    assert!(s.claims().unwrap().is_empty());
    assert_eq!(
        s.provider_receipt("consumer", op).unwrap().unwrap()["execution"]["state"],
        "succeeded"
    );
    assert_eq!(s.get("consumer", op).unwrap().unwrap().disposition, None);
    assert_eq!(s.auto_settlement_operations().unwrap().len(), 1);
}

#[test]
fn automatic_transient_artifact_ownership_defers_discard() {
    let (root, s) = fixture();
    let op = "auto-artifact-busy";
    let descriptor = ready(&s, op);
    let path = s
        .read(&consumer(), "consumer", op, &descriptor)
        .unwrap()
        .path;
    corrupt_in_place(&path);
    let a = s.get("consumer", op).unwrap().unwrap();
    let mut receipt = status(
        op,
        "succeeded",
        json!({"state":"unavailable","reason":"corrupt"}),
    );
    receipt["revision"] = json!(3);
    reconcile_at(&s, &provider(), &a, &receipt).unwrap();
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(
            root.path()
                .join("service/leases")
                .join(format!("{}.lock", descriptor.handle)),
        )
        .unwrap();
    lease.try_lock().unwrap();
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert!(!s.execution_released("consumer", op).unwrap());
    assert_eq!(s.provider_receipt("consumer", op).unwrap(), Some(receipt));
    assert!(std::path::Path::new(&path).is_file());
}

#[test]
fn automatic_settlement_reclaims_empty_output_capacity_and_retains_unknown_evidence() {
    for stage_bytes in [None, Some(false)] {
        let (root, s) = fixture();
        for n in 0..24 {
            let op = format!("auto-capacity-{n}");
            start(&s, &op);
            let stage = stage_bytes.map(|write| {
                let stage = s.stage(&provider(), "consumer", &op).unwrap();
                if write {
                    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
                        .save_with_format(&stage.path, image::ImageFormat::Png)
                        .unwrap();
                }
                stage
            });
            let mut unknown = status(&op, "unknown", json!({"state":"none"}));
            unknown["revision"] = json!(2);
            unknown["execution"]["error"] = json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
            let a = s.get("consumer", &op).unwrap().unwrap();
            reconcile_at(&s, &provider(), &a, &unknown).unwrap();
            super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
            assert_eq!(s.provider_receipt("consumer", &op).unwrap(), Some(unknown));
            assert!(s.get("consumer", &op).unwrap().is_some());
            assert!(s.execution_released("consumer", &op).unwrap());
            assert!(s.claims().unwrap().is_empty());
            if let Some(stage) = stage {
                assert!(
                    !std::path::Path::new(&stage.path).exists(),
                    "inactive empty stage bytes should be collected"
                );
            }
            assert!(
                matches!(call(&s, "start", request(&op), |_, _| panic!("Unknown replayed")),
            Err(AppError::Service { ref code, .. }) if code == "recovery_stopped")
            );
        }
        drop(s);
        let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
        start(&reopened, "capacity-after-restart");
    }
}

#[test]
fn automatic_connection_test_registration_keeps_forwarding_owned() {
    let (_root, s) = fixture();
    let owner = generation("fixture.test-registration", 'b');
    // The production frontend owns settings.test through test.begin and the
    // provider's subsequent registration/reply, even without a presentation job.
    let registering =
        super::backend::CallLease::acquire_method(&owner.package_id, "settings.test").unwrap();
    super::service_bridge::begin_test_in(
        &s,
        &owner,
        "connection-registration",
        &"c".repeat(64),
        || true,
    )
    .unwrap();
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert!(!s
        .execution_released(&owner.package_id, "connection-registration")
        .unwrap());
    drop(registering);
    // Timeout/lost acceptance ends the outer call before registration does.
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert!(!s
        .execution_released(&owner.package_id, "connection-registration")
        .unwrap());
    let mut receipt = status(
        "connection-registration",
        "unknown",
        json!({"state":"none"}),
    );
    receipt["provider"]["packageId"] = json!(owner.package_id);
    receipt["execution"]["error"] =
        json!({"code":"interrupted","message":"Registration ended","correlationId":null});
    let a = s
        .get(&owner.package_id, "connection-registration")
        .unwrap()
        .unwrap();
    reconcile_at(&s, &owner, &a, &receipt).unwrap();
    super::service_bridge::test_registered(&owner, "connection-registration");
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert!(s
        .execution_released(&owner.package_id, "connection-registration")
        .unwrap());
}

#[test]
fn automatic_connection_test_death_waits_for_admitted_registration() {
    use std::sync::mpsc;
    use std::time::Duration;
    let (_root, store) = fixture();
    let store = Arc::new(store);
    let owner = generation("fixture.registration-death", 'b');
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let begin = {
        let store = store.clone();
        let owner = owner.clone();
        let entered = entered.clone();
        let release = release.clone();
        std::thread::spawn(move || {
            super::service_bridge::begin_test_in(
                &store,
                &owner,
                "registration-death",
                &"c".repeat(64),
                || {
                    entered.wait();
                    release.wait();
                    true
                },
            )
            .unwrap()
        })
    };
    entered.wait();
    let (ended, done) = mpsc::channel();
    let dead = {
        let owner = owner.clone();
        std::thread::spawn(move || {
            super::service_bridge::on_dead(owner);
            ended.send(()).unwrap();
        })
    };
    let retired_before_publication = done.recv_timeout(Duration::from_millis(200)).is_ok();
    release.wait();
    begin.join().unwrap();
    dead.join().unwrap();
    assert!(
        !retired_before_publication,
        "death retired ownership before the admitted begin finished"
    );
    assert!(
        !super::service_bridge::dispatch_active(&owner.package_id, "registration-death").unwrap()
    );
    super::ai_operations::auto_reconcile_in(&store, &IdleAutomatic).unwrap();
    assert!(store
        .execution_released(&owner.package_id, "registration-death")
        .unwrap());
}

#[test]
fn automatic_idle_proof_fences_startup_and_lifecycle_until_commit() {
    use crate::service_state::job::JobRecord;
    let (_root, s) = fixture();
    let owner = generation("fixture.auto-proof", 'b');
    let a = Admission {
        consumer: owner.clone(),
        provider: owner.clone(),
        target: ServiceTarget {
            package_id: owner.package_id.clone(),
            ..target()
        },
        operation_id: "proof-commit".into(),
        fingerprint: "c".repeat(64),
        phase: AdmissionPhase::Reserved,
        inputs: vec![],
        output: None,
        needs_attention: false,
        disposition: None,
        transfer_receipt: None,
    };
    s.reserve(a).unwrap();
    s.claim_forwarding(&owner, "proof-commit").unwrap();
    struct Proof(std::cell::Cell<bool>);
    impl super::ai_operations::AutomaticPort for Proof {
        fn active(
            &self,
            a: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            self.0.set(
                super::backend::CallLease::acquire_direction(&a.provider.package_id, 3).is_err()
                    && super::backend::CallLease::acquire_method(
                        &a.provider.package_id,
                        "settings.test",
                    )
                    .is_err()
                    && super::backend::begin_drain(&a.provider.package_id).is_err(),
            );
            Ok(false)
        }
        fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
            panic!("no output")
        }
    }
    let port = Proof(std::cell::Cell::new(false));
    super::ai_operations::auto_reconcile_in(&s, &port).unwrap();
    assert!(
        port.0.get(),
        "startup/lifecycle can invalidate the idle proof"
    );
    assert!(s
        .execution_released(&owner.package_id, "proof-commit")
        .unwrap());
    assert!(super::backend::CallLease::acquire_direction(&owner.package_id, 3).is_ok());
    assert!(super::backend::begin_drain(&owner.package_id).is_ok());
}
#[test]
fn automatic_settlement_of_stopped_unknown_survives_restart_without_replay() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let op = "auto-stopped";
    let registered = s.register_job(job(op, 71)).unwrap();
    let unknown = stopped_unknown(&s, op);
    // Actual bootstrap path, without any user action or plugin IO.
    super::ai_operations::settle_stopped_backlog(&s).unwrap();
    assert_eq!(
        s.job(&registered.job_key).unwrap().unwrap().state,
        JobState::NeedsAttention
    );
    // After bootstrap, the actual live policy can prove this fixture's
    // provider package is gone; stopped evidence alone cannot prove no result.
    super::ai_operations::auto_reconcile_in(&s, &super::ai_operations::LiveAutomatic).unwrap();
    let settled = s.job(&registered.job_key).unwrap().unwrap();
    assert_eq!(settled.state, JobState::Discarded);
    assert_eq!(
        settled.error.as_deref(),
        Some("Remote result is unconfirmed")
    );
    assert!(settled.settled_at_ms.is_some());
    assert!(s.auto_settlement_operations().unwrap().is_empty());
    assert!(s.claims().unwrap().is_empty());
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    super::ai_operations::settle_stopped_backlog(&reopened).unwrap();
    assert_eq!(reopened.job(&registered.job_key).unwrap(), Some(settled));
    assert_eq!(
        reopened.provider_receipt("consumer", op).unwrap(),
        Some(unknown)
    );
    assert!(
        matches!(call(&reopened,"start",request(op),|_,_|panic!("automatic settlement replayed Unknown")),Err(AppError::Service{ref code,..}) if code=="recovery_stopped")
    );
}
#[test]
fn automatic_settlement_preserves_idle_failed_reason_and_requires_worker_proof() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let op = "auto-failed";
    let registered = s.register_job(job(op, 72)).unwrap();
    start(&s, op);
    let mut failed = status(op, "failed", json!({"state":"none"}));
    failed["revision"] = json!(2);
    failed["execution"]["error"] = json!({"code":"rejected","message":"Provider rejected the image dimensions","correlationId":null});
    call(&s, "status", json!({"operationId":op}), |_, _| {
        Ok(failed.clone())
    })
    .unwrap();
    assert!(s.auto_settle_operation("consumer", op, false).is_err());
    assert_eq!(
        s.job(&registered.job_key).unwrap().unwrap().state,
        JobState::Accepting
    );
    s.fail_next_write();
    assert!(s.auto_settle_operation("consumer", op, true).is_err());
    assert!(!s.execution_released("consumer", op).unwrap());
    assert_eq!(s.dismissed_revision("consumer", op).unwrap(), None);
    let settled = super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].state, JobState::Discarded);
    assert_eq!(
        settled[0].error.as_deref(),
        Some("Provider rejected the image dimensions")
    );
    assert!(super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic)
        .unwrap()
        .is_empty());
    assert_eq!(
        call(&s, "status", json!({"operationId":op}), |_, _| panic!(
            "settled status should use retained receipt"
        ))
        .unwrap(),
        failed
    );
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        reopened.job(&registered.job_key).unwrap(),
        Some(settled[0].clone())
    );
}
#[test]
fn automatic_recovery_obtains_retained_output_and_completes_without_discard_or_start() {
    use crate::service_state::job::{JobRecord, JobState};
    for acquired in [false, true] {
        let (root, s) = fixture();
        let op = "auto-output";
        let registered = s.register_job(job(op, 73)).unwrap();
        let descriptor = ready(&s, op);
        s.update_job(
            &registered.owner,
            &registered.job_key,
            JobState::NeedsAttention,
            Some("needs_attention".into()),
            None,
            None,
            Some("Lost consumer reply".into()),
        )
        .unwrap();
        let data = root.path().join("consumer-data");
        fs::create_dir(&data).unwrap();
        s.register_consumer_root("consumer", data.clone()).unwrap();
        let copy = data.join("recovered.png");
        if acquired {
            fs::copy(
                s.read(&consumer(), "consumer", op, &descriptor)
                    .unwrap()
                    .path,
                &copy,
            )
            .unwrap();
            let transfer = s
                .acquired(&consumer(), op, &descriptor, copy.to_str().unwrap())
                .unwrap();
            call(&s,"acknowledge",json!({"operationId":op,"outputSha256":descriptor.sha256,"disposition":"acquired","transferReceipt":transfer.transfer_receipt}),|_,_| Ok(status(op,"succeeded",json!({"state":"acquired","transferReceipt":transfer.transfer_receipt})))).unwrap();
        }
        struct RecoverOutput<'a> {
            store: &'a Store,
            descriptor: &'a ArtifactDescriptor,
            copy: &'a Path,
        }
        impl super::ai_operations::AutomaticPort for RecoverOutput<'_> {
            fn active(
                &self,
                _: &Admission,
                _: Option<&JobRecord>,
                _: bool,
                _: &str,
            ) -> Result<bool, AppError> {
                Ok(false)
            }
            fn recover(&self, a: &Admission, job: Option<&JobRecord>) -> Result<(), AppError> {
                let d = self.descriptor;
                // Exercise the real local read/acquisition/acknowledgement path.
                if a.phase != AdmissionPhase::Released {
                    fs::copy(
                        self.store
                            .read(&consumer(), "consumer", &a.operation_id, d)?
                            .path,
                        self.copy,
                    )
                    .unwrap();
                }
                let receipt = self.store.acquired(
                    &consumer(),
                    &a.operation_id,
                    d,
                    self.copy.to_str().unwrap(),
                )?;
                call(
                    self.store,
                    "acknowledge",
                    json!({"operationId":a.operation_id,"outputSha256":d.sha256,"disposition":"acquired","transferReceipt":receipt.transfer_receipt}),
                    |method, _| {
                        assert!(method.ends_with(".acknowledge"));
                        Ok(status(
                            &a.operation_id,
                            "succeeded",
                            json!({"state":"acquired","transferReceipt":receipt.transfer_receipt}),
                        ))
                    },
                )?;
                let job = job.unwrap();
                self.store.update_job(
                    &job.owner,
                    &job.job_key,
                    JobState::Completed,
                    Some("complete".into()),
                    Some(self.copy.to_str().unwrap().into()),
                    Some(17),
                    None,
                )?;
                Ok(())
            }
        }
        let published = super::ai_operations::auto_reconcile_in(
            &s,
            &RecoverOutput {
                store: &s,
                descriptor: &descriptor,
                copy: &copy,
            },
        )
        .unwrap();
        assert_eq!(published.len(), usize::from(acquired));
        assert!(published.iter().all(|job| job.state == JobState::Completed));
        assert!(copy.is_file());
        let completed = s.job(&registered.job_key).unwrap().unwrap();
        assert_eq!(completed.state, JobState::Completed);
        assert_eq!(completed.output_path.as_deref(), copy.to_str());
        assert_eq!(s.dismissed_revision("consumer", op).unwrap(), None);
        assert!(s.claims().unwrap().is_empty());
    }
}
#[test]
fn automatic_settlement_backlog_is_not_hidden_behind_already_settled_rows() {
    let root = fixture_root();
    // Unknown forensic reservations are intentionally retained by Dismiss;
    // raise only this fixture's byte budget to exercise >128-row backlog.
    let s = Store::open(
        root.path().join("service"),
        Limits {
            disk_bytes: 32 * 1024 * 1024 * 1024,
            ..Limits::default()
        },
    )
    .unwrap();
    for n in 0..140 {
        let op = format!("backlog-{n}");
        stopped_unknown(&s, &op);
    }
    super::ai_operations::settle_stopped_backlog(&s).unwrap();
    super::ai_operations::auto_reconcile_in(&s, &super::ai_operations::LiveAutomatic).unwrap();
    assert!(s.auto_settlement_operations().unwrap().is_empty());
    assert!(s.claims().unwrap().is_empty());
}

#[test]
fn automatic_settlement_cannot_cross_a_paid_start_already_in_flight() {
    let (_root, store) = fixture();
    let store = Arc::new(store);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let s = store.clone();
    let e = entered.clone();
    let r = release.clone();
    let worker = std::thread::spawn(move || {
        call(&s, "start", request("auto-dispatch"), |_, _| {
            e.wait();
            r.wait();
            Ok(running("auto-dispatch"))
        })
        .unwrap()
    });
    entered.wait();
    let settled = super::ai_operations::auto_reconcile_in(&store, &IdleAutomatic).unwrap();
    assert!(settled.is_empty());
    assert!(!store
        .execution_released("consumer", "auto-dispatch")
        .unwrap());
    assert_eq!(
        store
            .dismissed_revision("consumer", "auto-dispatch")
            .unwrap(),
        None
    );
    release.wait();
    worker.join().unwrap();
    assert_eq!(
        store
            .provider_receipt("consumer", "auto-dispatch")
            .unwrap()
            .unwrap()["execution"]["state"],
        "running"
    );
}
#[test]
fn automatic_discarded_provider_output_settles_and_survives_restart() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let op = "auto-discarded";
    let registered = s.register_job(job(op, 74)).unwrap();
    ready(&s, op);
    let original = s.get("consumer", op).unwrap().unwrap();
    let receipt = status(op, "succeeded", json!({"state":"discarded"}));
    super::ai_operations::commit_discard(&s, &provider(), &original, &receipt).unwrap();
    let settled = super::job_bridge::observe_in(
        &s,
        &registered,
        &json!({
            "jobId": registered.job_id, "operationId":op, "revision":1,
            "status":"discarded", "recoveryState":"discarded"
        }),
    )
    .unwrap();
    assert_eq!(settled.state, JobState::Discarded);
    assert!(super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic)
        .unwrap()
        .is_empty());
    assert!(s.claims().unwrap().is_empty());
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        reopened.job(&registered.job_key).unwrap().unwrap().state,
        JobState::Discarded
    );
}
#[test]
fn automatic_unknown_with_live_worker_is_left_untouched() {
    use crate::service_state::job::JobRecord;
    let (_root, s) = fixture();
    let op = "auto-live";
    stopped_unknown(&s, op);
    struct Active;
    impl super::ai_operations::AutomaticPort for Active {
        fn active(
            &self,
            _: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            Ok(true)
        }
        fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
            panic!("active operation recovered")
        }
    }
    assert!(super::ai_operations::auto_reconcile_in(&s, &Active)
        .unwrap()
        .is_empty());
    assert_eq!(s.dismissed_revision("consumer", op).unwrap(), None);
}
#[test]
fn automatic_unavailable_corrupt_output_retains_success_for_later_recovery() {
    use crate::service_state::job::{JobRecord, JobState};
    let (_root, s) = fixture();
    let op = "auto-corrupt";
    s.register_job(job(op, 75)).unwrap();
    let descriptor = ready(&s, op);
    let path = s
        .read(&consumer(), "consumer", op, &descriptor)
        .unwrap()
        .path;
    corrupt_in_place(&path);
    let original = s.get("consumer", op).unwrap().unwrap();
    let mut unavailable = status(
        op,
        "succeeded",
        json!({"state":"unavailable","reason":"corrupt"}),
    );
    unavailable["revision"] = json!(3);
    reconcile_at(&s, &provider(), &original, &unavailable).unwrap();
    struct Retry;
    impl super::ai_operations::AutomaticPort for Retry {
        fn active(
            &self,
            _: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            Ok(false)
        }
        fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
            Err(AppError::Other("original output is still corrupt".into()))
        }
    }
    let settled = super::ai_operations::auto_reconcile_in(&s, &Retry).unwrap();
    assert_eq!(settled.len(), 1);
    assert_eq!(
        s.job_for_operation("consumer", op).unwrap().unwrap().state,
        JobState::Error
    );
    assert_eq!(s.get("consumer", op).unwrap().unwrap().disposition, None);
    assert!(!s.claims().unwrap().is_empty());
    assert!(
        Path::new(&path).is_file(),
        "actual bytes must remain retained"
    );
}

#[test]
fn automatic_settlement_fills_missing_terminal_error_reason_without_changing_outcome() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let op = "auto-error-reason";
    let registered = s.register_job(job(op, 76)).unwrap();
    start(&s, op);
    let mut failed = status(op, "failed", json!({"state":"none"}));
    failed["revision"] = json!(2);
    failed["execution"]["error"] =
        json!({"code":"rejected","message":"Provider rejected dimensions","correlationId":null});
    call(&s, "status", json!({"operationId":op}), |_, _| {
        Ok(failed.clone())
    })
    .unwrap();
    s.update_job(
        &registered.owner,
        &registered.job_key,
        JobState::Error,
        Some("failed".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let settled = super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].state, JobState::Error);
    assert_eq!(
        settled[0].error.as_deref(),
        Some("Provider rejected dimensions")
    );
    assert!(super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic)
        .unwrap()
        .is_empty());
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(
        reopened.job(&registered.job_key).unwrap(),
        Some(settled[0].clone())
    );
}

#[test]
fn automatic_review_consumer_evidence_releases_interrupted_acknowledgement_locally() {
    use crate::service_state::job::{JobRecord, JobState};
    let (root, s) = fixture();
    let op = "review-consumer-evidence";
    let registered = s.register_job(job(op, 74)).unwrap();
    let d = ready(&s, op);
    s.update_job(
        &registered.owner,
        &registered.job_key,
        JobState::NeedsAttention,
        Some("stopped".into()),
        None,
        None,
        Some("Lost acknowledgement".into()),
    )
    .unwrap();
    let data = root.path().join("consumer-data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    let copy = data.join("original.png");
    let original = s.read(&consumer(), "consumer", op, &d).unwrap().path;
    let original_bytes = fs::read(&original).unwrap();
    fs::copy(&original, &copy).unwrap();
    let transfer = s
        .acquired(&consumer(), op, &d, copy.to_str().unwrap())
        .unwrap();
    fs::remove_file(&original).unwrap();
    let a = s.get("consumer", op).unwrap().unwrap();
    let mut unavailable = status(
        op,
        "succeeded",
        json!({"state":"unavailable","reason":"missing"}),
    );
    unavailable["revision"] = json!(3);
    reconcile_at(&s, &provider(), &a, &unavailable).unwrap();
    struct NoProvider;
    impl super::ai_operations::AutomaticPort for NoProvider {
        fn active(
            &self,
            _: &Admission,
            _: Option<&JobRecord>,
            _: bool,
            _: &str,
        ) -> Result<bool, AppError> {
            panic!("verified acquisition must complete without provider status");
        }
        fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
            panic!("verified acquisition must complete without provider recovery");
        }
    }
    let completed = super::ai_operations::auto_reconcile_in(&s, &NoProvider).unwrap();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].state, JobState::Completed);
    assert_eq!(completed[0].output_path.as_deref(), copy.to_str());
    assert_eq!(completed[0].run_id, registered.run_id);
    assert!(completed[0].error.is_none());
    let released = s.get("consumer", op).unwrap().unwrap();
    assert_eq!(released.phase, AdmissionPhase::Released);
    assert_eq!(released.disposition.as_deref(), Some("acquired"));
    assert_eq!(
        released.transfer_receipt.as_deref(),
        Some(transfer.transfer_receipt.as_str())
    );
    assert!(!s.execution_released("consumer", op).unwrap());
    assert!(s.claims().unwrap().is_empty());
    assert_eq!(fs::read(&copy).unwrap(), original_bytes);
    let retained = s.provider_receipt("consumer", op).unwrap().unwrap();
    assert_eq!(retained["delivery"]["state"], "acquired");
    assert_eq!(retained["revision"], json!(3));
    assert_eq!(
        call(&s, "status", json!({"operationId":op}), |_, _| panic!(
            "released status must use retained receipt"
        ))
        .unwrap(),
        retained
    );
    assert!(super::ai_operations::auto_reconcile_in(&s, &NoProvider)
        .unwrap()
        .is_empty());
    let mut acquired = status(
        op,
        "succeeded",
        json!({"state":"acquired","transferReceipt":transfer.transfer_receipt}),
    );
    acquired["revision"] = json!(4);
    call(&s, "acknowledge", json!({"operationId":op,"outputSha256":d.sha256,"disposition":"acquired","transferReceipt":transfer.transfer_receipt}), |_, _| Ok(acquired.clone())).unwrap();
    assert_eq!(
        s.get("consumer", op)
            .unwrap()
            .unwrap()
            .disposition
            .as_deref(),
        Some("acquired")
    );
    assert_eq!(fs::read(&copy).unwrap(), original_bytes);
    assert_eq!(s.job(&registered.job_key).unwrap().unwrap(), completed[0]);
}

// Native admission is process-wide; each lifecycle fixture needs private
// package IDs so unrelated parallel tests cannot own its control leases.
fn dead_unknown_fixture(op: &str) -> (FixtureRoot, Store, Admission) {
    let (root, store) = fixture();
    let consumer = generation(&format!("fixture.{op}.consumer"), 'a');
    let provider = generation(&format!("fixture.{op}.provider"), 'b');
    let a = store
        .reserve(Admission {
            consumer: consumer.clone(),
            provider: provider.clone(),
            target: ServiceTarget {
                package_id: provider.package_id.clone(),
                ..target()
            },
            operation_id: op.into(),
            fingerprint: "c".repeat(64),
            phase: AdmissionPhase::Reserved,
            inputs: vec![],
            output: None,
            needs_attention: false,
            disposition: None,
            transfer_receipt: None,
        })
        .unwrap();
    store.claim_forwarding(&consumer, op).unwrap();
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["provider"]["packageId"] = json!(provider.package_id);
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
    reconcile_at(&store, &provider, &a, &unknown).unwrap();
    (root, store, a)
}

#[test]
fn automatic_review_dead_no_output_settles_without_restarting_packages() {
    let op = "review-dead-unknown";
    let (_root, s, a) = dead_unknown_fixture(op);
    super::ai_operations::auto_reconcile_in(&s, &super::ai_operations::LiveAutomatic).unwrap();
    assert!(
        s.execution_released(&a.consumer.package_id, op).unwrap(),
        "dead packages must not need startup to prove inactivity"
    );
    assert!(s.claims().unwrap().is_empty());
    for package in [&*a.consumer.package_id, &*a.provider.package_id] {
        let drain = super::lifecycle::drain_idle(&s, package).unwrap();
        drop(drain);
    }
}

#[test]
fn automatic_review_lifecycle_settles_dead_no_output_before_busy_check() {
    let op = "review-repair-dead";
    let (_root, s, a) = dead_unknown_fixture(op);
    let drain = super::lifecycle::drain_idle(&s, &a.provider.package_id);
    assert!(
        drain.is_ok(),
        "disable/uninstall/repair must settle dead terminal records before their busy check"
    );
    assert!(
        !s.execution_released(&a.consumer.package_id, op).unwrap(),
        "lifecycle admission must preserve uncertain evidence without state-specific settlement"
    );
}

#[test]
fn automatic_review_late_success_corrects_settled_unknown_job_with_output() {
    use crate::service_state::job::JobState;
    let (root, s) = fixture();
    let op = "review-late-output";
    let registered = s.register_job(job(op, 88)).unwrap();
    start(&s, op);
    let d = sealed(&s, op);
    let a = s.get("consumer", op).unwrap().unwrap();
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
    reconcile_at(&s, &provider(), &a, &unknown).unwrap();
    // Persist a legacy host's stopped presentation. New settlement must never
    // manufacture this state while the sealed original is retained.
    s.update_job(
        &registered.owner,
        &registered.job_key,
        JobState::Discarded,
        Some("stopped".into()),
        None,
        None,
        None,
    )
    .unwrap();
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    assert_eq!(
        s.job(&registered.job_key).unwrap().unwrap().state,
        JobState::Discarded
    );
    let mut success = status(op, "succeeded", json!({"state":"available","output":d}));
    success["revision"] = json!(3);
    reconcile_at(&s, &provider(), &a, &success).unwrap();
    let data = root.path().join("consumer-data");
    fs::create_dir(&data).unwrap();
    s.register_consumer_root("consumer", data.clone()).unwrap();
    let copy = data.join("late.png");
    fs::copy(s.read(&consumer(), "consumer", op, &d).unwrap().path, &copy).unwrap();
    let transfer = s
        .acquired(&consumer(), op, &d, copy.to_str().unwrap())
        .unwrap();
    let premature = super::job_bridge::observe_in(&s, &registered, &json!({
        "jobId":registered.job_id, "operationId":op, "revision":4,
        "status":"succeeded", "recoveryState":"complete", "outputPath":copy.to_str().unwrap(), "runId":17
    })).unwrap();
    assert_eq!(
        premature.state,
        JobState::Discarded,
        "completion before acknowledgement must not override settlement"
    );
    let mut acquired = status(
        op,
        "succeeded",
        json!({"state":"acquired","transferReceipt":transfer.transfer_receipt}),
    );
    acquired["revision"] = json!(4);
    call(&s, "acknowledge", json!({"operationId":op,"outputSha256":d.sha256,"disposition":"acquired","transferReceipt":transfer.transfer_receipt}), |_, _| Ok(acquired.clone())).unwrap();
    assert_eq!(
        s.auto_settlement_operations().unwrap().len(),
        1,
        "acknowledgement before a completion event must remain discoverable"
    );
    let cost = json!({"amount":"0.075","currency":"USD","estimated":false,"source":"bfl.credits"});
    let completed = super::job_bridge::observe_in(&s, &registered, &json!({
        "jobId":registered.job_id, "operationId":op, "revision":5, "cost":cost, "reveal":{"kind":"file","path":copy.to_str().unwrap()},
        "status":"succeeded", "recoveryState":"complete", "outputPath":copy.to_str().unwrap(), "runId":17
    })).unwrap();
    assert_eq!(
        completed.state,
        JobState::Completed,
        "late acknowledged success must replace the host's earlier no-output settlement"
    );
    assert_eq!(completed.output_path.as_deref(), copy.to_str());
    assert_eq!(serde_json::to_value(&completed.cost).unwrap(), cost);
    assert_eq!(
        serde_json::to_value(&completed.reveal).unwrap(),
        json!({"kind":"file","path":copy.to_str().unwrap()})
    );
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(reopened.job(&registered.job_key).unwrap(), Some(completed));
}

#[test]
fn automatic_review_late_completion_event_probes_a_settled_job() {
    let (_root, s) = fixture();
    let op = "review-complete-event";
    let registered = s.register_job(job(op, 89)).unwrap();
    stopped_unknown(&s, op);
    super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
    let mut probed = Vec::new();
    super::job_bridge::event_in(
        &s,
        &consumer(),
        "openai-image-complete",
        &json!({"jobId":registered.job_id,"operationId":op}),
        |job| probed.push(job.job_key),
    )
    .unwrap();
    assert_eq!(probed, [registered.job_key]);
}

#[test]
fn automatic_review_local_delivery_failure_is_ordinary_history_with_retained_recovery() {
    use crate::service_state::job::JobState;
    let (_root, s) = fixture();
    let op = "review-failed-delivery";
    let registered = s.register_job(job(op, 90)).unwrap();
    let d = ready(&s, op);
    let original = s.get("consumer", op).unwrap().unwrap();
    let mut unavailable = status(
        op,
        "succeeded",
        json!({"state":"unavailable","reason":"missing"}),
    );
    unavailable["revision"] = json!(3);
    reconcile_at(&s, &provider(), &original, &unavailable).unwrap();
    let observed = super::job_bridge::observe_in(&s, &registered, &json!({
        "jobId":registered.job_id, "operationId":op, "revision":4,
        "status":"failed", "recoveryState":"needs_attention", "providerExecution":{"state":"succeeded"},
        "error":"Original output delivery failed"
    })).unwrap();
    assert_eq!(
        observed.state,
        JobState::Error,
        "local delivery failure belongs in ordinary failed history"
    );
    assert_eq!(
        observed.error.as_deref(),
        Some("Original output delivery failed")
    );
    assert_eq!(s.get("consumer", op).unwrap().unwrap().output, Some(d));
    assert!(!s.execution_released("consumer", op).unwrap());
    assert_eq!(s.auto_settlement_operations().unwrap().len(), 1);
}

#[test]
fn automatic_review_restart_restores_legacy_stopped_success_with_original_stage() {
    let (root, s) = fixture();
    let op = "review-legacy-unavailable";
    start(&s, op);
    let stage = s.stage(&provider(), "consumer", op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    let a = s.get("consumer", op).unwrap().unwrap();
    reconcile_at(
        &s,
        &provider(),
        &a,
        &status(
            op,
            "succeeded",
            json!({"state":"unavailable","reason":"missing"}),
        ),
    )
    .unwrap();
    let db = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
    db.execute(
        "UPDATE operations SET exec_released=1 WHERE consumer='consumer' AND operation=?1",
        [op],
    )
    .unwrap();
    db.execute("UPDATE operations SET admission=json_set(admission,'$.needsAttention',json('true')) WHERE consumer='consumer' AND operation=?1", [op]).unwrap();
    drop(db);
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert!(
        reopened.execution_released("consumer", op).unwrap(),
        "original recovery must preserve the no-replay fence"
    );
    assert!(reopened.claims().unwrap().is_empty());
    assert!(reopened
        .recover_original_output(&provider(), "consumer", op)
        .unwrap()
        .is_some());
}

#[test]
fn automatic_review_unknown_diagnostics_can_finalize_only_the_original_turn() {
    let (_root, s) = fixture();
    let op = "review-late-diagnostics";
    start(&s, op);
    let d = sealed(&s, op);
    let a = s.get("consumer", op).unwrap().unwrap();
    let thread = "12345678-1234-1234-1234-123456789abc";
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Outcome unconfirmed","correlationId":null});
    unknown["diagnostics"] = json!({"kind":"codex_image_turn","threadId":thread,"turnState":"incomplete","usage":{"inputTokens":null,"cachedInputTokens":null,"outputTokens":null},"explanation":{"kind":"error","text":"Local result was interrupted","truncated":false}});
    reconcile_at(&s, &provider(), &a, &unknown).unwrap();
    let mut success = status(op, "succeeded", json!({"state":"available","output":d}));
    success["revision"] = json!(3);
    success["diagnostics"] = json!({"kind":"codex_image_turn","threadId":thread,"turnState":"completed","usage":{"inputTokens":5,"cachedInputTokens":0,"outputTokens":3},"explanation":null});
    let mut foreign = success.clone();
    foreign["diagnostics"]["threadId"] = json!("abcdefab-1234-1234-1234-123456789abc");
    assert!(reconcile_at(&s, &provider(), &a, &foreign).is_err());
    let mut replay = unknown.clone();
    replay["revision"] = json!(3);
    replay["execution"] = json!({"state":"running"});
    assert!(
        reconcile_at(&s, &provider(), &a, &replay).is_err(),
        "uncertainty must never reopen paid execution"
    );
    reconcile_at(&s, &provider(), &a, &success).unwrap();
    assert_eq!(
        s.provider_receipt("consumer", op).unwrap().unwrap()["diagnostics"]["threadId"],
        thread
    );
}

#[test]
fn review_settled_unknown_collects_nonempty_inputs_and_restores_capacity() {
    let root = fixture_root();
    let input = root.path().join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let limits = Limits {
        disk_bytes: 100 * 1024 * 1024 + fs::metadata(&input).unwrap().len(),
        ..Limits::default()
    };
    let s = Store::open(root.path().join("service"), limits).unwrap();
    let op = "review-input-capacity";
    let captured = s
        .capture(
            &consumer(),
            op,
            vec![CaptureInput {
                path: input.to_string_lossy().into(),
                expected_digest: None,
            }],
        )
        .unwrap();
    let artifact_path = s
        .read(&consumer(), "consumer", op, &captured[0].artifact)
        .unwrap()
        .path;
    let mut req = request(op);
    req["inputs"] = json!([captured[0].artifact]);
    call(&s, "start", req.clone(), |_, _| Ok(running(op))).unwrap();
    let mut unknown = status(op, "unknown", json!({"state":"none"}));
    unknown["revision"] = json!(2);
    unknown["execution"]["error"] =
        json!({"code":"interrupted","message":"Unconfirmed","correlationId":null});
    let a = s.get("consumer", op).unwrap().unwrap();
    reconcile_at(&s, &provider(), &a, &unknown).unwrap();
    // The settlement entry point must collect bytes during this session.
    s.auto_settle_operation("consumer", op, true).unwrap();
    assert!(
        !Path::new(&artifact_path).exists(),
        "settled input was never collected"
    );
    assert_eq!(
        s.provider_receipt("consumer", op).unwrap(),
        Some(unknown.clone())
    );
    drop(s);
    let s = Store::open(root.path().join("service"), limits).unwrap();
    assert!(call(&s, "start", req, |_, _| panic!("Unknown replayed")).is_err());
    let next = "review-next-input";
    let captured = s
        .capture(
            &consumer(),
            next,
            vec![CaptureInput {
                path: input.to_string_lossy().into(),
                expected_digest: None,
            }],
        )
        .unwrap();
    let mut req = request(next);
    req["inputs"] = json!([captured[0].artifact]);
    call(&s, "start", req, |_, _| Ok(running(next)))
        .expect("settled input capacity must be reusable");
}

#[test]
fn review_automatic_settlement_keeps_successful_operation_inputs_and_output() {
    let (root, s) = fixture();
    let input = root.path().join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save(&input)
        .unwrap();
    let op = "review-success-inputs";
    let captured = s
        .capture(
            &consumer(),
            op,
            vec![CaptureInput {
                path: input.to_string_lossy().into(),
                expected_digest: None,
            }],
        )
        .unwrap();
    let original = s
        .read(&consumer(), "consumer", op, &captured[0].artifact)
        .unwrap()
        .path;
    let mut req = request(op);
    req["inputs"] = json!([captured[0].artifact]);
    call(&s, "start", req, |_, _| Ok(running(op))).unwrap();
    let output = sealed(&s, op);
    let a = s.get("consumer", op).unwrap().unwrap();
    reconcile_at(
        &s,
        &provider(),
        &a,
        &status(
            op,
            "succeeded",
            json!({"state":"available","output":output}),
        ),
    )
    .unwrap();
    assert!(s.auto_settle_operation("consumer", op, true).is_err());
    s.gc().unwrap();
    assert!(Path::new(&original).exists());
    assert!(s
        .read(&consumer(), "consumer", op, &captured[0].artifact)
        .is_ok());
    assert!(s.read(&consumer(), "consumer", op, &output).is_ok());
    assert!(!s.execution_released("consumer", op).unwrap());
}

fn recovery_manifest(id: &str) -> super::package::Manifest {
    serde_json::from_value(json!({"formatVersion":1,"id":id,"name":"Recovery","description":"Recovery","version":"2.0.0","sdkVersion":3,"svelteVersion":super::package::SVELTE_VERSION,"target":format!("{}-unknown-linux-gnu",std::env::consts::ARCH),"frontend":"index.js","styles":"index.css","backend":"worker","contributions":["recovery"],"services":[{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}],"serviceDependencies":[{"packageId":"provider","serviceId":"image-generation","major":1}],"files":{}})).unwrap()
}

#[test]
fn invariant_b_replacement_recovers_settled_accepted_and_running_after_restart() {
    for execution in ["accepted", "running"] {
        let (root, s) = fixture();
        let op = "replacement-uncertain";
        call(&s, "start", request(op), |_, _| {
            Ok(status(op, execution, json!({"state":"none"})))
        })
        .unwrap();
        s.auto_settle_operation("consumer", op, true).unwrap();
        drop(s);
        let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
        let authority = super::service_bridge::recovery_provider(
            &s,
            &recovery_manifest("provider"),
            &generation("provider", 'd'),
            "consumer",
            op,
        )
        .expect("compatible replacement must inspect the original settled uncertain execution");
        assert_eq!(authority, provider());
        let a = s.get("consumer", op).unwrap().unwrap();
        let _permit = s.output_recovery_guard(&a).unwrap();
        let d = sealed(&s, op);
        let mut success = status(op, "succeeded", json!({"state":"available","output":d}));
        success["revision"] = json!(2);
        reconcile_at(&s, &authority, &a, &success).unwrap();
        assert!(s.read(&consumer(), "consumer", op, &d).is_ok());
        call(&s, "start", request(op), |method, _| {
            assert!(method.ends_with(".status"), "uncertain execution replayed");
            Ok(success.clone())
        })
        .unwrap();
    }
}

#[test]
fn invariant_a_and_b_released_acquired_running_job_is_repairable_and_completes() {
    use crate::service_state::job::{JobRecord, JobState};
    for mode in [
        "consumer-cost",
        "provider-cost",
        "view",
        "large-presentation",
    ] {
        // The oversized record needs a ~2 KB output path, beyond macOS PATH_MAX
        // and Windows MAX_PATH; the trimming logic it covers is platform-neutral.
        if mode == "large-presentation" && !cfg!(target_os = "linux") {
            continue;
        }
        let cost =
            json!({"amount":"0.075","currency":"USD","estimated":false,"source":"bfl.credits"});
        let view =
            json!({"kind":"view","viewId":"trace.view","directory":"/images","targetId":"17"});
        let (root, s) = fixture();
        let op = "acknowledged-unpublished";
        let registered = s.register_job(job(op, 97)).unwrap();
        s.update_job(
            &consumer(),
            &registered.job_key,
            JobState::Running,
            Some("running".into()),
            None,
            Some(17),
            None,
        )
        .unwrap();
        if matches!(mode, "view" | "large-presentation") {
            let mut prior_cost = cost.clone();
            prior_cost["amount"] = json!("9".repeat(15000));
            s.observe_job_with_presentation(
                &registered.owner,
                &registered.job_key,
                1,
                JobState::Running,
                Some("running".into()),
                None,
                Some(17),
                None,
                None,
                Some((
                    (mode == "large-presentation")
                        .then(|| crate::service_state::job::cost(&prior_cost).unwrap()),
                    (mode == "view").then(|| crate::service_state::job::reveal(&view).unwrap()),
                )),
            )
            .unwrap();
        }
        let d = ready(&s, op);
        let data = root.path().join("consumer-data");
        fs::create_dir(&data).unwrap();
        s.register_consumer_root("consumer", data.clone()).unwrap();
        let mut output_directory = data.clone();
        if mode == "large-presentation" {
            for _ in 0..10 {
                output_directory = output_directory.join("x".repeat(200));
            }
            fs::create_dir_all(&output_directory).unwrap();
        }
        let copy = output_directory.join("acquired.png");
        fs::copy(s.read(&consumer(), "consumer", op, &d).unwrap().path, &copy).unwrap();
        let proof = s
            .acquired(&consumer(), op, &d, copy.to_str().unwrap())
            .unwrap();
        let mut acknowledged = status(
            op,
            "succeeded",
            json!({"state":"acquired","transferReceipt":proof.transfer_receipt}),
        );
        if mode == "provider-cost" {
            acknowledged["billing"] = json!({"cost":cost});
        }
        call(&s, "acknowledge", json!({"operationId":op,"outputSha256":d.sha256,"disposition":"acquired","transferReceipt":proof.transfer_receipt}), |_, _| Ok(acknowledged.clone())).unwrap();
        // Crash before a consumer completion receipt. Only host acquisition and the
        // previously pinned consumer run survive; no provider bytes remain.
        drop(s);
        let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
        for id in ["consumer", "provider"] {
            drop(
                super::lifecycle::drain_idle(&s, id)
                    .expect("acknowledged output must never block repair or removal"),
            );
        }
        struct AcquiredOnly;
        impl super::ai_operations::AutomaticPort for AcquiredOnly {
            fn active(
                &self,
                _: &Admission,
                _: Option<&JobRecord>,
                _: bool,
                _: &str,
            ) -> Result<bool, AppError> {
                Ok(false)
            }
            fn recover(&self, _: &Admission, _: Option<&JobRecord>) -> Result<(), AppError> {
                Err(AppError::Other(
                    "provider has already released its output".into(),
                ))
            }
        }
        super::ai_operations::auto_reconcile_in(&s, &AcquiredOnly).unwrap();
        let completed = s.job(&registered.job_key).unwrap().unwrap();
        assert_eq!(completed.state, JobState::Completed);
        assert_eq!(completed.output_path.as_deref(), copy.to_str());
        assert_eq!(completed.run_id, Some(17));
        assert!(copy.is_file());
        let expected_reveal = if mode == "view" {
            view
        } else {
            json!({"kind":"file","path":copy.to_str().unwrap()})
        };
        assert_eq!(
            serde_json::to_value(&completed.reveal).unwrap(),
            expected_reveal
        );
        if mode == "provider-cost" {
            assert_eq!(serde_json::to_value(&completed.cost).unwrap(), cost);
        } else {
            assert!(completed.cost.is_none());
        }
        let observed = super::job_bridge::observe_in(&s, &completed, &json!({
        "jobId":completed.job_id, "operationId":op, "revision":completed.source_revision + 1,
        "status":"succeeded", "recoveryState":"complete", "outputPath":copy.to_str().unwrap(), "runId":17, "cost":cost
    })).unwrap();
        assert_eq!(serde_json::to_value(&observed.cost).unwrap(), cost);
        assert_eq!(observed.reveal, completed.reveal);
        assert_eq!(observed.settled_at_ms, completed.settled_at_ms);
        assert_eq!(observed.output_path, completed.output_path);
        assert_eq!(
            observed.revision > completed.revision,
            mode != "provider-cost"
        );
        let mut changed_cost = cost.clone();
        changed_cost["amount"] = json!("99");
        let changed = super::job_bridge::observe_in(&s, &observed, &json!({
        "jobId":observed.job_id, "operationId":op, "revision":observed.source_revision + 1,
        "status":"succeeded", "recoveryState":"complete", "outputPath":copy.to_str().unwrap(), "runId":17, "cost":changed_cost
    })).unwrap();
        assert_eq!(changed, observed, "the first terminal cost stays pinned");
    }
}

#[test]
fn invariant_b_self_owned_provider_replacement_needs_no_dependency_on_itself() {
    let mut a = Admission {
        consumer: provider(),
        provider: provider(),
        target: target(),
        operation_id: "self-owned".into(),
        fingerprint: "c".repeat(64),
        phase: AdmissionPhase::Reserved,
        inputs: vec![],
        output: None,
        needs_attention: false,
        disposition: None,
        transfer_receipt: None,
    };
    let mut manifest = recovery_manifest("provider");
    manifest.service_dependencies.clear();
    for phase in [
        AdmissionPhase::Reserved,
        AdmissionPhase::Forwarding,
        AdmissionPhase::Accepted,
        AdmissionPhase::Terminal,
        AdmissionPhase::Released,
    ] {
        a.phase = phase;
        assert!(super::ai_operations::replacement_recovers(&manifest, &a));
    }
    manifest.services.clear();
    assert!(!super::ai_operations::replacement_recovers(&manifest, &a));
}
#[test]
fn invariant_a_signals_counterpart_cancellation_before_releasing_all_phases() {
    let (_root, s) = fixture();
    for op in [
        "cancel-reserved",
        "cancel-accepted",
        "cancel-settled",
        "cancel-acquired",
    ] {
        if op == "cancel-reserved" {
            s.reserve(Admission {
                consumer: consumer(),
                provider: provider(),
                target: target(),
                operation_id: op.into(),
                fingerprint: "c".repeat(64),
                phase: AdmissionPhase::Reserved,
                inputs: vec![],
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            })
            .unwrap();
        } else {
            start(&s, op);
        }
        if op == "cancel-settled" {
            s.auto_settle_operation("consumer", op, true).unwrap();
        }
    }
    struct Cancellation<'a> {
        store: &'a Store,
        cancelled: Mutex<Vec<String>>,
    }
    impl RecoveryPort for Cancellation<'_> {
        fn closing(&self) -> bool {
            false
        }
        fn signal_cancel(&self, a: &Admission) {
            assert_ne!(
                self.store
                    .get(&a.consumer.package_id, &a.operation_id)
                    .unwrap()
                    .unwrap()
                    .phase,
                AdmissionPhase::Released
            );
            self.cancelled.lock().unwrap().push(a.operation_id.clone());
        }
        fn control(
            &self,
            _: &Admission,
            _: &str,
            _: &mut dyn FnMut(&PackageGeneration, &Value) -> Result<(), AppError>,
        ) -> Result<Value, AppError> {
            panic!("removal cannot wait for recovery")
        }
    }
    let port = Cancellation {
        store: &s,
        cancelled: Mutex::new(vec![]),
    };
    super::service_bridge::signal_removal_cancellations_in(&s, "consumer", |_| false, &port)
        .unwrap();
    let mut cancelled = port.cancelled.lock().unwrap().clone();
    cancelled.sort();
    assert_eq!(
        cancelled,
        [
            "cancel-accepted",
            "cancel-acquired",
            "cancel-reserved",
            "cancel-settled"
        ]
    );
    s.abandon_package_outputs("consumer").unwrap();
    assert!(s.claims().unwrap().is_empty());
}

#[test]
fn invariant_a_rejected_counterpart_cancellation_retries_after_release_and_restart() {
    let (root, s) = fixture();
    start(&s, "retry-cancel");
    struct Queue(bool);
    impl RecoveryPort for Queue {
        fn closing(&self) -> bool {
            false
        }
        fn signal_cancel(&self, _: &Admission) {}
        fn try_signal_cancel(&self, _: &Admission) -> bool {
            self.0
        }
        fn control(
            &self,
            _: &Admission,
            _: &str,
            _: &mut dyn FnMut(&PackageGeneration, &Value) -> Result<(), AppError>,
        ) -> Result<Value, AppError> {
            panic!("no replay")
        }
    }
    super::service_bridge::signal_removal_cancellations_in(
        &s,
        "consumer",
        |_| false,
        &Queue(false),
    )
    .unwrap();
    s.abandon_package_outputs("consumer").unwrap();
    drop(s);
    let reopened = Store::open(root.path().join("service"), Limits::default()).unwrap();
    assert_eq!(reopened.pending_removal_cancellations().unwrap().len(), 1);
    super::service_bridge::retry_removal_cancellations_in(&reopened, &Queue(true)).unwrap();
    assert!(reopened.pending_removal_cancellations().unwrap().is_empty());
    assert!(reopened.claims().unwrap().is_empty());
}
#[test]
fn invariant_b_acquired_output_completes_all_nonterminal_jobs_with_or_without_a_run() {
    use crate::service_state::job::JobState;
    for state in [
        JobState::Accepting,
        JobState::Running,
        JobState::Recovering,
        JobState::NeedsAttention,
    ] {
        for run in [None, Some(17)] {
            let (root, s) = fixture();
            let op = "acquired-all-jobs";
            let registered = s.register_job(job(op, 98)).unwrap();
            if state != JobState::Accepting || run.is_some() {
                s.update_job(
                    &consumer(),
                    &registered.job_key,
                    state,
                    Some("fixture".into()),
                    None,
                    run,
                    None,
                )
                .unwrap();
            }
            let d = ready(&s, op);
            let data = root.path().join("consumer-data");
            fs::create_dir(&data).unwrap();
            s.register_consumer_root("consumer", data.clone()).unwrap();
            let copy = data.join("delivered.png");
            fs::copy(s.read(&consumer(), "consumer", op, &d).unwrap().path, &copy).unwrap();
            let proof = s
                .acquired(&consumer(), op, &d, copy.to_str().unwrap())
                .unwrap();
            s.release(
                &provider(),
                "consumer",
                op,
                "acquired",
                Some(&proof.transfer_receipt),
            )
            .unwrap();
            drop(s);
            let s = Store::open(root.path().join("service"), Limits::default()).unwrap();
            // Run the production automatic decision, with only an idle proof.
            // The provider already collected its bytes; recovery must publish
            // completion from the acquired consumer output.
            super::ai_operations::auto_reconcile_in(&s, &IdleAutomatic).unwrap();
            let completed = s.job(&registered.job_key).unwrap().unwrap();
            assert_eq!(completed.state, JobState::Completed, "{state:?}/{run:?}");
            assert_eq!(completed.run_id, run);
            assert_eq!(completed.output_path.as_deref(), copy.to_str());
        }
    }
}

#[test]
fn released_acquired_replay_validates_request_with_legacy_execution_flag() {
    let (root, store) = fixture();
    let op = "legacy-acquired-replay";
    let output = ready(&store, op);
    let data = root.path().join("consumer-data");
    fs::create_dir(&data).unwrap();
    store
        .register_consumer_root("consumer", data.clone())
        .unwrap();
    let copy = data.join("result.png");
    fs::copy(
        store
            .read(&consumer(), "consumer", op, &output)
            .unwrap()
            .path,
        &copy,
    )
    .unwrap();
    let proof = store
        .acquired(&consumer(), op, &output, copy.to_str().unwrap())
        .unwrap();
    let receipt = status(
        op,
        "succeeded",
        json!({"state":"acquired","transferReceipt":proof.transfer_receipt}),
    );
    let admission = store.get("consumer", op).unwrap().unwrap();
    reconcile_at(&store, &provider(), &admission, &receipt).unwrap();
    let conn = rusqlite::Connection::open(root.path().join("service/ledger.sqlite")).unwrap();
    for flag in [false, true] {
        conn.execute(
            "UPDATE operations SET exec_released=?1 WHERE consumer='consumer' AND operation=?2",
            rusqlite::params![flag, op],
        )
        .unwrap();
        assert_eq!(
            call(&store, "status", json!({"operationId":op}), |_, _| panic!(
                "released status reached provider"
            ))
            .unwrap(),
            receipt
        );
        assert_eq!(
            call(&store, "start", request(op), |_, _| panic!(
                "released replay reached provider"
            ))
            .unwrap(),
            receipt
        );
        let mut changed = request(op);
        changed["prompt"] = json!("different paid request");
        assert!(call(&store, "start", changed, |_, _| panic!(
            "conflicting replay reached provider"
        ))
        .is_err());
        assert_eq!(
            store.provider_receipt("consumer", op).unwrap().unwrap(),
            receipt
        );
        assert!(copy.is_file());
    }
}

#[test]
fn unadmitted_status_validates_receipt_structure_and_billing_bounds() {
    let (_root, store) = fixture();
    let base = running("unadmitted");
    let mut invalid = vec![Value::Null, json!({"billing":{}})];
    let mut malformed = base.clone();
    malformed["revision"] = json!(0);
    invalid.push(malformed);
    for evidence in [
        json!({"schema":"x".repeat(65),"values":{}}),
        json!({"schema":"fixture","values":(0..33).map(|i| (i.to_string(), json!(i))).collect::<serde_json::Map<String, Value>>()}),
        json!({"schema":"fixture","values":{"nested":{}}}),
    ] {
        let mut receipt = base.clone();
        receipt["billing"] = json!({"evidence":evidence});
        invalid.push(receipt);
    }
    let accepted: Vec<_> = invalid
        .iter()
        .filter(|receipt| {
            ["status", "cancel"].iter().any(|method| {
                call(
                    &store,
                    method,
                    json!({"operationId":"unadmitted"}),
                    |_, _| Ok((*receipt).clone()),
                )
                .is_ok()
            })
        })
        .collect();
    assert!(accepted.is_empty(), "unvalidated receipts: {accepted:?}");
    assert!(store.get("consumer", "unadmitted").unwrap().is_none());
}

#[test]
fn unadmitted_status_projects_billing_for_each_consumer_capability() {
    let (_root, store) = fixture();
    let mut receipt = running("unadmitted");
    receipt["billing"] = json!({"cost":{"amount":"0.005","currency":"USD","estimated":true,"source":"fixture"},"evidence":{"schema":"x".repeat(64),"values":(0..32).map(|i| (i.to_string(), json!(i))).collect::<serde_json::Map<String, Value>>()}});
    for supports in [false, true] {
        let response = call(
            &store,
            "status",
            json!({"operationId":"unadmitted"}),
            |_, _| Ok(receipt.clone()),
        )
        .unwrap();
        let response = crate::service_state::receipt::for_consumer(response, supports);
        if supports {
            assert_eq!(response, receipt);
        } else {
            let mut legacy = receipt.clone();
            legacy.as_object_mut().unwrap().remove("billing");
            assert_eq!(response, legacy);
        }
    }
    assert!(store.get("consumer", "unadmitted").unwrap().is_none());
}
