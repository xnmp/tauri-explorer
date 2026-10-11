//! §14.3 caller death while the provider is live, with real processes: the
//! actual Wry handle, production brokers, recovery actor and job reconciler,
//! and two fake SDK 3 packages. A Trace stand-in consumer registers its host
//! progress job through `jobs.start` and starts an image operation through
//! the installed-host service bridge; the Image Generation stand-in holds the
//! operation running. The consumer process is then SIGKILLed. Each gate order
//! runs its own operation: the provider succeeds before it observes the
//! host's cancel, then (on the restarted consumer) the provider confirms the
//! cancel before its held work could succeed. Run only with a private XDG
//! profile under Xvfb and TE_SERVICE_NATIVE_FIXTURE=1, like `native_tests`.
use super::super::{backend, job_bridge, package, root, service_host};
use super::native_tests::{
    data, log, package_from, require_private_fixture, start_request, wait_until, PROVIDER,
};
use crate::service_state::{
    job::{JobRecord, JobState},
    model::{AdmissionPhase, ArtifactDescriptor},
    Store,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Listener;

const CONSUMER: &str = "fixture.trace-consumer";
const LONG: Duration = Duration::from_secs(30);

/// Shared by both roles: concurrent request handling, a durable method log
/// and blocking reverse requests correlated by ID.
const PRELUDE: &str = r#"#!/usr/bin/env python3
import json,sys,pathlib,threading,time,os
root=pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1])
out=threading.Lock()
cond=threading.Condition()
replies={}
sequence=[0]
def send(v):
    with out:
        sys.stdout.write(json.dumps(v)+'\n'); sys.stdout.flush()
def log(entry):
    entry['pid']=os.getpid()
    with out:
        with open(root/'log.jsonl','a') as f:
            f.write(json.dumps(entry)+'\n'); f.flush(); os.fsync(f.fileno())
def put(path,value):
    tmp=path.with_name(path.name+'.tmp'); tmp.write_text(json.dumps(value)); os.replace(tmp,path)
def rpc(method,params,limit=60):
    with cond:
        sequence[0]+=1; rid='host:%s:%d:%d'%(ROLE,os.getpid(),sequence[0])
    send({'jsonrpc':'2.0','id':rid,'method':method,'params':params})
    end=time.time()+limit
    with cond:
        while rid not in replies:
            left=end-time.time()
            if left<=0: raise TimeoutError(method)
            cond.wait(left)
        return replies.pop(rid)
def result_of(reply,what):
    if 'result' not in reply: raise RuntimeError('%s: %s'%(what,json.dumps(reply.get('error'))))
    return reply['result']
def wait_file(name):
    end=time.time()+90
    while not (root/name).exists():
        if time.time()>end: raise TimeoutError(name)
        time.sleep(.01)
def guarded(work,*args):
    try: work(*args)
    except Exception as cause: log({'event':'worker-error','error':repr(cause)})
def serve(handle):
    for line in sys.stdin:
        f=json.loads(line)
        if 'method' in f: threading.Thread(target=handle,args=(f,),daemon=True).start()
        else:
            with cond:
                replies[f['id']]=f; cond.notify_all()
"#;

/// The provider holds every `status`/`cancel` for an operation until
/// `release-<op>` exists, and its work until `complete-<op>` exists. Work
/// that finds the operation cancelled abandons it without sealing output.
const PROVIDER_BODY: &str = r#"
ROLE='provider'
PROVIDER={'packageId':'xnmp.image-generation','serviceId':'image-generation','major':1}
METADATA={'adapter':'openai-images','endpointIdentity':'fixture','requestedModel':None,'actualModel':None,'externalRequestId':None,'threadId':None,'options':{'size':'1024x1024','resolution':None,'aspectRatio':None,'quality':'low','background':'auto'},'remoteChargeUncertain':False}
ops={}
lock=threading.Lock()
def receipt(op):
    s=ops[op]
    base={'version':1,'operationId':op,'requestFingerprint':s['fingerprint'],'provider':PROVIDER,'revision':s['revision']}
    if s['state']=='running': return dict(base,execution={'state':'running'},delivery={'state':'none'})
    if s['state']=='cancelled': return dict(base,execution={'state':'cancelled'},delivery={'state':'none'})
    done={'state':'succeeded','metadata':METADATA}
    if s['state']=='succeeded': return dict(base,execution=done,delivery={'state':'available','output':s['output']})
    return dict(base,execution=done,delivery={'state':'acquired','transferReceipt':s['transfer']})
