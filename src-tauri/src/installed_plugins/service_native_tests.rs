//! Actual Wry handle, production brokers, pipes, reverse workers and the
//! installed-host service bridge, with fake SDK 3 packages: an Image
//! Generation provider and two non-Trace consumers. Trace is not installed.
//! Run only with a private XDG profile under Xvfb and
//! TE_SERVICE_NATIVE_FIXTURE=1 (see the command in the test's assertion).
use super::super::{backend, package, root};
use crate::config;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

pub(super) const PROVIDER: &str = "xnmp.image-generation";
const FIRST: &str = "fixture.consumer";
const SECOND: &str = "fixture.second";

/// One SDK 3 backend for every role. Requests are served concurrently; the
/// consumer records each reverse reply under `replies/` by its request ID.
const BACKEND: &str = r#"#!/usr/bin/env python3
import json,sys,pathlib,threading,time,os
root=pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1])
ROLE='%ROLE%'
out=threading.Lock()
cond=threading.Condition()
replies={}
count=[0]
INCARNATION=str(os.getpid())
PROVIDER={'packageId':'xnmp.image-generation','serviceId':'image-generation','major':1}
def send(v):
    data=json.dumps(v)
    with out:
        sys.stdout.write(data+'\n'); sys.stdout.flush()
def log(entry):
    with out:
        with open(root/'log.jsonl','a') as f: f.write(json.dumps(entry)+'\n')
def wait_file(name):
    end=time.time()+90
    while not (root/name).exists() and time.time()<end: time.sleep(.01)
def record(rid):
    end=time.time()+90
    with cond:
        while rid not in replies and time.time()<end: cond.wait(.1)
        reply=replies.pop(rid,None)
    folder=root/'replies'; folder.mkdir(exist_ok=True)
    name=rid.replace(':','_')
    (folder/(name+'.tmp')).write_text(json.dumps(reply))
    os.replace(folder/(name+'.tmp'),folder/(name+'.json'))
def receipt(op):
    state=json.loads((root/'ops'/(op+'.json')).read_text())
    base={'version':1,'operationId':op,'requestFingerprint':state['fingerprint'],'provider':PROVIDER,'delivery':{'state':'none'}}
    if state['incarnation']!=INCARNATION:
        return dict(base,revision=2,execution={'state':'unknown','error':{'code':'interrupted','message':'Provider restarted before the result was confirmed','correlationId':None}})
    return dict(base,revision=1,execution={'state':'running'})
def handle(f):
    method=f['method']; params=f.get('params',{}); fid=f.get('id')
    log({'method':method,'params':params,'pid':INCARNATION})
    result=None
    if method=='initialize': result={'protocolVersion':1,'ready':False}
    elif method=='lifecycle.activate': result={'ready':True}
    elif method=='fixture.send':
        ids=[]
        for request in params['requests']:
            if request.get('notify'):
                send({'jsonrpc':'2.0','method':request['method'],'params':request['params']}); continue
            with cond:
                count[0]+=1; rid='host:%s:%d'%(ROLE,count[0])
            ids.append(rid)
            threading.Thread(target=record,args=(rid,),daemon=True).start()
            send({'jsonrpc':'2.0','id':rid,'method':request['method'],'params':request['params']})
        result={'ids':ids}
    elif method=='fixture.exit': os._exit(3)
    elif method.startswith('services.image-generation.v1.'):
        verb=method.rsplit('.',1)[1]; request=params['request']
        if verb=='describe': result={'available':True}
        elif verb=='prepare':
            wait_file('release-prepare'); time.sleep(request['delay']); result={'nonce':request['nonce']}
        elif verb=='start':
            (root/'ops').mkdir(exist_ok=True)
            (root/'ops'/(request['operationId']+'.json')).write_text(json.dumps({'fingerprint':request['effectiveRecipeDigest'],'incarnation':INCARNATION}))
            result=receipt(request['operationId'])
        elif verb in ('status','cancel'):
            op=request['operationId']
            if (root/('hold-'+op)).exists(): wait_file('release-'+op)
            result=receipt(op)
    if fid is not None: send({'jsonrpc':'2.0','id':fid,'result':result})
for line in sys.stdin:
    f=json.loads(line)
    if 'method' in f: threading.Thread(target=handle,args=(f,),daemon=True).start()
    else:
        with cond:
            replies[f['id']]=f; cond.notify_all()
"#;

