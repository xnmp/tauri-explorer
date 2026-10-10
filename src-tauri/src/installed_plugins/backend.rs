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
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
static CLOSING: AtomicBool = AtomicBool::new(false);
static INCARNATIONS: AtomicU64 = AtomicU64::new(1);
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
static STARTING: Mutex<()> = Mutex::new(());
fn brokers() -> &'static Mutex<HashMap<String, Arc<Broker>>> {
    BROKERS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn initialize(app: AppHandle) {
    let _ = APP.set(app);
}
fn error(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}

struct Waiter {
    sender: mpsc::Sender<Result<Value, String>>,
    bytes: Vec<u8>,
    sequence: u64,
}
#[derive(Clone)]
struct Job {
    kind: String,
    operation_id: String,
}

pub(super) struct Broker {
    package_id: String,
    app: AppHandle,
    child: Mutex<Child>,
    input: Mutex<Option<mpsc::SyncSender<Vec<u8>>>>,
    alive: AtomicBool,
    retired: AtomicBool,
    active: AtomicBool,
    incarnation: u64,
    text_bridge: OnceLock<Arc<super::text_service::TextBridge>>,
    sequence: AtomicU64,
    pending: Mutex<HashMap<u64, Waiter>>,
    jobs: Mutex<HashMap<u64, Job>>,
    controls: Mutex<HashMap<String, JobControl>>,
    spools: Mutex<HashMap<String, Arc<tempfile::TempDir>>>,
}

impl Broker {
    fn text_owner(&self) -> String {
        format!("plugin:{}:{}", self.package_id, self.incarnation)
    }

    fn text_request(self: &Arc<Self>, frame: Value) -> Result<(), AppError> {
        let bridge = self.text_bridge.get_or_init(|| {
            let active_owner = Arc::downgrade(self);
            let sender = Arc::downgrade(self);
            Arc::new(super::text_service::TextBridge::new(self.text_owner(),
                move || active_owner.upgrade().is_some_and(|owner| owner.active.load(Ordering::Acquire) && owner.alive.load(Ordering::Acquire)),
                move |frame| { if let Some(owner) = sender.upgrade() { if owner.alive.load(Ordering::Acquire) && owner.send(&frame).is_err() { owner.fail("Text service reply could not be delivered"); } } },
                Arc::new(super::text_service::NativeText)))
        });
        if !frame["id"].as_str().is_some_and(|id| id.starts_with("host:") && id.len() <= 128) { return Err(error("Invalid text service request ID")); }
        bridge.handle(frame);
        Ok(())
    }

