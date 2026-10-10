//! Disable retires the real broker process only after durable claims drain.
//! Run only in a dedicated process with private XDG roots under Xvfb and
//! TE_LIFECYCLE_NATIVE_FIXTURE=1, like `backend::native_tests`.
use super::super::{backend, package, root, service_host};
use super::{set_enabled, Profile};
use crate::service_state::model::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

fn installed(root: &Path, id: &str) -> package::Installed {
    let source = r#"#!/usr/bin/env python3
import json,os,sys
for line in sys.stdin:
 f=json.loads(line);method=f.get('method')
 if method=='initialize': result={'protocolVersion':1,'ready':True}
 elif method=='ping': result={'pid':os.getpid()}
 else: result={'ready':True}
 print(json.dumps({'jsonrpc':'2.0','id':f['id'],'result':result}),flush=True)
"#;
    let digest = hex::encode(Sha256::digest(source.as_bytes()));
    let directory = root.join("payloads").join(&digest);
    fs::create_dir_all(&directory).unwrap();
    let files = [
        ("index.js", b"export const plugins=[];".as_slice()),
        ("index.css", b"body{}".as_slice()),
        ("worker", source.as_bytes()),
    ];
    let declarations: serde_json::Map<String, Value> = files
        .iter()
        .map(|(name, bytes)| {
            fs::write(directory.join(name), bytes).unwrap();
            (
                (*name).to_owned(),
                json!({"size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))}),
            )
        })
        .collect();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(directory.join("worker"), fs::Permissions::from_mode(0o700)).unwrap();
    let target = format!("{}-unknown-linux-gnu", std::env::consts::ARCH);
    serde_json::from_value(json!({"enabled":true,"digest":digest,"manifest":{
        "formatVersion":1,"id":id,"name":"retirement fixture","description":"private broker fixture",
        "version":"1.0.0","sdkVersion":2,"svelteVersion":"5.56.3","target":target,"frontend":"index.js",
        "styles":"index.css","backend":"worker","contributions":[id],"files":declarations
    }}))
    .unwrap()
}
fn running(pid: i64) -> bool {
    fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        !stat
            .rsplit_once(')')
            .unwrap()
            .1
            .trim_start()
            .starts_with('Z')
    })
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_disable_retires_the_backend_only_after_claims_drain() {
    assert_eq!(
        std::env::var("TE_LIFECYCLE_NATIVE_FIXTURE").as_deref(),
        Ok("1")
    );
    let profile = std::env::var("XDG_CONFIG_HOME").unwrap();
    assert!(
        profile.starts_with("/tmp/te-lifecycle-native."),
        "Never use the user profile"
    );
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    super::super::initialize(app.handle().clone()).unwrap();
    let root = root().unwrap();
    fs::create_dir_all(&root).unwrap();
    let id = "fixture.retirement";
    let current = installed(&root, id);
    package::write_index(&root, std::slice::from_ref(&current)).unwrap();
    let pid = backend::ensure(id)
        .unwrap()
        .call("ping", json!({}))
        .unwrap()["pid"]
        .as_i64()
        .unwrap();
    assert!(running(pid));
    // An accepted operation in which this package is the consumer.
    let store = service_host::store().unwrap();
    let consumer = PackageGeneration {
        package_id: id.into(),
        digest: current.digest.clone(),
        incarnation: 1,
    };
    let provider = PackageGeneration {
        package_id: "fixture.absent-provider".into(),
        digest: "c".repeat(64),
        incarnation: 1,
    };
    store
        .reserve(Admission {
            consumer: consumer.clone(),
            provider: provider.clone(),
            target: ServiceTarget {
                package_id: provider.package_id.clone(),
                service_id: "image-generation".into(),
                major: 1,
            },
            operation_id: "retirement".into(),
            fingerprint: "b".repeat(64),
            phase: AdmissionPhase::Reserved,
            inputs: vec![],
            output: None,
            needs_attention: false,
            disposition: None,
            transfer_receipt: None,
        })
        .unwrap();
    store.claim_forwarding(&consumer, "retirement").unwrap();
    store.accepted(&provider, id, "retirement").unwrap();
    let profile = Profile { root: &root, store };
    assert!(service_host::is_busy(
        &set_enabled(&profile, id, false).unwrap_err()
    ));
    assert!(package::list(&root).unwrap()[0].enabled);
    assert!(running(pid), "a refused disable retired the backend");
    assert_eq!(
        backend::ensure(id)
            .unwrap()
            .call("ping", json!({}))
            .unwrap()["pid"],
        pid
    );
    // The provider settles with an unknown outcome and no live worker.
    store
        .terminal(&provider, id, "retirement", None, true)
        .unwrap();
    store
        .stop_recovery(&provider, id, "retirement", true)
        .unwrap();
    set_enabled(&profile, id, false).unwrap();
    assert!(!package::list(&root).unwrap()[0].enabled);
    let deadline = Instant::now() + Duration::from_secs(3);
    while running(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!running(pid), "disable left the backend running");
    assert!(backend::active_instance(id, &current.digest).is_none());
    assert!(backend::ensure(id).is_err());
    super::super::shutdown();
    drop(app);
}