fn package(root: &Path, id: &str, services: Value, dependencies: Value) -> package::Installed {
    // One script per role; the role names its reverse request IDs.
    package_from(
        root,
        id,
        &BACKEND.replace("%ROLE%", id),
        services,
        dependencies,
    )
}
/// Installs `source` as the SDK 3 backend of package `id`.
pub(super) fn package_from(
    root: &Path,
    id: &str,
    source: &str,
    services: Value,
    dependencies: Value,
) -> package::Installed {
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
        "formatVersion":1,"id":id,"name":"service fixture","description":"private service fixture",
        "version":"1.0.0","sdkVersion":3,"svelteVersion":package::SVELTE_VERSION,"target":target,"frontend":"index.js",
        "styles":"index.css","backend":"worker","contributions":[id],"services":services,
        "serviceDependencies":dependencies,"files":declarations
    }}))
    .unwrap()
}
pub(super) fn data(id: &str) -> PathBuf {
    config::config_dir().unwrap().join("plugin-data").join(id)
}
pub(super) fn log(id: &str) -> Vec<Value> {
    fs::read_to_string(data(id).join("log.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn provider_calls(verb: &str) -> Vec<Value> {
    log(PROVIDER)
        .into_iter()
        .filter(|entry| entry["method"] == format!("services.image-generation.v1.{verb}"))
        .collect()
}
pub(super) fn wait_until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
/// Sends reverse requests from a consumer backend. Returns their IDs in order.
fn send(consumer: &str, requests: Vec<(&str, Value)>) -> Vec<String> {
    let requests: Vec<_> = requests
        .into_iter()
        .map(|(method, params)| json!({"method":method,"params":params}))
        .collect();
    backend::call(consumer, "fixture.send", json!({"requests":requests})).unwrap()["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect()
}
fn reply_path(consumer: &str, id: &str) -> PathBuf {
    data(consumer)
        .join("replies")
        .join(format!("{}.json", id.replace(':', "_")))
}
fn has_reply(consumer: &str, id: &str) -> bool {
    reply_path(consumer, id).is_file()
}
fn reply(consumer: &str, id: &str, limit: Duration) -> Value {
    wait_until(&format!("reply {id}"), limit, || has_reply(consumer, id));
    let reply: Value =
        serde_json::from_str(&fs::read_to_string(reply_path(consumer, id)).unwrap()).unwrap();
    assert_eq!(reply["id"], id, "reply correlated to another request");
    reply
}
fn invoke(method: &str, params: Value) -> (&'static str, Value) {
    (
        "host.services.invoke",
        json!({"packageId":PROVIDER,"serviceId":"image-generation","major":1,"method":method,"params":params}),
    )
}
pub(super) fn start_request(op: &str) -> Value {
    json!({"operationId":op,"connectionId":"fixture-profile","expectedConnectionRevision":"fixture-revision","model":null,"prompt":"fixture prompt","inputs":[],"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"preparationToken":"fixture-token","effectiveRecipeDigest":"c".repeat(64)})
}
fn provider_incarnation() -> u64 {
    let digest = package::list(&root().unwrap())
        .unwrap()
        .into_iter()
        .find(|p| p.manifest.id == PROVIDER)
        .unwrap()
        .digest;
    backend::active_instance(PROVIDER, &digest)
        .expect("provider broker is live")
        .generation()
        .incarnation
}

/// Refuses to run outside a private te-service-native.* XDG profile or with
/// any real provider credential in the environment.
pub(super) fn require_private_fixture() {
    assert_eq!(
        std::env::var("TE_SERVICE_NATIVE_FIXTURE").as_deref(),
        Ok("1"),
        "set TE_SERVICE_NATIVE_FIXTURE=1 with private XDG roots under a te-service-native.* directory; run under xvfb-run -a dbus-run-session with --ignored --exact --test-threads=1"
    );
    let profile = PathBuf::from(std::env::var("XDG_CONFIG_HOME").unwrap());
    assert!(
        profile.ancestors().any(|dir| dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("te-service-native."))),
        "Never use the user profile"
    );
    for secret in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "ANTHROPIC_API_KEY",
    ] {
        assert!(std::env::var_os(secret).is_none(), "{secret} must be unset");
    }
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_second_consumer_status_timeout_transport_loss_and_reverse_correlation() {
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    super::super::initialize(app.handle().clone()).unwrap();
    let root = root().unwrap();
    fs::create_dir_all(&root).unwrap();
    let methods = json!([
        "describe",
        "prepare",
        "start",
        "status",
        "cancel",
        "acknowledge"
    ]);
    let dependency = json!([{"packageId":PROVIDER,"serviceId":"image-generation","major":1}]);
    package::write_index(
        &root,
        &[
            package(
                &root,
                PROVIDER,
                json!([{"id":"image-generation","major":1,"methods":methods}]),
                json!([]),
            ),
            package(&root, FIRST, json!([]), dependency.clone()),
            package(&root, SECOND, json!([]), dependency),
        ],
    )
    .unwrap();
    assert!(package::list(&root)
        .unwrap()
        .iter()
        .all(|p| p.manifest.id != "xnmp.trace-explorer"));
    let long = Duration::from_secs(30);

    // §14.2: a non-Trace consumer reaches Image Generation through the real
    // installed-host bridge; the provider sees that consumer's identity.
    let ids = send(
        FIRST,
        vec![(
            "host.services.describe",
            json!({"packageId":PROVIDER,"serviceId":"image-generation","major":1}),
        )],
    );
    assert_eq!(reply(FIRST, &ids[0], long)["result"]["available"], true);
    let first_start = send(FIRST, vec![invoke("start", start_request("first-op"))]);
    let second_start = send(SECOND, vec![invoke("start", start_request("second-op"))]);
    for (consumer, id) in [(FIRST, &first_start[0]), (SECOND, &second_start[0])] {
        assert_eq!(
            reply(consumer, id, long)["result"]["execution"]["state"],
            "running"
        );
    }
    let starts = provider_calls("start");
    assert_eq!(starts.len(), 2);
    let callers: Vec<_> = starts
        .iter()
        .map(|call| call["params"]["caller"]["packageId"].clone())
        .collect();
    assert!(callers.contains(&json!(FIRST)) && callers.contains(&json!(SECOND)));
    let store = super::super::service_host::store().unwrap();
    assert_eq!(store.claims().unwrap().len(), 2);

    // §21.3 #3: the first consumer's read-only status request times out. The
    // shared provider is not stopped, and the second consumer keeps working.
    let incarnation = provider_incarnation();
    fs::write(data(PROVIDER).join("hold-first-op"), b"hold").unwrap();
    let held = send(
        FIRST,
        vec![invoke("status", json!({"operationId":"first-op"}))],
    );
    let meanwhile = send(
        SECOND,
        vec![invoke("status", json!({"operationId":"second-op"}))],
    );
    assert_eq!(
        reply(SECOND, &meanwhile[0], Duration::from_secs(5))["result"]["execution"]["state"],
        "running",
        "a held status request delayed another consumer"
    );
    let timed_out = reply(FIRST, &held[0], long);
    assert!(timed_out["error"].is_object(), "{timed_out}");
    assert_eq!(
        provider_incarnation(),
        incarnation,
        "status timeout stopped the shared provider"
    );
    // The provider's late reply arrives after the host abandoned that call.
    fs::write(data(PROVIDER).join("release-first-op"), b"late").unwrap();
    let after = send(
        SECOND,
        vec![invoke("status", json!({"operationId":"second-op"}))],
    );
    assert_eq!(
        reply(SECOND, &after[0], long)["result"]["operationId"],
        "second-op"
    );
    assert!(provider_calls("cancel").is_empty());
    assert_eq!(provider_incarnation(), incarnation);
    assert_eq!(
        log(PROVIDER)
            .iter()
            .filter(|e| e["method"] == "initialize")
            .count(),
        1
    );
    let unchanged = store.get(FIRST, "first-op").unwrap().unwrap();
    assert!(!unchanged.needs_attention);

    // §21.3 #5: concurrent service, artifact, text and process reverse
    // requests with the consumer's ordinary service slots full.
    let source = data(FIRST).join("input.png");
    image::RgbaImage::from_pixel(2, 3, image::Rgba([1, 2, 3, 255]))
        .save(&source)
        .unwrap();
    let capture = (
        "host.artifacts.capture",
        json!({"operationId":"burst-capture","inputs":[{"path":source.to_string_lossy(),"expectedDigest":null}]}),
    );
    let mut burst: Vec<(&str, Value)> = (0..10)
        .map(|n| {
            invoke(
                "prepare",
                json!({"nonce":format!("nonce-{n}"),"delay":(10 - n) as f64 * 0.02}),
            )
        })
        .collect();
    burst.push(capture.clone());
    burst.push(invoke("status", json!({"operationId":"first-op"})));
    burst.push((
        "host.artifacts.read",
        json!({"operationId":"first-op","artifact":{"handle":"f".repeat(48),"sha256":"f".repeat(64),"byteLength":1,"mediaType":"image/png"}}),
    ));
    burst.push(("host.text.describe", json!({})));
    burst.push((
        "host.process.run",
        json!({"program":"/bin/sh","args":["-c","printf fixture"],"cwd":null,"env":[],"stdoutLimit":1024,"stderrLimit":1024}),
    ));
    let ids = send(FIRST, burst);
    let (prepares, rest) = ids.split_at(10);
    // Overflow beyond the caller's eight ordinary slots is refused promptly.
    for id in prepares[8..].iter().chain([&rest[0]]) {
        let refused = reply(FIRST, id, Duration::from_secs(5));
        assert_eq!(
            refused["error"]["data"]["code"], "capacity_reached",
            "{refused}"
        );
    }
    // Control, callback, text and process work is not starved meanwhile.
    let status = reply(FIRST, &rest[1], Duration::from_secs(5));
    assert_eq!(status["result"]["operationId"], "first-op");
    let read = reply(FIRST, &rest[2], Duration::from_secs(5));
    assert!(read["error"].is_object(), "{read}");
    let text = reply(FIRST, &rest[3], Duration::from_secs(10));
    assert!(text["result"]["configurationRevision"].is_u64(), "{text}");
    // The lib test harness cannot host the SDK 3 process-supervisor anchor,
    // so supervision setup fails before the leaf is spawned: a typed,
    // definite non-execution. Its reply is still routed to its own request
    // ID and nowhere else.
    let process = reply(FIRST, &rest[4], Duration::from_secs(10));
    assert_eq!(process["error"]["data"]["code"], "not_started", "{process}");
    // Bounded stdin is advertised at initialization and enforced before
    // admission; an unknown field is still refused.
    let initialize = log(FIRST)
        .into_iter()
        .find(|entry| entry["method"] == "initialize")
        .unwrap();
    assert_eq!(
        initialize["params"]["processStdin"],
        json!({"version":1,"maxBytes":256 * 1024}),
        "{initialize}"
    );
    let shell = |extra: Value| {
        let mut params = json!({"program":"/bin/sh","args":["-c","cat"],"cwd":null,"env":[],"stdoutLimit":1024,"stderrLimit":1024});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        ("host.process.run", params)
    };
    let stdin = send(
        FIRST,
        vec![
            shell(json!({"stdin":"x".repeat(256 * 1024 + 1)})),
            shell(json!({"stdin":"bounded"})),
            shell(json!({"stdinPath":"/etc/hostname"})),
        ],
    );
    for (id, code) in stdin
        .iter()
        .zip(["invalid_request", "not_started", "invalid_request"])
    {
        let refused = reply(FIRST, id, Duration::from_secs(10));
        assert_eq!(refused["error"]["data"]["code"], code, "{refused}");
    }
    assert!(
        prepares[..8].iter().all(|id| !has_reply(FIRST, id)),
        "held prepares replied early"
    );
    fs::write(data(PROVIDER).join("release-prepare"), b"go").unwrap();
    for (n, id) in prepares[..8].iter().enumerate() {
        assert_eq!(
            reply(FIRST, id, long)["result"]["nonce"],
            format!("nonce-{n}")
        );
    }
    let consumer = backend::active_instance(
        FIRST,
        &store
            .get(FIRST, "first-op")
            .unwrap()
            .unwrap()
            .consumer
            .digest,
    )
    .unwrap();
    wait_until("reverse permits to drain", long, || {
        consumer
            .reverse_pending
            .iter()
            .all(|lane| lane.load(Ordering::Acquire) == 0)
    });
    let captured = reply(FIRST, &send(FIRST, vec![capture])[0], long);
    assert_eq!(
        captured["result"]["inputs"][0]["sourcePath"],
        source.to_string_lossy().as_ref()
    );

    // §21.3 #3 transport loss: the provider dies with both consumers'
    // operations accepted. One recovery owner reconciles both by status.
    assert!(backend::call(PROVIDER, "fixture.exit", json!({})).is_err());
    wait_until(
        "recovery to reconcile both operations",
        Duration::from_secs(45),
        || {
            [(FIRST, "first-op"), (SECOND, "second-op")]
                .iter()
                .all(|(consumer, op)| {
                    store.get(consumer, op).unwrap().is_some_and(|a| {
                        a.phase == crate::service_state::model::AdmissionPhase::Terminal
                    })
                })
        },
    );
    let restarted: Vec<_> = log(PROVIDER)
        .into_iter()
        .skip_while(|e| e["method"] != "fixture.exit")
        .collect();
    let restarted_methods: Vec<_> = restarted
        .iter()
        .filter_map(|e| e["method"].as_str().filter(|m| m.starts_with("services.")))
        .collect();
    assert!(!restarted_methods.is_empty());
    assert!(
        restarted_methods.iter().all(|m| m.ends_with(".status")),
        "{restarted_methods:?}"
    );
    for op in ["first-op", "second-op"] {
        assert!(
            restarted
                .iter()
                .any(|e| e["params"]["request"]["operationId"] == op),
            "{op}"
        );
    }
    for (consumer, op) in [(FIRST, "first-op"), (SECOND, "second-op")] {
        let a = store.get(consumer, op).unwrap().unwrap();
        assert!(
            a.needs_attention,
            "unknown outcome is retained for attention"
        );
        assert_eq!(
            store.provider_receipt(consumer, op).unwrap().unwrap()["execution"]["state"],
            "unknown"
        );
    }
    assert_eq!(provider_calls("start").len(), 2);
    super::super::shutdown();
    drop(app);
}

// Reproduce the restart ordering with actual brokers, activation and status RPC.
// No transport port can short-circuit provider reconciliation in this fixture.
#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_startup_settlement_queries_retained_paid_output_before_recovery() {
    review_startup_output(false, false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_reopened_unknown_recovers_provider_raw_image_without_replay() {
    review_startup_output(true, false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_success_evidence_failure_keeps_querying_provider_for_repair() {
    review_startup_output(false, true);
}

fn review_startup_output(raw: bool, repair: bool) {
    use crate::service_state::{model::*, Store};
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    backend::initialize(app.handle().clone());
    let store = super::super::service_host::initialize(&config::config_dir().unwrap()).unwrap();
    backend::finish_initialize();
    let root = root().unwrap();
    let source = r#"#!/usr/bin/env python3
import json,sys,pathlib
root=pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1])
for line in sys.stdin:
 f=json.loads(line);m=f.get('method');p=f.get('params',{})
 if 'id' not in f: continue
 with open(root/'methods','a') as out: out.write(str(m)+'\n')
 if m=='initialize': r={'protocolVersion':1,'ready':False}
 elif m=='lifecycle.activate': r={'ready':True}
 elif m=='control.operationIdle': r={'idle':True}
 elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())
 else: r=None
 print(json.dumps({'jsonrpc':'2.0','id':f['id'],'result':r}),flush=True)
"#;
    let raw_source = REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "provider").replace(
        "  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())",
        r#"  elif m=='services.image-generation.v1.status':
   r=json.loads((root/'retained.json').read_text())
   if r['delivery']['state']=='unavailable':
    op=p['request']['operationId'];consumer=p['caller']['packageId']
    stage=rpc('host.artifacts.stage',{'consumerPackageId':consumer,'operationId':op})
    pathlib.Path(stage['path']).write_bytes((root/'raw.png').read_bytes())
    artifact=rpc('host.artifacts.seal',{'consumerPackageId':consumer,'operationId':op,'handle':stage['handle'],'mediaType':'image/png'})
    r['delivery']={'state':'available','output':artifact}
    (root/'retained.json').write_text(json.dumps(r))"#);
    let repair_source = REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "provider").replace(
        "  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())",
        r#"  elif m=='services.image-generation.v1.status':
   r=json.loads((root/'retained.json').read_text())
   marker=root/'success-observed'
   n=int(marker.read_text()) if marker.exists() else 0
   marker.write_text(str(n+1))
   if n==1:
    r['revision']=1;r['execution']={'state':'running'};r['delivery']={'state':'none'}
   elif n==2: r['execution']['metadata']['requestedModel']='conflicting-model'
   elif n in [3,4,5]: r=None
   elif n>=6:
    artifact=rpc('host.artifacts.seal',{'consumerPackageId':p['caller']['packageId'],'operationId':p['request']['operationId'],'handle':r['delivery']['output']['handle'],'mediaType':'image/png'})
    r['revision']=3;r['delivery']={'state':'available','output':artifact}
    (root/'retained.json').write_text(json.dumps(r))
"#);
    let p = package_from(
        &root,
        PROVIDER,
        if raw {
            &raw_source
        } else if repair {
            &repair_source
        } else {
            source
        },
        json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}]),
        json!([]),
    );
    package::write_index(&root, std::slice::from_ref(&p)).unwrap();
    let consumer = PackageGeneration {
        package_id: "fixture.broken-consumer".into(),
        digest: "a".repeat(64),
        incarnation: 1,
    };
    let provider = PackageGeneration {
        package_id: PROVIDER.into(),
        digest: p.digest.clone(),
        incarnation: 1,
    };
    let op = "startup-paid";
    let a = store
        .reserve(Admission {
            consumer: consumer.clone(),
            provider: provider.clone(),
            target: ServiceTarget {
                package_id: PROVIDER.into(),
                service_id: "image-generation".into(),
                major: 1,
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
    let base = json!({"version":1,"operationId":op,"requestFingerprint":a.fingerprint,"provider":{"packageId":PROVIDER,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"running"},"delivery":{"state":"none"}});
    super::reconcile_at(store, &provider, &a, &base).unwrap();
    let stage = store.stage(&provider, &consumer.package_id, op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    let output = if raw || repair {
        let bytes = fs::read(&stage.path).unwrap();
        fs::create_dir_all(data(PROVIDER)).unwrap();
        fs::write(data(PROVIDER).join("raw.png"), &bytes).unwrap();
        if raw {
            fs::remove_file(&stage.path).unwrap();
        }
        ArtifactDescriptor {
            handle: stage.handle.clone(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            byte_length: bytes.len() as u64,
            media_type: "image/png".into(),
        }
    } else {
        store
            .seal(
                &provider,
                &consumer.package_id,
                op,
                &stage.handle,
                "image/png",
            )
            .unwrap()
    };
    let mut success = base.clone();
    success["revision"] = json!(2);
    success["execution"] = json!({"state":"succeeded","metadata":{"adapter":"openai-images","endpointIdentity":"https://fixture.test/v1/images","requestedModel":null,"actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}});
    success["delivery"] = if raw {
        json!({"state":"unavailable","reason":"missing"})
    } else {
        json!({"state":"available","output":output})
    };
    fs::create_dir_all(data(PROVIDER)).unwrap();
    fs::write(
        data(PROVIDER).join("retained.json"),
        serde_json::to_vec(&success).unwrap(),
    )
    .unwrap();
    if raw {
        let mut unknown = base.clone();
        unknown["revision"] = json!(2);
        unknown["execution"] = json!({"state":"unknown","error":{"code":"interrupted","message":"Unconfirmed","correlationId":null}});
        super::reconcile_at(store, &provider, &a, &unknown).unwrap();
        store
            .auto_settle_operation(&consumer.package_id, op, true)
            .unwrap();
        assert!(store.auto_settlement_operations().unwrap().is_empty());
        store.revisit_uncertain_settlements().unwrap();
        success["revision"] = json!(3);
        fs::write(
            data(PROVIDER).join("retained.json"),
            serde_json::to_vec(&success).unwrap(),
        )
        .unwrap();
    }
    assert!(backend::active_instance(PROVIDER, &p.digest).is_none());
    // Settlement wins scheduling, before the startup recovery actor starts.
    super::super::ai_operations::auto_reconcile_in(
        store,
        &super::super::ai_operations::LiveAutomatic,
    )
    .unwrap();
    if repair {
        assert_eq!(
            store
                .provider_receipt(&consumer.package_id, op)
                .unwrap()
                .unwrap()["execution"]["state"],
            "running"
        );
        assert!(!store.execution_released(&consumer.package_id, op).unwrap());
        // Older replies, a conflicting success and three malformed answers
        // cannot erase a success whose artifact evidence failed to commit.
        for _ in 0..5 {
            super::super::ai_operations::auto_reconcile_in(
                store,
                &super::super::ai_operations::LiveAutomatic,
            )
            .unwrap();
            assert!(!store.execution_released(&consumer.package_id, op).unwrap());
        }
        // Querying continues past that exhausted answer budget, so the real
        // provider can seal the original artifact on its next status query.
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
    }
    let status = store
        .provider_receipt(&consumer.package_id, op)
        .unwrap()
        .unwrap();
    let stopped = store.execution_released(&consumer.package_id, op).unwrap();
    backend::shutdown();
    assert_eq!(
        status["execution"]["state"], "succeeded",
        "absent broker hid the retained paid result"
    );
    assert!(!stopped);
    assert_eq!(
        store.get(&consumer.package_id, op).unwrap().unwrap().output,
        Some(output)
    );
    let methods = fs::read_to_string(data(PROVIDER).join("methods")).unwrap();
    assert!(methods.contains("services.image-generation.v1.status"));
    if repair {
        assert_eq!(
            methods
                .lines()
                .filter(|m| *m == "services.image-generation.v1.status")
                .count(),
            7
        );
    }
    assert!(!methods.contains(".start"));
    assert!(!methods.contains(".cancel"));
    // Durable reopening does not exclude the original handoff.
    let reopened = Store::open(
        config::config_dir().unwrap().join("service-state"),
        Limits::default(),
    )
    .unwrap();
    assert_eq!(reopened.auto_settlement_operations().unwrap().len(), 1);
}

const REVIEW_RECOVERY_BACKEND: &str = r#"#!/usr/bin/env python3
import json,sys,pathlib,threading,os
root=pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1]);ROLE='%ROLE%'
condition=threading.Condition();replies={};output_lock=threading.Lock();sequence=0
TARGET={'packageId':'xnmp.image-generation','serviceId':'image-generation','major':1}
def send(v):
 with output_lock: print(json.dumps(v),flush=True)
def rpc(method,params):
 global sequence
 with condition: sequence+=1;rid='host:'+str(sequence)
 send({'jsonrpc':'2.0','id':rid,'method':method,'params':params})
 with condition:
  if not condition.wait_for(lambda:rid in replies,timeout=10): raise RuntimeError('host timeout '+method)
  reply=replies.pop(rid)
 if 'error' in reply: raise RuntimeError(str(reply['error']))
 return reply['result']
def invoke(method,params): return rpc('host.services.invoke',dict(TARGET,method=method,params=params))
def handle(f):
 m=f['method'];p=f.get('params') or {};op=p.get('operationId');r=None
 with output_lock:
  with open(root/'methods','a') as log: log.write(m+'\n')
 try:
  if m=='initialize': r={'protocolVersion':1,'ready':False}
  elif m=='lifecycle.activate': r={'ready':ROLE!='broken'}
  elif m=='lifecycle.quiesce': r={'ready':False,'idle':True,'checkpoint':True}
  elif m=='control.operationIdle': r={'idle':True}
  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())
  elif m=='services.image-generation.v1.acknowledge':
   r=json.loads((root/'retained.json').read_text());r['revision']+=1
   r['delivery']={'state':'acquired','transferReceipt':p['request']['transferReceipt']}
   (root/'retained.json').write_text(json.dumps(r))
  elif m=='jobs.status':
   state=root/('delivered-'+op+'.json')
   if state.exists(): r=json.loads(state.read_text())
   elif (root/'binding.json').exists(): r=dict(json.loads((root/'binding.json').read_text()),revision=1,status='running',recoveryState='running',workerActive=False)
  elif m=='jobs.start':
   (root/'binding.json').write_text(json.dumps({'jobId':p['jobId'],'operationId':p['operationId']}));r=p['jobId']
  elif m=='jobs.resumeOperation':
   if ROLE=='delivery-fails': raise RuntimeError('local delivery failed')
   receipt=invoke('status',{'operationId':op});artifact=receipt['delivery']['output']
   original=rpc('host.artifacts.read',{'operationId':op,'artifact':artifact})
   target=root/('generated-'+op+'.png');target.write_bytes(pathlib.Path(original['path']).read_bytes())
   proof=rpc('host.artifacts.acquired',{'operationId':op,'artifact':artifact,'evidencePath':str(target)})['transferReceipt']
   ack=invoke('acknowledge',{'operationId':op,'outputSha256':artifact['sha256'],'disposition':'acquired','transferReceipt':proof})
   assert ack['delivery']['state']=='acquired'
   binding=json.loads((root/'binding.json').read_text())
   r=dict(binding,revision=2,status='succeeded',recoveryState='succeeded',workerActive=False,outputPath=str(target),runId=7)
   (root/('delivered-'+op+'.json')).write_text(json.dumps(r))
   send({'jsonrpc':'2.0','method':'event','params':{'name':'openai-image-complete','payload':r}})
  send({'jsonrpc':'2.0','id':f['id'],'result':r})
 except Exception as error: send({'jsonrpc':'2.0','id':f['id'],'error':{'code':-32000,'message':str(error)}})
for line in sys.stdin:
 f=json.loads(line)
 if 'method' in f: threading.Thread(target=handle,args=(f,),daemon=True).start()
 else:
  with condition: replies[f['id']]=f;condition.notify_all()
"#;

fn review_archive(root: &Path, p: &package::Installed) -> PathBuf {
    use std::io::Write;
    let path = root
        .parent()
        .unwrap()
        .join(format!("{}.teplugin", p.digest));
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    serde_json::to_writer(&mut zip, &p.manifest).unwrap();
    for name in p.manifest.files.keys() {
        zip.start_file(name, options).unwrap();
        zip.write_all(&fs::read(root.join("payloads").join(&p.digest).join(name)).unwrap())
            .unwrap();
    }
    zip.finish().unwrap();
    path
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_compatible_provider_upgrade_recovers_host_spool_after_quiesce_refusal() {
    review_host_spool_upgrade(true, false, false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_compatible_consumer_upgrade_recovers_host_spool() {
    review_host_spool_upgrade(false, false, false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_compatible_provider_upgrade_recovers_bound_host_success_after_lost_reply() {
    review_host_spool_upgrade(true, true, false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_compatible_consumer_upgrade_recovers_bound_host_success_after_lost_reply() {
    review_host_spool_upgrade(false, true, false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_unbound_host_success_delivers_after_exhausted_status_outage_without_restart() {
    review_host_spool_upgrade(false, true, true);
}

fn review_host_spool_upgrade(
    upgrade_provider: bool,
    initially_unknown: bool,
    unbound_outage: bool,
) {
    use crate::service_state::{job::*, model::*, Store};
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    backend::initialize(app.handle().clone());
    let config = config::config_dir().unwrap();
    let store = super::super::service_host::initialize(&config).unwrap();
    backend::finish_initialize();
    let root = root().unwrap();
    let id = "fixture.host-spool-consumer";
    let services =
        json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}]);
    let deps =
        json!([{"packageId":PROVIDER,"serviceId":"image-generation","major":1,"optional":true}]);
    let provider_source = REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "provider").replace(
        "  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())",
        r#"  elif m=='services.image-generation.v1.status':
   if (root/'fail-status').exists(): raise RuntimeError('original status publisher unavailable')
   r=json.loads((root/'retained.json').read_text())
   if r['delivery']['state'] in ('unavailable','none'):
    op=p['request']['operationId'];consumer=p['caller']['packageId']
    stage=rpc('host.artifacts.stage',{'consumerPackageId':consumer,'operationId':op})
    completed=rpc('host.process.recover',{'requestId':'host:fixture-completed','consumerPackageId':consumer,'operationId':op})
    assert completed['status']==0
    original=pathlib.Path(completed['stdout'])
    pathlib.Path(stage['path']).write_bytes(original.read_bytes())
    artifact=rpc('host.artifacts.seal',{'consumerPackageId':consumer,'operationId':op,'handle':stage['handle'],'mediaType':'image/png'})
    r['revision']+=1;r['execution']=json.loads((root/'original-success-execution').read_text());r['delivery']={'state':'available','output':artifact}
    (root/'retained.json').write_text(json.dumps(r))
    send({'jsonrpc':'2.0','method':'host.process.release','params':{'handle':completed['handle']}})"#,
    ).replace(
        "  elif m=='lifecycle.quiesce': r={'ready':False,'idle':True,'checkpoint':True}",
        "  elif m=='lifecycle.quiesce':\n   r=rpc('host.artifacts.stage',{'consumerPackageId':'fixture.host-spool-consumer','operationId':'host-spool-paid'})",
    );
    let provider_source = if unbound_outage {
        provider_source.replace(
            "{'requestId':'host:fixture-completed','consumerPackageId':consumer,'operationId':op}",
            "{'requestId':'host:fixture-completed','owner':json.loads((root/'original-host-owner').read_text())}",
        )
    } else {
        provider_source
    };
    let provider = package_from(
        &root,
        PROVIDER,
        &provider_source,
        services.clone(),
        json!([]),
    );
    let consumer = package_from(
        &root,
        id,
        &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "fixed"),
        json!([]),
        deps.clone(),
    );
    package::write_index(&root, &[provider.clone(), consumer.clone()]).unwrap();
    let p = backend::ensure(PROVIDER).unwrap().generation();
    let c = backend::ensure(id).unwrap().generation();
    let op = "host-spool-paid";
    let admission = store
        .reserve(Admission {
            consumer: c.clone(),
            provider: p.clone(),
            target: ServiceTarget {
                package_id: PROVIDER.into(),
                service_id: "image-generation".into(),
                major: 1,
            },
            operation_id: op.into(),
            fingerprint: "d".repeat(64),
            phase: AdmissionPhase::Reserved,
            inputs: vec![],
            output: None,
            needs_attention: false,
            disposition: None,
            transfer_receipt: None,
        })
        .unwrap();
    store.claim_forwarding(&c, op).unwrap();
    store.accepted(&p, id, op).unwrap();
    let job = store
        .register_job(JobRecord {
            job_key: "d".repeat(48),
            owner: c.clone(),
            operation_id: op.into(),
            job_id: (1 << 51) | 63,
            kind: "openai-image".into(),
            label: "AI image".into(),
            origin_window: "main.fixture".into(),
            revision: 0,
            source_revision: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            settled_at_ms: None,
            estimate_key: None,
            state: JobState::Accepting,
            phase: None,
            output_path: None,
            run_id: None,
            error: None,
        })
        .unwrap();
    let mut original = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .write_to(&mut original, image::ImageFormat::Png)
        .unwrap();
    let original = original.into_inner();
    let spool = backend::fixture_completed_bound_process_spool(
        PROVIDER,
        &original,
        (!unbound_outage).then_some((id, op)),
    )
    .unwrap();
    fs::write(
        data(PROVIDER).join("original-host-spool"),
        spool.to_string_lossy().as_bytes(),
    )
    .unwrap();
    fs::write(
        data(PROVIDER).join("original-host-owner"),
        serde_json::to_vec(&p).unwrap(),
    )
    .unwrap();
    fs::write(
        data(id).join("binding.json"),
        serde_json::to_vec(&json!({"jobId":job.job_id,"operationId":op})).unwrap(),
    )
    .unwrap();
    let success = json!({"version":1,"operationId":op,"requestFingerprint":admission.fingerprint,"provider":{"packageId":PROVIDER,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"succeeded","metadata":{"adapter":"openai-images","endpointIdentity":"fixture","requestedModel":null,"actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}},"delivery":{"state":"unavailable","reason":"storage_unavailable"}});
    fs::write(
        data(PROVIDER).join("original-success-execution"),
        serde_json::to_vec(&success["execution"]).unwrap(),
    )
    .unwrap();
    let success = if initially_unknown {
        let mut unknown = success.clone();
        unknown["execution"] = json!({"state":"unknown","error":{"code":"interrupted","message":"Original CLI reply was lost","correlationId":null}});
        unknown["delivery"] = json!({"state":"none"});
        unknown
    } else {
        success
    };
    fs::write(
        data(PROVIDER).join("retained.json"),
        serde_json::to_vec(&success).unwrap(),
    )
    .unwrap();
    super::reconcile_at(store, &p, &admission, &success).unwrap();
    if initially_unknown && !unbound_outage {
        assert!(
            store.auto_settle_operation(id, op, true).is_err(),
            "provider Unknown cannot settle a known completed original host execution"
        );
    }
    if unbound_outage {
        assert!(store.has_unbound_host_output(&p).unwrap());
        assert!(!store.has_bound_host_output(id, op).unwrap());
        fs::write(data(PROVIDER).join("fail-status"), []).unwrap();
        for _ in 0..6 {
            super::super::ai_operations::auto_reconcile_in(
                store,
                &super::super::ai_operations::LiveAutomatic,
            )
            .unwrap();
        }
        assert!(store.execution_released(id, op).unwrap());
        assert!(store.claims().unwrap().is_empty());
        assert!(store.job(&job.job_key).unwrap().unwrap().state.terminal());
        assert_eq!(
            store.auto_settlement_operations().unwrap().len(),
            1,
            "an unbound original reply disappeared behind the stopped-job dismissal"
        );
        assert_eq!(fs::read(&spool).unwrap(), original);
        assert!(
            fs::read_to_string(data(PROVIDER).join("methods"))
                .unwrap()
                .lines()
                .filter(|method| *method == "services.image-generation.v1.status")
                .count()
                >= 6,
            "unbound original replies require status probes after the uncertainty budget"
        );
        fs::remove_file(data(PROVIDER).join("fail-status")).unwrap();
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
        wait_until(
            "healthy provider delivers journalled unbound reply",
            Duration::from_secs(20),
            || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
        );
        let completed = store.job(&job.job_key).unwrap().unwrap();
        assert_eq!(fs::read(completed.output_path.unwrap()).unwrap(), original);
        assert_eq!(
            store.get(id, op).unwrap().unwrap().disposition.as_deref(),
            Some("acquired")
        );
        for package in [id, PROVIDER] {
            assert!(
                !fs::read_to_string(data(package).join("methods"))
                    .unwrap()
                    .lines()
                    .any(|method| method.ends_with(".start")),
                "outage recovery repeated paid work"
            );
        }
        backend::shutdown();
        return;
    }
    let replacement = if upgrade_provider {
        package_from(
            &root,
            PROVIDER,
            &format!("{provider_source}\n# compatible replacement"),
            services,
            json!([]),
        )
    } else {
        package_from(
            &root,
            id,
            &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "fixed-after-upgrade"),
            json!([]),
            deps,
        )
    };
    let profile = super::super::lifecycle::Profile { root: &root, store };
    super::super::lifecycle::upgrade(
        &profile,
        &review_archive(&root, &replacement),
        &backend::preflight_candidate,
    )
    .unwrap();
    assert!(
        spool.exists(),
        "compatible retirement deleted the sole complete original output"
    );
    assert_eq!(fs::read(&spool).unwrap(), original);
    if upgrade_provider {
        // SDK reverse request counters can reset in the replacement. Its
        // unrelated completed output must not replace original custody.
        backend::fixture_completed_process_spool(PROVIDER, b"unrelated replacement output")
            .unwrap();
    }
    let reopened = Store::open(config.join("service-state"), Limits::default()).unwrap();
    assert_eq!(reopened.get(id, op).unwrap().unwrap().provider, p);
    assert_eq!(
        reopened
            .host_spool_result_for_owner(PROVIDER, "host:fixture-completed", Some(&p))
            .unwrap()
            .unwrap()["stdout"],
        spool.to_string_lossy().as_ref()
    );
    super::super::ai_operations::auto_reconcile_in(
        store,
        &super::super::ai_operations::LiveAutomatic,
    )
    .unwrap();
    wait_until(
        "replacement delivery of complete host-spooled output",
        Duration::from_secs(20),
        || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
    );
    let completed = store.job(&job.job_key).unwrap().unwrap();
    assert_eq!(fs::read(completed.output_path.unwrap()).unwrap(), original);
    assert_eq!(
        store.get(id, op).unwrap().unwrap().disposition.as_deref(),
        Some("acquired")
    );
    for package in [id, PROVIDER] {
        assert!(
            !fs::read_to_string(data(package).join("methods"))
                .unwrap()
                .lines()
                .any(|m| m.ends_with(".start")),
            "replacement replayed paid execution"
        );
    }
    backend::shutdown();
    drop(app);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_compatible_upgrade_delivers_original_success_through_real_reverse_rpc() {
    review_consumer_upgrade("broken", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_incompatible_consumer_upgrade_releases_original_success_once() {
    review_consumer_upgrade("broken", true);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_incompatible_provider_upgrade_releases_original_success_once() {
    review_consumer_upgrade("provider-repair", true);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_sealed_unpublished_output_recovers_after_status_outage_without_restart() {
    review_consumer_upgrade("sealed-status-outage", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_compatible_provider_upgrade_delivers_sealed_unpublished_output() {
    review_consumer_upgrade("sealed-status-upgrade", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_live_failed_delivery_does_not_pin_consumer_job_ownership() {
    review_consumer_upgrade("delivery-fails", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_legacy_stopped_job_delivers_authoritative_success() {
    review_consumer_upgrade("legacy-stopped", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_broken_provider_upgrade_recovers_original_success() {
    review_consumer_upgrade("provider-repair", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_failed_late_publication_survives_provider_upgrade_without_replay() {
    review_consumer_upgrade("late-provider-repair", false);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_storage_full_survives_recovery_budget_and_delivers_after_release() {
    review_consumer_upgrade("quota-recovery", false);
}

fn review_consumer_upgrade(old_role: &str, incompatible_upgrade: bool) {
    use crate::service_state::{job::*, model::*};
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    backend::initialize(app.handle().clone());
    let store = super::super::service_host::initialize(&config::config_dir().unwrap()).unwrap();
    backend::finish_initialize();
    let root = root().unwrap();
    let id = "fixture.repair-consumer";
    let provider_repair = matches!(old_role, "provider-repair" | "late-provider-repair");
    let late = old_role == "late-provider-repair";
    let quota = old_role == "quota-recovery";
    let sealed_upgrade = old_role == "sealed-status-upgrade";
    let sealed_outage = matches!(old_role, "sealed-status-outage" | "sealed-status-upgrade");
    let deps = json!([{"packageId":PROVIDER,"serviceId":"image-generation","major":1,"optional":provider_repair}]);
    let provider_source = REVIEW_RECOVERY_BACKEND.replace(
        "%ROLE%",
        if provider_repair {
            "broken"
        } else {
            "provider"
        },
    );
    let provider_source = if sealed_outage {
        provider_source.replace(
            "  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())",
            "  elif m=='services.image-generation.v1.status':\n   if (root/'fail-status').exists(): raise RuntimeError('status publisher unavailable')\n   r=json.loads((root/'retained.json').read_text())",
        )
    } else if quota {
        provider_source.replace(
        "  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())",
        r#"  elif m=='services.image-generation.v1.status':
   r=json.loads((root/'retained.json').read_text());op=p['request']['operationId'];consumer=p['caller']['packageId']
   if r['delivery']['state']=='unavailable':
    stage=rpc('host.artifacts.stage',{'consumerPackageId':consumer,'operationId':op})
    pathlib.Path(stage['path']).write_bytes((root/'raw.png').read_bytes())
    artifact=rpc('host.artifacts.seal',{'consumerPackageId':consumer,'operationId':op,'handle':stage['handle'],'mediaType':'image/png'})
    r['delivery']={'state':'available','output':artifact};(root/'retained.json').write_text(json.dumps(r))"#)
    } else {
        provider_source
    };
    let p = package_from(
        &root,
        PROVIDER,
        &provider_source,
        json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}]),
        json!([]),
    );
    let old = package_from(
        &root,
        id,
        &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", if sealed_outage { "fixed" } else { old_role }),
        json!([]),
        deps.clone(),
    );
    package::write_index(&root, &[p.clone(), old.clone()]).unwrap();
    let consumer = PackageGeneration {
        package_id: id.into(),
        digest: old.digest.clone(),
        incarnation: 1,
    };
    let provider = PackageGeneration {
        package_id: PROVIDER.into(),
        digest: p.digest.clone(),
        incarnation: 1,
    };
    let (consumer, job) = if old_role == "delivery-fails" {
        let job_id = backend::call(id, "jobs.start", json!({"kind":"openai-image"}))
            .unwrap()
            .as_u64()
            .unwrap();
        let job = store
            .snapshot_jobs()
            .unwrap()
            .jobs
            .into_iter()
            .find(|j| j.job_id == job_id)
            .unwrap();
        assert!(backend::ensure(id).unwrap().owns_job(job_id));
        (job.owner.clone(), job)
    } else {
        let job = store
            .register_job(JobRecord {
                job_key: "e".repeat(48),
                owner: consumer.clone(),
                operation_id: "consumer-repair-paid".into(),
                job_id: (1 << 51) | 41,
                kind: "openai-image".into(),
                label: "AI image".into(),
                origin_window: "main.fixture".into(),
                revision: 0,
                source_revision: 0,
                created_at_ms: 1,
                updated_at_ms: 1,
                settled_at_ms: None,
                estimate_key: None,
                state: JobState::Accepting,
                phase: None,
                output_path: None,
                run_id: None,
                error: None,
            })
            .unwrap();
        (consumer, job)
    };
    let op = job.operation_id.as_str();
    let a = store
        .reserve(Admission {
            consumer: consumer.clone(),
            provider: provider.clone(),
            target: ServiceTarget {
                package_id: PROVIDER.into(),
                service_id: "image-generation".into(),
                major: 1,
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
    let stage = store.stage(&provider, id, op).unwrap();
    image::RgbaImage::from_pixel(2, 3, image::Rgba([12, 34, 56, 255]))
        .save_with_format(&stage.path, image::ImageFormat::Png)
        .unwrap();
    let artifact = if late || quota {
        let bytes = fs::read(&stage.path).unwrap();
        ArtifactDescriptor {
            handle: stage.handle.clone(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            byte_length: bytes.len() as u64,
            media_type: "image/png".into(),
        }
    } else {
        store
            .seal(&provider, id, op, &stage.handle, "image/png")
            .unwrap()
    };
    let success = json!({"version":1,"operationId":op,"requestFingerprint":a.fingerprint,"provider":{"packageId":PROVIDER,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"succeeded","metadata":{"adapter":"openai-images","endpointIdentity":"fixture","requestedModel":null,"actualModel":null,"externalRequestId":null,"threadId":null,"options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"low","background":"auto"},"remoteChargeUncertain":false}},"delivery":{"state":"available","output":artifact}});
    let mut success = success;
    if late || quota {
        // Model late original bytes arriving after an empty Unknown was fenced.
        // A currently retained original is no longer eligible for settlement.
        let original_bytes = fs::read(&stage.path).unwrap();
        fs::remove_file(&stage.path).unwrap();
        let mut unknown = success.clone();
        unknown["execution"] = json!({"state":"unknown","error":{"code":"interrupted","message":"Unconfirmed","correlationId":null}});
        unknown["delivery"] = json!({"state":"none"});
        super::reconcile_at(store, &provider, &a, &unknown).unwrap();
        store.auto_settle_operation(id, op, true).unwrap();
        assert!(store.auto_settlement_operations().unwrap().is_empty());
        fs::write(&stage.path, original_bytes).unwrap();
        success["revision"] = json!(2);
        if late {
            assert!(
                super::reconcile_at(store, &provider, &a, &success).is_err(),
                "unsealed original must fail publication"
            );
            assert_eq!(
                store.auto_settlement_operations().unwrap().len(),
                1,
                "failed publication must remain discoverable"
            );
        } else {
            store.revisit_uncertain_settlements().unwrap();
        }
    } else if sealed_outage {
        let mut running = success.clone();
        running["execution"] = json!({"state":"running"});
        running["delivery"] = json!({"state":"none"});
        super::reconcile_at(store, &provider, &a, &running).unwrap();
        success["revision"] = json!(2);
    } else {
        super::reconcile_at(store, &provider, &a, &success).unwrap();
    }
    if old_role == "legacy-stopped" {
        store
            .update_job(
                &job.owner,
                &job.job_key,
                JobState::NeedsAttention,
                Some("stopped".into()),
                None,
                None,
                Some("Automatic recovery stopped".into()),
            )
            .unwrap();
    }
    if quota {
        success["delivery"] = json!({"state":"unavailable","reason":"storage_unavailable"});
    }
    fs::create_dir_all(data(PROVIDER)).unwrap();
    fs::write(
        data(PROVIDER).join("retained.json"),
        serde_json::to_vec(&success).unwrap(),
    )
    .unwrap();
    fs::create_dir_all(data(id)).unwrap();
    fs::write(
        data(id).join("binding.json"),
        serde_json::to_vec(&json!({"jobId":job.job_id,"operationId":op})).unwrap(),
    )
    .unwrap();
    if sealed_outage {
        fs::write(data(PROVIDER).join("fail-status"), b"").unwrap();
        for _ in 0..6 {
            super::super::ai_operations::auto_reconcile_in(
                store,
                &super::super::ai_operations::LiveAutomatic,
            )
            .unwrap();
        }
        assert_eq!(store.dismissed_revision(id, op).unwrap(), None);
        assert_eq!(store.auto_settlement_operations().unwrap().len(), 1);
        assert!(!store.job(&job.job_key).unwrap().unwrap().state.terminal());
        assert!(
            fs::read_to_string(data(PROVIDER).join("methods"))
                .unwrap()
                .lines()
                .filter(|m| *m == "services.image-generation.v1.status")
                .count()
                >= 6,
            "retained output retries beyond the uncertainty budget"
        );
        fs::remove_file(data(PROVIDER).join("fail-status")).unwrap();
        if sealed_upgrade {
            let replacement = package_from(
                &root,
                PROVIDER,
                &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "fixed-provider"),
                json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}]),
                json!([]),
            );
            let profile = super::super::lifecycle::Profile { root: &root, store };
            let upgraded = super::super::lifecycle::upgrade(
                &profile,
                &review_archive(&root, &replacement),
                &backend::preflight_candidate,
            )
            .expect("compatible replacement must recover unpublished sealed output");
            assert_ne!(upgraded.digest, p.digest);
        }
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
        wait_until(
            "healthy status delivers retained original",
            Duration::from_secs(15),
            || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
        );
        let completed = store.job(&job.job_key).unwrap().unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(
                fs::read(completed.output_path.unwrap()).unwrap()
            )),
            artifact.sha256
        );
        assert_eq!(
            store.get(id, op).unwrap().unwrap().disposition.as_deref(),
            Some("acquired")
        );
        for package in [id, PROVIDER] {
            assert!(!fs::read_to_string(data(package).join("methods"))
                .unwrap()
                .contains(".start"));
        }
        backend::shutdown();
        return;
    }
    if quota {
        fs::write(
            data(PROVIDER).join("raw.png"),
            fs::read(&stage.path).unwrap(),
        )
        .unwrap();
        let capacity_provider = PackageGeneration {
            package_id: "fixture.capacity-provider".into(),
            digest: "f".repeat(64),
            incarnation: 1,
        };
        let mut capacity_workers = Vec::new();
        for i in 0..20 {
            let c = PackageGeneration {
                package_id: format!("fixture.capacity-{i}"),
                ..consumer.clone()
            };
            // These reservations represent live admitted recovery work. A
            // succeeded/missing row with no worker is now correctly reclaimed
            // by the same sweep and cannot be used to manufacture a full disk.
            capacity_workers.push(backend::CallLease::acquire(&c.package_id).unwrap());
            let occupied = store
                .reserve(Admission {
                    consumer: c.clone(),
                    provider: capacity_provider.clone(),
                    target: ServiceTarget {
                        package_id: capacity_provider.package_id.clone(),
                        ..a.target.clone()
                    },
                    operation_id: "capacity".into(),
                    ..a.clone()
                })
                .unwrap();
            store.claim_forwarding(&c, "capacity").unwrap();
            let mut receipt = success.clone();
            receipt["operationId"] = json!("capacity");
            receipt["provider"]["packageId"] = json!(capacity_provider.package_id);
            receipt["delivery"] = json!({"state":"unavailable","reason":"missing"});
            super::reconcile_at(store, &capacity_provider, &occupied, &receipt).unwrap();
        }
        for _ in 0..6 {
            super::super::ai_operations::auto_reconcile_in(
                store,
                &super::super::ai_operations::LiveAutomatic,
            )
            .unwrap();
            assert_eq!(
                store.job(&job.job_key).unwrap().unwrap().phase.as_deref(),
                Some("storage_full")
            );
            assert!(
                store
                    .auto_settlement_operations()
                    .unwrap()
                    .iter()
                    .any(|(a, _, _)| a.consumer.package_id == id && a.operation_id == op),
                "quota failure must not exhaust recovery or re-hide Unknown"
            );
        }
        store
            .release(
                &capacity_provider,
                "fixture.capacity-0",
                "capacity",
                "discarded",
                None,
            )
            .unwrap();
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
        wait_until(
            "capacity release delivers original output",
            Duration::from_secs(15),
            || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
        );
        let completed = store.job(&job.job_key).unwrap().unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(
                fs::read(completed.output_path.unwrap()).unwrap()
            )),
            artifact.sha256
        );
        let methods = fs::read_to_string(data(PROVIDER).join("methods")).unwrap();
        assert!(
            methods
                .lines()
                .filter(|m| *m == "services.image-generation.v1.status")
                .count()
                >= 7
        );
        assert!(!methods.contains(".start"));
        drop(capacity_workers);
        backend::shutdown();
        return;
    }
    if provider_repair {
        let profile = super::super::lifecycle::Profile { root: &root, store };
        if incompatible_upgrade {
            let incompatible = package_from(
                &root,
                PROVIDER,
                &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "incompatible-provider"),
                json!([{"id":"image-generation","major":2,"methods":["status","cancel","acknowledge"]}]),
                json!([]),
            );
            super::super::lifecycle::upgrade(
                &profile,
                &review_archive(&root, &incompatible),
                &backend::preflight_candidate,
            )
            .expect("broken provider must be repairable");
            super::super::ai_operations::auto_reconcile_in(
                store,
                &super::super::ai_operations::LiveAutomatic,
            )
            .unwrap();
            assert_ne!(
                store.job(&job.job_key).unwrap().unwrap().state,
                JobState::Completed,
                "incompatible provider must not acquire original recovery authority"
            );
            assert_incompatible_upgrade_released(store, id, op, &job, &artifact, PROVIDER);
            backend::shutdown();
            return;
        }
        let source=REVIEW_RECOVERY_BACKEND.replace("%ROLE%","fixed-provider").replace(
            "  elif m=='services.image-generation.v1.status': r=json.loads((root/'retained.json').read_text())",
            r#"  elif m=='services.image-generation.v1.status':
   r=json.loads((root/'retained.json').read_text())
   artifact=rpc('host.artifacts.seal',{'consumerPackageId':p['caller']['packageId'],'operationId':p['request']['operationId'],'handle':r['delivery']['output']['handle'],'mediaType':'image/png'})
   assert artifact==r['delivery']['output']"#);
        let next = package_from(
            &root,
            PROVIDER,
            &source,
            json!([{"id":"image-generation","major":1,"methods":["status","cancel","acknowledge"]}]),
            json!([]),
        );
        let upgraded = super::super::lifecycle::upgrade(
            &profile,
            &review_archive(&root, &next),
            &backend::preflight_candidate,
        )
        .unwrap();
        assert_ne!(upgraded.digest, p.digest);
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
        wait_until(
            "upgraded provider delivery",
            Duration::from_secs(15),
            || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
        );
        let completed = store.job(&job.job_key).unwrap().unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(
                fs::read(completed.output_path.unwrap()).unwrap()
            )),
            artifact.sha256
        );
        assert_eq!(
            store.get(id, op).unwrap().unwrap().disposition.as_deref(),
            Some("acquired")
        );
        for package in [id, PROVIDER] {
            let methods = fs::read_to_string(data(package).join("methods")).unwrap();
            assert!(
                !methods.contains(".start"),
                "original operation must not be replayed"
            );
        }
        backend::shutdown();
        return;
    }
    // Original consumer activation fails; automatic passes keep success/bytes.
    super::super::ai_operations::auto_reconcile_in(
        store,
        &super::super::ai_operations::LiveAutomatic,
    )
    .unwrap();
    if old_role == "legacy-stopped" {
        wait_until(
            "legacy stopped job delivery",
            Duration::from_secs(3),
            || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
        );
        let finished = store.job(&job.job_key).unwrap().unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(
                fs::read(finished.output_path.unwrap()).unwrap()
            )),
            artifact.sha256
        );
        assert_eq!(
            store.get(id, op).unwrap().unwrap().disposition.as_deref(),
            Some("acquired")
        );
        backend::shutdown();
        return;
    }
    assert_eq!(
        store.get(id, op).unwrap().unwrap().output,
        Some(artifact.clone())
    );
    assert_eq!(
        store.get(id, op).unwrap().unwrap().phase,
        AdmissionPhase::Terminal
    );
    // Same release version, different package digest: capability negotiation,
    // rather than version comparison, must permit local handoff.
    let profile = super::super::lifecycle::Profile { root: &root, store };
    if incompatible_upgrade {
        let resume_count = fs::read_to_string(data(id).join("methods"))
            .unwrap()
            .lines()
            .filter(|m| *m == "jobs.resumeOperation")
            .count();
        let incompatible = package_from(
            &root,
            id,
            &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "incompatible"),
            json!([]),
            json!([{"packageId":PROVIDER,"serviceId":"image-generation","major":2,"optional":true}]),
        );
        super::super::lifecycle::upgrade(
            &profile,
            &review_archive(&root, &incompatible),
            &backend::preflight_candidate,
        )
        .unwrap();
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
        assert_incompatible_upgrade_released(store, id, op, &job, &artifact, id);
        assert_eq!(
            fs::read_to_string(data(id).join("methods"))
                .unwrap()
                .lines()
                .filter(|m| *m == "jobs.resumeOperation")
                .count(),
            resume_count,
            "incompatible feature must not resume recovery"
        );
        backend::shutdown();
        return;
    }
    let next = package_from(
        &root,
        id,
        &REVIEW_RECOVERY_BACKEND.replace("%ROLE%", "fixed"),
        json!([]),
        deps,
    );
    let archive = review_archive(&root, &next);
    let profile = super::super::lifecycle::Profile { root: &root, store };
    let upgraded =
        super::super::lifecycle::upgrade(&profile, &archive, &backend::preflight_candidate)
            .expect("failed original consumer must be repairable");
    assert_ne!(upgraded.digest, old.digest);
    super::super::ai_operations::auto_reconcile_in(
        store,
        &super::super::ai_operations::LiveAutomatic,
    )
    .unwrap();
    wait_until(
        "upgraded consumer delivery",
        Duration::from_secs(15),
        || store.job(&job.job_key).unwrap().unwrap().state == JobState::Completed,
    );
    let finished = store.job(&job.job_key).unwrap().unwrap();
    let generated = fs::read(finished.output_path.unwrap()).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&generated)), artifact.sha256);
    assert_eq!(
        store.get(id, op).unwrap().unwrap().disposition.as_deref(),
        Some("acquired")
    );
    for package_id in [PROVIDER, id] {
        let methods = fs::read_to_string(data(package_id).join("methods")).unwrap();
        assert!(!methods.contains("services.image-generation.v1.start"));
        assert_eq!(
            methods.lines().filter(|m| *m == "jobs.start").count(),
            usize::from(package_id == id && old_role == "delivery-fails")
        );
    }
    backend::shutdown();
}

fn assert_incompatible_upgrade_released(
    store: &crate::service_state::Store,
    consumer: &str,
    op: &str,
    job: &crate::service_state::job::JobRecord,
    artifact: &crate::service_state::model::ArtifactDescriptor,
    removed: &str,
) {
    use crate::service_state::{job::JobState, model::AdmissionPhase};
    let admission = store.get(consumer, op).unwrap().unwrap();
    assert_eq!(admission.phase, AdmissionPhase::Released);
    assert_eq!(admission.disposition.as_deref(), Some("discarded"));
    let notice = store.job(&job.job_key).unwrap().unwrap();
    assert_eq!(notice.state, JobState::Error);
    assert_eq!(notice.phase.as_deref(), Some("consumer_removed"));
    assert!(notice.error.as_deref().unwrap().contains(removed));
    assert!(
        store.abandon_package_outputs(removed).unwrap().is_empty(),
        "report once"
    );
    let private = config::config_dir().unwrap().join("service-state");
    assert!(!private
        .join("bytes")
        .join(format!("{}.bin", artifact.handle))
        .exists());
    assert!(!private
        .join("stages")
        .join(format!("{}.png", artifact.handle))
        .exists());
    let reopened =
        crate::service_state::Store::open(private, crate::service_state::model::Limits::default())
            .unwrap();
    assert!(reopened
        .abandon_package_outputs(removed)
        .unwrap()
        .is_empty());
    assert_eq!(reopened.job(&job.job_key).unwrap().unwrap(), notice);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_review_uncertain_settlement_bounds_real_status_failures_and_timeouts() {
    use crate::service_state::model::*;
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    backend::initialize(app.handle().clone());
    let store = super::super::service_host::initialize(&config::config_dir().unwrap()).unwrap();
    backend::finish_initialize();
    let root = root().unwrap();
    for (case, answer) in [
        ("malformed", "r=None"),
        ("timeout", "import time;time.sleep(2);r=None"),
        ("activation", "r=None"),
        ("death", "os._exit(3)"),
    ] {
        backend::retire(PROVIDER);
        let source = REVIEW_RECOVERY_BACKEND
            .replace(
                "%ROLE%",
                if case == "activation" {
                    "broken"
                } else {
                    "provider"
                },
            )
            .replace("r=json.loads((root/'retained.json').read_text())", answer);
        let p = package_from(
            &root,
            PROVIDER,
            &source,
            json!([{"id":"image-generation","major":1,"methods":["status"]}]),
            json!([]),
        );
        package::write_index(&root, std::slice::from_ref(&p)).unwrap();
        let consumer = PackageGeneration {
            package_id: format!("fixture.retry-{case}"),
            digest: "a".repeat(64),
            incarnation: 1,
        };
        let provider = PackageGeneration {
            package_id: PROVIDER.into(),
            digest: p.digest.clone(),
            incarnation: 1,
        };
        let op = format!("bounded-{case}");
        let a = store
            .reserve(Admission {
                consumer: consumer.clone(),
                provider: provider.clone(),
                target: ServiceTarget {
                    package_id: PROVIDER.into(),
                    service_id: "image-generation".into(),
                    major: 1,
                },
                operation_id: op.clone(),
                fingerprint: "c".repeat(64),
                phase: AdmissionPhase::Reserved,
                inputs: vec![],
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            })
            .unwrap();
        store.claim_forwarding(&consumer, &op).unwrap();
        let receipt = json!({"version":1,"operationId":op,"requestFingerprint":a.fingerprint,"provider":{"packageId":PROVIDER,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"running"},"delivery":{"state":"none"}});
        super::reconcile_at(store, &provider, &a, &receipt).unwrap();
        if case != "activation" {
            backend::ensure(PROVIDER).unwrap();
        }
        let before = fs::read_to_string(data(PROVIDER).join("methods")).unwrap_or_default();
        for n in 0..3 {
            // Activation failure joins the real dead process tree. Only the
            // status-timeout case intentionally exhausts a tiny RPC budget.
            let budget = if case == "timeout" {
                Duration::from_millis(200)
            } else {
                Duration::from_secs(5)
            };
            crate::native_deadline::scoped(Instant::now() + budget, || {
                super::super::ai_operations::auto_reconcile_in(
                    store,
                    &super::super::ai_operations::LiveAutomatic,
                )
                .unwrap();
            });
            if case == "timeout" {
                let methods = fs::read_to_string(data(PROVIDER).join("methods")).unwrap();
                assert_eq!(
                    methods[before.len()..]
                        .lines()
                        .filter(|m| *m == "services.image-generation.v1.status")
                        .count(),
                    n + 1,
                    "timeout did not reach the provider on pass {n}"
                );
            }
            if n < 2 {
                assert!(
                    !store.execution_released(&consumer.package_id, &op).unwrap(),
                    "settled before bounded recovery attempts: {case}"
                );
            }
        }
        // A timeout's last pass has no budget left for committing settlement.
        // The next pass owns fresh idle proof without waiting for a fourth RPC.
        super::super::ai_operations::auto_reconcile_in(
            store,
            &super::super::ai_operations::LiveAutomatic,
        )
        .unwrap();
        assert!(
            store.execution_released(&consumer.package_id, &op).unwrap(),
            "unanswerable provider stranded capacity: {case}"
        );
        let methods = fs::read_to_string(data(PROVIDER).join("methods")).unwrap();
        let calls = methods[before.len()..].lines().collect::<Vec<_>>();
        let expected = if case == "activation" {
            "lifecycle.activate"
        } else {
            "services.image-generation.v1.status"
        };
        assert_eq!(
            calls.iter().filter(|m| **m == expected).count(),
            3,
            "unbounded provider attempts: {case}"
        );
        if case == "timeout" {
            assert_eq!(
                calls
                    .iter()
                    .filter(|m| **m == "control.operationIdle")
                    .count(),
                4,
                "fresh timeout settlement skipped its own inactivity proof"
            );
        }
        assert!(!calls
            .iter()
            .any(|m| m.ends_with(".start") || m.ends_with(".cancel")));
        assert!(store
            .provider_receipt(&consumer.package_id, &op)
            .unwrap()
            .is_some());
    }
    backend::shutdown();
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_service_admission_before_disable_cannot_start_after_reenable() {
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    super::super::initialize(app.handle().clone()).unwrap();
    let root = root().unwrap();
    fs::create_dir_all(&root).unwrap();
    let provider = package(
        &root,
        PROVIDER,
        json!([{"id":"image-generation","major":1,"methods":["describe","prepare","start","status","cancel","acknowledge"]}]),
        json!([]),
    );
    let consumer = package(
        &root,
        FIRST,
        json!([]),
        json!([{"packageId":PROVIDER,"serviceId":"image-generation","major":1,"optional":true}]),
    );
    package::write_index(&root, &[provider.clone(), consumer]).unwrap();
    let consumer = backend::ensure(FIRST).unwrap();
    let request = super::Invocation {
        package_id: PROVIDER.into(),
        service_id: "image-generation".into(),
        major: 1,
        method: "start".into(),
        params: start_request("late-service-admission"),
    };
    // This is the production invoke boundary after routing and lease
    // acquisition, before ensure. The provider has no Broker yet.
    let lease = {
        let _gate = super::super::read_lifecycle().unwrap();
        backend::CallLease::acquire_lane(PROVIDER, false).unwrap()
    };
    let store = super::super::service_host::store().unwrap();
    let profile = super::super::lifecycle::Profile { root: &root, store };
    super::super::lifecycle::set_enabled(&profile, PROVIDER, false).unwrap();
    assert!(
        package::list(&root)
            .unwrap()
            .iter()
            .find(|entry| entry.manifest.id == FIRST)
            .unwrap()
            .enabled
    );
    assert!(consumer.can_recover());
    super::super::lifecycle::set_enabled(&profile, PROVIDER, true).unwrap();
    let result = super::invoke_admitted(&consumer, request, &provider, &lease);
    let paid_starts = provider_calls("start");
    backend::shutdown();
    assert!(
        result.is_err(),
        "cancelled service admission reached replacement provider: result={result:?}, paid_starts={paid_starts:?}"
    );
    assert!(
        paid_starts.is_empty(),
        "cancelled admission dispatched paid start"
    );
    assert!(
        store
            .get(FIRST, "late-service-admission")
            .unwrap()
            .is_none(),
        "cancelled admission created new durable work"
    );
}
