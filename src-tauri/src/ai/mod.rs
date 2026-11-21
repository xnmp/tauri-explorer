//! Host-owned short text service. Broker identities are supplied by native code;
//! JSON request fields cannot claim another caller's work or credentials.
mod adapters;
mod agent_folder;
mod cli;
pub(crate) mod credentials;
pub mod domain;
pub(crate) mod image_migration;
mod storage;
use credentials::{OsSecrets, SecretStore};
use domain::*;
pub use domain::{AgentDescribe, AgentResult, Describe, ServiceError, TextResult};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
pub(crate) use storage::{migrate_summary, write_trace_config};
use tauri::Emitter;

type OwnerCheck = Arc<dyn Fn() -> bool + Send + Sync>;
/// No configuration revision: text jobs, and agent jobs before their snapshot.
const UNPINNED: u64 = u64::MAX;
pub(super) struct Control {
    cancelled: AtomicBool,
    /// Set when the configuration an agent job was pinned to changed (#1884).
    superseded: AtomicBool,
    /// The configuration revision an agent job snapshotted, or [`UNPINNED`].
    pinned: AtomicU64,
    active: AtomicBool,
    deadline: Mutex<Instant>,
    started: Instant,
    owner: OwnerCheck,
}
impl Control {
    pub(super) fn new(timeout: Duration, owner: OwnerCheck) -> Arc<Self> {
        let now = Instant::now();
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            superseded: AtomicBool::new(false),
            pinned: AtomicU64::new(UNPINNED),
            active: AtomicBool::new(false),
            deadline: Mutex::new(now + timeout),
            started: now,
            owner,
        })
    }
    fn check(&self) -> Result<()> {
        if self.superseded.load(Ordering::Acquire) {
            return Err(ServiceError::new(
                "configuration_changed",
                "AI settings changed while the agent job was queued or running; it was cancelled",
            ));
        }
        if self.cancelled.load(Ordering::Acquire) || (self.owner)() {
            return Err(ServiceError::new("cancelled", "Text request was cancelled"));
        }
        if Instant::now() >= *self.deadline.lock().unwrap() {
            return Err(ServiceError::new(
                "timed_out",
                "Text request deadline elapsed",
            ));
        }
        Ok(())
    }
    async fn stopped(&self) -> ServiceError {
        loop {
            if let Err(e) = self.check() {
                return e;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    /// Cancels the job when it is pinned to a revision other than `observed`.
    fn supersede_unless(&self, observed: u64) {
        let pinned = self.pinned.load(Ordering::SeqCst);
        if pinned != UNPINNED && observed != UNPINNED && pinned != observed {
            self.superseded.store(true, Ordering::Release);
        }
    }
}
type JobKey = (String, String);
/// How long a cancellation (or a finished job) is remembered.
const RECORD_TTL: Duration = Duration::from_secs(120);
/// Bound on remembered finished jobs; past it, a late cancel is treated as
/// one for an unknown job.
const FINISHED_LIMIT: usize = 4096;
#[derive(Default)]
struct Registry {
    live: HashMap<JobKey, Arc<Control>>,
    /// Cancellations that arrived before their job was admitted. Only
    /// request IDs never seen are recorded: cancelling a live job stops its
    /// control, and a finished one needs nothing, so abort churn leaves no
    /// records behind. A record is consumed by the admission it refuses.
    cancelled: HashMap<JobKey, Instant>,
    /// Recently admitted-and-ended jobs, so their late cancels write no record.
    finished: HashMap<JobKey, Instant>,
    blocked_until: Option<Instant>,
}
impl Registry {
    fn finish(&mut self, key: JobKey) {
        let now = Instant::now();
        if self.finished.len() >= FINISHED_LIMIT {
            self.finished.retain(|_, until| *until > now);
        }
        if self.finished.len() < FINISHED_LIMIT {
            self.finished.insert(key, now + RECORD_TTL);
        }
    }
}
/// Folder resolution for agent jobs (#1884). It can touch a hung network
/// mount, so it runs in its own small blocking pool under its own timeout,
/// never holding a slot text requests or settings wait for.
pub(super) type FolderResolver = Arc<dyn Fn(&str) -> Result<PathBuf> + Send + Sync>;
struct Folders {
    resolve: FolderResolver,
    slots: Arc<tokio::sync::Semaphore>,
    timeout: Duration,
}
/// Folder resolutions in flight at once; a resolution stuck on a dead mount
/// keeps its slot until the OS returns.
const FOLDER_RESOLUTIONS: usize = 2;
const FOLDER_TIMEOUT: Duration = Duration::from_secs(5);
/// Per-caller limits: text requests, and agent jobs (2 running + 4 queued),
/// which have their own caller identity so they never consume text quota.
const TEXT_PER_CALLER: usize = 8;
const AGENT_PER_CALLER: usize = AGENT_MAX_CONCURRENT + 4;
struct Service {
    store: storage::Store,
    secrets: Arc<dyn SecretStore>,
    live: Mutex<Registry>,
    slots: Arc<tokio::sync::Semaphore>,
    /// Folder-agent jobs (#1884) run for minutes, so they have their own
    /// small pool and never occupy the text slots titles wait for.
    agent_slots: Arc<tokio::sync::Semaphore>,
    folders: Folders,
    /// The latest configuration revision the host has announced, or
    /// [`UNPINNED`] before the first; agent jobs pinned to another revision
    /// are cancelled.
    observed_revision: AtomicU64,
}
struct Admission<'a> {
    service: &'a Service,
    key: (String, String),
    control: Arc<Control>,
}
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        self.control.cancel();
        let mut registry = self.service.live.lock().unwrap();
        registry.live.remove(&self.key);
        registry.finish(self.key.clone());
    }
}
impl Service {
    fn new(root: std::path::PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store: storage::Store::new(root),
            secrets,
            live: Mutex::new(Registry::default()),
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
            agent_slots: Arc::new(tokio::sync::Semaphore::new(AGENT_MAX_CONCURRENT)),
            folders: Folders {
                resolve: Arc::new(|folder| agent_folder::FolderPolicy::local().resolve(folder)),
                slots: Arc::new(tokio::sync::Semaphore::new(FOLDER_RESOLUTIONS)),
                timeout: FOLDER_TIMEOUT,
            },
            observed_revision: AtomicU64::new(UNPINNED),
        }
    }
    #[cfg(test)]
    fn with_folders(mut self, resolve: FolderResolver, timeout: Duration) -> Self {
        self.folders.resolve = resolve;
        self.folders.timeout = timeout;
        self
    }
    /// Records the configuration revision the host just announced and
    /// cancels live and queued agent jobs pinned to another one: disabling AI
    /// or changing or removing the CLI profile must not leave them running.
    fn observe_revision(&self, revision: u64) {
        // Revisions only move forward: a watcher that read an older revision
        // and reports it after a save announced a newer one must not move the
        // observed revision back, or every new job would be cancelled.
        let advance = |current: u64| {
            Some(if current == UNPINNED {
                revision
            } else {
                current.max(revision)
            })
        };
        let previous = self
            .observed_revision
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, advance)
            .unwrap_or_else(|current| current);
        let latest = advance(previous).unwrap_or(revision);
        for control in self.live.lock().unwrap().live.values() {
            control.supersede_unless(latest);
        }
    }
    /// Pins an agent job to the revision it snapshotted. Checked after the
    /// store so a change announced in between is never missed.
    fn pin(&self, control: &Control, revision: u64) {
        control.pinned.store(revision, Ordering::SeqCst);
        control.supersede_unless(self.observed_revision.load(Ordering::SeqCst));
    }
    fn describe(&self) -> Result<Describe> {
        let config = self.store.read()?;
        let profile = config
            .profiles
            .iter()
            .find(|p| Some(&p.id) == config.default_profile_id.as_ref());
        let error = if !config.enabled {
            Some(ServiceError::new("disabled", "Text generation is disabled"))
        } else if let Some(profile) = profile {
            self.check_profile(profile).err()
        } else {
            Some(ServiceError::new(
                "not_configured",
                "Select a default text profile",
            ))
        };
        Ok(Describe {
            version: 1,
            enabled: config.enabled,
            available: error.is_none(),
            configuration_revision: config.revision,
            context: profile.map(|p| p.context(config.revision)),
            error,
        })
    }
    fn check_profile(&self, profile: &Profile) -> Result<()> {
        match profile.connection {
            Connection::Codex { .. } | Connection::Claude { .. } => adapters::check_cli(profile),
            _ => credentials::resolve(profile, self.secrets.as_ref()).map(|_| ()),
        }
    }
    fn admit(&self, caller: String, request: &Request, owner: OwnerCheck) -> Result<Admission<'_>> {
        self.admit_job(
            caller,
            &request.request_id,
            Duration::from_millis(request.timeout_ms.unwrap_or(45_000)),
            owner,
            TEXT_PER_CALLER,
        )
    }
    /// Admission shared by text and agent jobs: one registry, so the same
    /// queue bounds and cancellation records cover both. Agent jobs use their
    /// own caller identity and `per_caller` limit, so they never take text
    /// quota.
    fn admit_job(
        &self,
        caller: String,
        request_id: &str,
        timeout: Duration,
        owner: OwnerCheck,
        per_caller: usize,
    ) -> Result<Admission<'_>> {
        if caller.is_empty() || caller.len() > 512 {
            return Err(ServiceError::invalid("Invalid native caller"));
        }
        let control = Control::new(timeout, owner);
        control.check()?;
        let key = (caller, request_id.to_owned());
        let mut live = self.live.lock().unwrap();
        let now = Instant::now();
        live.cancelled.retain(|_, until| *until > now);
        live.finished.retain(|_, until| *until > now);
        if live.cancelled.remove(&key).is_some() {
            live.finish(key);
            return Err(ServiceError::new(
                "cancelled",
                "Text request was cancelled before admission",
            ));
        }
        if live.cancelled.contains_key(&(key.0.clone(), String::new())) {
            return Err(ServiceError::new(
                "capacity_reached",
                "Text cancellation capacity reached for this caller; try again later",
            ));
        }
        if live.blocked_until.is_some_and(|until| until > now) {
            return Err(ServiceError::new(
                "capacity_reached",
                "Text cancellation capacity reached; try again later",
            ));
        }
        if live.live.contains_key(&key) {
            return Err(ServiceError::invalid(
                "Request ID is already active for this caller",
            ));
        }
        if live.live.len() >= 36
            || live
                .live
                .values()
                .filter(|control| !control.active.load(Ordering::Acquire))
                .count()
                >= 32
            || live
                .live
                .keys()
                .filter(|(caller, _)| caller == &key.0)
                .count()
                >= per_caller
        {
            return Err(ServiceError::new(
                "capacity_reached",
                "Text service queue is full for this caller",
            ));
        }
        control.check()?;
        live.live.insert(key.clone(), control.clone());
        Ok(Admission {
            service: self,
            key,
            control,
        })
    }
    async fn generate(
        &'static self,
        caller: String,
        value: Value,
        owner: OwnerCheck,
        selected: Option<(String, u64)>,
    ) -> Result<TextResult> {
        let request: Request = serde_json::from_value(value)
            .map_err(|_| ServiceError::invalid("Malformed text request"))?;
        validate_request(&request)?;
        let admission = self.admit(caller, &request, owner)?;
        let control = admission.control.clone();
        // Snapshot credential and endpoint before queueing. Config locks end before provider IO.
        let expected = request.expected_configuration_revision;
        let worker_control = control.clone();
        let local_permit = tokio::select! {permit=local_slots().acquire_owned()=>permit.map_err(|_|ServiceError::new("unavailable","AI local worker queue stopped"))?,error=control.stopped()=>return Err(error)};
        let snapshot_worker = tokio::task::spawn_blocking(move || {
            let _local_permit = local_permit;
            worker_control.check()?;
            let snapshot = if let Some((id, revision)) = selected {
                let _guard = self.store.lock()?;
                let config = self.store.read_locked()?;
                storage::check_revision(&config, revision)?;
                let profile = config
                    .profiles
                    .into_iter()
                    .find(|p| p.id == id)
                    .ok_or_else(|| ServiceError::invalid("Unknown test profile"))?;
                let credential = credentials::resolve(&profile, self.secrets.as_ref())?;
                (profile, config.revision, credential)
            } else {
                self.store.snapshot(self.secrets.as_ref(), expected)?
            };
            worker_control.check()?;
            Ok::<_, ServiceError>(snapshot)
        });
        let snapshot = tokio::select! {result=snapshot_worker=>result.map_err(|_|ServiceError::new("unavailable","Text configuration worker failed"))??,error=control.stopped()=>return Err(error)};
        let (profile, revision, credential) = snapshot;
        {
            let mut deadline = control.deadline.lock().unwrap();
            *deadline =
                (*deadline).min(control.started + Duration::from_millis(profile.timeout_ms));
        }
        control.check()?;
        let permit = tokio::select! {permit=self.slots.clone().acquire_owned()=>permit.map_err(|_|ServiceError::new("unavailable","Text service stopped"))?,error=control.stopped()=>return Err(error)};
        control.check()?;
        control.active.store(true, Ordering::Release);
        let context = profile.context(revision);
        // HTTP IO is directly cancellable. CLI worker is awaited after stop so the
        // permit remains held until process-tree termination completes.
        let result =
            adapters::execute(profile, credential, request, context, control, permit).await;
        drop(admission);
        result
    }
    /// Whether a configured connection can run folder-agent jobs (#1884),
    /// the models it offers and how far its reads are confined. Only the
    /// CLI's `--help` probe ever runs here.
    fn describe_agent(&self) -> Result<AgentDescribe> {
        let config = self.store.read()?;
        let selected = agent_profile(&config);
        let profile = selected.as_ref().ok();
        let error = match &selected {
            Ok(profile) => cli::check_agent(profile, &cli::process_env, &|| false).err(),
            Err(error) => Some(error.clone()),
        };
        let (models, default_model) = profile
            .and_then(|p| agent_models(p))
            .map_or((Vec::new(), None), |(models, default)| {
                (models, Some(default))
            });
        let (read_scope, isolation) = match profile.map(|p| &p.connection) {
            Some(Connection::Claude { .. }) => (
                Some(ReadScope::Folder),
                Some("Claude Code runs with only its Read, Glob and Grep tools. Its --restricted mode refuses any path outside the folder, including through symlinks. No shell, no writes, no web, no MCP."),
            ),
            Some(Connection::Codex { .. }) => (
                Some(ReadScope::FolderRequested),
                Some("Codex reads through sandboxed read-only shell commands under a permission profile that denies every path except the folder, the platform runtime and Codex itself, with network off. Permission profiles are a Codex beta: a Codex version without them falls back to its read-only sandbox, which can read the whole disk."),
            ),
            _ => (None, None),
        };
        Ok(AgentDescribe {
            version: 1,
            enabled: config.enabled,
            available: error.is_none(),
            configuration_revision: config.revision,
            context: profile.map(|p| p.context(config.revision)),
            models,
            default_model,
            read_scope,
            isolation,
            max_timeout_ms: AGENT_MAX_TIMEOUT_MS,
            max_concurrent: AGENT_MAX_CONCURRENT,
            error,
        })
    }
    /// One folder-agent job (#1884). Shares admission and cancellation with
    /// text requests but not their quota (callers pass an agent identity);
    /// its deadline is the request's (capped at [`AGENT_MAX_TIMEOUT_MS`]) and
    /// is not shortened by the profile timeout.
    async fn run_agent(
        &'static self,
        caller: String,
        value: Value,
        owner: OwnerCheck,
    ) -> Result<AgentResult> {
        let request: AgentRequest = serde_json::from_value(value)
            .map_err(|_| ServiceError::invalid("Malformed agent request"))?;
        validate_agent_request(&request)?;
        let admission = self.admit_job(
            caller,
            &request.request_id,
            Duration::from_millis(agent_deadline_ms(request.timeout_ms)),
            owner,
            AGENT_PER_CALLER,
        )?;
        let control = admission.control.clone();
        let folder = tokio::select! {result=self.resolve_folder(&request.folder)=>result?,error=control.stopped()=>return Err(error)};
        // Configuration reads take the store lock; no folder IO happens here.
        let worker_control = control.clone();
        let local_permit = tokio::select! {permit=local_slots().acquire_owned()=>permit.map_err(|_|ServiceError::new("unavailable","AI local worker queue stopped"))?,error=control.stopped()=>return Err(error)};
        let requested_model = request.model.clone();
        let expected = request.expected_configuration_revision;
        let prepare = tokio::task::spawn_blocking(move || {
            let _local_permit = local_permit;
            worker_control.check()?;
            let _guard = self.store.lock()?;
            let config = self.store.read_locked()?;
            if let Some(expected) = expected {
                storage::check_revision(&config, expected)?;
            }
            let profile = agent_profile(&config)?.clone();
            let (models, default) = agent_models(&profile)
                .ok_or_else(|| ServiceError::new("unsupported", "Not a CLI connection"))?;
            let model = requested_model.unwrap_or(default);
            if !models.contains(&model) {
                return Err(ServiceError::invalid(
                    "Model is not offered for agent jobs on this connection; use one that describe lists",
                ));
            }
            worker_control.check()?;
            Ok::<_, ServiceError>((profile, model, config.revision))
        });
        let (profile, model, revision) = tokio::select! {result=prepare=>result.map_err(|_|ServiceError::new("unavailable","Agent configuration worker failed"))??,error=control.stopped()=>return Err(error)};
        self.pin(&control, revision);
        let permit = tokio::select! {permit=self.agent_slots.clone().acquire_owned()=>permit.map_err(|_|ServiceError::new("unavailable","Agent service stopped"))?,error=control.stopped()=>return Err(error)};
        control.check()?;
        control.active.store(true, Ordering::Release);
        // The CLI worker is awaited even after a stop, so the agent slot stays
        // held until the owned process tree has been terminated.
        let worker = control.clone();
        let used = model.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            cli::run_agent(
                &profile,
                &request,
                &folder,
                &used,
                &worker,
                &cli::process_env,
            )
        })
        .await
        .map_err(|_| ServiceError::new("unavailable", "Agent CLI worker failed"))?;
        control.check()?;
        drop(admission);
        let (text, usage) = result?;
        Ok(AgentResult { text, model, usage })
    }
    /// Resolves and checks an agent folder in the folder pool, within the
    /// folder timeout. A resolution the OS never returns from (a dead network
    /// mount) keeps only its folder slot; the job fails with `timed_out`.
    async fn resolve_folder(&self, folder: &str) -> Result<PathBuf> {
        let timeout = self.folders.timeout;
        let slots = self.folders.slots.clone();
        let resolve = self.folders.resolve.clone();
        let folder = folder.to_owned();
        // Waiting for a folder worker is reported apart from a folder that
        // does not answer: once earlier folders hang, every worker stays with
        // its blocked call, and a job on a healthy folder must say so rather
        // than blame its own folder.
        let permit = match tokio::time::timeout(timeout, slots.acquire_owned()).await {
            Ok(permit) => permit
                .map_err(|_| ServiceError::new("unavailable", "Agent folder worker stopped"))?,
            Err(_) => {
                return Err(ServiceError::new(
                    "unavailable",
                    "Agent jobs are waiting for earlier folders that stopped responding (a stalled network mount?); they resume once those folders answer",
                ))
            }
        };
        let work = async move {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                resolve(&folder)
            })
            .await
            .map_err(|_| ServiceError::new("unavailable", "Agent folder worker failed"))?
        };
        tokio::time::timeout(timeout, work).await.unwrap_or_else(|_| {
            Err(ServiceError::new(
                "timed_out",
                &format!(
                    "Agent folder did not respond within {} seconds; it may be on a stalled network mount",
                    timeout.as_secs_f32()
                ),
            ))
        })
    }
    /// Cancels a job. A live job is stopped and a recently finished one
    /// needs nothing; neither leaves a record, so cancelling on every
    /// navigation cannot fill the caller's records. Only a request ID not yet
    /// seen is recorded, for the cancel that overtakes its own `run`.
    fn cancel(&self, caller: &str, id: &str) -> bool {
        if !valid_id(id) || caller.is_empty() || caller.len() > 512 {
            return false;
        }
        let key = (caller.into(), id.into());
        let mut registry = self.live.lock().unwrap();
        if let Some(control) = registry.live.get(&key) {
            control.cancel();
            return true;
        }
        let now = Instant::now();
        registry.finished.retain(|_, until| *until > now);
        if registry.finished.contains_key(&key) {
            return true;
        }
        registry.cancelled.retain(|_, until| *until > now);
        let until = now + RECORD_TTL;
        // One incarnation cannot occupy every cancellation record. The empty
        // request ID is an internal sentinel; public IDs are always nonempty.
        if !registry.cancelled.contains_key(&key)
            && registry
                .cancelled
                .keys()
                .filter(|(owner, _)| owner == caller)
                .count()
                >= 64
        {
            if registry.cancelled.len() < 4096 {
                registry
                    .cancelled
                    .insert((caller.into(), String::new()), until);
            } else {
                registry.blocked_until = Some(until);
            }
            return true;
        }
        if registry.cancelled.len() < 4096 || registry.cancelled.contains_key(&key) {
            registry.cancelled.insert(key, until);
        } else {
            registry.blocked_until = Some(until);
        }
        true
    }
    fn cancel_caller(&self, caller: &str) {
        for ((owner, _), control) in self.live.lock().unwrap().live.iter() {
            if owner == caller {
                control.cancel();
            }
        }
    }
}
fn service() -> Result<&'static Service> {
    static SERVICE: OnceLock<Service> = OnceLock::new();
    if let Some(service) = SERVICE.get() {
        return Ok(service);
    }
    let root = crate::config::config_dir().map_err(|_| {
        ServiceError::new("unavailable", "Host configuration directory is unavailable")
    })?;
    let _ = SERVICE.set(Service::new(root, Arc::new(OsSecrets)));
    Ok(SERVICE.get().expect("service initialized"))
}
pub fn configuration_revision() -> Result<u64> {
    Ok(service()?.store.read()?.revision)
}
pub fn describe() -> Result<Describe> {
    service()?.describe()
}
pub async fn describe_owned(is_cancelled: OwnerCheck) -> Result<Describe> {
    let control = Control::new(Duration::from_secs(5), is_cancelled);
    control.check()?;
    let worker = control.clone();
    let read = blocking(move || {
        worker.check()?;
        let result = describe();
        worker.check()?;
        result
    });
    tokio::select! {result=read=>result,error=control.stopped()=>Err(error)}
}
pub async fn generate_owned(
    caller: String,
    request: Value,
    is_cancelled: OwnerCheck,
) -> Result<TextResult> {
    service()?
        .generate(caller, request, is_cancelled, None)
        .await
}
pub fn cancel(caller: &str, request_id: &str) -> bool {
    service().is_ok_and(|s| s.cancel(caller, request_id))
}
pub fn cancel_caller(caller: &str) {
    if let Ok(s) = service() {
        s.cancel_caller(caller);
    }
}
/// The host announced a committed configuration revision (a save here, or
/// another process's write seen by the config watcher). Agent jobs pinned to
/// another revision are cancelled.
pub fn observe_configuration_revision(revision: u64) {
    if let Ok(s) = service() {
        s.observe_revision(revision);
    }
}
pub fn cancel_all() {
    if let Ok(s) = service() {
        for control in s.live.lock().unwrap().live.values() {
            control.cancel();
        }
    }
}