def work(op,consumer):
    wait_file('complete-'+op)
    with lock: live=ops[op]['state']=='running'
    if not live:
        log({'event':'abandoned','operationId':op}); return
    stage=result_of(rpc('host.artifacts.stage',{'consumerPackageId':consumer,'operationId':op}),'stage')
    with open(stage['path'],'wb') as f:
        f.write((root/'output.png').read_bytes()); f.flush(); os.fsync(f.fileno())
    sealed=result_of(rpc('host.artifacts.seal',{'consumerPackageId':consumer,'operationId':op,'handle':stage['handle'],'mediaType':'image/png'}),'seal')
    with lock:
        if ops[op]['state']=='running': ops[op].update(state='succeeded',revision=2,output=sealed)
    log({'event':'sealed','operationId':op})
def handle(f):
    method=f['method']; params=f.get('params') or {}; fid=f.get('id')
    request=params.get('request') or {}
    op=request.get('operationId')
    log({'method':method,'operationId':op,'caller':params.get('caller')})
    result=None
    if method=='initialize': result={'protocolVersion':1,'ready':False}
    elif method=='lifecycle.activate': result={'ready':True}
    elif method=='services.image-generation.v1.start':
        with lock:
            ops[op]={'fingerprint':request['effectiveRecipeDigest'],'state':'running','revision':1}
            result=receipt(op)
        threading.Thread(target=guarded,args=(work,op,params['caller']['packageId']),daemon=True).start()
    elif method in ('services.image-generation.v1.status','services.image-generation.v1.cancel'):
        wait_file('release-'+op)
        with lock:
            if method.endswith('.cancel') and ops[op]['state']=='running': ops[op].update(state='cancelled',revision=2)
            result=receipt(op)
    elif method=='services.image-generation.v1.acknowledge':
        with lock:
            s=ops[op]
            if s['state']=='succeeded' and request.get('disposition')=='acquired' and request.get('outputSha256')==s['output']['sha256']:
                s.update(state='acquired',revision=3,transfer=request['transferReceipt'])
            result=receipt(op)
    if fid is not None: send({'jsonrpc':'2.0','id':fid,'result':result})
serve(handle)
"#;

/// Plays Trace's consumer role: a durable per-operation link answering
/// `jobs.status`, the sole provider start, and on restart a recovery worker
/// that adopts the provider's outcome (read, local copy, `acquired`,
/// `acknowledge`) and announces the terminal event. Unlike Trace, which
/// resumes with status, a restarted incarnation first replays its recorded
/// start: the host must answer it from the original operation, never by
/// forwarding a second paid start.
const CONSUMER_BODY: &str = r#"
ROLE='consumer'
TARGET={'packageId':'xnmp.image-generation','serviceId':'image-generation','major':1}
state=threading.Lock()
put(root/'consumer.pid',os.getpid())
def path(op): return root/'ops'/(op+'.json')
def save(op,**changes):
    with state:
        s=json.loads(path(op).read_text()); s.update(changes); s['revision']+=1
        put(path(op),s)
        return s
def snapshot(op):
    if not path(op).exists(): return None
    s=json.loads(path(op).read_text())
    return {'jobId':s['jobId'],'runId':s['runId'],'operationId':op,'revision':s['revision'],'status':s['status'],'recoveryState':s['phase'],'outputPath':s.get('outputPath'),'error':s.get('error'),'providerExecution':s.get('execution')}
