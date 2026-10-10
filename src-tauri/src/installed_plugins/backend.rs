//! One native broker per installed package, shared across every webview.
use super::{package, root};
use crate::{
    config,
    error::AppError,
    plugin_job::JobControl,
    process_ext::{output_controlled, NoConsole},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
static CLOSING: AtomicBool = AtomicBool::new(false);
static OWNERSHIP_READY: AtomicBool = AtomicBool::new(false);
static INCARNATIONS: OnceLock<AtomicU64> = OnceLock::new();
fn next_incarnation() -> Result<u64, AppError> {
    if INCARNATIONS.get().is_none() {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|_| error("Could not allocate plugin incarnation"))?;
        let seed = (u64::from_le_bytes(bytes) & ((1u64 << 52) - 1)).max(1);
        let _ = INCARNATIONS.set(AtomicU64::new(seed));
    }
    let incarnation = INCARNATIONS
        .get()
        .expect("initialized")
        .fetch_add(1, Ordering::Relaxed);
    if incarnation > 9_007_199_254_740_991 {
        return Err(error("Plugin incarnation capacity reached"));
    }
    Ok(incarnation)
}
static APP: OnceLock<AppHandle> = OnceLock::new();
static RECOVERING: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
fn recovering() -> &'static Mutex<HashMap<String, usize>> {
    RECOVERING.get_or_init(|| Mutex::new(HashMap::new()))
}
struct RecoveryLease(String);
impl Drop for RecoveryLease {
    fn drop(&mut self) {
        let mut all = recovering()
            .lock()
            .unwrap_or_else(|cause| cause.into_inner());
        if let Some(count) = all.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                all.remove(&self.0);
            }
        }
    }
}
static BROKERS: OnceLock<Mutex<HashMap<String, Arc<Broker>>>> = OnceLock::new();
// Owned for shutdown, never consulted by routing or ordinary ensure().
static CANDIDATES: OnceLock<Mutex<HashMap<u64, Arc<Broker>>>> = OnceLock::new();
static STARTING: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
#[derive(Default)]
struct Admissions {
    calls: HashMap<(String, usize), usize>,
    fenced: HashSet<String>,
    recovery_fences: HashSet<String>,
}
static CALLS: OnceLock<Mutex<Admissions>> = OnceLock::new();
static ADMISSIONS_CHANGED: Condvar = Condvar::new();
pub(super) struct CallLease((String, usize));
pub(super) fn control_method(method: &str) -> bool {
    matches!(
        method,
        "lifecycle.quiesce"
            | "jobs.cancelOperation"
            | "jobs.resumeOperation"
            | "control.operationIdle"
            | "control.discardOperation"
            | "settings.cancelTest"
            | "settings.test.discard"
    ) || method.ends_with(".status")
        || method.ends_with(".cancel")
        || method.ends_with(".acknowledge")
}
impl CallLease {
    /// Acquire while holding the short lifecycle read gate, then release the
    /// gate before startup, callbacks or provider IO.
    pub(super) fn acquire(package: &str) -> Result<Self, AppError> {
        Self::acquire_lane(package, false)
    }
    pub(super) fn acquire_method(package: &str, method: &str) -> Result<Self, AppError> {
        Self::acquire_lane(package, control_method(method))
    }
    pub(super) fn acquire_lane(package: &str, control: bool) -> Result<Self, AppError> {
        Self::acquire_direction(package, usize::from(control))
    }
    pub(super) fn acquire_direction(package: &str, lane: usize) -> Result<Self, AppError> {
        if lane >= 4 {
            return Err(error("Invalid plugin admission lane"));
        }
        if CLOSING.load(Ordering::Acquire) {
            return Err(error("Plugin host is shutting down"));
        }
        let mut admissions = crate::native_deadline::lock(
            CALLS.get_or_init(Default::default),
            "Plugin admission lock is unavailable",
        )?;
        if CLOSING.load(Ordering::Acquire) {
            return Err(error("Plugin host is shutting down"));
        }
        if admissions.fenced.contains(package) {
            return Err(error("Plugin package is draining for a lifecycle change"));
        }
        let calls = &mut admissions.calls;
        let key = (package.to_owned(), lane);
        if calls
            .iter()
            .filter(|((_, direction), _)| *direction == lane)
            .map(|(_, count)| count)
            .sum::<usize>()
            >= [64, 16, 32, 16][lane]
            || calls.get(&key).copied().unwrap_or(0) >= [16, 8, 16, 4][lane]
        {
            return Err(error("Plugin call capacity reached"));
        }
        *calls.entry(key.clone()).or_default() += 1;
        Ok(Self(key))
    }
}
impl Drop for CallLease {
    fn drop(&mut self) {
        let mut calls = CALLS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|cause| cause.into_inner());
        if let Some(count) = calls.calls.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                calls.calls.remove(&self.0);
            }
        }
        ADMISSIONS_CHANGED.notify_all();
    }
}
pub(super) fn wait_for_admissions() {
    let mut admissions = CALLS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|cause| cause.into_inner());
    while !admissions.calls.is_empty() {
        admissions = ADMISSIONS_CHANGED
            .wait(admissions)
            .unwrap_or_else(|cause| cause.into_inner());
    }
}
const STARTING_PHASE: u8 = 0;
const PREFLIGHT_PHASE: u8 = 1;
const ACTIVATING_PHASE: u8 = 2;
const ACTIVE_PHASE: u8 = 3;
const DEAD_PHASE: u8 = 4;
const DRAINING_PHASE: u8 = 5;
fn brokers() -> &'static Mutex<HashMap<String, Arc<Broker>>> {
    BROKERS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn initialize(app: AppHandle) {
    let _ = APP.set(app);
}
pub(super) fn finish_initialize() {
    OWNERSHIP_READY.store(true, Ordering::Release);
}
fn error(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}

struct Waiter {
    sender: mpsc::Sender<Result<Value, AppError>>,
    bytes: Vec<u8>,
    sequence: u64,
    control: bool,
}
#[derive(Clone)]
struct Job {
    kind: String,
    operation_id: String,
}

pub(super) struct Broker {
    package_id: String,
    installed: package::Installed,
    validation_only: bool,
    app: AppHandle,
    child: Mutex<Child>,
    input: Mutex<Option<Inputs>>,
    alive: AtomicBool,
    tree_stopped: AtomicBool,
    retired: AtomicBool,
    phase: AtomicU8,
    activation: Mutex<()>,
    pub(super) reverse_pending: [AtomicUsize; 3],
    incarnation: u64,
    control_token: String,
    diagnostics: Mutex<super::diagnostics::Diagnostics>,
    text_bridge: OnceLock<Arc<super::text_service::TextBridge>>,
    sequence: AtomicU64,
    pending: Mutex<HashMap<u64, Waiter>>,
    jobs: Mutex<HashMap<u64, Job>>,
    controls: Mutex<HashMap<String, JobControl>>,
    spools: Mutex<HashMap<String, Arc<tempfile::TempDir>>>,
    io_workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
}
/// Captured before spawning, so rejected workers and panics release ownership.
struct WorkerCleanup<F: FnOnce()>(Option<F>);
impl<F: FnOnce()> WorkerCleanup<F> {
    fn new(cleanup: F) -> Self {
        Self(Some(cleanup))
    }
}
impl<F: FnOnce()> Drop for WorkerCleanup<F> {
    fn drop(&mut self) {
        if let Some(cleanup) = self.0.take() {
            cleanup();
        }
    }
}

/// Fields drop in order, including when Builder rejects the closure: remove
/// registry references, finish final spool unlink IO, then release admission.
struct ProcessAdmission<F: FnOnce()> {
    _cleanup: WorkerCleanup<F>,
    spool: Arc<tempfile::TempDir>,
    _lease: CallLease,
}

#[cfg(test)]
thread_local! { static REJECT_WORKER_SPAWN: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }
pub(super) fn spawn_worker(
    name: &str,
    work: impl FnOnce() + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    #[cfg(test)]
    if REJECT_WORKER_SPAWN.with(|remaining| match remaining.get() {
        Some(0) => {
            remaining.set(None);
            true
        }
        Some(count) => {
            remaining.set(Some(count - 1));
            false
        }
        None => false,
    }) {
        return Err(std::io::Error::other("Fixture worker spawn rejection"));
    }
    std::thread::Builder::new().name(name.into()).spawn(work)
}

fn cleanup_process_resources(
    controls: &Mutex<HashMap<String, JobControl>>,
    spools: &Mutex<HashMap<String, Arc<tempfile::TempDir>>>,
    id: &str,
    control: &JobControl,
    keep_spool: bool,
) {
    controls
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .remove(id);
    if !keep_spool {
        control.cancel();
        spools
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .remove(id);
    }
}

fn join_io_workers(workers: &Mutex<Vec<std::thread::JoinHandle<()>>>) {
    let owned = std::mem::take(&mut *workers.lock().unwrap_or_else(|cause| cause.into_inner()));
    for worker in owned {
        if worker.thread().id() == std::thread::current().id() {
            // A retiring reader retains its own handle until it returns. It
            // cannot synchronously join itself; no IO is claimed ended here.
            workers
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .push(worker);
        } else {
            let _ = worker.join();
        }
    }
}

