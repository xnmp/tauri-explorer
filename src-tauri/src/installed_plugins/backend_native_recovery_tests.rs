//! Startup recovery of retained AI ownership against actual brokers, isolated
//! in a dedicated process. Run only with private XDG roots + Xvfb and
//! TE_LIFECYCLE_NATIVE_FIXTURE=1.
use super::native_tests::{payload, wait_file, JOB_POLL_INTERVAL};
use super::*;
use crate::service_state::{
    job::{JobRecord, JobState},
    model::{Admission, AdmissionPhase, Limits, PackageGeneration, ServiceTarget},
    Store,
};
use sha2::{Digest, Sha256};
use std::path::Path;

const PROVIDER: &str = "fixture.provider";
const CONSUMER: &str = "fixture.consumer";
const SERVICE: &str = "fixture-image";
const OPERATION: &str = "fixture-operation-1";
const JOB_ID: u64 = (1 << 51) | 7;

/// Records every host method, answers cancel with an in-flight receipt and
/// holds status until the test writes `provider-status-release`.
const PROVIDER_SOURCE: &str = r#"#!/usr/bin/env python3
import json,os,pathlib,sys,time
gate=pathlib.Path('__GATE__')
def send(v): print(json.dumps(v),flush=True)
def record(m):
 with open(gate/'provider.methods','a') as f:
  f.write(m+'\n');f.flush();os.fsync(f.fileno())
(gate/'provider.pid').write_text(str(os.getpid()))
def receipt(state,revision):
 return {'version':1,'operationId':'__OPERATION__','requestFingerprint':'__FINGERPRINT__','provider':{'packageId':'__PROVIDER__','serviceId':'__SERVICE__','major':1},'revision':revision,'execution':{'state':state},'delivery':{'state':'none'}}
for line in sys.stdin:
 f=json.loads(line);method=f.get('method')
 if method is None: continue
 record(method)
 if method=='initialize': result={'protocolVersion':1,'ready':False}
 elif method.endswith('.cancel'): result=receipt('running',1)
 elif method.endswith('.status'):
  (gate/'provider-status-entered').write_text('held')
  while not (gate/'provider-status-release').exists(): time.sleep(.01)
  result=receipt('cancelled',2)
 else: result={'ready':True}
 if 'id' in f: send({'jsonrpc':'2.0','id':f['id'],'result':result})
 if method.endswith('.status'): (gate/'provider-status-replied').write_text('sent')
"#;
/// Records every host method and holds the n-th `jobs.status` until the test
/// writes `consumer-status-release-<n>`.
const CONSUMER_SOURCE: &str = r#"#!/usr/bin/env python3
import json,os,pathlib,sys,time
gate=pathlib.Path('__GATE__')
def send(v): print(json.dumps(v),flush=True)
def record(m):
 with open(gate/'consumer.methods','a') as f:
  f.write(m+'\n');f.flush();os.fsync(f.fileno())
(gate/'consumer.pid').write_text(str(os.getpid()))
n=0
for line in sys.stdin:
 f=json.loads(line);method=f.get('method')
 if method is None: continue
 record(method)
 if method=='initialize': result={'protocolVersion':1,'ready':False}
 elif method=='jobs.status':
  n+=1
  (gate/f'consumer-status-entered-{n}').write_text('held')
  while not (gate/f'consumer-status-release-{n}').exists(): time.sleep(.01)
  result={'jobId':__JOB_ID__,'operationId':'__OPERATION__','status':'running','recoveryState':'running','revision':n}
 else: result={'ready':True}
 if 'id' in f: send({'jsonrpc':'2.0','id':f['id'],'result':result})
"#;