def invoke(method,params): return rpc('host.services.invoke',dict(TARGET,method=method,params=params))
def emit(name,payload): send({'jsonrpc':'2.0','method':'event','params':{'name':name,'payload':payload}})
def dispatch(op,request):
    receipt=result_of(invoke('start',request),'start')
    save(op,phase='running',execution=receipt['execution'])
def handoff(op,output):
    read=result_of(rpc('host.artifacts.read',{'operationId':op,'artifact':output}),'read')
    target=os.path.join(os.path.realpath(root),'generated-'+op+'.png')
    with open(read['path'],'rb') as source, open(target,'wb') as copy:
        copy.write(source.read()); copy.flush(); os.fsync(copy.fileno())
    proof=result_of(rpc('host.artifacts.acquired',{'operationId':op,'artifact':output,'evidencePath':target}),'acquired')['transferReceipt']
    ack=result_of(invoke('acknowledge',{'operationId':op,'outputSha256':output['sha256'],'disposition':'acquired','transferReceipt':proof}),'acknowledge')
    if ack['delivery']['state']!='acquired': raise RuntimeError('acknowledgement pending')
    s=save(op,status='succeeded',phase='succeeded',execution=ack['execution'],outputPath=target)
    emit('openai-image-complete',{'jobId':s['jobId'],'runId':s['runId'],'outputPath':target,'operationId':op})
def recover(op):
    request=json.loads(path(op).read_text())['request']
    for _ in range(100):
        reply=invoke('start',request)
        if 'result' in reply: break
        log({'event':'recovery-error','operationId':op,'error':reply.get('error')}); time.sleep(.1)
    log({'event':'replayed-start','operationId':op,'answered':'result' in reply})
    while True:
        if 'result' in reply:
            r=reply['result']; execution=r['execution']['state']
            if execution not in ('accepted','running'): break
        else: log({'event':'recovery-error','operationId':op,'error':reply.get('error')})
        time.sleep(.1)
        reply=invoke('status',{'operationId':op})
    if execution=='succeeded' and r['delivery']['state']=='available':
        handoff(op,r['delivery']['output'])
    elif execution in ('cancelled','failed'):
        error='Provider cancelled image generation' if execution=='cancelled' else r['execution']['error']['message']
        s=save(op,status=execution,phase=execution,execution=r['execution'],error=error)
        emit('openai-image-error',{'jobId':s['jobId'],'runId':s['runId'],'error':error,'operationId':op})
    else:
        save(op,status='uncertain',phase='needs_attention',execution=r['execution'],error='Provider outcome requires recovery')
def handle(f):
    method=f['method']; params=f.get('params') or {}; fid=f.get('id')
    log({'method':method,'operationId':params.get('operationId')})
    result=None
    if method=='initialize': result={'protocolVersion':1,'ready':False}
    elif method=='lifecycle.activate':
        result={'ready':True}
        (root/'ops').mkdir(exist_ok=True)
        for link in sorted((root/'ops').glob('*.json')):
            if json.loads(link.read_text())['status']=='running':
                threading.Thread(target=guarded,args=(recover,link.stem),daemon=True).start()
    elif method=='jobs.start':
        op=params['operationId']
        request=dict(params['request'],operationId=op)
        (root/'ops').mkdir(exist_ok=True)
        with state:
            run=len(list((root/'ops').glob('*.json')))+1
            put(path(op),{'jobId':params['jobId'],'runId':run,'status':'running','phase':'forwarding','revision':1,'request':request})
        threading.Thread(target=guarded,args=(dispatch,op,request),daemon=True).start()
        result={'jobId':params['jobId']}
    elif method=='jobs.status': result=snapshot(params['operationId'])
    if fid is not None: send({'jsonrpc':'2.0','id':fid,'result':result})