/// A partially started backend must never survive an error return.
struct StartupGuard(Option<Arc<Broker>>);
impl Drop for StartupGuard {
    fn drop(&mut self) {
        if let Some(broker) = self.0.take() {
            broker.stop();
        }
    }
}

struct Inputs {
    normal: mpsc::SyncSender<Vec<u8>>,
    control: mpsc::SyncSender<Vec<u8>>,
    callback: mpsc::SyncSender<Vec<u8>>,
}

/// Every path that can reap the child first stops its owned process group
/// while holding the same child lock. The unreaped main PID pins the group ID.
fn terminate_owned_tree(child: &mut Child, stopped: &AtomicBool) {
    if !stopped.swap(true, Ordering::AcqRel) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn a_package_without_a_broker_is_fenced_while_unrelated_controls_remain_usable() {
        let package = "fixture.absent-mutation";
        let fence = begin_drain(package).unwrap();
        for lane in 0..4 {
            assert!(CallLease::acquire_direction(package, lane).is_err());
        }
        assert!(begin_drain(package).is_err());
        let control =
            CallLease::acquire_method("fixture.unrelated-mutation", "jobs.status").unwrap();
        drop(control);
        drop(fence);
        assert!(CallLease::acquire(package).is_ok());
    }

    #[test]
    fn an_admitted_startup_prevents_fencing_until_the_actual_handshake_returns() {
        let package = "fixture.startup-mutation";
        let (ready, started) = mpsc::channel();
        let (release, finish) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _startup = CallLease::acquire_direction(package, 3).unwrap();
            ready.send(()).unwrap();
            finish.recv().unwrap();
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(begin_drain(package).is_err());
        assert!(CallLease::acquire_method("fixture.startup-unrelated", "jobs.status").is_ok());
        release.send(()).unwrap();
        worker.join().unwrap();
        let fence = begin_drain(package).unwrap();
        assert!(CallLease::acquire_direction(package, 3).is_err());
        drop(fence);
        assert!(CallLease::acquire_direction(package, 3).is_ok());
    }

    #[test]
    fn failed_rollback_keeps_all_package_admissions_closed_after_the_owner_returns() {
        let package = "fixture.rollback-recovery-required";
        let fence = begin_drain(package).unwrap();
        fence.retain_for_recovery();
        drop(fence);
        for method in ["settings.read", "jobs.status", "jobs.cancelOperation"] {
            assert!(CallLease::acquire_method(package, method).is_err());
        }
        assert!(begin_drain(package).is_err());
        assert!(CallLease::acquire_direction(package, 3).is_err());
        assert!(CallLease::acquire("fixture.rollback-unrelated").is_ok());
    }

    #[test]
    fn saturated_frontend_settings_leave_cancel_status_and_discard_admissible() {
        let package = "fixture.frontend-control-capacity";
        let ordinary: Vec<_> = (0..16)
            .map(|_| CallLease::acquire_method(package, "settings.check").unwrap())
            .collect();
        assert!(CallLease::acquire_method(package, "settings.read").is_err());
        for method in [
            "settings.cancelTest",
            "settings.test.status",
            "settings.test.discard",
        ] {
            let lease = CallLease::acquire_method(package, method).unwrap();
            drop(lease);
        }
        drop(ordinary);
        assert!(CallLease::acquire_method(package, "settings.read").is_ok());
    }
}

#[cfg(test)]
mod worker_spawn_tests {
    use super::*;

    fn reject_after(successful: usize) {
        REJECT_WORKER_SPAWN.with(|fail| fail.set(Some(successful)));
    }

    #[test]
    fn rejected_migration_worker_releases_coordinator_ownership_for_an_unpaid_retry() {
        let invoked = Arc::new(AtomicUsize::new(0));
        let first = invoked.clone();
        reject_after(0);
        assert!(spawn_image_migration(move || {
            first.fetch_add(1, Ordering::AcqRel);
        })
        .is_err());
        assert_eq!(invoked.load(Ordering::Acquire), 0);
        let second = invoked.clone();
        let (done, finished) = mpsc::channel();
        assert!(spawn_image_migration(move || {
            second.fetch_add(1, Ordering::AcqRel);
            done.send(()).unwrap();
        })
        .unwrap());
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(invoked.load(Ordering::Acquire), 1);
    }

    #[test]
    fn rejected_process_worker_never_dispatches_and_releases_spool_control_and_admission() {
        let id = "fixture.process-spawn-rejected";
        let control = JobControl::new();
        let spool = Arc::new(tempfile::tempdir().unwrap());
        let path = spool.path().to_owned();
        let controls = Arc::new(Mutex::new(HashMap::from([(
            id.to_owned(),
            control.clone(),
        )])));
        let spools = Arc::new(Mutex::new(HashMap::from([(id.to_owned(), spool.clone())])));
        let cleanup_controls = controls.clone();
        let cleanup_spools = spools.clone();
        let cleanup_control = control.clone();
        let cleanup = WorkerCleanup::new(move || {
            cleanup_process_resources(
                &cleanup_controls,
                &cleanup_spools,
                id,
                &cleanup_control,
                false,
            )
        });
        let lease = CallLease::acquire(id).unwrap();
        let invoked = Arc::new(AtomicUsize::new(0));
        let dispatched = invoked.clone();
        let admission = ProcessAdmission {
            _cleanup: cleanup,
            spool,
            _lease: lease,
        };
        reject_after(0);
        assert!(spawn_worker("fixture-rejected-process", move || {
            let _admission = admission;
            dispatched.fetch_add(1, Ordering::AcqRel);
        })
        .is_err());
        assert_eq!(invoked.load(Ordering::Acquire), 0);
        assert!(control.check().is_err());
        assert!(!path.exists());
        // All admission capacity is usable again, rather than one leaked slot.
        let all: Vec<_> = (0..16).map(|_| CallLease::acquire(id).unwrap()).collect();
        drop(all);
    }

    #[test]
    fn panicked_worker_releases_resources_but_successful_delivery_retains_spool() {
        for keep in [false, true] {
            let control = JobControl::new();
            let spool = Arc::new(tempfile::tempdir().unwrap());
            let path = spool.path().to_owned();
            let controls = Arc::new(Mutex::new(HashMap::from([(
                "fixture".into(),
                control.clone(),
            )])));
            let spools = Arc::new(Mutex::new(HashMap::from([(
                "fixture".into(),
                spool.clone(),
            )])));
            let (owned_controls, owned_spools, owned_control) =
                (controls.clone(), spools.clone(), control.clone());
            let cleanup = WorkerCleanup::new(move || {
                cleanup_process_resources(
                    &owned_controls,
                    &owned_spools,
                    "fixture",
                    &owned_control,
                    keep,
                )
            });
            let package = if keep {
                "fixture-process-success"
            } else {
                "fixture-process-panic"
            };
            let admission = ProcessAdmission {
                _cleanup: cleanup,
                spool,
                _lease: CallLease::acquire(package).unwrap(),
            };
            let worker = spawn_worker("fixture-owned-cleanup", move || {
                let _admission = admission;
                if !keep {
                    panic!("fixture process worker failure");
                }
            })
            .unwrap();
            assert_eq!(worker.join().is_ok(), keep);
            assert_eq!(path.exists(), keep);
            assert_eq!(control.check().is_ok(), keep);
            let all: Vec<_> = (0..16)
                .map(|_| CallLease::acquire(package).unwrap())
                .collect();
            drop(all);
            // The successful spool is explicitly released by its consumer.
            spools.lock().unwrap().clear();
            assert!(!path.exists());
        }
    }