    fn send(&self, value: &Value) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(value).map_err(|cause| error(cause.to_string()))?;
        if bytes.len() > 1024 * 1024 {
            return Err(error("Plugin request exceeds 1 MiB"));
        }
        let guard = self
            .input
            .lock()
            .map_err(|_| error("Plugin transport lock is unavailable"))?;
        let input = guard
            .as_ref()
            .ok_or_else(|| error("Plugin backend disconnected"))?;
        input.try_send(bytes).map_err(|cause| {
            error(match cause {
                mpsc::TrySendError::Full(_) => "Plugin write capacity reached",
                mpsc::TrySendError::Disconnected(_) => "Plugin writer disconnected",
            })
        })?;
        Ok(())
    }

    pub(super) fn call(&self, method: &str, params: Value) -> Result<Value, AppError> {
        if !self.alive.load(Ordering::Acquire) || self.retired.load(Ordering::Acquire) {
            return Err(error("Plugin backend is unavailable"));
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| error("Plugin reply lock is unavailable"))?;
            if pending.len() >= 32 {
                return Err(error("Plugin request capacity reached"));
            }
            pending.insert(
                id,
                Waiter {
                    sender,
                    bytes: vec![],
                    sequence: 0,
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
        match receiver.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(value)) => {
                if method == "lifecycle.activate" {
                    self.active.store(true, Ordering::Release);
                }
                Ok(value)
            },
            Ok(Err(cause)) => Err(error(cause)),
            Err(_) => {
                // The worker may still be validating an unaccepted operation.
                // Stop it before status lookup so a late reply cannot launch
                // work after the caller has already lost acceptance ownership.
                self.fail(
                    "Plugin reply deadline reached; backend stopped before accepting late work",
                );
                self.pending
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .remove(&id);
                Err(AppError::MutationUncertain(
                    "Plugin reply was lost; inspect its history before repeating an operation"
                        .into(),
                ))
            }
        }
    }

    fn fail(&self, reason: &str) {
        let recover_jobs =
            !self.retired.load(Ordering::Acquire) && !CLOSING.load(Ordering::Acquire);
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        self.active.store(false, Ordering::Release);
        crate::ai::cancel_caller(&self.text_owner());
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
        let _ = self
            .child
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .kill();

        if recovery.is_some() {
            let package_id = self.package_id.clone();
            let app = self.app.clone();
            let reason = reason.to_owned();
            // Query durable acceptance after reconciliation. Never replay jobs.start:
            // losing a transport reply must not repeat a paid provider request.
            std::thread::spawn(move || {
                let _recovery = recovery;
                if CLOSING.load(Ordering::Acquire) {
                    return;
                }
                let _guard = match super::read_lifecycle() {
                    Ok(guard) => guard,
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
        }
    }

    fn receive(self: &Arc<Self>, frame: Value) -> Result<(), AppError> {
        if frame["jsonrpc"] != "2.0" {
            return Err(error("Invalid plugin RPC version"));
        }
        if let Some(method) = frame["method"].as_str() {
            match method {
                "event" => {
                    let name = frame["params"]["name"]
                        .as_str()
                        .ok_or_else(|| error("Invalid plugin event"))?;
                    if name.len() > 128 {
                        return Err(error("Invalid plugin event"));
                    }
                    let payload = &frame["params"]["payload"];
                    if name.ends_with("-complete") || name.ends_with("-error") {
                        if let Some(id) = payload["jobId"].as_u64() {
                            self.jobs
                                .lock()
                                .unwrap_or_else(|cause| cause.into_inner())
                                .remove(&id);
                        }
                    }
                    self.app
                        .emit(name, payload)
                        .map_err(|cause| error(cause.to_string()))?;
                }
                "host.process.run" => {
                    if let Err(cause) = self.run_process(&frame) {
                        self.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32002,"message":cause.to_string()}}))?;
                    }
                }
                "host.text.describe" | "host.text.generate" | "host.text.cancel" => {
                    self.text_request(frame.clone())?;
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
            Err(cause["message"]
                .as_str()
                .unwrap_or("Plugin request failed")
                .to_owned())
        } else {
            Ok(response["result"].clone())
        };
        let _ = waiter.sender.send(result);
        Ok(())
    }

    fn run_process(self: &Arc<Self>, frame: &Value) -> Result<(), AppError> {
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
        {
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
        }
        let owner = self.clone();
        std::thread::spawn(move || {
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
            owner
                .controls
                .lock()
                .unwrap_or_else(|cause| cause.into_inner())
                .remove(&id);
            if result.is_err() {
                owner
                    .spools
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .remove(&id);
            }
            let response = match result {
                Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                Err(cause) => {
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":cause.to_string()}})
                }
            };
            if owner.send(&response).is_err() {
                owner
                    .spools
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .remove(&id);
                owner.fail("Plugin service reply could not be delivered");
            }
        });
        Ok(())
    }

    fn stop(&self) {
        self.retired.store(true, Ordering::Release);
        self.fail("Plugin backend stopped; inspect history before repeating generation");
        self.input
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take();
        let mut child = self.child.lock().unwrap_or_else(|cause| cause.into_inner());
        let deadline = Instant::now() + Duration::from_secs(2);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if matches!(child.try_wait(), Ok(None)) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        self.spools
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .clear();
    }
}

