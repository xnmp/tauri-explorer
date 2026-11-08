//! Startup degrades instead of failing: a profile owned by another process,
//! unreadable AI storage and failed startup recovery keep ordinary browsing
//! and legacy backends, never run recovery or service participants, and retry.
//! Run only in a dedicated process with private XDG roots under Xvfb and
//! TE_LIFECYCLE_NATIVE_FIXTURE=1, like `backend::native_tests`.
use super::lifecycle::mutation_native_tests::{methods, native_app, scripted};
use super::*;
use crate::service_state::{
    job::{JobRecord, JobState},
    model::{Limits, PackageGeneration},
    Store,
};
use serde_json::json;
use std::fs;

const LEGACY: &str = "fixture.legacy";
const MODERN: &str = "fixture.modern";

fn publish(root: &Path) {
    fs::create_dir_all(root).unwrap();
    package::write_index(
        root,
        &[
            scripted(root, LEGACY, 2, "quiesce"),
            scripted(root, MODERN, 3, "quiesce"),
        ],
    )
    .unwrap();
}
fn pending_errors() -> Vec<String> {
    PENDING_INSTALL_ERRORS
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .clone()
}
fn serves(id: &str) -> bool {
    match backend::ensure(id).and_then(|broker| broker.call("ping", json!({}))) {
        Ok(reply) => reply["pid"].as_i64().is_some(),
        Err(cause) => {
            eprintln!("{id} does not serve: {cause}");
            false
        }
    }
}
fn accepting_job(store: &Store) -> JobRecord {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    store
        .register_job(JobRecord {
            job_key: "d".repeat(48),
            owner: PackageGeneration {
                package_id: "fixture.elsewhere".into(),
                digest: "a".repeat(64),
                incarnation: 3,
            },
            operation_id: "0123456789abcdef0123456789abcdef".into(),
            job_id: (1 << 51) | 3,
            kind: "openai-image".into(),
            label: "AI image".into(),
            origin_window: "main.first".into(),
            revision: 0,
            source_revision: 0,
            ownership_epoch: 0,
            created_at_ms: now,
            updated_at_ms: now,
            settled_at_ms: None,
            estimate_key: None,
            state: JobState::Accepting,
            phase: Some("preparing".into()),
            output_path: None,
            cost: None,
            reveal: None,
            run_id: None,
            error: None,
        })
        .unwrap()
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_a_process_without_the_profile_never_recovers_its_live_claims() {
    let app = native_app();
    let config = config::config_dir().unwrap();
    publish(&root().unwrap());
    // A first, live process owns the profile and has work in flight.
    let first = ownership::acquire(&config.canonicalize().unwrap()).unwrap();
    let ledger = Store::open(config.join("service-state"), Limits::default()).unwrap();
    let live = accepting_job(&ledger);
    super::initialize(app.handle().clone()).unwrap();
    // The refusal names this process, which holds `first` (#1433).
    let named = format!("(held by {}", std::env::current_exe().unwrap().display());
    assert!(pending_errors()
        .iter()
        .any(|e| ownership::is_not_owner(e) && e.contains(&named)));
    // Its claims were neither recovered nor reopened by this process.
    assert_eq!(ledger.job(&live.job_key).unwrap().unwrap(), live);
    assert!(service_host::store().is_err());
    // Browsing-side legacy backends work; service participants never start.
    assert!(serves(LEGACY));
    assert!(backend::ensure(MODERN).is_err());
    assert!(methods(&root().unwrap(), MODERN).is_empty());
    assert!(ensure_services().is_err());
    assert_eq!(ledger.job(&live.job_key).unwrap().unwrap(), live);
    // Once the first process exits, the next service action takes over.
    drop(first);
    ensure_services().unwrap();
    assert_eq!(
        ledger.job(&live.job_key).unwrap().unwrap().state,
        JobState::Recovering
    );
    assert!(serves(MODERN));
    shutdown();
    drop(app);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_unreadable_ai_storage_keeps_legacy_backends_and_retries() {
    let app = native_app();
    let config = config::config_dir().unwrap();
    let root = root().unwrap();
    publish(&root);
    // The ledger cannot open: its directory path is occupied.
    fs::write(config.join("service-state"), b"not a directory").unwrap();
    super::initialize(app.handle().clone()).unwrap();
    assert!(pending_errors().iter().any(|e| e == STORAGE_DEFERRED));
    assert!(serves(LEGACY));
    assert!(backend::ensure(MODERN).is_err());
    assert!(methods(&root, MODERN).is_empty());
    assert!(ensure_services().is_err());
    // The open failure is not cached. A later startup-recovery error still
    // degrades: an interrupted package change now holds every backend.
    fs::remove_file(config.join("service-state")).unwrap();
    fs::create_dir_all(root.join("upgrade-pending")).unwrap();
    fs::write(root.join("upgrade-pending/upgrade.json"), b"{").unwrap();
    assert!(ensure_services().is_err());
    assert!(service_host::store().is_ok());
    assert!(backend::ensure(LEGACY).is_err());
    assert!(backend::ensure(MODERN).is_err());
    fs::remove_dir_all(root.join("upgrade-pending")).unwrap();
    ensure_services().unwrap();
    assert!(serves(MODERN));
    assert!(serves(LEGACY));
    shutdown();
    drop(app);
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_startup_recovery_errors_degrade_instead_of_failing_setup() {
    let app = native_app();
    let root = root().unwrap();
    publish(&root);
    fs::create_dir_all(root.join("upgrade-pending")).unwrap();
    fs::write(root.join("upgrade-pending/upgrade.json"), b"{").unwrap();
    // Setup must not fail: Tauri aborts the whole app on a setup error.
    super::initialize(app.handle().clone()).unwrap();
    assert!(pending_errors().iter().any(|e| e == STORAGE_DEFERRED));
    assert!(backend::ensure(MODERN).is_err());
    fs::remove_dir_all(root.join("upgrade-pending")).unwrap();
    ensure_services().unwrap();
    assert!(serves(MODERN));
    assert!(serves(LEGACY));
    shutdown();
    drop(app);
}

/// A queued request as a `.teplugin` archive of a runnable scripted payload.
fn queued_archive(config: &Path, id: &str) -> PathBuf {
    use std::io::Write;
    // Built outside the installed root so its payload is not pre-published.
    let source = config.join("queued-source");
    // SDK 3: private validation preflight requires a deferred (not ready) reply.
    let installed = scripted(&source, id, 3, "quiesce");
    let queue = config.join("pending-plugins");
    fs::create_dir_all(&queue).unwrap();
    let path = queue.join(format!("{id}.teplugin"));
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    let options = zip::write::SimpleFileOptions::default().unix_permissions(0o700);
    zip.start_file("manifest.json", options).unwrap();
    serde_json::to_writer(&mut zip, &installed.manifest).unwrap();
    for name in installed.manifest.files.keys() {
        zip.start_file(name, options).unwrap();
        zip.write_all(
            &fs::read(source.join("payloads").join(&installed.digest).join(name)).unwrap(),
        )
        .unwrap();
    }
    zip.finish().unwrap();
    path
}

#[test]
#[ignore = "requires a private native display/profile; execute via dedicated subprocess"]
fn native_queued_installs_apply_when_ownership_is_acquired_after_startup() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    const QUEUED: &str = "fixture.queued";
    let app = native_app();
    let config = config::config_dir().unwrap();
    let request = queued_archive(&config, QUEUED);
    // The previous instance still holds the lease while this one starts.
    let previous = ownership::acquire(&config.canonicalize().unwrap()).unwrap();
    super::initialize(app.handle().clone()).unwrap();
    assert!(pending_errors().iter().any(|e| ownership::is_not_owner(e)));
    std::thread::sleep(Duration::from_millis(200));
    assert!(request.exists(), "a non-owner must not apply the queue");
    assert_eq!(QUEUE_WORKERS_STARTED.load(Ordering::SeqCst), 0);
    // The previous instance exits; the opportunistic read-path retry is the
    // first to acquire ownership (#1528).
    drop(previous);
    retry_services();
    assert!(backend::ownership_ready());
    let deadline = Instant::now() + Duration::from_secs(10);
    while request.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !request.exists(),
        "queued install was skipped after late ownership: {:?}",
        pending_errors()
    );
    assert!(
        !config.join("pending-plugins/failed").exists(),
        "queued install was quarantined: {:?}",
        pending_errors()
    );
    assert!(package::list(&root().unwrap())
        .unwrap()
        .iter()
        .any(|installed| installed.manifest.id == QUEUED));
    assert!(serves(QUEUED));
    // Later service entry points never start a second worker.
    ensure_services().unwrap();
    {
        let _gate = mutation_lock().unwrap();
        bootstrap_services().unwrap();
    }
    assert_eq!(QUEUE_WORKERS_STARTED.load(Ordering::SeqCst), 1);
    assert!(!pending_errors().iter().any(|e| e.contains("Queued plugin")));
    shutdown();
    drop(app);
}