serve(handle)
"#;

#[derive(Clone, Copy, Debug, PartialEq)]
enum GateOrder {
    SuccessBeforeCancel,
    CancelBeforeSuccess,
}
/// Every `plugin-jobs:changed` record for one job, in emission order.
fn job_events(events: &Mutex<Vec<Value>>, key: &str) -> Vec<Value> {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "updated" && e["job"]["jobKey"] == key)
        .map(|e| e["job"].clone())
        .collect()
}
fn terminal(state: &Value) -> bool {
    matches!(
        state.as_str(),
        Some("completed" | "error" | "cancelled" | "discarded")
    )
}
fn provider_requests(op: &str, verb: &str) -> Vec<Value> {
    log(PROVIDER)
        .into_iter()
        .filter(|e| {
            e["method"] == format!("services.image-generation.v1.{verb}") && e["operationId"] == op
        })
        .collect()
}
fn provider_event(op: &str, event: &str) -> bool {
    log(PROVIDER)
        .iter()
        .any(|e| e["event"] == event && e["operationId"] == op)
}
fn consumer_pid() -> Option<i64> {
    fs::read_to_string(data(CONSUMER).join("consumer.pid"))
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
}
fn job(store: &Store, key: &str) -> JobRecord {
    store.job(key).unwrap().expect("job is retained")
}

