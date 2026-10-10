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
fn fixture() -> (tempfile::TempDir, Store) {
    let root = tempfile::tempdir().unwrap();
    let store = Store::open(root.path().join("service"), Limits::default()).unwrap();
    (root, store)
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
    let stage = store.stage(&provider(), "consumer", op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    store
        .seal(&provider(), "consumer", op, &stage.handle, "image/png")
        .unwrap()
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
        created_at_ms: 1_000 + n,
        updated_at_ms: 1_000 + n,
        state: JobState::Accepting,
        phase: Some("preparing".into()),
        output_path: None,
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
    // The tombstone refuses a conflicting discard and turns replay into status.
    let a = s.get("consumer", "import").unwrap().unwrap();
    assert!(reconcile_at(
        &s,
        &provider(),
        &a,
        &status("import", "succeeded", json!({"state":"discarded"}))
    )
    .is_err());
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
