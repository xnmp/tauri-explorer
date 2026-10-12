//! Disable retires the real broker process only after durable claims drain.
//! Run only in a dedicated process with private XDG roots under Xvfb and
//! TE_LIFECYCLE_NATIVE_FIXTURE=1, like `backend::native_tests`.
use super::super::{backend, package, root, service_host};
use super::{set_enabled, uninstall, Profile};
use crate::service_state::model::*;
use serde_json::json;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

/// One scripted backend for every lifecycle fixture. It records each host
/// method (and operation ID) to `methods`, answers SDK 3 activation, and
/// emits an ordinary event after replying to `poke`. `behaviour` selects
/// `refuse-quiesce` (the plugin stays ready) or `crash-on-start`.
const SCRIPTED: &str = r#"#!/usr/bin/env python3
import json,os,sys
log='__LOG__';behaviour='__BEHAVIOUR__'
def send(v): print(json.dumps(v),flush=True)
def reply(f,r): send({'jsonrpc':'2.0','id':f['id'],'result':r})
for line in sys.stdin:
 f=json.loads(line);m=f.get('method')
 if m is None or 'id' not in f: continue
 with open(log,'a') as out: out.write((m+' '+str(f.get('params',{}).get('operationId',''))).strip()+'\n')
 if m=='initialize': reply(f,{'protocolVersion':1,'ready':__READY__})
 elif m=='ping': reply(f,{'pid':os.getpid()})
 elif m=='poke':
  reply(f,{});send({'jsonrpc':'2.0','method':'event','params':{'name':'fixture:changed','payload':{}}})
 elif m=='lifecycle.quiesce' and behaviour=='refuse-quiesce':
  send({'jsonrpc':'2.0','id':f['id'],'error':{'code':-32002,'message':'checkpoint busy','data':{'code':'capacity_reached'}}})
 elif m=='lifecycle.quiesce': reply(f,{'ready':False,'idle':True,'checkpoint':True})
 elif m=='jobs.start' and behaviour=='crash-on-start': os._exit(3)
 elif m=='jobs.status': reply(f,None)
 elif m=='jobs.cancelOperation': reply(f,{'cancelRequested':True})
 else: reply(f,{'ready':True})
"#;
pub(in crate::installed_plugins) fn scripted(
    root: &Path,
    id: &str,
    sdk: u32,
    behaviour: &str,
) -> package::Installed {
    let source = SCRIPTED
        .replace("__LOG__", methods_path(root, id).to_str().unwrap())
        .replace("__BEHAVIOUR__", behaviour)
        // SDK 3 activates explicitly; older SDKs are ready from initialize.
        .replace("__READY__", if sdk >= 3 { "False" } else { "True" });
    let mut installed = super::super::backend::native_tests::payload(root, &source);
    installed.manifest.id = id.into();
    installed.manifest.contributions = vec![id.into()];
    installed.manifest.sdk_version = sdk;
    installed
}
fn methods_path(root: &Path, id: &str) -> std::path::PathBuf {
    root.parent().unwrap().join(format!("{id}.methods"))
}
pub(in crate::installed_plugins) fn methods(root: &Path, id: &str) -> Vec<String> {
    fs::read_to_string(methods_path(root, id))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}