fn local_slots() -> Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    let permit = local_slots()
        .acquire_owned()
        .await
        .map_err(|_| ServiceError::new("unavailable", "AI local worker queue stopped"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| ServiceError::new("unavailable", "AI settings worker failed"))?
}
async fn sanitized(config: Configuration) -> Result<Value> {
    blocking(move || {
        let s = service()?;
        Ok(s.store.sanitized(config, s.secrets.as_ref()))
    })
    .await
}
fn notify(app: &tauri::AppHandle, config: &Configuration) {
    observe_configuration_revision(config.revision);
    let _ = app.emit(
        "ai:text-configuration-changed",
        json!({"revision":config.revision}),
    );
}
#[tauri::command]
pub async fn ai_connections_read() -> Result<Value> {
    blocking(|| {
        let s = service()?;
        let config = s.store.read()?;
        Ok(s.store.sanitized(config, s.secrets.as_ref()))
    })
    .await
}
/// Drops the read-only `hasCredential` marker from every profile; input of any
/// other shape is left for `parse_configuration` to reject.
fn strip_credential_flags(value: &mut Value) {
    if let Some(profiles) = value.get_mut("profiles").and_then(Value::as_array_mut) {
        for profile in profiles {
            if let Some(p) = profile.as_object_mut() {
                p.remove("hasCredential");
            }
        }
    }
}
#[tauri::command]
pub async fn ai_connections_save(
    app: tauri::AppHandle,
    configuration: Value,
    expected_revision: u64,
) -> Result<Value> {
    let config = blocking(move || {
        let mut value = configuration;
        strip_credential_flags(&mut value);
        let config = parse_configuration(value)?;
        {
            let s = service()?;
            s.store
                .save_with_secrets(config, expected_revision, Some(s.secrets.as_ref()))
        }
    })
    .await?;
    notify(&app, &config);
    sanitized(config).await
}
#[tauri::command]
pub async fn ai_connection_set_credential(
    app: tauri::AppHandle,
    profile_id: String,
    key: String,
    expected_revision: u64,
) -> Result<Value> {
    let config = blocking(move || {
        let s = service()?;
        s.store.credential(
            &profile_id,
            Some(&key),
            expected_revision,
            s.secrets.as_ref(),
        )
    })
    .await?;
    notify(&app, &config);
    sanitized(config).await
}
#[tauri::command]
pub async fn ai_connection_clear_credential(
    app: tauri::AppHandle,
    profile_id: String,
    expected_revision: u64,
) -> Result<Value> {
    let config = blocking(move || {
        let s = service()?;
        s.store
            .credential(&profile_id, None, expected_revision, s.secrets.as_ref())
    })
    .await?;
    notify(&app, &config);
    sanitized(config).await
}
#[tauri::command]
pub async fn ai_connection_check(profile_id: String) -> Result<Check> {
    blocking(move || {
        let s = service()?;
        let config = s.store.read()?;
        let profile = config
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| ServiceError::invalid("Unknown profile"))?;
        let error = s.check_profile(profile).err();
        Ok(Check {
            available: error.is_none(),
            error,
        })
    })
    .await
}
#[tauri::command]
pub async fn ai_connection_test(
    window: tauri::Window,
    profile_id: String,
    request_id: String,
    expected_configuration_revision: u64,
) -> Result<TextResult> {
    service()?.generate(format!("settings:{}",window.label()),json!({"requestId":request_id,"instructions":"Return exactly the word Ready, without punctuation.","input":"Connection test","maxOutputTokens":16,"timeoutMs":45000,"expectedConfigurationRevision":expected_configuration_revision}),{
    use tauri::Manager;
    let app=window.app_handle().clone();let label=window.label().to_owned();
    Arc::new(move||app.get_webview_window(&label).is_none())
},Some((profile_id,expected_configuration_revision))).await
}
#[tauri::command]
pub async fn ai_connection_cancel_test(window: tauri::Window, request_id: String) -> Result<bool> {
    Ok(cancel(&format!("settings:{}", window.label()), &request_id))
}
/// Core window consumers (AI filter, #1506) share one caller per window, so a
/// window can only cancel its own requests and closing it cancels them.
fn window_caller(label: &str) -> String {
    format!("window:{label}")
}
/// Agent jobs have their own caller identity per window, with its own quota
/// and cancellation records, so they never take a window's text quota.
fn agent_caller(label: &str) -> String {
    format!("agent:window:{label}")
}
fn window_owner(window: &tauri::Window) -> OwnerCheck {
    use tauri::Manager;
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    Arc::new(move || app.get_webview_window(&label).is_none())
}
/// Whether the default text profile is enabled and locally usable. Consumers
/// check this before assembling any request content. Bounded like the plugin
/// facade: a profile check that never returns (a locked Secret Service, a
/// stalled CLI probe) must reach the AI filter as an error, not leave it
/// waiting without feedback (#1522).
#[tauri::command]
pub async fn ai_text_describe(window: tauri::Window) -> Result<Describe> {
    describe_owned(window_owner(&window)).await
}
/// Generate with the default text profile on behalf of a core window feature.
/// `expected_configuration_revision` pins the profile the caller described.
#[tauri::command]
pub async fn ai_text_generate(
    window: tauri::Window,
    request_id: String,
    instructions: String,
    input: String,
    max_output_tokens: u32,
    expected_configuration_revision: Option<u64>,
) -> Result<TextResult> {
    let request = json!({
        "requestId": request_id,
        "instructions": instructions,
        "input": input,
        "maxOutputTokens": max_output_tokens,
        "expectedConfigurationRevision": expected_configuration_revision,
    });
    service()?
        .generate(
            window_caller(window.label()),
            request,
            window_owner(&window),
            None,
        )
        .await
}
#[tauri::command]
pub async fn ai_text_cancel(window: tauri::Window, request_id: String) -> Result<bool> {
    Ok(cancel(&window_caller(window.label()), &request_id))
}
/// Bounded like [`describe_owned`]: the CLI help probe may stall, and a
/// describe that never returns would leave a plugin waiting without feedback.
pub async fn describe_agent_owned(is_cancelled: OwnerCheck) -> Result<AgentDescribe> {
    let control = Control::new(Duration::from_secs(5), is_cancelled);
    control.check()?;
    let worker = control.clone();
    let read = blocking(move || {
        worker.check()?;
        let result = service()?.describe_agent();
        worker.check()?;
        result
    });
    tokio::select! {result=read=>result,error=control.stopped()=>Err(error)}
}
/// Whether a configured CLI connection can run folder-agent jobs, its models
/// (the default is the cheapest) and how far its reads are confined.
#[tauri::command]
pub async fn ai_agent_describe(window: tauri::Window) -> Result<AgentDescribe> {
    describe_agent_owned(window_owner(&window)).await
}
/// Run one folder-agent job: the CLI starts in `folder` with read-only file
/// tools and answers `instructions` about the files it chooses to read.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_agent_run(
    window: tauri::Window,
    request_id: String,
    folder: String,
    instructions: String,
    input: String,
    model: Option<String>,
    max_output_tokens: u32,
    timeout_ms: Option<u64>,
    max_turns: Option<u32>,
    expected_configuration_revision: Option<u64>,
) -> Result<AgentResult> {
    let request = json!({
        "requestId": request_id,
        "folder": folder,
        "instructions": instructions,
        "input": input,
        "model": model,
        "maxOutputTokens": max_output_tokens,
        "timeoutMs": timeout_ms,
        "maxTurns": max_turns,
        "expectedConfigurationRevision": expected_configuration_revision,
    });
    service()?
        .run_agent(agent_caller(window.label()), request, window_owner(&window))
        .await
}
#[tauri::command]
pub async fn ai_agent_cancel(window: tauri::Window, request_id: String) -> Result<bool> {
    Ok(cancel(&agent_caller(window.label()), &request_id))
}
#[cfg(test)]
mod agent_tests;
#[cfg(test)]
mod cli_tests;
#[cfg(test)]
mod tests;
