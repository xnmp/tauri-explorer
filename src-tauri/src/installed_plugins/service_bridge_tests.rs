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
    let (_root,store)=fixture();let op="stopped";start(&store,op);
    let mut unknown=status(op,"unknown",json!({"state":"none"}));unknown["revision"]=json!(2);unknown["execution"]["error"]=json!({"code":"interrupted","message":"Remote result is unconfirmed","correlationId":null});
    call(&store,"status",json!({"operationId":op}),|_,_|Ok(unknown.clone())).unwrap();
    let original=store.get("consumer",op).unwrap().unwrap();
    store.stop_recovery(&provider(),"consumer",op,true).unwrap();
    assert_eq!(super::service_bridge::recovery_retained_status(&store,&original).unwrap(),Some(unknown.clone()));
    for (method,request) in [("status",json!({"operationId":op})),("start",request(op))] {
        assert!(matches!(call(&store,method,request,|_,_|panic!("stopped operation reached provider")),Err(AppError::Service{ref code,..}) if code=="recovery_stopped"));
    }
    assert_eq!(store.provider_receipt("consumer",op).unwrap(),Some(unknown));assert!(store.claims().unwrap().is_empty());
    // Execution release allows compatible package changes, not an old
    // consumer that would relabel the original unknown as interrupted.
    assert!(super::service_host::require_legacy_consumer_compatible(&store, "consumer").is_err());
    assert!(super::service_host::require_legacy_consumer_compatible(&store, "provider").is_ok());
    assert!(super::service_host::require_legacy_consumer_compatible(&store, "unrelated").is_ok());
}
#[test]
fn explicit_discard_is_authoritative_for_a_previously_queued_recovery_snapshot() {
    let (_root,store)=fixture();let op="discarded-recovery";ready(&store,op);
    let original=store.get("consumer",op).unwrap().unwrap();
    let receipt=status(op,"succeeded",json!({"state":"discarded"}));
    reconcile_at(&store,&provider(),&original,&receipt).unwrap();
    assert_eq!(super::service_bridge::recovery_retained_status(&store,&original).unwrap(),Some(receipt));
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