pub(in crate::installed_plugins) fn running(pid: i64) -> bool {
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
fn native_disable_retires_the_backend_and_releases_accepted_claims() {
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
    // SDK 3, so the eventual disable runs the real quiesce handshake.
    let current = scripted(&root, id, 3, "quiesce");
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
    set_enabled(&profile, id, false).unwrap();
    assert!(store.claims().unwrap().is_empty());
    assert_eq!(
        store.get(id, "retirement").unwrap().unwrap().phase,
        AdmissionPhase::Released
    );
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

pub(in crate::installed_plugins) fn native_app() -> tauri::App {
    assert_eq!(
        std::env::var("TE_LIFECYCLE_NATIVE_FIXTURE").as_deref(),
        Ok("1")
    );
    let profile = std::env::var("XDG_CONFIG_HOME").unwrap();
    assert!(
        profile.starts_with("/tmp/te-lifecycle-native."),
        "Never use the user profile"
    );
    tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap()
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_disable_and_uninstall_ignore_quiesce_refusal_and_disable_dependents() {
    let app = native_app();
    super::super::initialize(app.handle().clone()).unwrap();
    let root = root().unwrap();
    fs::create_dir_all(&root).unwrap();
    let id = "fixture.refusing";
    let current = scripted(&root, id, 3, "refuse-quiesce");
    // A provider that quiesces, and a consumer whose dependency on it
    // refuses the provider's removal only after that handshake.
    let provider = with_manifest(
        scripted(&root, "fixture.quiescing", 3, "quiesce"),
        json!({"services":[{"id":"fixture-service","major":1,"methods":["status"]}]}),
    );
    let dependent = with_manifest(
        scripted(&root, "fixture.dependent", 3, "quiesce"),
        json!({"serviceDependencies":[{"packageId":"fixture.quiescing","serviceId":"fixture-service","major":1}]}),
    );
    package::write_index(&root, &[current.clone(), provider.clone(), dependent]).unwrap();
    let broker = backend::ensure(id).unwrap();
    let pid = broker.call("ping", json!({})).unwrap()["pid"]
        .as_i64()
        .unwrap();
    // Control: an ordinary event from an active backend is harmless.
    broker.call("poke", json!({})).unwrap();
    assert_eq!(broker.call("ping", json!({})).unwrap()["pid"], pid);
    let profile = Profile {
        root: &root,
        store: service_host::store().unwrap(),
    };
    set_enabled(&profile, id, false).unwrap();
    assert!(
        !package::list(&root)
            .unwrap()
            .iter()
            .find(|p| p.manifest.id == id)
            .unwrap()
            .enabled
    );
    assert!(!running(pid));
    assert!(backend::active_instance(id, &current.digest).is_none());
    let quiescing = backend::ensure(&provider.manifest.id).unwrap();
    let provider_pid = quiescing.call("ping", json!({})).unwrap()["pid"]
        .as_i64()
        .unwrap();
    uninstall(&profile, &provider.manifest.id).unwrap();
    assert!(!running(provider_pid));
    let installed = package::list(&root).unwrap();
    assert!(!installed
        .iter()
        .any(|p| p.manifest.id == provider.manifest.id));
    assert!(
        !installed
            .iter()
            .find(|p| p.manifest.id == "fixture.dependent")
            .unwrap()
            .enabled
    );
    super::super::shutdown();
    drop(app);
}
fn with_manifest(
    mut installed: package::Installed,
    fields: serde_json::Value,
) -> package::Installed {
    let mut manifest = serde_json::to_value(&installed.manifest).unwrap();
    for (key, value) in fields.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    installed.manifest = serde_json::from_value(manifest).unwrap();
    installed
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_jobs_the_consumer_never_accepted_settle_and_free_their_package() {
    use crate::service_state::job::{JobRecord, JobState};
    let app = native_app();
    super::super::initialize(app.handle().clone()).unwrap();
    let root = root().unwrap();
    fs::create_dir_all(&root).unwrap();
    let id = "fixture.crashing-consumer";
    let current = scripted(&root, id, 3, "crash-on-start");
    package::write_index(&root, std::slice::from_ref(&current)).unwrap();
    let store = service_host::store().unwrap();
    // The consumer dies mid-request: its caller sees a plain transport error.
    let started = backend::call_with_origin(
        id,
        "jobs.start",
        json!({"kind":"openai-image","request":{}}),
        "main",
        std::time::SystemTime::now(),
    );
    assert!(started.is_err());
    let jobs = store.snapshot_jobs().unwrap().jobs;
    assert_eq!(jobs.len(), 1);
    let crashed = &jobs[0];
    assert_eq!(crashed.state, JobState::Error, "{crashed:?}");
    assert_eq!(crashed.phase.as_deref(), Some("not_accepted"));
    // The replacement consumer fenced the original ID before its absence settled it.
    let log = methods(&root, id);
    let fence = log
        .iter()
        .position(|m| *m == format!("jobs.cancelOperation {}", crashed.operation_id))
        .expect("fenced");
    assert!(log[fence..]
        .iter()
        .any(|m| *m == format!("jobs.status {}", crashed.operation_id)));
    // A job left in attention by an earlier process settles once its
    // consumer is running again, through the reconciler alone.
    let broker = backend::ensure(id).unwrap();
    let old = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        - 700_000;
    let earlier = store
        .register_job(JobRecord {
            job_key: "e".repeat(48),
            owner: broker.generation(),
            operation_id: "fedcba9876543210fedcba9876543210".into(),
            job_id: (1 << 51) | 9,
            kind: "openai-image".into(),
            label: "AI image".into(),
            origin_window: "main.previous".into(),
            revision: 0,
            source_revision: 0,
            ownership_epoch: 0,
            created_at_ms: old,
            updated_at_ms: old,
            settled_at_ms: None,
            estimate_key: None,
            state: JobState::Accepting,
            phase: Some("preparing".into()),
            output_path: None,
            run_id: None,
            error: None,
        })
        .unwrap();
    store
        .update_job(
            &earlier.owner,
            &earlier.job_key,
            JobState::NeedsAttention,
            Some("needs_attention".into()),
            None,
            None,
            Some("Recovery requires attention".into()),
        )
        .unwrap();
    assert!(store.busy(id).unwrap());
    let deadline = Instant::now() + Duration::from_secs(15);
    while store.job(&earlier.job_key).unwrap().unwrap().state != JobState::Error
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    let settled = store.job(&earlier.job_key).unwrap().unwrap();
    assert_eq!(
        settled.phase.as_deref(),
        Some("not_accepted"),
        "{settled:?}"
    );
    assert!(methods(&root, id)
        .iter()
        .any(|m| *m == "jobs.cancelOperation fedcba9876543210fedcba9876543210"));
    // Nothing durable or live holds the package: disable is admitted.
    assert!(!store.busy(id).unwrap());
    let profile = Profile { root: &root, store };
    set_enabled(&profile, id, false).unwrap();
    assert!(!package::list(&root).unwrap()[0].enabled);
    super::super::shutdown();
    drop(app);
}
