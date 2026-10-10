//! Host-owned short text service. Broker identities are supplied by native code;
//! JSON request fields cannot claim another caller's work or credentials.
mod adapters;
mod cli;
pub(crate) mod credentials;
pub mod domain;
pub(crate) mod image_migration;
mod storage;
use credentials::{OsSecrets, SecretStore};
use domain::*;
pub use domain::{Describe, ServiceError, TextResult};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
pub(crate) use storage::{migrate_summary, write_trace_config};
use tauri::Emitter;

type OwnerCheck = Arc<dyn Fn() -> bool + Send + Sync>;
pub(super) struct Control {
    cancelled: AtomicBool,
    active: AtomicBool,
    deadline: Mutex<Instant>,
    started: Instant,
    owner: OwnerCheck,
}
impl Control {
    fn check(&self) -> Result<()> {
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
}
#[derive(Default)]
struct Registry {
    live: HashMap<(String, String), Arc<Control>>,
    cancelled: HashMap<(String, String), Instant>,
    blocked_until: Option<Instant>,
}
struct Service {
    store: storage::Store,
    secrets: Arc<dyn SecretStore>,
    live: Mutex<Registry>,
    slots: Arc<tokio::sync::Semaphore>,
}
struct Admission<'a> {
    service: &'a Service,
    key: (String, String),
    control: Arc<Control>,
}
impl Drop for Admission<'_> {
    fn drop(&mut self) {
        self.control.cancel();
        self.service.live.lock().unwrap().live.remove(&self.key);
    }
}
impl Service {
    fn new(root: std::path::PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store: storage::Store::new(root),
            secrets,
            live: Mutex::new(Registry::default()),
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }
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
        if caller.is_empty() || caller.len() > 512 {
            return Err(ServiceError::invalid("Invalid native caller"));
        }
        let control = Arc::new(Control {
            cancelled: AtomicBool::new(false),
            active: AtomicBool::new(false),
            deadline: Mutex::new(
                Instant::now() + Duration::from_millis(request.timeout_ms.unwrap_or(45_000)),
            ),
            started: Instant::now(),
            owner,
        });
        control.check()?;
        let key = (caller, request.request_id.clone());
        let mut live = self.live.lock().unwrap();
        let now = Instant::now();
        live.cancelled.retain(|_, until| *until > now);
        if live.cancelled.contains_key(&key) {
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
                >= 8
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
    fn cancel(&self, caller: &str, id: &str) -> bool {
        if !valid_id(id) || caller.is_empty() || caller.len() > 512 {
            return false;
        }
        let key = (caller.into(), id.into());
        let mut registry = self.live.lock().unwrap();
        if let Some(control) = registry.live.get(&key) {
            control.cancel();
        }
        let now = Instant::now();
        registry.cancelled.retain(|_, until| *until > now);
        let until = now + Duration::from_secs(120);
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
    let now = Instant::now();
    let control = Arc::new(Control {
        cancelled: AtomicBool::new(false),
        active: AtomicBool::new(false),
        deadline: Mutex::new(now + Duration::from_secs(5)),
        started: now,
        owner: is_cancelled,
    });
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
#[allow(dead_code)] // Native core consumers may use this unowned facade.
pub async fn generate(caller: String, request: Value) -> Result<TextResult> {
    generate_owned(caller, request, Arc::new(|| false)).await
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
#[tauri::command]
pub async fn ai_connections_save(
    app: tauri::AppHandle,
    configuration: Value,
    expected_revision: u64,
) -> Result<Value> {
    let config = blocking(move || {
        let mut value = configuration;
        if let Some(profiles) = value["profiles"].as_array_mut() {
            for profile in profiles {
                if let Some(p) = profile.as_object_mut() {
                    p.remove("hasCredential");
                }
            }
        }
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
#[cfg(test)]
mod cli_tests;
#[cfg(test)]
mod tests;
