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
    // so the owned process reports the uncertainty-preserving interruption.
    // Its reply is still routed to its own request ID and nowhere else.
    let process = reply(FIRST, &rest[4], Duration::from_secs(10));
    assert_eq!(process["error"]["data"]["code"], "interrupted", "{process}");
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