    #[test]
    fn retiring_io_thread_keeps_itself_owned_until_actual_return() {
        let workers = Arc::new(Mutex::new(Vec::new()));
        let owned = workers.clone();
        let (ready, started) = mpsc::channel();
        let (released, finish) = mpsc::channel();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let gate = barrier.clone();
        let ended = Arc::new(AtomicBool::new(false));
        let actual_end = ended.clone();
        let worker = spawn_worker("fixture-self-retiring-reader", move || {
            gate.wait();
            join_io_workers(&owned);
            ready.send(()).unwrap();
            finish.recv().unwrap();
            actual_end.store(true, Ordering::Release);
        })
        .unwrap();
        workers.lock().unwrap().push(worker);
        barrier.wait();
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!ended.load(Ordering::Acquire));
        released.send(()).unwrap();
        join_io_workers(&workers);
        assert!(ended.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn partial_backend_startup_stops_descendant_pipe_holders_and_joins_started_io() {
        use std::os::unix::process::CommandExt;
        for failed_worker in 0..3 {
            let root = tempfile::tempdir().unwrap();
            let marker = root.path().join("started");
            let mut child = Command::new("python3")
                .args(["-c", "import os,subprocess,sys,time; subprocess.Popen(['sleep','30']); open(sys.argv[1],'w').write('ready'); time.sleep(30)"])
                .arg(&marker).process_group(0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let child = Arc::new(Mutex::new(child));
            let workers = Arc::new(Mutex::new(Vec::new()));
            let (owned_child, owned_workers) = (child.clone(), workers.clone());
            let cleanup = WorkerCleanup::new(move || {
                {
                    let mut child = owned_child.lock().unwrap();
                    terminate_owned_tree(&mut child, &AtomicBool::new(false));
                    child.wait().unwrap();
                }
                join_io_workers(&owned_workers);
            });
            let deadline = Instant::now() + Duration::from_secs(3);
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(marker.exists());
            let ended = Arc::new(AtomicUsize::new(0));
            reject_after(failed_worker);
            let result = (|| -> std::io::Result<()> {
                let count = ended.clone();
                let worker = spawn_worker("fixture-stderr", move || {
                    let mut bytes = vec![];
                    stderr.read_to_end(&mut bytes).unwrap();
                    count.fetch_add(1, Ordering::AcqRel);
                })?;
                workers.lock().unwrap().push(worker);
                let count = ended.clone();
                let worker = spawn_worker("fixture-writer", move || {
                    let _ = stdin.write_all(b"fixture");
                    count.fetch_add(1, Ordering::AcqRel);
                })?;
                workers.lock().unwrap().push(worker);
                let count = ended.clone();
                let worker = spawn_worker("fixture-reader", move || {
                    let mut bytes = vec![];
                    stdout.read_to_end(&mut bytes).unwrap();
                    count.fetch_add(1, Ordering::AcqRel);
                })?;
                workers.lock().unwrap().push(worker);
                Ok(())
            })();
            assert!(result.is_err());
            drop(cleanup);
            assert_eq!(ended.load(Ordering::Acquire), failed_worker);
            assert!(child.lock().unwrap().try_wait().unwrap().is_some());
            // The descendant inherited stderr; every started blocking reader
            // ending proves that startup failure killed its pipe holder too.
        }
    }
}

#[cfg(all(test, unix))]
mod owned_tree_tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    #[test]
    fn concurrent_retirement_stops_descendants_before_reaping_exited_main() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("spawned");
        let mut child = Command::new("python3")
            .args(["-c", "import os,subprocess,sys; subprocess.Popen(['sleep','30']); open(sys.argv[1],'w').write('ready'); os._exit(0)"])
            .arg(&marker).process_group(0).stdout(Stdio::piped()).spawn().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (done, eof) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = vec![];
            let result = stdout.read_to_end(&mut bytes);
            let _ = done.send(result);
        });
        let child = Arc::new(Mutex::new(child));
        let stopped = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(marker.exists());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (child, stopped, barrier) = (child.clone(), stopped.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut child = child.lock().unwrap();
                    terminate_owned_tree(&mut child, &stopped);
                    child.wait().unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        // The main has exited, but its descendant held stdout open. EOF proves
        // retirement also terminated that descendant in the owned group.
        eof.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    }
}

impl Broker {
    pub(super) fn generation(&self) -> crate::service_state::model::PackageGeneration {
        crate::service_state::model::PackageGeneration {
            package_id: self.package_id.clone(),
            digest: self.installed.digest.clone(),
            incarnation: self.incarnation,
        }
    }
    pub(super) fn owned_processes_idle(&self) -> bool {
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
    }
    pub(super) fn control_call(&self, method: &str, mut params: Value) -> Result<Value, AppError> {
        if !matches!(method, "control.operationIdle" | "control.discardOperation") {
            return Err(error("Unknown native provider control"));
        }
        params["controlToken"] = json!(self.control_token);
        self.call(method, params)
    }
    pub(super) fn finish_job(&self, id: u64) {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }
    pub(super) fn is_active(&self) -> bool {
        self.phase.load(Ordering::Acquire) == ACTIVE_PHASE && self.alive.load(Ordering::Acquire)
    }
    pub(super) fn can_recover(&self) -> bool {
        matches!(
            self.phase.load(Ordering::Acquire),
            ACTIVATING_PHASE | ACTIVE_PHASE
        ) && self.alive.load(Ordering::Acquire)
    }
    pub(super) fn manifest(&self) -> &package::Manifest {
        &self.installed.manifest
    }
    fn disconnect_reason(&self) -> String {
        let class = self
            .diagnostics
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .classification();
        format!(
            "Plugin backend unavailable ({class}; correlation {}:{})",
            self.package_id, self.incarnation
        )
    }
    pub(super) fn emit_service_update(&self, consumer: Value, status: Value) {
        let _ = self.app.emit(
            "image-generation:operation-changed",
            json!({"consumerPackageId":consumer,"status":status}),
        );
    }
    fn activate(&self) -> Result<(), AppError> {
        let _action = if self.package_id == "xnmp.trace-explorer" {
            Some(super::ai_operations::action_guard()?)
        } else {
            None
        };
        let _guard = crate::native_deadline::lock(
            &self.activation,
            "Plugin activation lock is unavailable",
        )?;
        if self.is_active() {
            return Ok(());
        }
        if !self.alive.load(Ordering::Acquire) {
            return Err(error("Plugin backend is unavailable"));
        }
        if self.phase.load(Ordering::Acquire) == DRAINING_PHASE {
            return Err(error("Plugin package is draining for a lifecycle change"));
        }
        self.phase.store(ACTIVATING_PHASE, Ordering::Release);
        let result = self.call("lifecycle.activate", json!({}))?;
        if self.installed.manifest.sdk_version >= 3 && result["ready"] != true {
            return Err(error("Plugin activation protocol mismatch"));
        }
        self.phase.store(ACTIVE_PHASE, Ordering::Release);
        Ok(())
    }
    fn text_owner(&self) -> String {
        format!("plugin:{}:{}", self.package_id, self.incarnation)
    }

