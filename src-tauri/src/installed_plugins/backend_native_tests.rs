//! Actual Wry handle and production broker IO, isolated in a dedicated process.
//! Run only with private XDG roots + Xvfb and TE_LIFECYCLE_NATIVE_FIXTURE=1.
use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;
/// Mirrors the job reconciler's sleep in job_bridge::initialize.
pub(super) const JOB_POLL_INTERVAL: Duration = Duration::from_secs(2);

fn candidate(root: &Path, id: &str, behavior: &str) -> package::Installed {
    let source = format!(
        r#"#!/usr/bin/env python3
import json,sys,pathlib,time,subprocess
root=pathlib.Path(sys.argv[sys.argv.index('--data-dir')+1])
behavior={behavior:?}
def send(v): print(json.dumps(v),flush=True)
for line in sys.stdin:
 f=json.loads(line);method=f.get('method');params=f.get('params',{{}})
 if method=='initialize':
  if params.get('validationOnly'):
   (root/'history.sqlite').write_bytes(b'candidate validation only')
   for n,method in enumerate(['host.process.run','host.text.generate','host.credentials.resolve','host.artifacts.gc','host.services.invoke']):
    send({{'jsonrpc':'2.0','id':'host:probe'+str(n),'method':method,'params':{{}}}})
    result=json.loads(sys.stdin.readline())
    assert result['error']['data']['code']=='preflight_not_active',result
   send({{'jsonrpc':'2.0','method':'event','params':{{'name':'preflight-must-stay-private','payload':{{'changed':True}}}}}})
   if behavior in ['held','shutdown']:
    (root/'held').write_text('ready')
    while not (root/'release').exists(): time.sleep(.01)
   send({{'jsonrpc':'2.0','id':f['id'],'result':{{'protocolVersion':2 if behavior=='reject' else 1,'ready':False}}}})
  else:
   send({{'jsonrpc':'2.0','id':f['id'],'result':{{'protocolVersion':1,'ready':True}}}})
 elif method=='provenance.begin': send({{'jsonrpc':'2.0','id':f['id'],'result':{{'id':1}}}})
 elif method=='ping': send({{'jsonrpc':'2.0','id':f['id'],'result':{{'behavior':behavior}}}})
 else: send({{'jsonrpc':'2.0','id':f['id'],'result':{{'ready':True}}}})
"#
    );
    let mut installed = payload(root, &source);
    installed.manifest.id = id.into();
    installed.manifest.contributions = vec![id.into()];
    installed
}
/// Publish an executable worker as an enabled package payload. The caller owns
/// any manifest field beyond the SDK 2 defaults written here.
pub(in crate::installed_plugins) fn payload(root: &Path, source: &str) -> package::Installed {
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
        "formatVersion":1,"id":"fixture.payload","name":"native fixture","description":"private production-broker fixture",
        "version":"1.0.0","sdkVersion":2,"svelteVersion":"5.56.3","target":target,"frontend":"index.js",
        "styles":"index.css","backend":"worker","contributions":["fixture.payload"],"stateFiles":["history.sqlite"],"files":declarations
    }})).unwrap()
}
pub(super) fn wait_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        path.exists(),
        "Candidate did not enter held validation: {}",
        path.display()
    );
}
#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_private_preflight_retirement_and_shutdown() {
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
    use tauri::Listener;
    let candidate_events = Arc::new(AtomicUsize::new(0));
    let observed_events = candidate_events.clone();
    app.listen("preflight-must-stay-private", move |_| {
        observed_events.fetch_add(1, Ordering::AcqRel);
    });
    super::super::initialize(app.handle().clone()).unwrap();
    let root = root().unwrap();
    fs::create_dir_all(&root).unwrap();
    let original = candidate(&root, "fixture.lifecycle", "original");
    let mut unrelated = candidate(&root, "fixture.unrelated", "unrelated");
    unrelated.manifest.provenance = true;
    package::write_index(&root, &[original.clone(), unrelated]).unwrap();
    let data = config::config_dir()
        .unwrap()
        .join("plugin-data/fixture.lifecycle");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("history.sqlite"), b"original database").unwrap();
    ensure("fixture.lifecycle").unwrap();
    assert_eq!(
        ensure("fixture.unrelated")
            .unwrap()
            .call("ping", json!({}))
            .unwrap()["behavior"],
        "unrelated"
    );
    let held = candidate(&root, "fixture.lifecycle", "held");
    let held_root = root.clone();
    let install = std::thread::spawn(move || {
        let _mutation = super::super::MUTATIONS
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        let fence = super::super::drain_idle("fixture.lifecycle").unwrap();
        fence.quiesce().unwrap();
        super::super::lifecycle::install(&held_root, held, &fence)
    });
    let validation = root.join("upgrade-pending/validation");
    wait_file(&validation.join("held"));
    assert_eq!(
        package::list(&root)
            .unwrap()
            .iter()
            .find(|p| p.manifest.id == "fixture.lifecycle")
            .unwrap()
            .digest,
        original.digest
    );
    assert_eq!(
        fs::read(data.join("history.sqlite")).unwrap(),
        b"original database"
    );
    assert_eq!(candidate_events.load(Ordering::Acquire), 0);
    assert!(ensure("fixture.lifecycle").is_err());
    assert_eq!(
        ensure("fixture.unrelated")
            .unwrap()
            .call("ping", json!({}))
            .unwrap()["behavior"],
        "unrelated"
    );
    fs::write(validation.join("release"), b"continue").unwrap();
    let installed = install.join().unwrap().unwrap();
    assert_eq!(
        fs::read(data.join("history.sqlite")).unwrap(),
        b"original database"
    );
    assert!(active_instance("fixture.lifecycle", &installed.digest).is_none());
    assert_eq!(
        ensure("fixture.lifecycle")
            .unwrap()
            .call("ping", json!({}))
            .unwrap()["behavior"],
        "held"
    );
    // Rejection stops private IO before restoring the original committed index.
    let rejected = candidate(&root, "fixture.lifecycle", "reject");
    {
        let _mutation = super::super::MUTATIONS
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        let fence = super::super::drain_idle("fixture.lifecycle").unwrap();
        assert!(super::super::lifecycle::install(&root, rejected, &fence).is_err());
    }
    assert_eq!(
        package::list(&root)
            .unwrap()
            .iter()
            .find(|p| p.manifest.id == "fixture.lifecycle")
            .unwrap()
            .digest,
        installed.digest
    );
    assert_eq!(
        fs::read(data.join("history.sqlite")).unwrap(),
        b"original database"
    );
    assert_eq!(
        ensure("fixture.lifecycle")
            .unwrap()
            .call("ping", json!({}))
            .unwrap()["behavior"],
        "held"
    );
    // Retirement joins actual readers/writer/stderr with no global gates held.
    retire("fixture.unrelated");
    assert_eq!(
        ensure("fixture.unrelated")
            .unwrap()
            .call("ping", json!({}))
            .unwrap()["behavior"],
        "unrelated"
    );
    let publisher =
        super::super::provenance::begin_operation(super::super::provenance::OperationStart {
            operation: "fixture.publication".into(),
            parameters: json!({}),
            inputs: vec![],
        })
        .unwrap();
    assert!(publisher.recording());
    let shutting = candidate(&root, "fixture.lifecycle", "shutdown");
    let owned_root = root.clone();
    let owner = std::thread::spawn(move || {
        let _mutation = super::super::MUTATIONS
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        let fence = super::super::drain_idle("fixture.lifecycle").unwrap();
        super::super::lifecycle::install(&owned_root, shutting, &fence)
    });
    wait_file(&validation.join("held"));
    let started = Instant::now();
    let (complete, finished) = mpsc::channel();
    let shutdown_worker = std::thread::spawn(move || {
        super::super::shutdown();
        complete.send(()).unwrap();
    });
    assert!(owner.join().unwrap().is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "Shutdown failed to stop a private candidate promptly"
    );
    // Private rollback has finished, but shutdown still owns the profile until
    // an already-admitted native publisher releases its evidence lease. Shutdown
    // also joins the job reconciler, which observes closing only between
    // JOB_POLL_INTERVAL sleeps; hold the publisher well past that bound so a
    // pending shutdown here can only be waiting for the publisher.
    let profile_root = config::config_dir().unwrap().canonicalize().unwrap();
    let hold_until = started + JOB_POLL_INTERVAL * 2 + Duration::from_secs(1);
    assert!(
        matches!(
            finished.recv_timeout(hold_until.saturating_duration_since(Instant::now())),
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "Shutdown finished while an admitted publisher lease was live"
    );
    assert!(
        super::super::ownership::acquire(&profile_root).is_err(),
        "Shutdown released profile ownership while a publisher lease was live"
    );
    let released = Instant::now();
    drop(publisher);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
    let tail = released.elapsed();
    eprintln!("lifecycle-native: shutdown returned {tail:?} after publisher release");
    assert!(
        tail < Duration::from_millis(500),
        "Shutdown waited {tail:?} after the last publisher released"
    );
    shutdown_worker.join().unwrap();
    drop(super::super::ownership::acquire(&profile_root).unwrap());
    assert_eq!(
        fs::read(data.join("history.sqlite")).unwrap(),
        b"original database"
    );
    assert!(!root.join("upgrade-pending").exists());
    assert!(ensure("fixture.unrelated").is_err());
    assert!(CallLease::acquire("fixture.after-shutdown").is_err());
    assert!(super::super::mutation_lock().is_err());
    assert_eq!(candidate_events.load(Ordering::Acquire), 0);
    drop(app);
}