pub(super) fn ensure(id: &str) -> Result<Arc<Broker>, AppError> {
    ensure_mode(id, false)
}
pub(super) fn preflight(id: &str) -> Result<Arc<Broker>, AppError> {
    ensure_mode(id, true)
}
fn ensure_mode(id: &str, defer_recovery: bool) -> Result<Arc<Broker>, AppError> {
    let _starting = STARTING
        .lock()
        .map_err(|_| error("Plugin startup lock is unavailable"))?;
    if CLOSING.load(Ordering::Acquire) {
        return Err(error("Plugin host is shutting down"));
    }
    let app = APP
        .get()
        .ok_or_else(|| error("Plugin host is not initialized"))?
        .clone();
    let mut registry = brokers()
        .lock()
        .map_err(|_| error("Plugin runtime lock is unavailable"))?;
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
    if let Some(old) = registry.remove(id) {
        old.stop();
    }
    let installed = package::list(&root()?)?
        .into_iter()
        .find(|entry| entry.manifest.id == id)
        .ok_or_else(|| error("Plugin package is not installed"))?;
    let binary = package::backend_path(&root()?, &installed)?;
    let data = config::config_dir()?.join("plugin-data").join(id);
    fs::create_dir_all(&data)?;
    for filename in &installed.manifest.initial_data_files {
        let destination = data.join(filename);
        let source = config::config_dir()?.join(filename);
        if !destination.exists() && source.is_file() {
            fs::copy(source, destination)?;
        }
    }
    let mut command = Command::new(binary);
    command
        .no_console()
        .args([std::ffi::OsStr::new("--data-dir"), data.as_os_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| error("Plugin stdin is unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| error("Plugin stdout is unavailable"))?;
    let (writer, frames) = mpsc::sync_channel::<Vec<u8>>(16);
    let broker = Arc::new(Broker {
        package_id: id.to_owned(),
        app,
        child: Mutex::new(child),
        input: Mutex::new(Some(writer)),
        alive: AtomicBool::new(true),
        retired: AtomicBool::new(false),
        active: AtomicBool::new(false),
        incarnation: INCARNATIONS.fetch_add(1, Ordering::Relaxed),
        text_bridge: OnceLock::new(),
        sequence: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        jobs: Mutex::new(HashMap::new()),
        controls: Mutex::new(HashMap::new()),
        spools: Mutex::new(HashMap::new()),
    });
    // Publish the owned process before waiting on its handshake. Shutdown can
    // then stop a nonresponsive candidate without waiting on the registry lock.
    registry.insert(id.to_owned(), broker.clone());
    drop(registry);
    let writer_owner = Arc::downgrade(&broker);
    std::thread::spawn(move || {
        for frame in frames {
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
        }
    });
    let weak = Arc::downgrade(&broker);
    std::thread::spawn(move || {
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
                owner.fail("Plugin backend exited or exceeded its frame limit");
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
    });
    let _ownership = super::provenance::ownership_guard()?;
    match broker.call(
        "initialize",
        json!({"protocolVersion":1,"activeRunIds":super::provenance::active_runs(id),"processService":true,"textService":{"version":1},"deferRecovery":defer_recovery}),
    ) {
        Ok(result) if result["protocolVersion"] == 1 && result["ready"] == !defer_recovery => {}
        Ok(_) => {
            broker.stop();
            return Err(error("Plugin backend protocol mismatch"));
        }
        Err(cause) => {
            broker.stop();
            return Err(cause);
        }
    }
    broker.active.store(!defer_recovery, Ordering::Release);
    Ok(broker)
}

pub(super) fn is_closing() -> bool {
    CLOSING.load(Ordering::Acquire)
}

pub(super) fn call(id: &str, method: &str, mut params: Value) -> Result<Value, AppError> {
    if !params.is_object() || method.len() > 128 {
        return Err(error("Invalid plugin request"));
    }
    if method == "initialize" || method.starts_with("host.") || method.starts_with("lifecycle.") {
        return Err(error("Plugin method is owned by the host"));
    }
    let broker = ensure(id)?;
    let job = if method == "jobs.start" {
        let id = crate::plugin_job::next_job_id();
        params["jobId"] = json!(id);
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
    if result.is_err() {
        if let Some((job_id, operation_id)) = job {
            if let Ok(status) = ensure(id).and_then(|current| {
                current.call("jobs.status", json!({"operationId":operation_id}))
            }) {
                if status["jobId"].as_u64() == Some(job_id) {
                    return Ok(json!(job_id));
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
    !super::provenance::active_runs(id).is_empty()
        || brokers()
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .get(id)
            .is_some_and(|broker| {
                !broker
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
    if let Some(broker) = brokers()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .remove(id)
    {
        broker.stop();
    }
}

pub(super) fn shutdown() {
    CLOSING.store(true, Ordering::Release);
    for (_, broker) in brokers()
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .drain()
    {
        broker.stop();
    }
}