    fn text_request(self: &Arc<Self>, frame: Value) -> Result<(), AppError> {
        let bridge = self.text_bridge.get_or_init(|| {
            let active_owner = Arc::downgrade(self);
            let sender = Arc::downgrade(self);
            Arc::new(super::text_service::TextBridge::new(
                self.text_owner(),
                self.package_id.clone(),
                move || {
                    active_owner
                        .upgrade()
                        .is_some_and(|owner| owner.is_active())
                },
                move |frame| {
                    if let Some(owner) = sender.upgrade() {
                        if owner.alive.load(Ordering::Acquire) && owner.send(&frame).is_err() {
                            owner.fail("Text service reply could not be delivered");
                        }
                    }
                },
                Arc::new(super::text_service::NativeText),
            ))
        });
        if !frame["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("host:") && id.len() <= 128)
        {
            return Err(error("Invalid text service request ID"));
        }
        bridge.handle(frame);
        Ok(())
    }

    pub(super) fn send(&self, value: &Value) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(value).map_err(|cause| error(cause.to_string()))?;
        if bytes.len() > 1024 * 1024 {
            return Err(error("Plugin request exceeds 1 MiB"));
        }
        let guard =
            crate::native_deadline::lock(&self.input, "Plugin transport lock is unavailable")?;
        let input = guard
            .as_ref()
            .ok_or_else(|| error("Plugin backend disconnected"))?;
        let method = value["method"].as_str().unwrap_or("");
        let sender = if value["id"].is_string()
            && (value.get("result").is_some() || value.get("error").is_some())
        {
            &input.callback
        } else if control_method(method) {
            &input.control
        } else {
            &input.normal
        };
        sender.try_send(bytes).map_err(|cause| {
            error(match cause {
                mpsc::TrySendError::Full(_) => "Plugin write capacity reached",
                mpsc::TrySendError::Disconnected(_) => "Plugin writer disconnected",
            })
        })?;
        Ok(())
    }
    pub(super) fn notify_request(&self, method: &str, params: Value) -> Result<(), AppError> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
    }

    pub(super) fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let rpc_wait = crate::native_deadline::remaining(Duration::from_secs(
            if self.installed.manifest.sdk_version >= 3 {
                15
            } else {
                60
            },
        ))?;
        if !self.alive.load(Ordering::Acquire) || self.retired.load(Ordering::Acquire) {
            return Err(error("Plugin backend is unavailable"));
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let service = method.starts_with("services.");
        let modern = self.installed.manifest.sdk_version >= 3;
        let control = control_method(method);
        let cancel_late_start = if service && method.ends_with(".start") {
            Some(
                json!({"caller":params["caller"],"request":{"operationId":params["request"]["operationId"]}}),
            )
        } else {
            None
        };
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending =
                crate::native_deadline::lock(&self.pending, "Plugin reply lock is unavailable")?;
            if pending.len() >= 32
                || !control && pending.values().filter(|waiter| !waiter.control).count() >= 28
            {
                return Err(error("Plugin request capacity reached"));
            }
            pending.insert(
                id,
                Waiter {
                    sender,
                    bytes: vec![],
                    sequence: 0,
                    control,
                },
            );
        }
        if let Err(cause) =
            self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        {
            self.pending
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .remove(&id);
            return Err(cause);
        }
        match receiver
            .recv_timeout(crate::native_deadline::remaining(rpc_wait).unwrap_or(Duration::ZERO))
        {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(cause)) => Err(cause),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .remove(&id);
                if modern {
                    if let Some(params) = cancel_late_start {
                        // An acceptance reply may be lost. Cancel intent is
                        // idempotent; durable forwarding ownership remains and
                        // subsequent requests query status, never repeat start.
                        let cancel_method = format!("{}.cancel", method.trim_end_matches(".start"));
                        let _ = self.notify_request(&cancel_method, params);
                        return Err(AppError::MutationUncertain("Image acceptance reply was lost; recovery will inspect the original operation".into()));
                    }
                    if method == "settings.test" {
                        let _ = self.notify_request(
                            "settings.cancelTest",
                            json!({"requestId":params["requestId"]}),
                        );
                        return Err(AppError::MutationUncertain("Image test acceptance reply was lost; inspect the original test before testing again".into()));
                    }
                    if method == "jobs.start" {
                        let _ = self.notify_request(
                            "jobs.cancelOperation",
                            json!({"operationId":params["operationId"]}),
                        );
                        return Err(AppError::MutationUncertain("Image job acceptance reply was lost; inspect the original operation before starting again".into()));
                    }
                    return Err(error(
                        "Service reply deadline reached; provider remains available",
                    ));
                }
                // The worker may still be validating an unaccepted operation.
                // Stop it before status lookup so a late reply cannot launch
                // work after the caller has already lost acceptance ownership.
                self.fail(
                    "Plugin reply deadline reached; backend stopped before accepting late work",
                );
                Err(AppError::MutationUncertain(
                    "Plugin reply was lost; inspect its history before repeating an operation"
                        .into(),
                ))
            }
        }
    }

    fn fail(&self, reason: &str) {
        let recover_jobs = !self.validation_only
            && self.installed.manifest.sdk_version < 3
            && !self.retired.load(Ordering::Acquire)
            && !CLOSING.load(Ordering::Acquire);
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        self.phase.store(DEAD_PHASE, Ordering::Release);
        {
            let mut child = self.child.lock().unwrap_or_else(|cause| cause.into_inner());
            terminate_owned_tree(&mut child, &self.tree_stopped);
        }
        if !self.validation_only
            && self.installed.manifest.sdk_version >= 3
            && !CLOSING.load(Ordering::Acquire)
        {
            super::job_bridge::disconnected(&self.generation());
            super::service_bridge::on_dead(self.generation());
        }
        if !self.validation_only {
            crate::ai::cancel_caller(&self.text_owner());
        }
        // Reserve reconciliation ownership before any caller can replace this
        // dead broker. A normal replacement must not turn crash recovery into
        // an intentional retirement or leave an accepted job without an event.
        let (jobs, recovery): (Vec<_>, _) = {
            let mut owned = self.jobs.lock().unwrap_or_else(|cause| cause.into_inner());
            let recovery = if !owned.is_empty() && recover_jobs {
                *recovering()
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .entry(self.package_id.clone())
                    .or_default() += 1;
                Some(RecoveryLease(self.package_id.clone()))
            } else {
                None
            };
            (owned.drain().collect(), recovery)
        };
        self.input
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take();
        for (_, waiter) in self
            .pending
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .drain()
        {
            let _ = waiter.sender.send(Err(reason.into()));
        }
        for control in self
            .controls
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .values()
        {
            control.cancel();
        }
        self.spools
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .clear();
        // Teardown does not borrow the writer thread or its pipe. A worker
        // that stopped reading stdin cannot keep either callers or shutdown.

        if recovery.is_some() {
            let package_id = self.package_id.clone();
            let app = self.app.clone();
            let reason = reason.to_owned();
            // Query durable acceptance after reconciliation. Never replay jobs.start:
            // losing a transport reply must not repeat a paid provider request.
            let refused_jobs: Vec<_> = jobs
                .iter()
                .map(|(id, job)| (*id, job.kind.clone()))
                .collect();
            let refused_app = app.clone();
            let spawned = spawn_worker("legacy-plugin-reconciliation", move || {
                let _recovery = recovery;
                if CLOSING.load(Ordering::Acquire) {
                    return;
                }
                let _lease = match (|| {
                    let _gate = super::read_lifecycle()?;
                    CallLease::acquire_lane(&package_id, true)
                })() {
                    Ok(lease) => lease,
                    Err(_) => return,
                };
                for (id, job) in jobs {
                    let status = ensure(&package_id).and_then(|broker| {
                        broker.call("jobs.status", json!({"operationId":job.operation_id}))
                    });
                    let published = status
                        .as_ref()
                        .ok()
                        .filter(|status| {
                            status["jobId"].as_u64() == Some(id) && status["status"] == "succeeded"
                        })
                        .and_then(|status| status["outputPath"].as_str());
                    let (event, payload) = match published {
                        Some(path) => (
                            format!("{}-complete", job.kind),
                            json!({"jobId":id,"outputPath":path}),
                        ),
                        None => (
                            format!("{}-error", job.kind),
                            json!({"jobId":id,"error":status.as_ref().ok().and_then(|status|status["error"].as_str()).unwrap_or(&reason)}),
                        ),
                    };
                    let _ = app.emit(&event, payload);
                }
            });
            if spawned.is_err() {
                for (id, kind) in refused_jobs {
                    let _ = refused_app.emit(&format!("{kind}-error"), json!({"jobId":id,"error":"Native recovery worker could not start; inspect the original operation history before repeating it"}));
                }
            }
        }
    }

    fn receive(self: &Arc<Self>, frame: Value) -> Result<(), AppError> {
        if frame["jsonrpc"] != "2.0" {
            return Err(error("Invalid plugin RPC version"));
        }
        if let Some(method) = frame["method"].as_str() {
            if self.validation_only {
                // All SDK generations use the same private preflight boundary.
                // Notifications are quarantined; reverse requests never dispatch.
                if let Some(id) = frame.get("id") {
                    self.send(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Plugin preflight cannot invoke host services","data":{"code":"preflight_not_active"}}}))?;
                }
                return Ok(());
            }
            match method {
                "event" => {
                    let name = frame["params"]["name"]
                        .as_str()
                        .ok_or_else(|| error("Invalid plugin event"))?;
                    if name.len() > 128 {
                        return Err(error("Invalid plugin event"));
                    }
                    let payload = &frame["params"]["payload"];
                    if self.installed.manifest.sdk_version >= 3
                        && self.phase.load(Ordering::Acquire) == DRAINING_PHASE
                    {
                        // A durable terminal observation may have released its
                        // claims just before this queued notification arrives.
                        // Notifications own no execution/publication transition;
                        // quarantine them while the unlocked idle handshake runs.
                        return Ok(());
                    }
                    if self.installed.manifest.sdk_version >= 3 && !self.can_recover() {
                        return Err(error("Inactive plugin cannot publish service events"));
                    }
                    if self.installed.manifest.sdk_version >= 3
                        && (name.ends_with("-complete")
                            || name.ends_with("-error")
                            || name.ends_with("-progress"))
                    {
                        return super::job_bridge::event(self.clone(), name, payload);
                    }
                    if name.ends_with("-complete")
                        || name.ends_with("-error")
                        || name.ends_with("-progress")
                    {
                        let Some(id) = payload["jobId"].as_u64() else {
                            return Err(error("Invalid plugin job event"));
                        };
                        let mut jobs = self.jobs.lock().unwrap_or_else(|cause| cause.into_inner());
                        let Some(job) = jobs.get(&id) else {
                            return Ok(());
                        };
                        if ![
                            format!("{}-complete", job.kind),
                            format!("{}-error", job.kind),
                            format!("{}-progress", job.kind),
                        ]
                        .contains(&name.to_owned())
                        {
                            return Err(error("Plugin job event does not match its owned kind"));
                        }
                        if name.ends_with("-complete") || name.ends_with("-error") {
                            jobs.remove(&id);
                        }
                    }
                    if name == "image-generation:operation-changed" {
                        return super::service_bridge::event_update(self.clone(), payload.clone());
                    }
                    if name.starts_with("image-generation:") {
                        if self.package_id != "xnmp.image-generation"
                            || name != "image-generation:configuration-changed"
                            || !self.is_active()
                        {
                            return Err(error("Plugin does not own this configuration event"));
                        }
                        let revision = payload["documentRevision"]
                            .as_u64()
                            .filter(|value| *value <= 9_007_199_254_740_991)
                            .ok_or_else(|| error("Invalid image configuration revision"))?;
                        let affected = payload["affectedProfileIds"]
                            .as_array()
                            .filter(|ids| ids.len() <= 128)
                            .ok_or_else(|| error("Invalid image configuration event"))?;
                        if affected.iter().any(|id| {
                            !id.as_str().is_some_and(|id| {
                                !id.is_empty()
                                    && id.len() <= 128
                                    && id
                                        .bytes()
                                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                            })
                        }) {
                            return Err(error("Invalid image profile identity"));
                        }
                        return self
                            .app
                            .emit(
                                name,
                                json!({"documentRevision":revision,"affectedProfileIds":affected}),
                            )
                            .map_err(|cause| error(cause.to_string()));
                    }
                    self.app
                        .emit(name, payload)
                        .map_err(|cause| error(cause.to_string()))?;
                }
                "host.process.run" => {
                    if let Err(cause) = self.run_process(&frame) {
                        self.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32002,"message":cause.to_string(),"data":{"code":cause.service_code()}}}))?;
                    }
                }
                "host.text.describe" | "host.text.generate" | "host.text.cancel" => {
                    self.text_request(frame.clone())?;
                }
                method
                    if method.starts_with("host.services.")
                        || method.starts_with("host.artifacts.")
                        || method.starts_with("host.credentials.") =>
                {
                    super::service_bridge::handle(self.clone(), frame.clone())?;
                }
                "host.process.cancel" => {
                    if let Some(id) = frame["params"]["requestId"].as_str() {
                        if let Some(control) = self
                            .controls
                            .lock()
                            .unwrap_or_else(|cause| cause.into_inner())
                            .get(id)
                        {
                            control.cancel();
                        }
                        self.spools
                            .lock()
                            .unwrap_or_else(|cause| cause.into_inner())
                            .remove(id);
                    }
                }
                "host.process.release" => {
                    if let Some(handle) = frame["params"]["handle"].as_str() {
                        self.spools
                            .lock()
                            .unwrap_or_else(|cause| cause.into_inner())
                            .remove(handle);
                    }
                }
                _ => return Err(error("Unsupported plugin host service")),
            }
            return Ok(());
        }
        let id = frame["id"]
            .as_u64()
            .ok_or_else(|| error("Invalid plugin response ID"))?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| error("Plugin reply lock is unavailable"))?;
        let Some(waiter) = pending.get_mut(&id) else {
            return Ok(());
        };
        let response = if let Some(chunk) = frame.get("chunk") {
            if chunk["sequence"].as_u64() != Some(waiter.sequence) {
                return Err(error("Plugin response chunks arrived out of order"));
            }
            let data = base64::engine::general_purpose::STANDARD
                .decode(
                    chunk["data"]
                        .as_str()
                        .ok_or_else(|| error("Invalid plugin response chunk"))?,
                )
                .map_err(|_| error("Invalid plugin response chunk"))?;
            if data.len() > 256 * 1024 || waiter.bytes.len() + data.len() > 32 * 1024 * 1024 {
                return Err(error("Plugin response exceeds size limit"));
            }
            waiter.sequence += 1;
            waiter.bytes.extend(data);
            if !chunk["final"]
                .as_bool()
                .ok_or_else(|| error("Invalid plugin response chunk"))?
            {
                return Ok(());
            }
            serde_json::from_slice::<Value>(&waiter.bytes)
                .map_err(|_| error("Invalid chunked plugin reply"))?
        } else {
            frame
        };
        if response["jsonrpc"] != "2.0"
            || response["id"].as_u64() != Some(id)
            || response.get("result").is_some() == response.get("error").is_some()
        {
            return Err(error("Invalid plugin response correlation or envelope"));
        }
        let waiter = pending.remove(&id).expect("reply was found");
        let result = if let Some(cause) = response.get("error") {
            let message = cause["message"]
                .as_str()
                .unwrap_or("Plugin request failed")
                .to_owned();
            if self.installed.manifest.sdk_version >= 3 {
                let code = cause["data"]["code"]
                    .as_str()
                    .filter(|code| {
                        !code.is_empty()
                            && code.len() <= 64
                            && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    })
                    .unwrap_or("protocol_error")
                    .to_owned();
                Err(AppError::Service {
                    code,
                    message: if message.chars().count() <= 512
                        && !message.chars().any(char::is_control)
                    {
                        message
                    } else {
                        "Plugin service failed".into()
                    },
                })
            } else {
                Err(error(message))
            }
        } else {
            Ok(response["result"].clone())
        };
        let _ = waiter.sender.send(result);
        Ok(())
    }

    fn run_process(self: &Arc<Self>, frame: &Value) -> Result<(), AppError> {
        if self.installed.manifest.sdk_version >= 3 && !self.is_active() {
            return Err(error("Plugin is not active"));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Process {
            program: String,
            args: Vec<String>,
            cwd: Option<PathBuf>,
            env: Vec<(String, Option<String>)>,
            stdout_limit: usize,
            stderr_limit: usize,
        }
        let id = frame["id"]
            .as_str()
            .filter(|id| id.starts_with("host:") && id.len() < 100)
            .ok_or_else(|| error("Invalid host-service request ID"))?
            .to_owned();
        let request: Process = serde_json::from_value(frame["params"].clone())
            .map_err(|_| error("Invalid host process request"))?;
        if !PathBuf::from(&request.program).is_absolute()
            || request.args.len() > 128
            || request.env.len() > 128
            || request.args.iter().any(|arg| arg.len() > 64 * 1024)
            || request.stdout_limit > 16 * 1024 * 1024
            || request.stderr_limit > 1024 * 1024
        {
            return Err(error("Host process request exceeds its limits"));
        }
        let control = JobControl::new();
        let spool = Arc::new(
            tempfile::Builder::new()
                .prefix("tauri-explorer-plugin-output-")
                .tempdir()?,
        );
        let lease = {
            let _gate = super::read_lifecycle()?;
            if self.installed.manifest.sdk_version >= 3 && !self.is_active() {
                return Err(error("Plugin is not active for process admission"));
            }
            let lease = CallLease::acquire(&self.package_id)?;
            let mut controls = self
                .controls
                .lock()
                .map_err(|_| error("Plugin process lock is unavailable"))?;
            if controls.len() >= 4 || controls.contains_key(&id) {
                return Err(error("Plugin process capacity reached"));
            }
            let mut spools = self
                .spools
                .lock()
                .map_err(|_| error("Plugin spool lock is unavailable"))?;
            if !self.alive.load(Ordering::Acquire) || spools.len() >= 8 {
                return Err(error("Plugin output spool capacity reached"));
            }
            spools.insert(id.clone(), spool.clone());
            controls.insert(id.clone(), control.clone());
            lease
        };
        let owner = self.clone();
        let cleanup_owner = self.clone();
        let cleanup_id = id.clone();
        let cleanup_control = control.clone();
        let keep_spool = Arc::new(AtomicBool::new(false));
        let cleanup_keep = keep_spool.clone();
        let cleanup = WorkerCleanup::new(move || {
            cleanup_process_resources(
                &cleanup_owner.controls,
                &cleanup_owner.spools,
                &cleanup_id,
                &cleanup_control,
                cleanup_keep.load(Ordering::Acquire),
            );
        });
        let admission = ProcessAdmission {
            _cleanup: cleanup,
            spool,
            _lease: lease,
        };
        spawn_worker("plugin-owned-process", move || {
            // Move the whole owner into the worker, preserving field drop
            // order both on rejected spawn and after actual process/byte IO.
            let admission=admission;
            let spool=&admission.spool;
            let result = (|| {
                let mut command = Command::new(&request.program);
                command.no_console().args(request.args);
                if let Some(cwd) = request.cwd {
                    command.current_dir(cwd);
                }
                for (key, value) in request.env {
                    if let Some(value) = value {
                        command.env(key, value);
                    } else {
                        command.env_remove(key);
                    }
                }
                command.stdin(Stdio::null());
                #[cfg(unix)]
                let output_controlled = if owner.installed.manifest.sdk_version >= 3 {
                    crate::process_supervisor::output_controlled
                } else {
                    output_controlled
                };
                let output = output_controlled(
                    &mut command,
                    || !owner.alive.load(Ordering::Acquire) || control.check().is_err(),
                    (request.stdout_limit, request.stderr_limit),
                    "Plugin process cancelled",
                )?;
                if !owner.alive.load(Ordering::Acquire) || control.check().is_err() {
                    return Err(error("Plugin process cancelled"));
                }
                let stdout = spool.path().join("stdout");
                let stderr = spool.path().join("stderr");
                fs::write(&stdout, output.stdout)?;
                fs::write(&stderr, output.stderr)?;
                #[cfg(unix)]
                let status = {
                    use std::os::unix::process::ExitStatusExt;
                    output.status.into_raw() as i64
                };
                #[cfg(windows)]
                let status = {
                    i64::from(
                        output
                            .status
                            .code()
                            .ok_or_else(|| error("Process exit code is unavailable"))?
                            as u32,
                    )
                };
                {
                    let spools = owner
                        .spools
                        .lock()
                        .map_err(|_| error("Plugin spool lock is unavailable"))?;
                    if !owner.alive.load(Ordering::Acquire)
                        || !spools.contains_key(&id)
                        || control.check().is_err()
                    {
                        return Err(error("Plugin process cancelled"));
                    }
                }
                Ok::<_, AppError>(
                    json!({"handle":id,"status":status,"stdout":stdout,"stderr":stderr}),
                )
            })();
            let completed = result.is_ok();
            let response = match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(cause) => {
                    if owner.installed.manifest.sdk_version>=3 {
                        // No failed host execution reply proves that a CLI did
                        // not submit remotely. Preserve uncertainty across the
                        // RPC boundary, including cancellation and output loss.
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Owned plugin process did not provide a complete result","data":{"code":"interrupted"}}})
                    } else {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":cause.to_string(),"data":{"code":cause.service_code()}}})
                    }
                }
            };
            if owner.send(&response).is_err() {
                owner
                    .spools
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .remove(&id);
                owner.fail("Plugin service reply could not be delivered");
            } else if completed {
                keep_spool.store(true, Ordering::Release);
            }
        }).map_err(|_| AppError::Service {
            code: "interrupted".into(),
            message: "Owned plugin process worker could not be started".into(),
        })?;
        Ok(())
    }

    fn stop(&self) {
        if self.validation_only {
            CANDIDATES
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .remove(&self.incarnation);
        }
        self.retired.store(true, Ordering::Release);
        self.fail("Plugin backend stopped; inspect history before repeating generation");
        self.input
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take();
        let mut child = self.child.lock().unwrap_or_else(|cause| cause.into_inner());
        terminate_owned_tree(&mut child, &self.tree_stopped);
        let deadline = Instant::now() + Duration::from_secs(2);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
            let _ = child.wait();
        }
        drop(child);
        self.spools
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .clear();
        join_io_workers(&self.io_workers);
    }

    fn retain_io_worker(&self, worker: std::thread::JoinHandle<()>) {
        let orphan = {
            let mut workers = self
                .io_workers
                .lock()
                .unwrap_or_else(|cause| cause.into_inner());
            if self.alive.load(Ordering::Acquire) {
                workers.push(worker);
                None
            } else {
                Some(worker)
            }
        };
        // A concurrent shutdown may have already drained the list. Do not
        // publish a later startup worker beyond that teardown boundary.
        if let Some(worker) = orphan {
            let _ = worker.join();
        }
    }
}