/// Starts one job, kills its consumer while the provider holds the work,
/// drives `order`'s gates and returns the settled job.
fn kill_during_execution(store: &Store, events: &Mutex<Vec<Value>>, order: GateOrder) -> JobRecord {
    let accepted = backend::call(
        CONSUMER,
        "jobs.start",
        json!({"kind":"openai-image","request":start_request("assigned-by-host")}),
    )
    .unwrap();
    let registered = store
        .snapshot_jobs()
        .unwrap()
        .jobs
        .into_iter()
        .find(|j| Some(j.job_id) == accepted["jobId"].as_u64())
        .expect("the host registered the progress job");
    let (op, key) = (registered.operation_id.clone(), registered.job_key.clone());
    wait_until("provider acceptance", LONG, || {
        store
            .get(CONSUMER, &op)
            .unwrap()
            .is_some_and(|a| a.phase == AdmissionPhase::Accepted)
    });
    wait_until("the running job", LONG, || {
        job(store, &key).state == JobState::Running
    });

    let dead = registered.owner.incarnation;
    let pid = consumer_pid().unwrap();
    let before = job_events(events, &key).len();
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
    // The host's recovery cancels the dead incarnation's live work; the
    // provider holds that cancel.
    wait_until("the host cancel to reach the provider", LONG, || {
        provider_requests(&op, "cancel")
            .iter()
            .any(|c| c["caller"]["incarnation"] == dead)
    });
    // The broker published the death before handing recovery the claim: no
    // generic backend-death failure, only recovery.
    let presented = job_events(events, &key).split_off(before);
    assert!(
        !job(store, &key).state.terminal() && presented.iter().all(|j| !terminal(&j["state"])),
        "{order:?}: consumer death failed the job while the provider still runs: {presented:?}"
    );
    // The job reconciler restarts the consumer, whose replayed start reaches
    // the provider only as a held status of the original operation.
    wait_until("the restarted consumer", LONG, || {
        consumer_pid().is_some_and(|current| current != pid)
    });
    let restarted = consumer_pid().unwrap();
    wait_until("the restarted consumer's held status", LONG, || {
        provider_requests(&op, "status")
            .iter()
            .any(|c| c["caller"]["incarnation"] != dead)
    });
    // Two status polls of the new incarnation: the first reconcile cycle
    // against it has completed and published its observation.
    wait_until(
        "two reconciler polls of the restarted consumer",
        LONG,
        || {
            log(CONSUMER)
                .iter()
                .filter(|e| e["method"] == "jobs.status" && e["pid"] == restarted)
                .count()
                >= 2
        },
    );
    let held = job(store, &key);
    assert!(
        matches!(held.state, JobState::Recovering | JobState::Running),
        "{order:?}: consumer death made the job {held:?} while the provider still runs"
    );
    let after_kill = job_events(events, &key).split_off(before);
    assert!(
        after_kill.iter().any(|j| j["state"] == "recovering"),
        "{order:?}: death was not presented as recovery: {after_kill:?}"
    );
    assert!(
        after_kill.iter().all(|j| !terminal(&j["state"])),
        "{order:?}: a terminal job event preceded the provider outcome: {after_kill:?}"
    );
    let claim = store.get(CONSUMER, &op).unwrap().unwrap();
    assert_eq!(claim.phase, AdmissionPhase::Accepted, "{order:?}");
    assert!(!claim.needs_attention, "{order:?}");

    let gate = |name: &str| fs::write(data(PROVIDER).join(format!("{name}-{op}")), b"go").unwrap();
    match order {
        GateOrder::SuccessBeforeCancel => {
            gate("complete");
            wait_until("provider success", LONG, || provider_event(&op, "sealed"));
            assert!(
                !job(store, &key).state.terminal(),
                "the job settled before the provider's outcome was observed"
            );
            gate("release");
        }
        GateOrder::CancelBeforeSuccess => {
            gate("release");
            wait_until("the cancelled job", LONG, || {
                job(store, &key).state.terminal()
            });
            gate("complete");
            wait_until("the provider to abandon cancelled work", LONG, || {
                provider_event(&op, "abandoned")
            });
        }
    }
    wait_until("the terminal job", LONG, || {
        job(store, &key).state.terminal()
    });
    // The restarted consumer's replayed start was answered from the original
    // operation (the provider log's single start is asserted by the caller).
    assert!(
        log(CONSUMER).iter().any(|e| e["event"] == "replayed-start"
            && e["operationId"] == op.as_str()
            && e["answered"] == true),
        "{order:?}: the restarted consumer's replayed start was not answered"
    );
    wait_until("the provider handoff release", LONG, || {
        store
            .get(CONSUMER, &op)
            .unwrap()
            .is_some_and(|a| a.phase == AdmissionPhase::Released)
    });
    job(store, &key)
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_consumer_kill_while_provider_runs_settles_each_gate_order_once() {
    require_private_fixture();
    let app = tauri::Builder::<tauri::Wry>::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    // What the frontend consumes: host job events, plus any raw plugin
    // outcome event that would bypass the durable job.
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let raw = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let events = events.clone();
        app.listen_any("plugin-jobs:changed", move |event| {
            events
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        for name in ["openai-image-error", "openai-image-complete"] {
            let raw = raw.clone();
            app.listen_any(name, move |event| {
                raw.lock().unwrap().push(event.payload().to_owned());
            });
        }
    }
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
    package::write_index(
        &root,
        &[
            package_from(
                &root,
                PROVIDER,
                &format!("{PRELUDE}{PROVIDER_BODY}"),
                json!([{"id":"image-generation","major":1,"methods":methods}]),
                json!([]),
            ),
            package_from(
                &root,
                CONSUMER,
                &format!("{PRELUDE}{CONSUMER_BODY}"),
                json!([]),
                json!([{"packageId":PROVIDER,"serviceId":"image-generation","major":1}]),
            ),
        ],
    )
    .unwrap();
    fs::create_dir_all(data(PROVIDER)).unwrap();
    let mut png = Vec::new();
    image::RgbaImage::from_pixel(4, 4, image::Rgba([9, 8, 7, 255]))
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    fs::write(data(PROVIDER).join("output.png"), &png).unwrap();
    let store = service_host::store().unwrap();

    let won = kill_during_execution(store, &events, GateOrder::SuccessBeforeCancel);
    let cancelled = kill_during_execution(store, &events, GateOrder::CancelBeforeSuccess);

    // Truthful outcomes: the success is adopted, the confirmed cancel is a
    // cancellation, and neither is presented as a failure.
    assert_eq!(won.state, JobState::Completed, "{won:?}");
    assert_eq!(cancelled.state, JobState::Cancelled, "{cancelled:?}");
    let copy = won
        .output_path
        .clone()
        .expect("completed job names its image");
    let receipt = store
        .provider_receipt(CONSUMER, &won.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt["delivery"]["state"], "acquired");
    assert_eq!(
        store
            .provider_receipt(CONSUMER, &cancelled.operation_id)
            .unwrap()
            .unwrap()["execution"]["state"],
        "cancelled"
    );
    assert!(!provider_event(&cancelled.operation_id, "sealed"));

    let jobs = job_bridge::snapshot("main").unwrap()["jobs"]
        .as_array()
        .unwrap()
        .clone();
    for settled in [&won, &cancelled] {
        let op = &settled.operation_id;
        let presented: Vec<_> = job_events(&events, &settled.job_key)
            .iter()
            .map(|j| format!("{}@{}", j["state"], j["revision"]))
            .collect();
        let reached: Vec<_> = log(PROVIDER)
            .iter()
            .filter(|e| e["operationId"] == op.as_str())
            .map(|e| {
                format!(
                    "{}{}",
                    e["method"].as_str().or(e["event"].as_str()).unwrap_or("?"),
                    e["caller"]["incarnation"]
                        .as_u64()
                        .map(|i| format!("<-{i}"))
                        .unwrap_or_default()
                )
            })
            .collect();
        eprintln!("consumer-kill: {op} job {presented:?}; provider {reached:?}");
        // One provider invocation per operation, across both incarnations.
        assert_eq!(provider_requests(op, "start").len(), 1, "{op}");
        // One visible job for the operation.
        assert_eq!(
            jobs.iter().filter(|j| j["operationId"] == *op).count(),
            1,
            "{jobs:?}"
        );
        // One authoritative terminal event: every terminal emission carries
        // the same job revision and outcome; no failure was ever presented.
        let history = job_events(&events, &settled.job_key);
        assert!(
            history.iter().all(|j| j["state"] != "error"),
            "{op}: {presented:?}"
        );
        let mut outcomes: Vec<_> = history
            .iter()
            .filter(|j| terminal(&j["state"]))
            .map(|j| (j["revision"].as_u64().unwrap(), j["state"].clone()))
            .collect();
        outcomes.dedup();
        assert_eq!(
            outcomes,
            [(settled.revision, json!(settled.state))],
            "{op}: {presented:?}"
        );
    }
    assert!(raw.lock().unwrap().is_empty(), "{:?}", raw.lock().unwrap());

    // §14.3 lease: the provider handoff released the host's redundant
    // artifact once the restarted consumer acquired and acknowledged it.
    // Nothing Trace-local (a later user Save/Discard of its temporary image)
    // has happened, and none is needed for the release. The consumer's copy is
    // the exact sealed output; the host no longer retains or serves it.
    let released = store.get(CONSUMER, &won.operation_id).unwrap().unwrap();
    assert_eq!(released.disposition.as_deref(), Some("acquired"));
    let output: ArtifactDescriptor = released.output.clone().unwrap();
    assert_eq!(
        hex::encode(Sha256::digest(fs::read(&copy).unwrap())),
        output.sha256
    );
    assert!(store
        .read(&won.owner, CONSUMER, &won.operation_id, &output)
        .is_err());
    assert_eq!(
        store
            .get(CONSUMER, &cancelled.operation_id)
            .unwrap()
            .unwrap()
            .disposition
            .as_deref(),
        Some("discarded")
    );
    assert!(store.claims().unwrap().is_empty());
    assert!(!store.busy(PROVIDER).unwrap());
    super::super::shutdown();
    drop(app);
}
