//! One native broker per installed package, shared across every webview.
use super::{package, root};
use crate::{
    config,
    error::{AppError, ProcessRunError},
    plugin_job::JobControl,
    process_ext::NoConsole,
};
use base64::Engine;
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
    // Retain every live owner's revision for idle proofs and shutdown. Only
    // the current revision consumes admission capacity after cancellation.
    calls: HashMap<(String, usize, u64), usize>,
    fenced: HashSet<String>,
    recovery_fences: HashSet<String>,
    idle_fences: HashSet<String>,
    revisions: HashMap<String, u64>,
}
static CALLS: OnceLock<Mutex<Admissions>> = OnceLock::new();
static ADMISSIONS_CHANGED: Condvar = Condvar::new();
pub(super) struct CallLease((String, usize), u64);
/// Owns the admission gap between the worker-idle probes and their durable
/// commit. Controls/callbacks can finish existing work; starts and activation
/// cannot introduce new work, and lifecycle mutation cannot replace a broker.
pub(super) struct IdleCallFence(Vec<String>);
impl IdleCallFence {
    pub(super) fn acquire(packages: &[&str]) -> Result<Self, AppError> {
        let mut packages: Vec<_> = packages.iter().map(|p| (*p).to_owned()).collect();
        packages.sort();
        packages.dedup();
        let mut admissions = crate::native_deadline::lock(
            CALLS.get_or_init(Default::default),
            "Plugin admission lock is unavailable",
        )?;
        if CLOSING.load(Ordering::Acquire)
            || packages.iter().any(|package| {
                admissions.fenced.contains(package)
                    || admissions.idle_fences.contains(package)
                    || admissions.calls.iter().any(|((p, lane, _), count)| {
                        p == package && matches!(lane, 0 | 3) && *count != 0
                    })
            })
        {
            return Err(error("Plugin still owns startup or dispatch work"));
        }
        admissions.idle_fences.extend(packages.iter().cloned());
        Ok(Self(packages))
    }
}
impl Drop for IdleCallFence {
    fn drop(&mut self) {
        let mut admissions = CALLS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for package in &self.0 {
            admissions.idle_fences.remove(package);
        }
        ADMISSIONS_CHANGED.notify_all();
    }
}
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
    pub(super) fn require_current(&self, package: &str) -> Result<(), AppError> {
        if self.0 .0 != package {
            return Err(error("Plugin call admission belongs to another package"));
        }
        publish_startup(package, self.1, || Ok(()))
    }
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
        if admissions.fenced.contains(package)
            || matches!(lane, 0 | 3) && admissions.idle_fences.contains(package)
        {
            return Err(error("Plugin package is draining for a lifecycle change"));
        }
        let revision = admissions.revisions.get(package).copied().unwrap_or(0);
        let key = (package.to_owned(), lane, revision);
        if admissions
            .calls
            .iter()
            .filter(|((owner, direction, revision), _)| {
                *direction == lane
                    && admissions.revisions.get(owner).copied().unwrap_or(0) == *revision
            })
            .map(|(_, count)| count)
            .sum::<usize>()
            >= [64, 16, 32, 16][lane]
            || admissions.calls.get(&key).copied().unwrap_or(0) >= [16, 8, 16, 4][lane]
        {
            return Err(error("Plugin call capacity reached"));
        }
        *admissions.calls.entry(key.clone()).or_default() += 1;
        Ok(Self((key.0, key.1), revision))
    }
}
impl Drop for CallLease {
    fn drop(&mut self) {
        let mut calls = CALLS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|cause| cause.into_inner());
        let key = (self.0 .0.clone(), self.0 .1, self.1);
        if let Some(count) = calls.calls.get_mut(&key) {
            *count -= 1;
            if *count == 0 {
                calls.calls.remove(&key);
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

pub(super) fn generation_live(generation: &crate::service_state::model::PackageGeneration) -> bool {
    brokers()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .get(&generation.package_id)
        .is_some_and(|broker| {
            broker.generation() == *generation && broker.alive.load(Ordering::Acquire)
        })
}
pub(super) fn initialize(app: AppHandle) {
    let _ = APP.set(app);
}
pub(super) fn finish_initialize() {
    OWNERSHIP_READY.store(true, Ordering::Release);
}
/// Profile ownership and startup recovery completed in this process.
pub(super) fn ownership_ready() -> bool {
    OWNERSHIP_READY.load(Ordering::Acquire)
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
    spools: Mutex<HashMap<String, Arc<ProcessSpool>>>,
    io_workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

/// A running writer is pinned independently of its broker. Complete output
/// belongs to the durable store until the provider explicitly releases it.
struct ProcessSpool {
    handle: String,
    path: PathBuf,
    durable: Option<(
        &'static crate::service_state::Store,
        crate::service_state::model::PackageGeneration,
    )>,
    writer: Mutex<Option<crate::service_state::HostSpoolWriter<'static>>>,
    retain: AtomicBool,
    _temporary: Option<tempfile::TempDir>,
}
impl ProcessSpool {
    fn reserve_with_custody(
        owner: &crate::service_state::model::PackageGeneration,
        request: &str,
        limit: u64,
        durable: bool,
        custody: Option<(&str, &str)>,
    ) -> Result<Self, AppError> {
        if durable {
            let store = super::service_host::store()?;
            let (handle, path, writer) =
                store.reserve_pinned_host_spool_with_custody(owner, request, limit, custody)?;
            Ok(Self {
                handle,
                path,
                durable: Some((store, owner.clone())),
                writer: Mutex::new(Some(writer)),
                retain: AtomicBool::new(false),
                _temporary: None,
            })
        } else {
            let temp = tempfile::Builder::new()
                .prefix("tauri-explorer-plugin-output-")
                .tempdir()?;
            Ok(Self {
                handle: request.into(),
                path: temp.path().into(),
                durable: None,
                writer: Mutex::new(None),
                retain: AtomicBool::new(false),
                _temporary: Some(temp),
            })
        }
    }
    fn path(&self) -> &std::path::Path {
        &self.path
    }
    fn stdout_sink(&self) -> Result<fs::File, AppError> {
        if let Some((store, _)) = &self.durable {
            let writer = self
                .writer
                .lock()
                .map_err(|_| error("Plugin spool writer is unavailable"))?;
            return store.open_pinned_host_stdout(
                writer
                    .as_ref()
                    .ok_or_else(|| error("Plugin spool writer was released"))?,
            );
        }
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Ok(options.open(self.path().join("stdout"))?)
    }
    fn complete(&self, stdout: &[u8], stderr: &[u8], status: i64) -> Result<Value, AppError> {
        let writer = self
            .writer
            .lock()
            .map_err(|_| error("Plugin spool writer is unavailable"))?
            .take();
        if let Some((store, owner)) = &self.durable {
            // Preserve evidence even if writing, publication, the provider or
            // the reply transport fails after the CLI has completed.
            self.retain.store(true, Ordering::Release);
            store.write_pinned_host_reply(
                owner,
                writer
                    .as_ref()
                    .ok_or_else(|| error("Plugin spool writer was released"))?,
                stdout,
                stderr,
                status,
            )?;
            match store.retain_pinned_host_execution(
                owner,
                writer
                    .as_ref()
                    .ok_or_else(|| error("Plugin spool writer was released"))?,
                status,
            ) {
                Ok(true) => (),
                Ok(false) => return Err(error("Plugin output reservation was cancelled")),
                // The reservation still supplies durable identity and quota.
                // A failed metadata commit cannot prevent publication of the
                // original bytes and their independently durable manifest.
                Err(cause) => log::debug!("Pending CLI completion update deferred: {cause}"),
            }
        }
        let stdout_path = self.path().join("stdout");
        let stderr_path = self.path().join("stderr");
        if let Some((store, owner)) = &self.durable {
            store.seal_pinned_host_spool(owner, writer.as_ref().unwrap(), status)?;
        } else {
            fs::write(&stdout_path, stdout)?;
            fs::write(&stderr_path, stderr)?;
        }
        Ok(json!({"handle":self.handle,"status":status,"stdout":stdout_path,"stderr":stderr_path}))
    }
}
impl Drop for ProcessSpool {
    fn drop(&mut self) {
        self.writer
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if !self.retain.load(Ordering::Acquire) {
            if let Some((store, owner)) = &self.durable {
                if let Err(cause) =
                    store.abandon_unsealed_host_spool(&owner.package_id, &self.handle)
                {
                    log::warn!("Plugin output cleanup deferred: {cause}")
                }
            }
        }
    }
}

#[cfg(test)]
mod process_spool_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn native_exit_zero_with_excess_stderr_seals_and_recovers_original() {
        use crate::service_state::{
            model::{Limits, PackageGeneration},
            Store,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("service-state");
        let store = Box::leak(Box::new(
            Store::open(path.clone(), Limits::default()).unwrap(),
        ));
        let owner = PackageGeneration {
            package_id: "fixture.diagnostic-spool".into(),
            digest: "a".repeat(64),
            incarnation: 1,
        };
        let original = include_bytes!("../../../e2e-tauri/fixtures/image-crop/quadrants.png");
        let source = root.path().join("original.png");
        fs::write(&source, original).unwrap();
        let (handle, directory, writer) = store
            .reserve_pinned_host_spool(&owner, "host:stderr-overflow", 10240)
            .unwrap();
        let spool = ProcessSpool {
            handle,
            path: directory,
            durable: Some((store, owner.clone())),
            writer: Mutex::new(Some(writer)),
            retain: AtomicBool::new(false),
            _temporary: None,
        };
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "cat \"$1\"; printf diagnostic-prefix >&2; head -c 200000 /dev/zero >&2; printf diagnostic-suffix >&2", "fixture"]);
        command.arg(source);
        let output = crate::process_ext::output_with_input_streaming(
            &mut command,
            || false,
            (8192, 128),
            "cancelled",
            None,
            Some(spool.stdout_sink().unwrap()),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, original);
        assert_eq!(output.stderr.len(), 128);
        assert!(output.stderr.starts_with(b"diagnostic-prefix"));
        assert!(output.stderr.ends_with(b"diagnostic-suffix"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("[stderr truncated]"));
        spool.complete(&output.stdout, &output.stderr, 0).unwrap();
        // Destructor must trust the seal even without its in-memory retain bit.
        spool.retain.store(false, Ordering::Release);
        drop(spool);
        let reopened = Store::open(path, Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let reply = reopened
            .host_spool_result(&owner.package_id, "host:stderr-overflow")
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            original
        );
        assert_eq!(reply["status"], 0);
        reopened
            .release_host_spool(&owner.package_id, reply["handle"].as_str().unwrap())
            .unwrap();
    }

    #[test]
    fn paid_stdout_survives_failed_pending_marker_commit_and_retirement() {
        use crate::service_state::{
            model::{Limits, PackageGeneration},
            Store,
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("service-state");
        let store = Box::leak(Box::new(
            Store::open(path.clone(), Limits::default()).unwrap(),
        ));
        let owner = PackageGeneration {
            package_id: "fixture.paid-spool".into(),
            digest: "a".repeat(64),
            incarnation: 1,
        };
        let (handle, directory, writer) = store
            .reserve_pinned_host_spool(&owner, "host:paid-output", 1024)
            .unwrap();
        let spool = ProcessSpool {
            handle,
            path: directory,
            durable: Some((store, owner.clone())),
            writer: Mutex::new(Some(writer)),
            retain: AtomicBool::new(false),
            _temporary: None,
        };
        store.fail_next_write();
        let _reply = spool.complete(b"sole completed paid output", &[], 0);
        drop(spool);
        store.retire_generation(&owner).unwrap();
        let reopened = Store::open(path, Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let recovered = reopened
            .host_spool_result_for_owner(&owner.package_id, "host:paid-output", Some(&owner))
            .unwrap()
            .expect("the metadata failure discarded the sole paid output");
        assert_eq!(recovered["status"], 0);
        assert_eq!(
            fs::read(recovered["stdout"].as_str().unwrap()).unwrap(),
            b"sole completed paid output"
        );
    }
}

/// Completed process output fixture; uses the broker's actual output custody.
/// The lib harness cannot launch its own Unix supervisor executable.
#[cfg(test)]
pub(super) fn fixture_completed_process_spool(
    package_id: &str,
    bytes: &[u8],
) -> Result<PathBuf, AppError> {
    fixture_completed_bound_process_spool(package_id, bytes, None)
}
#[cfg(test)]
pub(super) fn fixture_completed_bound_process_spool(
    package_id: &str,
    bytes: &[u8],
    custody: Option<(&str, &str)>,
) -> Result<PathBuf, AppError> {
    fixture_process_spool(package_id, bytes, custody, false)
}
#[cfg(test)]
pub(super) fn fixture_pending_process_spool(
    package_id: &str,
    bytes: &[u8],
    custody: Option<(&str, &str)>,
) -> Result<PathBuf, AppError> {
    fixture_process_spool(package_id, bytes, custody, true)
}
#[cfg(test)]
fn fixture_process_spool(
    package_id: &str,
    bytes: &[u8],
    custody: Option<(&str, &str)>,
    pending: bool,
) -> Result<PathBuf, AppError> {
    let broker = ensure(package_id)?;
    let spool = Arc::new(ProcessSpool::reserve_with_custody(
        &broker.generation(),
        "host:fixture-completed",
        bytes.len() as u64,
        true,
        custody,
    )?);
    let path = if pending {
        let store = super::service_host::store()?;
        let writer = spool.writer.lock().unwrap().take().unwrap();
        spool.retain.store(true, Ordering::Release);
        store.write_pinned_host_reply(&broker.generation(), &writer, bytes, &[], 0)?;
        store.retain_pinned_host_execution(&broker.generation(), &writer, 0)?;
        spool.path.join("stdout")
    } else {
        let result = spool.complete(bytes, &[], 0)?;
        PathBuf::from(result["stdout"].as_str().unwrap())
    };
    broker
        .spools
        .lock()
        .map_err(|_| error("Plugin spool lock is unavailable"))?
        .insert("host:fixture-completed".into(), spool);
    Ok(path)
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
struct ProcessAdmission<T, F: FnOnce()> {
    _cleanup: WorkerCleanup<F>,
    spool: Arc<T>,
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

fn cleanup_process_resources<T>(
    controls: &Mutex<HashMap<String, JobControl>>,
    spools: &Mutex<HashMap<String, Arc<T>>>,
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
fn activation_result<T>(
    activate: impl FnOnce() -> Result<T, AppError>,
    stop: impl FnOnce(),
) -> Result<T, AppError> {
    let result = activate();
    if result.is_err() {
        stop();
    }
    result
}
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
    #[cfg(unix)]
    #[test]
    fn automatic_review_failed_activation_terminates_the_owned_backend() {
        use std::os::unix::process::CommandExt;
        for message in ["activation refused", "Plugin activation protocol mismatch"] {
            let child = std::cell::RefCell::new(
                Command::new("sh")
                    .args(["-c", "sleep 30"])
                    .process_group(0)
                    .spawn()
                    .unwrap(),
            );
            let stopped = AtomicBool::new(false);
            let result = activation_result(
                || Err::<(), _>(error(message)),
                || {
                    let mut child = child.borrow_mut();
                    terminate_owned_tree(&mut child, &stopped);
                    child.wait().unwrap();
                },
            );
            let exited = child.borrow_mut().try_wait().unwrap().is_some();
            // Always clean up, including when reproducing the pre-fix failure.
            if !exited {
                let mut child = child.borrow_mut();
                terminate_owned_tree(&mut child, &stopped);
                child.wait().unwrap();
            }
            assert!(result.is_err());
            assert!(
                exited,
                "a rejected activation must not leave its backend alive"
            );
        }
    }
    #[test]
    fn automatic_review_idle_probe_keeps_existing_controls_routable() {
        let package = "fixture.review-existing-controls";
        let _fence = IdleCallFence::acquire(&[package]).unwrap();
        for method in [
            "jobs.cancelOperation",
            "jobs.status",
            "services.image-generation.v1.acknowledge",
        ] {
            let _control = CallLease::acquire_method(package, method).unwrap();
            let routed = ensure_active_or_start(
                package,
                || Ok(Some("active broker")),
                |_| panic!("an existing active broker must not start again"),
            );
            assert_eq!(routed.unwrap(), "active broker");
        }
        assert!(ensure_active_or_start(package, || Ok(None::<()>), |_| Ok(())).is_err());
    }
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
    fn lifecycle_change_cancels_startup_publication_after_its_fence_is_released() {
        let id = "fixture.late-startup-publication";
        let admission = CallLease::acquire_direction(id, 3).unwrap();
        let drain = begin_change(id).unwrap();
        assert!(publish_startup(id, admission.1, || Ok(())).is_err());
        drop(drain);
        assert!(publish_startup(id, admission.1, || Ok(())).is_err());
        let fresh = CallLease::acquire_direction(id, 3).unwrap();
        assert!(publish_startup(id, fresh.1, || Ok(())).is_ok());
    }
    #[test]
    fn lifecycle_change_rejects_a_previously_admitted_ui_call_after_reenable() {
        let id = "fixture.late-ui-dispatch";
        let admission = CallLease::acquire_method(id, "jobs.start").unwrap();
        drop(begin_change(id).unwrap());
        let result = call_admitted(
            id,
            "jobs.start",
            json!({"kind":"image"}),
            "main",
            std::time::SystemTime::now(),
            &admission,
        );
        assert!(result.unwrap_err().to_string().contains("lifecycle change"));
        assert!(CallLease::acquire_method(id, "jobs.start")
            .unwrap()
            .require_current(id)
            .is_ok());
    }
    #[test]
    fn explicit_change_can_take_over_a_durable_recovery_fence_without_reopening_admission() {
        let id = "fixture.removal-recovery-takeover";
        let previous = begin_change(id).unwrap();
        previous.retain_for_recovery();
        drop(previous);
        assert!(CallLease::acquire(id).is_err());
        let recovered = begin_change(id).unwrap();
        assert!(CallLease::acquire(id).is_err());
        drop(recovered);
        assert!(CallLease::acquire(id).is_ok());
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
    /// A `jobs.start` for this job is in flight, or it was accepted here.
    pub(super) fn owns_job(&self, id: u64) -> bool {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&id)
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
        activation_result(
            || {
                let result = self.call("lifecycle.activate", json!({}))?;
                if self.installed.manifest.sdk_version >= 3 && result["ready"] != true {
                    return Err(error("Plugin activation protocol mismatch"));
                }
                Ok(())
            },
            || self.stop(),
        )?;
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
        self.call_reporting(method, params, &mut false)
    }
    /// `sent` becomes true once the request is queued to the writer. A failure
    /// while it is false is definite: the backend never received the request.
    pub(super) fn call_reporting(
        &self,
        method: &str,
        params: Value,
        sent: &mut bool,
    ) -> Result<Value, AppError> {
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
        *sent = true;
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
                        // A lifecycle phase race (a refused drain, activation
                        // pending) is not transport failure. Inactive plugins
                        // cannot publish, so the notification is dropped.
                        log::debug!(
                            "Dropped an event from inactive plugin {} ({name})",
                            self.package_id
                        );
                        return Ok(());
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
                        let mut spools = self
                            .spools
                            .lock()
                            .unwrap_or_else(|cause| cause.into_inner());
                        if spools
                            .get(id)
                            .is_some_and(|spool| !spool.retain.load(Ordering::Acquire))
                        {
                            spools.remove(id);
                        }
                    }
                }
                "host.process.release" => {
                    if let Some(handle) = frame["params"]["handle"].as_str() {
                        super::service_host::store()?
                            .release_host_spool_if_present(&self.package_id, handle)?;
                        self.spools
                            .lock()
                            .unwrap_or_else(|cause| cause.into_inner())
                            .retain(|_, spool| spool.handle != handle);
                    }
                }
                "host.process.recover" => {
                    let request = frame["params"]["requestId"]
                        .as_str()
                        .ok_or_else(|| error("Invalid original host process request ID"))?;
                    let store = super::service_host::store()?;
                    let original = frame["params"]
                        .get("owner")
                        .map(|value| {
                            serde_json::from_value::<
                                    crate::service_state::model::PackageGeneration,
                                >(value.clone())
                                .map_err(|_| error("Invalid original host process owner"))
                        })
                        .transpose()?;
                    let result = if let (Some(consumer), Some(operation)) = (
                        frame["params"]["consumerPackageId"].as_str(),
                        frame["params"]["operationId"].as_str(),
                    ) {
                        store.host_spool_result_for_operation(
                            &self.package_id,
                            request,
                            consumer,
                            operation,
                            original.as_ref(),
                        )?
                    } else {
                        store.host_spool_result_for_owner(
                            &self.package_id,
                            request,
                            original.as_ref(),
                        )?
                    };
                    self.send(&json!({"jsonrpc":"2.0","id":frame["id"],"result":result}))?;
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

    /// `host.process.run`. Every refusal returned here precedes spawning and
    /// carries a typed code (see `process_run::code`); the worker reports
    /// spawn refusals with the same codes and anything later as interrupted.
    fn run_process(self: &Arc<Self>, frame: &Value) -> Result<(), AppError> {
        use super::process_run::{code, refusal};
        // An invalid ID can never name a running process, so its refusal
        // cannot reach another request's waiter.
        let id = frame["id"]
            .as_str()
            .filter(|id| id.starts_with("host:") && id.len() < 100)
            .ok_or_else(|| refusal(code::INVALID_REQUEST, "Invalid host-service request ID"))?
            .to_owned();
        // Any reply to a running process's ID reaches that process's waiter:
        // never claim non-execution there (admission re-checks under lock).
        if self
            .controls
            .lock()
            .map_or(true, |controls| controls.contains_key(&id))
        {
            return Err(refusal(
                code::PROTOCOL_ERROR,
                "Plugin process request ID is already running",
            ));
        }
        if self.installed.manifest.sdk_version >= 3 && !self.is_active() {
            return Err(refusal(code::NOT_STARTED, "Plugin is not active"));
        }
        let request = super::process_run::parse(&frame["params"])?;
        let control = JobControl::new();
        let spool = Arc::new(
            ProcessSpool::reserve_with_custody(
                &self.generation(),
                &id,
                request.output_reservation(),
                self.installed.manifest.sdk_version >= 3,
                request.output_custody(),
            )
            .map_err(|_| {
                refusal(
                    code::NOT_STARTED,
                    "Plugin output spool is unavailable or its custody is ambiguous",
                )
            })?,
        );
        let lease = {
            let not_started = |cause: AppError| refusal(code::NOT_STARTED, &cause.to_string());
            let _gate = super::read_lifecycle().map_err(not_started)?;
            if self.installed.manifest.sdk_version >= 3 && !self.is_active() {
                return Err(refusal(
                    code::NOT_STARTED,
                    "Plugin is not active for process admission",
                ));
            }
            let lease = CallLease::acquire(&self.package_id).map_err(not_started)?;
            let mut controls = self
                .controls
                .lock()
                .map_err(|_| refusal(code::NOT_STARTED, "Plugin process lock is unavailable"))?;
            let mut spools = self
                .spools
                .lock()
                .map_err(|_| refusal(code::NOT_STARTED, "Plugin spool lock is unavailable"))?;
            super::process_run::admit(
                &mut controls,
                &mut spools,
                self.alive.load(Ordering::Acquire),
                &id,
                &control,
                &spool,
            )?;
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
            let modern = owner.installed.manifest.sdk_version >= 3;
            let result = (|| {
                let stdout_sink = spool.stdout_sink().map_err(ProcessRunError::NotStarted)?;
                let output = super::process_run::execute_streaming(
                    request,
                    || !owner.alive.load(Ordering::Acquire) || control.check().is_err(),
                    cfg!(unix) && modern,
                    Some(stdout_sink),
                )?;
                let started = ProcessRunError::Started;
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
                            .ok_or_else(|| started(error("Process exit code is unavailable")))?
                            as u32,
                    )
                };
                // A completed paid execution survives retirement and reply
                // loss. Lifecycle cancellation cannot discard returned bytes.
                spool.complete(&output.stdout,&output.stderr,status).map_err(started)
            })();
            let completed = result.is_ok();
            let response = match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(failure) if modern => {
                    let code = super::process_run::failure_code(&failure);
                    let message = match failure {
                        ProcessRunError::NotStarted(cause) => {
                            format!("Owned plugin process was not started: {cause}")
                        }
                        // No failed execution after spawn proves that a CLI
                        // did not submit remotely. Preserve uncertainty across
                        // the RPC boundary, including cancellation and output loss.
                        ProcessRunError::Started(_) => {
                            "Owned plugin process did not provide a complete result".into()
                        }
                    };
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message,"data":{"code":code}}})
                }
                Err(failure) => {
                    let cause = failure.into_error();
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":cause.to_string(),"data":{"code":cause.service_code()}}})
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
        }).map_err(|_| refusal(code::NOT_STARTED, "Owned plugin process worker could not be started"))?;
        Ok(())
    }

    fn stop(&self) {
        if !self.validation_only {
            if let Ok(store) = super::service_host::store() {
                if let Err(cause) = store.retire_generation(&self.generation()) {
                    log::warn!("Plugin generation retirement deferred: {cause}");
                }
            }
        }
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
    let broker = ensure_active_or_start(
        id,
        || {
            Ok(
                crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")?
                    .get(id)
                    .filter(|broker| broker.is_active())
                    .cloned(),
            )
        },
        |revision| {
            if !OWNERSHIP_READY.load(Ordering::Acquire) {
                let installed = package::list(&root()?)?
                    .into_iter()
                    .find(|entry| entry.manifest.id == id && entry.enabled)
                    .ok_or_else(|| error("Plugin package is disabled or removed"))?;
                if !super::degraded_backend_allowed(&installed)? {
                    return Err(error(
                    "Plugin AI services are unavailable in this process; this plugin waits for their recovery",
                ));
                }
            }
            let broker = ensure_mode(id, revision)?;
            if !broker.is_active() {
                broker.activate()?;
            }
            Ok(broker)
        },
    )?;
    if matches!(id, "xnmp.trace-explorer" | "xnmp.image-generation") {
        schedule_image_migration();
    }
    Ok(broker)
}
fn ensure_active_or_start<T>(
    id: &str,
    current: impl FnOnce() -> Result<Option<T>, AppError>,
    start: impl FnOnce(u64) -> Result<T, AppError>,
) -> Result<T, AppError> {
    // Startup/activation are owned before taking the package startup mutex.
    // A lifecycle change invalidates this revision even after its fence ends.
    let _startup_admission = {
        let _gate = super::read_lifecycle()?;
        // Retained controls need no startup lane. In particular an automatic
        // idle fence must leave status, cancel and acknowledge immediately usable.
        if let Some(broker) = current()? {
            return Ok(broker);
        }
        CallLease::acquire_direction(id, 3)?
    };
    start(_startup_admission.1)
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
    /// Set once `lifecycle.quiesce` may have left the plugin not ready: it was
    /// accepted, or its reply was lost. A reply that refused, or kept the
    /// plugin ready, leaves it serving exactly as before the drain.
    quiesced: AtomicBool,
}
#[cfg(test)]
pub(super) fn begin_drain(id: &str) -> Result<DrainGuard, AppError> {
    begin_drain_with(id, false)
}
/// Explicit lifecycle changes close new admission even when AI calls are live.
/// The caller retires the broker before modifying package state.
pub(super) fn begin_change(id: &str) -> Result<DrainGuard, AppError> {
    begin_drain_with(id, true)
}
fn begin_drain_with(id: &str, cancel_live: bool) -> Result<DrainGuard, AppError> {
    // The caller holds the short lifecycle write gate. Admission and fencing
    // share a mutex so even a caller without a Broker cannot cross this point.
    let mut admissions = crate::native_deadline::lock(
        CALLS.get_or_init(Default::default),
        "Plugin admission lock is unavailable",
    )?;
    if admissions.fenced.contains(id) && !(cancel_live && admissions.recovery_fences.contains(id))
        || !cancel_live
            && (admissions.idle_fences.contains(id)
                || admissions
                    .calls
                    .iter()
                    .any(|((package, _, _), count)| package == id && *count > 0))
    {
        // Typed busy: a queued upgrade racing a live call retries next launch.
        return Err(super::service_host::busy(
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
    if cancel_live {
        admissions.recovery_fences.remove(id);
        // Invalidated owners no longer occupy the replacement's capacity,
        // but keep their old keys until Drop proves that their work ended.
        *admissions.revisions.entry(id.to_owned()).or_default() += 1;
    }
    admissions.fenced.insert(id.to_owned());
    Ok(DrainGuard {
        id: id.to_owned(),
        broker,
        recovery_required: AtomicBool::new(false),
        quiesced: AtomicBool::new(false),
    })
}
impl DrainGuard {
    pub(super) fn generation(&self) -> Option<crate::service_state::model::PackageGeneration> {
        self.broker.as_ref().map(|broker| broker.generation())
    }
    pub(super) fn retain_for_recovery(&self) {
        self.recovery_required.store(true, Ordering::Release);
    }
    pub(super) fn quiesce(&self) -> Result<(), AppError> {
        if let Some(broker) = &self.broker {
            if broker.installed.manifest.sdk_version >= 3
                && broker.phase.load(Ordering::Acquire) == DRAINING_PHASE
            {
                let result = broker.call("lifecycle.quiesce", json!({}));
                if !refused_ready(&result) {
                    self.quiesced.store(true, Ordering::Release);
                }
                let result = result?;
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
                // A plugin that never quiesced is still ready: it resumes
                // serving events and reverse calls. One that may have
                // quiesced re-activates on its next ordinary admission.
                // Drop never waits on RPC or invokes callbacks.
                let restored = if self.quiesced.load(Ordering::Acquire) {
                    PREFLIGHT_PHASE
                } else {
                    ACTIVE_PHASE
                };
                let _ = broker.phase.compare_exchange(
                    DRAINING_PHASE,
                    restored,
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
/// The plugin answered quiesce and stayed ready: a definite service refusal,
/// or a reply that still reports readiness. Lost or ambiguous replies are not.
fn refused_ready(result: &Result<Value, AppError>) -> bool {
    match result {
        Ok(value) => value["ready"] == true,
        Err(AppError::Service { code, .. }) => !matches!(
            code.as_str(),
            "timed_out"
                | "worker_failed"
                | "mutation_uncertain"
                | "transport_unavailable"
                | "protocol_error"
        ),
        Err(_) => false,
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
        .any(|((package, _, _), count)| package == id && *count > 0)
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
/// Drops a settled job from its live broker's in-memory ownership, so that
/// presentation the host has settled cannot keep the package busy.
pub(super) fn release_job(owner: &crate::service_state::model::PackageGeneration, job_id: u64) {
    let broker = brokers()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .get(&owner.package_id)
        .filter(|broker| broker.installed.digest == owner.digest)
        .cloned();
    if let Some(broker) = broker {
        broker.finish_job(job_id);
    }
}
pub(super) fn current_instance(id: &str) -> Option<Arc<Broker>> {
    crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")
        .ok()?
        .get(id)
        .filter(|broker| broker.is_active())
        .cloned()
}
pub(super) fn active_instance(id: &str, digest: &str) -> Option<Arc<Broker>> {
    crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")
        .ok()?
        .get(id)
        .filter(|broker| broker.is_active() && broker.installed.digest == digest)
        .cloned()
}
/// Must be called under an IdleCallFence (or lifecycle drain). Never interpret
/// a lock error or a half-terminated broker as death. A new incarnation with
/// the same digest can own recovery of the recorded operation, so it is probed.
pub(super) fn settlement_broker(
    owner: &crate::service_state::model::PackageGeneration,
) -> Result<Option<Arc<Broker>>, AppError> {
    let broker = crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")?
        .get(&owner.package_id)
        .cloned();
    let Some(broker) = broker else {
        return Ok(None);
    };
    if !broker.alive.load(Ordering::Acquire) {
        let mut child =
            crate::native_deadline::lock(&broker.child, "Plugin process lock is unavailable")?;
        if broker.tree_stopped.load(Ordering::Acquire) && matches!(child.try_wait(), Ok(Some(_))) {
            return Ok(None);
        }
        return Err(error("Plugin termination is not yet verified"));
    }
    if !broker.is_active() || broker.installed.digest != owner.digest {
        return Err(error(
            "Original plugin worker is not available for an idle proof",
        ));
    }
    Ok(Some(broker))
}
pub(super) fn preflight_candidate(
    installed: &package::Installed,
    data: PathBuf,
    fence: &DrainGuard,
) -> Result<(), AppError> {
    if installed.manifest.id != fence.id {
        return Err(error("Candidate does not own its package mutation fence"));
    }
    let broker = start_broker(installed.clone(), data, true, None)?;
    // Validation always ends in retirement, never activation of the copied DB.
    broker.stop();
    Ok(())
}
fn ensure_mode(id: &str, revision: u64) -> Result<Arc<Broker>, AppError> {
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
    let previous = publish_startup(id, revision, || {
        let registry =
            crate::native_deadline::lock(brokers(), "Plugin runtime lock is unavailable")?;
        if CLOSING.load(Ordering::Acquire) {
            return Err(error("Plugin host is shutting down"));
        }
        Ok(registry.get(id).cloned())
    })?;
    if let Some(broker) = previous
        .as_ref()
        .filter(|b| b.alive.load(Ordering::Acquire))
    {
        return Ok(broker.clone());
    }
    // Keep the dead generation discoverable by lifecycle until retirement
    // durably fences its delayed creation workers.
    if let Some(old) = previous {
        old.stop();
    }
    let installed = package::list(&root()?)?
        .into_iter()
        .find(|entry| entry.manifest.id == id && entry.enabled)
        .ok_or_else(|| error("Plugin package is disabled or removed"))?;
    super::service_graph::validate_enabled(&package::list(&root()?)?)?;
    if installed.manifest.sdk_version < 3 {
        // Without an opened ledger (another process owns the profile, or it
        // is unreadable) no retained history is checkable; SDK 3 to legacy
        // downgrades are refused while history is retained, so none exists.
        if let Ok(store) = super::service_host::store() {
            super::service_host::require_legacy_consumer_compatible(store, id)?;
        }
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
    start_broker(installed, data, false, Some(revision))
}
fn publish_startup<T>(
    id: &str,
    revision: u64,
    publish: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let admissions = crate::native_deadline::lock(
        CALLS.get_or_init(Default::default),
        "Plugin admission lock is unavailable",
    )?;
    if admissions.fenced.contains(id)
        || admissions.revisions.get(id).copied().unwrap_or(0) != revision
    {
        return Err(error("Plugin request was cancelled by a lifecycle change"));
    }
    publish()
}
fn start_broker(
    installed: package::Installed,
    data: PathBuf,
    validation_only: bool,
    revision: Option<u64>,
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
        publish_startup(
            id,
            revision.ok_or_else(|| error("Plugin startup has no lifecycle admission"))?,
            || {
                let mut registry = brokers()
                    .lock()
                    .map_err(|_| error("Plugin runtime lock is unavailable"))?;
                if CLOSING.load(Ordering::Acquire) {
                    drop(registry);
                    return Err(error("Plugin host is shutting down"));
                }
                registry.insert(id.to_owned(), broker.clone());
                Ok(())
            },
        )?;
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
        json!({"protocolVersion":1,"activeRunIds":if validation_only {vec![]} else {super::provenance::active_runs(id)},"processService":true,"processStdin":super::process_run::stdin_capability(),"processRecovery":{"version":1,"owner":broker.generation()},"textService":{"version":1},"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1,"estimateKey":true},"hostControl":{"token":broker.control_token},"validationOnly":validation_only,"deferRecovery":deferred}),
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
    #[cfg(test)]
    JOB_EVENTS.with(|events| {
        if let Some(events) = &mut *events.borrow_mut() {
            events.push(payload.clone());
        }
    });
    if let Some(app) = APP.get() {
        let _ = app.emit("plugin-jobs:changed", payload);
    }
}
#[cfg(test)]
thread_local! {
    static JOB_EVENTS: std::cell::RefCell<Option<Vec<Value>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(super) fn capture_job_events<T>(run: impl FnOnce() -> T) -> (T, Vec<Value>) {
    JOB_EVENTS.with(|events| {
        assert!(events.borrow().is_none());
        *events.borrow_mut() = Some(Vec::new());
    });
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            JOB_EVENTS.with(|e| {
                e.borrow_mut().take();
            });
        }
    }
    let _reset = Reset;
    let result = run();
    (result, JOB_EVENTS.with(|e| e.borrow_mut().take().unwrap()))
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
    params: Value,
    origin_label: &str,
    entered: std::time::SystemTime,
) -> Result<Value, AppError> {
    let admission = {
        let _gate = super::read_lifecycle()?;
        CallLease::acquire_method(id, method)?
    };
    call_admitted(id, method, params, origin_label, entered, &admission)
}
pub(super) fn call_admitted(
    id: &str,
    method: &str,
    mut params: Value,
    origin_label: &str,
    entered: std::time::SystemTime,
    admission: &CallLease,
) -> Result<Value, AppError> {
    admission.require_current(id)?;
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
    admission.require_current(id)?;
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
    let mut sent = false;
    let result = broker.call_reporting(method, params, &mut sent);
    if let Some(record) = durable_job.as_ref() {
        if result.is_err() && !sent {
            // Refused before reaching the backend: it cannot have accepted.
            let _ = super::job_bridge::unsent(record, &broker);
        } else {
            super::job_bridge::schedule_status(broker.clone(), record.clone());
        }
    }
    if result.is_err() {
        if let Some((job_id, operation_id)) = job {
            if let Some((current, status)) = sent
                .then(|| {
                    ensure(id).and_then(|current| {
                        let status =
                            current.call("jobs.status", json!({"operationId":operation_id}))?;
                        Ok((current, status))
                    })
                })
                .and_then(Result::ok)
            {
                if status["jobId"].as_u64() == Some(job_id) {
                    return Ok(json!(job_id));
                }
                if let Some(record) = durable_job.as_ref() {
                    let _ = super::job_bridge::rejected(record, &current, &status);
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
pub(super) mod native_tests;