pub(super) fn ensure(id: &str) -> Result<Arc<Broker>, AppError> {
    // Startup/activation are owned before taking the package startup mutex.
    // Mutation cannot fence a package whose handshake has already begun.
    let _startup_admission = {
        let _gate = super::read_lifecycle()?;
        if !OWNERSHIP_READY.load(Ordering::Acquire) {
            return Err(error("Plugin ownership recovery is incomplete"));
        }
        CallLease::acquire_direction(id, 3)?
    };
    let broker = ensure_mode(id)?;
    if !broker.is_active() {
        broker.activate()?;
    }
    if matches!(id, "xnmp.trace-explorer" | "xnmp.image-generation") {
        schedule_image_migration();
    }
    Ok(broker)
}
static IMAGE_MIGRATION: AtomicBool = AtomicBool::new(false);
fn spawn_image_migration(work: impl FnOnce() + Send + 'static) -> Result<bool, AppError> {
    if IMAGE_MIGRATION
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(false);
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            IMAGE_MIGRATION.store(false, Ordering::Release);
        }
    }
    // Owned before spawning, including OS refusal and callback panic.
    let done = Done;
    spawn_worker("native-image-migration", move || {
        let _done = done;
        work();
    })
    .map_err(|_| error("Image connection import worker could not start"))?;
    Ok(true)
}
fn schedule_image_migration() {
    // One owned coordinator, never a worker per renderer request. Candidate
    // preflight does not enter ensure() and cannot install this source fence.
    let scheduled = spawn_image_migration(|| {
        let result = (|| -> Result<(), AppError> {
            let eligible = {
                let _gate = super::read_lifecycle()?;
                let packages = package::list(&super::root()?)?;
                ["xnmp.trace-explorer", "xnmp.image-generation"]
                    .iter()
                    .all(|id| {
                        packages.iter().any(|p| {
                            p.manifest.id == *id && p.enabled && p.manifest.sdk_version >= 3
                        })
                    })
            };
            if !eligible {
                return Ok(());
            }
            let trace = ensure("xnmp.trace-explorer")?;
            let provider = ensure("xnmp.image-generation")?;
            let (_consumer_lease, _provider_lease) = {
                let _gate = super::read_lifecycle()?;
                let packages = package::list(&super::root()?)?;
                if !trace.is_active()
                    || !provider.is_active()
                    || !migration_bindings_current(&packages, &trace.installed, &provider.installed)
                {
                    return Ok(());
                }
                (
                    CallLease::acquire(&trace.package_id)?,
                    CallLease::acquire(&provider.package_id)?,
                )
            };
            struct Destination(Arc<Broker>);
            impl crate::ai::image_migration::Destination for Destination {
                fn call(
                    &self,
                    method: &str,
                    mut params: Value,
                ) -> crate::ai::domain::Result<Value> {
                    if !matches!(
                        method,
                        "settings.read" | "migration.status" | "migration.import"
                    ) {
                        return Err(crate::ai::ServiceError::new(
                            "permission_denied",
                            "Unknown native migration method",
                        ));
                    }
                    params["controlToken"] = json!(self.0.control_token);
                    self.0.call(method, params).map_err(|error| {
                        crate::ai::ServiceError::new(
                            match error.service_code() {
                                "configuration_changed" => "configuration_changed",
                                "operation_conflict" => "operation_conflict",
                                "mutation_uncertain" => "mutation_uncertain",
                                "timed_out" => "timed_out",
                                _ => "unavailable",
                            },
                            "Image connection import is pending; its source settings are retained",
                        )
                    })
                }
            }
            crate::ai::image_migration::migrate(
                &crate::config::config_dir()?,
                &crate::ai::credentials::OsSecrets,
                &Destination(provider),
            )
            .map_err(|error| AppError::Service {
                code: error.code.into(),
                message: error.message,
            })?;
            let _ = trace
                .app
                .emit("config-file-changed", "plugin.openai-image.json");
            let _ = trace
                .app
                .emit("ai:image-migration-changed", json!({"state":"complete"}));
            Ok(())
        })();
        if let Err(error) = result {
            log::warn!("Image migration pending: {}", error.service_code());
            if let Some(app) = APP.get() {
                let _=app.emit("ai:image-migration-changed",json!({"state":"pending","error":{"code":error.service_code(),"message":"Image connection import is pending; original settings are retained. Unlock credential storage or open Image Generation connections."}}));
            }
        }
    });
    if let Err(cause) = scheduled {
        log::warn!("Image connection import pending: {cause}");
    }
}
fn migration_bindings_current(
    packages: &[package::Installed],
    trace: &package::Installed,
    provider: &package::Installed,
) -> bool {
    [trace, provider].iter().all(|bound| {
        bound.manifest.sdk_version >= 3
            && packages.iter().any(|current| {
                current.enabled
                    && current.manifest.id == bound.manifest.id
                    && current.digest == bound.digest
                    && current.manifest.sdk_version >= 3
            })
    })
}
#[cfg(test)]
mod migration_binding_tests {
    use super::*;
    fn installed(id: &str) -> package::Installed {
        serde_json::from_value(json!({"enabled":true,"digest":"a".repeat(64),"manifest":{"formatVersion":1,"id":id,"name":"fixture","description":"fixture","version":"1.0.0","sdkVersion":3,"svelteVersion":"5.56.3","target":"fixture","frontend":"index.js","styles":"index.css","backend":"fixture","contributions":[],"files":{}}})).unwrap()
    }
    #[test]
    fn final_cutover_lease_refuses_a_rollback_or_replacement_winning_after_initial_eligibility() {
        let trace = installed("xnmp.trace-explorer");
        let provider = installed("xnmp.image-generation");
        let current = vec![trace.clone(), provider.clone()];
        assert!(migration_bindings_current(&current, &trace, &provider));
        for role in 0..2 {
            for alteration in 0..3 {
                let mut current = current.clone();
                match alteration {
                    0 => current[role].manifest.sdk_version = 2,
                    1 => current[role].digest = "b".repeat(64),
                    _ => current[role].enabled = false,
                };
                assert!(!migration_bindings_current(&current, &trace, &provider));
            }
        }
        let mut legacy = trace.clone();
        legacy.manifest.sdk_version = 2;
        assert!(!migration_bindings_current(
            &[legacy.clone(), provider.clone()],
            &legacy,
            &provider
        ));
    }
}
pub(super) fn activate(id: &str) -> Result<(), AppError> {
    ensure(id).map(|_| ())
}
/// Created under the short lifecycle write gate after busy/claim checks. No
/// new frontend/reverse admission may race the subsequent unlocked handshake.
pub(super) struct DrainGuard {
    id: String,
    broker: Option<Arc<Broker>>,
    recovery_required: AtomicBool,
}
pub(super) fn begin_drain(id: &str) -> Result<DrainGuard, AppError> {
    // The caller holds the short lifecycle write gate. Admission and fencing
    // share a mutex so even a caller without a Broker cannot cross this point.
    let mut admissions = crate::native_deadline::lock(
        CALLS.get_or_init(Default::default),
        "Plugin admission lock is unavailable",
    )?;
    if admissions.fenced.contains(id)
        || admissions
            .calls
            .iter()
            .any(|((package, _), count)| package == id && *count > 0)
    {
        return Err(error(
            "Finish active plugin operations before changing this package",
        ));
    }
    let broker = brokers()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .get(id)
        .cloned();
    if let Some(broker) = &broker {
        if broker.installed.manifest.sdk_version >= 3 && broker.is_active() {
            broker
                .phase
                .compare_exchange(
                    ACTIVE_PHASE,
                    DRAINING_PHASE,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .map_err(|_| error("Plugin lifecycle state changed"))?;
        }
    }
    admissions.fenced.insert(id.to_owned());
    Ok(DrainGuard {
        id: id.to_owned(),
        broker,
        recovery_required: AtomicBool::new(false),
    })
}
impl DrainGuard {
    pub(super) fn retain_for_recovery(&self) {
        self.recovery_required.store(true, Ordering::Release);
    }
    pub(super) fn quiesce(&self) -> Result<(), AppError> {
        if let Some(broker) = &self.broker {
            if broker.installed.manifest.sdk_version >= 3
                && broker.phase.load(Ordering::Acquire) == DRAINING_PHASE
            {
                let result = broker.call("lifecycle.quiesce", json!({}))?;
                if result["ready"] != false
                    || result["idle"] != true
                    || result["checkpoint"] != true
                {
                    return Err(error(
                        "Plugin did not prove idle checkpointed state before lifecycle change",
                    ));
                }
            }
        }
        Ok(())
    }
}
impl Drop for DrainGuard {
    fn drop(&mut self) {
        if self.recovery_required.load(Ordering::Acquire) {
            CALLS
                .get_or_init(Default::default)
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .recovery_fences
                .insert(self.id.clone());
            return;
        }
        if let Some(broker) = &self.broker {
            if broker.alive.load(Ordering::Acquire) && !broker.retired.load(Ordering::Acquire) {
                // A refused mutation becomes activatable on its next ordinary
                // admission. Drop never waits on RPC or invokes callbacks.
                let _ = broker.phase.compare_exchange(
                    DRAINING_PHASE,
                    PREFLIGHT_PHASE,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
            }
        }
        CALLS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .fenced
            .remove(&self.id);
    }
}
pub(super) fn release_recovered_fence(id: &str) -> Result<(), AppError> {
    let mut admissions = CALLS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| error("Plugin admission lock is unavailable"))?;
    if !admissions.recovery_fences.contains(id) {
        return Ok(());
    }
    if admissions
        .calls
        .iter()
        .any(|((package, _), count)| package == id && *count > 0)
        || brokers()
            .lock()
            .map_err(|_| error("Plugin runtime lock is unavailable"))?
            .get(id)
            .is_some_and(|broker| broker.alive.load(Ordering::Acquire))
        || CANDIDATES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| error("Plugin candidate ownership lock is unavailable"))?
            .values()
            .any(|broker| broker.package_id == id)
    {
        return Err(error("Recovered plugin still owns native work"));
    }
    admissions.recovery_fences.remove(id);
    admissions.fenced.remove(id);
    Ok(())
}
pub(super) fn active_instance(id: &str, digest: &str) -> Option<Arc<Broker>> {
    crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")
        .ok()?
        .get(id)
        .filter(|broker| broker.is_active() && broker.installed.digest == digest)
        .cloned()
}
pub(super) fn preflight_candidate(
    installed: &package::Installed,
    data: PathBuf,
    fence: &DrainGuard,
) -> Result<(), AppError> {
    if installed.manifest.id != fence.id {
        return Err(error("Candidate does not own its package mutation fence"));
    }
    let broker = start_broker(installed.clone(), data, true)?;
    // Validation always ends in retirement, never activation of the copied DB.
    broker.stop();
    Ok(())
}
fn ensure_mode(id: &str) -> Result<Arc<Broker>, AppError> {
    crate::native_deadline::check()?;
    let startup = crate::native_deadline::lock(
        STARTING.get_or_init(Default::default),
        "Plugin startup map is unavailable",
    )?
    .entry(id.into())
    .or_insert_with(|| Arc::new(Mutex::new(())))
    .clone();
    let _starting = crate::native_deadline::lock(&startup, "Plugin startup lock is unavailable")?;
    if CLOSING.load(Ordering::Acquire) {
        return Err(error("Plugin host is shutting down"));
    }
    let mut registry =
        crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")?;
    // Shutdown drains this same registry. Rechecking while holding it prevents
    // publishing a child after that drain has completed.
    if CLOSING.load(Ordering::Acquire) {
        return Err(error("Plugin host is shutting down"));
    }
    if let Some(broker) = registry
        .get(id)
        .filter(|broker| broker.alive.load(Ordering::Acquire))
    {
        return Ok(broker.clone());
    }
    let previous = registry.remove(id);
    drop(registry);
    if let Some(old) = previous {
        old.stop();
    }
    let installed = package::list(&root()?)?
        .into_iter()
        .find(|entry| entry.manifest.id == id && entry.enabled)
        .ok_or_else(|| error("Plugin package is disabled or removed"))?;
    super::service_graph::validate_enabled(&package::list(&root()?)?)?;
    if installed.manifest.sdk_version < 3 {
        super::service_host::require_legacy_consumer_compatible(super::service_host::store()?, id)?;
    }
    let data = config::config_dir()?.join("plugin-data").join(id);
    fs::create_dir_all(&data)?;
    if installed.manifest.sdk_version >= 3 {
        super::service_host::store()?.register_consumer_root(id, dunce::canonicalize(&data)?)?;
    }
    for filename in &installed.manifest.initial_data_files {
        let destination = data.join(filename);
        let source = config::config_dir()?.join(filename);
        if !destination.exists() && source.is_file() {
            fs::copy(source, destination)?;
        }
    }
    start_broker(installed, data, false)
}
fn start_broker(
    installed: package::Installed,
    data: PathBuf,
    validation_only: bool,
) -> Result<Arc<Broker>, AppError> {
    crate::native_deadline::check()?;
    if CLOSING.load(Ordering::Acquire) {
        return Err(error("Plugin host is shutting down"));
    }
    let id = installed.manifest.id.as_str();
    let app = APP
        .get()
        .ok_or_else(|| error("Plugin host is not initialized"))?
        .clone();
    let binary = package::backend_path(&root()?, &installed)?;
    let mut command = Command::new(binary);
    command
        .no_console()
        .args([std::ffi::OsStr::new("--data-dir"), data.as_os_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let incarnation = next_incarnation()?;
    let mut token = [0u8; 32];
    getrandom::fill(&mut token).map_err(|_| error("Could not allocate native control token"))?;
    crate::native_deadline::check()?;
    if CLOSING.load(Ordering::Acquire) {
        return Err(error("Plugin host is shutting down"));
    }
    let mut child = command.spawn()?;
    let pipes = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
        (Some(input), Some(stdout), Some(stderr)) => (input, stdout, stderr),
        _ => {
            terminate_owned_tree(&mut child, &AtomicBool::new(false));
            let _ = child.wait();
            return Err(error("Plugin process pipes are unavailable"));
        }
    };
    let (mut input, stdout, mut stderr) = pipes;
    let (writer, frames) = mpsc::sync_channel::<Vec<u8>>(16);
    let (controls, control_frames) = mpsc::sync_channel::<Vec<u8>>(16);
    let (callbacks, callback_frames) = mpsc::sync_channel::<Vec<u8>>(32);
    let broker = Arc::new(Broker {
        package_id: id.to_owned(),
        installed: installed.clone(),
        validation_only,
        app,
        child: Mutex::new(child),
        input: Mutex::new(Some(Inputs {
            normal: writer,
            control: controls,
            callback: callbacks,
        })),
        alive: AtomicBool::new(true),
        tree_stopped: AtomicBool::new(false),
        retired: AtomicBool::new(false),
        phase: AtomicU8::new(STARTING_PHASE),
        activation: Mutex::new(()),
        reverse_pending: [
            AtomicUsize::new(0),
            AtomicUsize::new(0),
            AtomicUsize::new(0),
        ],
        incarnation,
        control_token: hex::encode(token),
        diagnostics: Mutex::new(Default::default()),
        text_bridge: OnceLock::new(),
        sequence: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        jobs: Mutex::new(HashMap::new()),
        controls: Mutex::new(HashMap::new()),
        spools: Mutex::new(HashMap::new()),
        io_workers: Mutex::new(Vec::new()),
    });
    let mut startup = StartupGuard(Some(broker.clone()));
    // Only ordinary startup enters the routable process map. The private
    // candidate is owned solely by this mutation and StartupGuard.
    if !validation_only {
        let mut registry = brokers()
            .lock()
            .map_err(|_| error("Plugin runtime lock is unavailable"))?;
        if CLOSING.load(Ordering::Acquire) {
            drop(registry);
            return Err(error("Plugin host is shutting down"));
        }
        registry.insert(id.to_owned(), broker.clone());
    } else {
        let mut candidates = CANDIDATES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| error("Plugin candidate ownership lock is unavailable"))?;
        if CLOSING.load(Ordering::Acquire) {
            drop(candidates);
            return Err(error("Plugin host is shutting down"));
        }
        candidates.insert(broker.incarnation, broker.clone());
    }
    let diagnostic_owner = Arc::downgrade(&broker);
    let worker = spawn_worker("plugin-stderr", move || {
        let mut bytes = [0u8; 4096];
        loop {
            let length = match stderr.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(length) => length,
            };
            let Some(owner) = diagnostic_owner.upgrade() else {
                break;
            };
            owner
                .diagnostics
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .push(&bytes[..length]);
        }
    })
    .map_err(|_| error("Plugin stderr worker could not be started"))?;
    broker.retain_io_worker(worker);
    let writer_owner = Arc::downgrade(&broker);
    let worker = spawn_worker("plugin-writer", move || loop {
        if !writer_owner
            .upgrade()
            .is_some_and(|owner| owner.alive.load(Ordering::Acquire))
        {
            break;
        }
        let frame = match callback_frames
            .try_recv()
            .or_else(|_| control_frames.try_recv())
        {
            Ok(frame) => frame,
            Err(_) => match frames.recv_timeout(Duration::from_millis(10)) {
                Ok(frame) => frame,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
        };
        if let Err(cause) = input
            .write_all(&frame)
            .and_then(|()| input.write_all(b"\n"))
            .and_then(|()| input.flush())
        {
            if let Some(owner) = writer_owner.upgrade() {
                owner.fail(&format!("Plugin writer disconnected: {cause}"));
            }
            break;
        }
    })
    .map_err(|_| error("Plugin writer worker could not be started"))?;
    broker.retain_io_worker(worker);
    let weak = Arc::downgrade(&broker);
    let worker = spawn_worker("plugin-reader", move || {
        let mut input = BufReader::new(stdout);
        loop {
            let mut frame = vec![];
            let read = input
                .by_ref()
                .take(1024 * 1024 + 2)
                .read_until(b'\n', &mut frame);
            let Some(owner) = weak.upgrade() else {
                break;
            };
            let body_size = frame.len() - usize::from(frame.last() == Some(&b'\n'));
            if !matches!(read,Ok(size)if size>0&&body_size<=1024*1024) {
                owner.fail(&owner.disconnect_reason());
                break;
            }
            let result = serde_json::from_slice(&frame)
                .map_err(|_| error("Plugin emitted malformed JSON"))
                .and_then(|value| owner.receive(value));
            if let Err(cause) = result {
                owner.fail(&cause.to_string());
                break;
            }
        }
    })
    .map_err(|_| error("Plugin reader worker could not be started"))?;
    broker.retain_io_worker(worker);
    let deferred = validation_only || installed.manifest.sdk_version >= 3;
    let ownership = if !validation_only && installed.manifest.sdk_version < 3 {
        Some(super::provenance::ownership_guard()?)
    } else {
        None
    };
    let initialized = broker.call(
        "initialize",
        json!({"protocolVersion":1,"activeRunIds":if validation_only {vec![]} else {super::provenance::active_runs(id)},"processService":true,"textService":{"version":1},"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1},"hostControl":{"token":broker.control_token},"validationOnly":validation_only,"deferRecovery":deferred}),
    );
    // Legacy reconciliation serialization must not survive into failure cleanup.
    drop(ownership);
    match initialized {
        Ok(result) if result["protocolVersion"] == 1 && result["ready"] == !deferred => {}
        Ok(_) => {
            broker.stop();
            return Err(error("Plugin backend protocol mismatch"));
        }
        Err(cause) => {
            broker.stop();
            return Err(cause);
        }
    }
    broker.phase.store(
        if deferred {
            PREFLIGHT_PHASE
        } else {
            ACTIVE_PHASE
        },
        Ordering::Release,
    );
    startup.0.take();
    Ok(broker)
}

pub(super) fn is_closing() -> bool {
    CLOSING.load(Ordering::Acquire)
}

pub(super) fn emit_operations_changed() {
    if let Some(app) = APP.get() {
        let _ = app.emit("ai:operations-changed", ());
    }
}
pub(super) fn emit_job_event(payload: Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit("plugin-jobs:changed", payload);
    }
}
pub(super) fn call(id: &str, method: &str, params: Value) -> Result<Value, AppError> {
    call_with_origin(id, method, params, "native", std::time::SystemTime::now())
}
/// A generation's ten-minute budget starts when the request entered native
/// code, so blocking-pool queueing and admission count against it.
fn operation_deadline_ms(entered: std::time::SystemTime) -> u64 {
    entered
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .saturating_add(600_000)
        .min(9_007_199_254_740_991) as u64
}
#[cfg(test)]
mod deadline_tests {
    use super::operation_deadline_ms;
    use std::time::{Duration, UNIX_EPOCH};
    #[test]
    fn budget_is_measured_from_native_entry_not_dispatch() {
        let entered = UNIX_EPOCH + Duration::from_millis(1_000_000);
        assert_eq!(operation_deadline_ms(entered), 1_600_000);
    }
    #[test]
    fn pre_epoch_and_far_future_clocks_stay_in_json_safe_range() {
        assert_eq!(
            operation_deadline_ms(UNIX_EPOCH - Duration::from_secs(5)),
            600_000
        );
        // Windows SystemTime cannot represent instants this far out.
        #[cfg(not(windows))]
        {
            let far = UNIX_EPOCH + Duration::from_secs(u64::MAX / 4);
            assert_eq!(operation_deadline_ms(far), 9_007_199_254_740_991);
        }
    }
}
pub(super) fn call_with_origin(
    id: &str,
    method: &str,
    mut params: Value,
    origin_label: &str,
    entered: std::time::SystemTime,
) -> Result<Value, AppError> {
    let operation_deadline = operation_deadline_ms(entered);
    if !params.is_object() || method.len() > 128 {
        return Err(error("Invalid plugin request"));
    }
    if matches!(
        method,
        "initialize" | "jobs.cancelOperation" | "jobs.resumeOperation"
    ) || method.starts_with("host.")
        || method.starts_with("lifecycle.")
        || method.starts_with("control.")
        || method.starts_with("migration.")
        || method.starts_with("services.")
    {
        return Err(error("Plugin method is owned by the host"));
    }
    let broker = ensure(id)?;
    let mut durable_job = None;
    let job = if method == "jobs.start" {
        let mut operation = [0u8; 16];
        getrandom::fill(&mut operation)
            .map_err(|cause| error(format!("Could not allocate image operation ID: {cause}")))?;
        let operation_id = hex::encode(operation);
        params["operationId"] = json!(operation_id);
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| {
                !kind.is_empty()
                    && kind.len() < 100
                    && kind
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            .ok_or_else(|| error("Invalid plugin job kind"))?
            .to_owned();
        let id = if broker.installed.manifest.sdk_version >= 3 {
            params["operationDeadlineAtMs"] = json!(operation_deadline);
            let record = super::job_bridge::register(
                broker.generation(),
                &operation_id,
                &kind,
                &super::job_bridge::origin(origin_label)?,
            )?;
            let id = record.job_id;
            durable_job = Some(record);
            id
        } else {
            crate::plugin_job::next_job_id()
        };
        params["jobId"] = json!(id);
        broker
            .jobs
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .insert(
                id,
                Job {
                    kind,
                    operation_id: operation_id.clone(),
                },
            );
        Some((id, operation_id))
    } else {
        None
    };
    let result = broker.call(method, params);
    if let Some(record) = durable_job.as_ref() {
        super::job_bridge::schedule_status(broker.clone(), record.clone());
    }
    if result.is_err() {
        if let Some((job_id, operation_id)) = job {
            if let Ok(status) = ensure(id).and_then(|current| {
                current.call("jobs.status", json!({"operationId":operation_id}))
            }) {
                if status["jobId"].as_u64() == Some(job_id) {
                    return Ok(json!(job_id));
                }
                if let (Some(record), Err(cause)) = (durable_job.as_ref(), &result) {
                    let _ = super::job_bridge::rejected(record, cause, &broker, &status);
                }
            }
            broker
                .jobs
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .remove(&job_id);
        }
    }
    result
}

pub(super) fn busy(id: &str) -> bool {
    CALLS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .calls
        .iter()
        .any(|((package, _), count)| package == id && *count > 0)
        || !super::provenance::active_runs(id).is_empty()
        || brokers()
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .get(id)
            .is_some_and(|broker| {
                !broker
                    .controls
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .is_empty()
                    || broker
                        .text_bridge
                        .get()
                        .is_some_and(|bridge| bridge.has_pending())
                    || broker
                        .reverse_pending
                        .iter()
                        .any(|count| count.load(Ordering::Acquire) > 0)
                    || !broker
                        .jobs
                        .lock()
                        .unwrap_or_else(|cause| cause.into_inner())
                        .is_empty()
            })
        || recovering()
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .contains_key(id)
}

pub(super) fn retire(id: &str) {
    let retired = {
        brokers()
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .remove(id)
    };
    if let Some(broker) = retired {
        broker.stop();
    }
}

pub(super) fn shutdown() {
    CLOSING.store(true, Ordering::Release);
    let retired: Vec<_> = {
        brokers()
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .drain()
            .map(|(_, broker)| broker)
            .collect()
    };
    let candidates: Vec<_> = {
        CANDIDATES
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .drain()
            .map(|(_, broker)| broker)
            .collect()
    };
    for broker in retired.into_iter().chain(candidates) {
        broker.stop();
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "backend_native_recovery_tests.rs"]
mod native_recovery_tests;
#[cfg(all(test, target_os = "linux"))]
#[path = "backend_native_tests.rs"]
mod native_tests;