fn fingerprint() -> String {
    hex::encode(Sha256::digest(b"fixture retained request"))
}
fn worker(template: &str, gate: &Path) -> String {
    template
        .replace("__GATE__", gate.to_str().unwrap())
        .replace("__OPERATION__", OPERATION)
        .replace("__FINGERPRINT__", &fingerprint())
        .replace("__PROVIDER__", PROVIDER)
        .replace("__SERVICE__", SERVICE)
        .replace("__JOB_ID__", &JOB_ID.to_string())
}
fn sdk3(mut installed: package::Installed, id: &str, extra: Value) -> package::Installed {
    let mut manifest = serde_json::to_value(&installed.manifest).unwrap();
    manifest["id"] = json!(id);
    manifest["contributions"] = json!([id]);
    manifest["sdkVersion"] = json!(3);
    for (key, value) in extra.as_object().unwrap() {
        manifest[key] = value.clone();
    }
    installed.manifest = serde_json::from_value(manifest).unwrap();
    installed
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
/// The durable state a previous process left behind: an accepted shared-provider
/// claim owned by dead incarnations, and its running presentation job.
fn seed(config: &Path, consumer: &PackageGeneration, provider: &PackageGeneration) -> JobRecord {
    let store = Store::open(config.join("service-state"), Limits::default()).unwrap();
    store
        .reserve(Admission {
            consumer: consumer.clone(),
            provider: provider.clone(),
            target: ServiceTarget {
                package_id: PROVIDER.into(),
                service_id: SERVICE.into(),
                major: 1,
            },
            operation_id: OPERATION.into(),
            fingerprint: fingerprint(),
            phase: AdmissionPhase::Reserved,
            inputs: vec![],
            output: None,
            needs_attention: false,
            disposition: None,
            transfer_receipt: None,
        })
        .unwrap();
    assert!(store.claim_forwarding(consumer, OPERATION).unwrap().1);
    store.accepted(provider, CONSUMER, OPERATION).unwrap();
    let timestamp = now_ms();
    let job = store
        .register_job(JobRecord {
            job_key: format!("{:048x}", 0xfeed_u64),
            owner: consumer.clone(),
            operation_id: OPERATION.into(),
            job_id: JOB_ID,
            kind: "openai-image".into(),
            label: "AI image".into(),
            origin_window: "main".into(),
            revision: 0,
            source_revision: 0,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
            state: JobState::Accepting,
            phase: Some("preparing".into()),
            output_path: None,
            run_id: None,
            error: None,
        })
        .unwrap();
    store
        .update_job(
            consumer,
            &job.job_key,
            JobState::Running,
            Some("running".into()),
            None,
            None,
            None,
        )
        .unwrap()
}
fn alive(pid_file: &Path) -> bool {
    let pid: i32 = fs::read_to_string(pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    unsafe { libc::kill(pid, 0) == 0 }
}
fn methods(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}
fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < deadline, "Timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_startup_recovery_holds_readiness_and_shutdown_for_actual_io() {
    assert_eq!(
        std::env::var("TE_LIFECYCLE_NATIVE_FIXTURE").as_deref(),
        Ok("1")
    );
    let profile = PathBuf::from(std::env::var("XDG_CONFIG_HOME").unwrap());
    assert!(
        profile
            .to_str()
            .unwrap()
            .starts_with("/tmp/te-lifecycle-native."),
        "Never use the user profile"
    );
    let gate = profile.parent().unwrap().join("gates");
    fs::create_dir_all(&gate).unwrap();
    let config = config::config_dir().unwrap();
    let root = config.join("installed-plugins");
    fs::create_dir_all(&root).unwrap();
    let provider = sdk3(
        payload(&root, &worker(PROVIDER_SOURCE, &gate)),
        PROVIDER,
        json!({"services":[{"id":SERVICE,"major":1,"methods":["start","status","cancel"]}]}),
    );
    let consumer = sdk3(
        payload(&root, &worker(CONSUMER_SOURCE, &gate)),
        CONSUMER,
        json!({"serviceDependencies":[{"packageId":PROVIDER,"serviceId":SERVICE,"major":1}]}),
    );
    package::write_index(&root, &[consumer.clone(), provider.clone()]).unwrap();
    let consumer_generation = PackageGeneration {
        package_id: CONSUMER.into(),
        digest: consumer.digest.clone(),
        incarnation: 41,
    };
    let provider_generation = PackageGeneration {
        package_id: PROVIDER.into(),
        digest: provider.digest.clone(),
        incarnation: 42,
    };
    let job = seed(&config, &consumer_generation, &provider_generation);
    assert_eq!(job.state, JobState::Running);

    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    super::super::initialize(app.handle().clone()).unwrap();
    let store = super::super::service_host::store().unwrap();
    // (a) Startup takes the persisted job out of its running presentation
    // before any consumer receipt has been observed.
    assert_eq!(
        store.job(&job.job_key).unwrap().unwrap().state,
        JobState::Recovering
    );
    // The recovery actor is now inside the provider's status RPC and the job
    // reconciler's worker is inside the consumer's jobs.status RPC.
    wait_file(&gate.join("provider-status-entered"));
    wait_file(&gate.join("consumer-status-entered-1"));
    let claim = store.get(CONSUMER, OPERATION).unwrap().unwrap();
    assert_eq!(claim.phase, AdmissionPhase::Accepted);
    assert!(!claim.needs_attention);
    assert_eq!(
        store
            .provider_receipt(CONSUMER, OPERATION)
            .unwrap()
            .unwrap()["execution"]["state"],
        "running"
    );
    for package in [CONSUMER, PROVIDER] {
        assert!(
            super::super::service_host::mutation_allowed_in(
                super::super::service_host::store().unwrap(),
                package
            )
            .is_err(),
            "{package} was released for package changes before its claim was recovered"
        );
    }
    let operations = super::super::ai_operations::snapshot().unwrap();
    assert_eq!(
        operations["operations"][0]["operationId"], OPERATION,
        "{operations}"
    );
    assert_eq!(
        store.job(&job.job_key).unwrap().unwrap().state,
        JobState::Recovering,
        "Job reported a consumer state before its status RPC returned"
    );
    // Only the returned consumer receipt may move the presentation job.
    fs::write(gate.join("consumer-status-release-1"), b"go").unwrap();
    wait_until("the returned consumer receipt", || {
        store.job(&job.job_key).unwrap().unwrap().state == JobState::Running
    });
    assert_eq!(
        store.get(CONSUMER, OPERATION).unwrap().unwrap().phase,
        AdmissionPhase::Accepted
    );
    // The reconciler polls again; hold that RPC too.
    let next_poll = Instant::now() + JOB_POLL_INTERVAL * 2;
    while !gate.join("consumer-status-entered-2").exists() {
        assert!(
            Instant::now() < next_poll,
            "Job reconciler did not poll again"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    // Let the reconciler finish this and any later poll, so the only actor
    // that can still be inside ledger IO during shutdown is recovery.
    for n in 2..=32 {
        fs::write(gate.join(format!("consumer-status-release-{n}")), b"go").unwrap();
    }
    // (b) Hold the ledger's write lock, then let the provider answer status.
    // The recovery actor must persist that authoritative receipt, so it is
    // inside durable ledger IO when shutdown begins.
    let profile_root = config.canonicalize().unwrap();
    let ledger = rusqlite::Connection::open(config.join("service-state/ledger.sqlite")).unwrap();
    ledger.busy_timeout(Duration::from_secs(5)).unwrap();
    ledger.execute_batch("BEGIN IMMEDIATE").unwrap();
    fs::write(gate.join("provider-status-release"), b"go").unwrap();
    wait_file(&gate.join("provider-status-replied"));
    // Margin for the actor to read the reply and reach the held write; the
    // receipt assertion below proves it did. Two mechanisms each keep
    // shutdown pending here: joining the recovery actor, and waiting for the
    // CallLease it holds across that IO. Removing both fails this test.
    std::thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    let (complete, finished) = mpsc::channel();
    let shutdown_worker = std::thread::spawn(move || {
        super::super::shutdown();
        complete.send(()).unwrap();
    });
    wait_until("both brokers to stop", || {
        !alive(&gate.join("provider.pid")) && !alive(&gate.join("consumer.pid"))
    });
    // The ledger's busy timeout is 3 s. Hold past the reconciler's bound so
    // only the recovery actor's durable write can keep shutdown pending.
    let hold_until = started + JOB_POLL_INTERVAL + Duration::from_millis(500);
    assert!(
        matches!(
            finished.recv_timeout(hold_until.saturating_duration_since(Instant::now())),
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "Shutdown returned while the recovery actor was inside ledger IO"
    );
    assert!(
        super::super::ownership::acquire(&profile_root).is_err(),
        "Shutdown released profile ownership while recovery IO was in progress"
    );
    assert!(
        !store
            .get(CONSUMER, OPERATION)
            .unwrap()
            .unwrap()
            .needs_attention
    );
    let released = Instant::now();
    ledger.execute_batch("COMMIT").unwrap();
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
    let tail = released.elapsed();
    eprintln!(
        "lifecycle-native: recovery shutdown returned {tail:?} after ledger release ({:?} total)",
        started.elapsed()
    );
    assert!(
        tail < Duration::from_millis(500),
        "Shutdown waited {tail:?} after recovery IO returned"
    );
    shutdown_worker.join().unwrap();
    // The actor's held write (the provider's authoritative cancellation)
    // completed before shutdown returned, and shutdown itself recorded no
    // attention verdict.
    let claim = store.get(CONSUMER, OPERATION).unwrap().unwrap();
    assert_ne!(
        claim.phase,
        AdmissionPhase::Accepted,
        "The receipt write held during shutdown never landed"
    );
    assert!(!claim.needs_attention);
    drop(super::super::ownership::acquire(&profile_root).unwrap());

    // (c) Recovery is unpaid: only handshake, cancellation and status reached
    // the provider, and the consumer was never asked to start work.
    let provider_methods = methods(&gate.join("provider.methods"));
    let consumer_methods = methods(&gate.join("consumer.methods"));
    eprintln!("lifecycle-native: provider methods {provider_methods:?}");
    eprintln!("lifecycle-native: consumer methods {consumer_methods:?}");
    let cancel = format!("services.{SERVICE}.v1.cancel");
    let status = format!("services.{SERVICE}.v1.status");
    assert!(provider_methods.contains(&cancel));
    assert!(provider_methods.contains(&status));
    assert!(consumer_methods.iter().any(|m| m == "jobs.status"));
    for method in provider_methods.iter().chain(&consumer_methods) {
        assert!(
            !method.ends_with("start"),
            "Recovery issued a paid start: {method}"
        );
    }
    drop(app);
}
