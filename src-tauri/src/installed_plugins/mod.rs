//! Generic installed-package services; provider implementation stays external.
mod backend;
mod ai_operations;
mod job_bridge;
mod diagnostics;
mod lifecycle;
#[cfg(target_os = "linux")]
mod ownership;
mod package;
pub(crate) mod provenance;
#[cfg(target_os = "linux")]
mod queue;
mod service_bridge;
#[cfg(test)]
mod service_bridge_tests;
mod service_graph;
#[cfg(test)]
mod service_graph_tests;
mod service_host;
mod text_service;
use crate::{config, error::AppError};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard},
};
use tauri::Emitter;
static LIFECYCLE: RwLock<()> = RwLock::new(());
pub(crate) fn read_lifecycle() -> Result<RwLockReadGuard<'static, ()>, AppError> {
    let guard = crate::native_deadline::read(&LIFECYCLE,"Plugin lifecycle lock is unavailable")?;
    if backend::is_closing() { return Err(AppError::Other("Plugin host is shutting down".into())); }
    Ok(guard)
}
static MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
static PENDING_INSTALL_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
#[cfg(target_os = "linux")]
static PROFILE_OWNER: Mutex<Option<ownership::ProfileOwner>> = Mutex::new(None);
#[cfg(target_os = "linux")]
static QUEUE_WORKER: queue::WorkerSlot = Mutex::new(None);
pub(super) fn initialize(app: tauri::AppHandle) -> Result<(), AppError> {
    if crate::portal::is_portal_mode() {
        return Ok(());
    }
    let _initializing = mutation_lock()?;
    #[cfg(target_os = "linux")]
    {
        let owner = ownership::acquire(&config::config_dir()?.canonicalize()?)?;
        *PROFILE_OWNER.lock().unwrap_or_else(|cause| cause.into_inner()) = Some(owner);
    }
    backend::initialize(app.clone());
    // No brokers are running yet. Reconstruct native metadata under this
    // bootstrap gate so newly scheduled reconciliation cannot race readiness.
    // No provider RPC or candidate handshake occurs while this gate is held.
    let bootstrap = LIFECYCLE.write().map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
    // Ordinary browsing remains available if durable AI ownership is damaged.
    // Package rollback and queued updates must not run until claims are readable.
    let services_ready = service_host::initialize().is_ok();
    if services_ready {
        lifecycle::recover(&root()?)?;
        service_bridge::recover_startup()?;
        job_bridge::initialize()?;
        backend::finish_initialize();
    } else {
        PENDING_INSTALL_ERRORS
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .push(
                "AI operation storage requires recovery; queued package changes were deferred"
                    .into(),
            );
    }
    drop(bootstrap);
    #[cfg(target_os = "linux")]
    {
        let directory = config::config_dir()?.join("pending-plugins");
        if services_ready
            && !matches!(std::fs::symlink_metadata(&directory), Err(cause) if cause.kind() == std::io::ErrorKind::NotFound)
        {
            let notify = app.clone();
            let spawned = queue::publish_worker(&QUEUE_WORKER, backend::is_closing, || std::thread::Builder::new().name("plugin-install-queue".into()).spawn(move || {
                let errors = queue::apply(
                    &directory,
                    |path| install_path(path).map(|_| ()),
                    backend::is_closing,
                )
                .unwrap_or_else(|cause| {
                    vec![format!(
                        "Could not process queued plugin installation: {cause}"
                    )]
                });
                for error in &errors {
                    log::warn!("{error}");
                }
                PENDING_INSTALL_ERRORS
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .extend(errors);
                let _ = app.emit("plugins:changed", ());
            }));
            // Queued files stay in place, so a refused worker retries next launch.
            if let Err(cause) = spawned {
                PENDING_INSTALL_ERRORS
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .push(format!("Queued plugin installation will retry on next launch: {cause}"));
                let _ = notify.emit("plugins:changed", ());
            }
        }
    }
    Ok(())
}
pub(super) fn shutdown() {
    backend::shutdown();
    let mutations = MUTATIONS.get_or_init(|| Mutex::new(()));
    // Never join while holding the gate: the worker's installer acquires it.
    #[cfg(target_os = "linux")]
    queue::settle_worker(mutations, &QUEUE_WORKER);
    // A private candidate is owned by its mutation, rather than the routable
    // broker map. Wait for its commit/rollback on every platform.
    let _settled = mutations.lock().unwrap_or_else(|cause| cause.into_inner());
    service_bridge::shutdown_recovery();
    job_bridge::shutdown();
    backend::wait_for_admissions();
    provenance::wait_for_publishers();
    #[cfg(target_os = "linux")]
    PROFILE_OWNER.lock().unwrap_or_else(|cause| cause.into_inner()).take();
}
fn root() -> Result<PathBuf, AppError> {
    Ok(config::config_dir()?.join("installed-plugins"))
}

fn write_lifecycle() -> Result<RwLockWriteGuard<'static, ()>, AppError> {
    let guard = LIFECYCLE
        .write()
        .map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
    if backend::is_closing() {
        return Err(AppError::Other("Plugin host is shutting down".into()));
    }
    Ok(guard)
}
fn mutation_lock() -> Result<std::sync::MutexGuard<'static, ()>, AppError> {
    let guard = crate::native_deadline::lock(MUTATIONS.get_or_init(|| Mutex::new(())), "Plugin installation lock is unavailable")?;
    if backend::is_closing() { return Err(AppError::Other("Plugin host is shutting down".into())); }
    Ok(guard)
}
fn drain_idle(id: &str) -> Result<backend::DrainGuard, AppError> {
    let _guard = write_lifecycle()?;
    service_host::mutation_allowed(id)?;
    if backend::busy(id) { return Err(AppError::Other("Finish active plugin operations before changing this package".into())); }
    backend::begin_drain(id)
}

fn error_window(label: &str, visible: bool) -> bool {
    visible && (label == "main" || label.starts_with("explorer-"))
}

pub(super) fn notify_pending_errors(window: &tauri::Window) {
    if error_window(window.label(), window.is_visible().unwrap_or(false))
        && !PENDING_INSTALL_ERRORS
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .is_empty()
    {
        let _ = window.emit("plugins:changed", ());
    }
}

fn install_path(path: &Path) -> Result<package::Installed, AppError> {
    let _guard = mutation_lock()?;
    lifecycle::recover(&root()?)?;
    let candidate = package::prepare(&root()?, path)?;
    let drain = {
        let _lifecycle = write_lifecycle()?;
        service_host::mutation_allowed(&candidate.manifest.id)?;
        if backend::busy(&candidate.manifest.id) { return Err(AppError::Other("Finish active plugin operations before upgrading".into())); }
        backend::begin_drain(&candidate.manifest.id)?
    };
    drain.quiesce()?;
    // The package fence, not a global lock, owns snapshot/preflight/rollback.
    // Reader threads may need lifecycle admission while retirement joins them.
    let installed = lifecycle::install(&root()?, candidate, &drain)?;
    drop(drain);
    drop(_guard);
    if installed.enabled {
        if let Err(cause) = backend::activate(&installed.manifest.id) {
            log::warn!("Installed plugin activation will retry on next use: {cause}");
        }
    } else { backend::retire(&installed.manifest.id); }
    Ok(installed)
}

#[tauri::command]
pub fn take_pending_plugin_install_errors(window: tauri::WebviewWindow) -> Vec<String> {
    if !error_window(window.label(), window.is_visible().unwrap_or(false)) {
        return vec![];
    }
    std::mem::take(
        &mut *PENDING_INSTALL_ERRORS
            .lock()
            .unwrap_or_else(|cause| cause.into_inner()),
    )
}

#[tauri::command]
pub async fn list_installed_plugins() -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = read_lifecycle()?;
        serde_json::to_value(package::list(&root()?)?)
            .map_err(|error| AppError::Other(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn plugin_backend_invoke(
    window: tauri::WebviewWindow,
    package_id: String,
    method: String,
    params: Value,
) -> Result<Value, AppError> {
    let origin_label=window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = read_lifecycle()?;
        if !package::list(&root()?)?
            .iter()
            .any(|entry| entry.manifest.id == package_id && entry.enabled)
        {
            return Err(AppError::Other(
                "Plugin package is disabled or removed".into(),
            ));
        }
        let _lease = backend::CallLease::acquire_method(&package_id,&method)?;
        drop(_guard);
        backend::call_with_origin(&package_id, &method, params,&origin_label)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

#[tauri::command]
pub async fn plugin_jobs_snapshot(window:tauri::WebviewWindow)->Result<Value,AppError> {
    let label=window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move||job_bridge::snapshot(&label)).await.map_err(|e|AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn plugin_job_cancel(job_key:String)->Result<Value,AppError> {
    tauri::async_runtime::spawn_blocking(move||job_bridge::cancel(&job_key)).await.map_err(|e|AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn plugin_job_resume(job_key:String)->Result<Value,AppError> {
    tauri::async_runtime::spawn_blocking(move||job_bridge::resume(&job_key)).await.map_err(|e|AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn plugin_job_dismiss(job_key:String)->Result<Value,AppError> {
    tauri::async_runtime::spawn_blocking(move|| {
        if let Some(revision)=service_host::store()?.dismiss_job(&job_key)? {
            backend::emit_job_event(serde_json::json!({"type":"dismissed","jobKey":job_key,"revision":revision}));
        }
        Ok(Value::Null)
    }).await.map_err(|e|AppError::WorkerFailed(e.to_string()))?
}

#[tauri::command]
pub async fn install_plugin(app: tauri::AppHandle, path: String) -> Result<Value, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(install_path(Path::new(&path))?)
            .map_err(|error| AppError::Other(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?;
    if result.is_ok() {
        let _ = app.emit("plugins:changed", ());
    }
    result
}

#[tauri::command]
pub async fn uninstall_plugin(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = mutation_lock()?;
        lifecycle::recover(&root()?)?;
        let drain = drain_idle(&id)?;
        drain.quiesce()?;
        let mut remaining = package::list(&root()?)?;
        remaining.retain(|entry| entry.manifest.id != id);
        service_graph::validate_enabled(&remaining)?;
        backend::retire(&id);
        let result = {
            let _lifecycle = LIFECYCLE.write().map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
            package::uninstall(&root()?, &id)
        };
        drop(drain);
        result
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?;
    if result.is_ok() {
        let _ = app.emit("plugins:changed", ());
    }
    result
}

pub(super) fn serve_asset(path: &str) -> Result<(Vec<u8>, &'static str), AppError> {
    package::frontend_asset(&root()?, path)
}

#[tauri::command]
pub async fn set_plugin_package_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _mutation = mutation_lock()?;
        lifecycle::recover(&root()?)?;
        {
            let _guard = read_lifecycle()?;
            let entries = package::list(&root()?)?;
            let current = entries.iter().find(|entry| entry.manifest.id == id)
                .ok_or_else(|| AppError::Other("Plugin package is not installed".into()))?;
            if current.enabled == enabled { return Ok(()); }
        }
        let drain = if enabled { None } else { Some(drain_idle(&id)?) };
        if let Some(drain) = &drain {
            drain.quiesce()?;
            backend::retire(&id);
        }
        let result = {
        let _guard = LIFECYCLE.write().map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
        let root = root()?;
        let mut entries = package::list(&root)?;
        let current=entries.iter().find(|entry|entry.manifest.id==id).ok_or_else(||AppError::Other("Plugin package is not installed".into()))?;
        if current.enabled==enabled {return Ok(());}
        if !enabled {service_host::mutation_allowed(&id)?;if backend::busy(&id) {return Err(AppError::Other("Finish active plugin operations before changing this package".into()));}}
        else if service_host::store()?.claims()?.iter().any(|a|(a.consumer.package_id==id&&a.consumer.digest!=current.digest)||(a.provider.package_id==id&&a.provider.digest!=current.digest)) {return Err(AppError::Other("Enable the pinned package version to recover its AI operations".into()));}
        let entry = entries
            .iter_mut()
            .find(|entry| entry.manifest.id == id)
            .ok_or_else(|| AppError::Other("Plugin package is not installed".into()))?;
        entry.enabled = enabled;
        service_graph::validate_enabled(&entries)?;
        package::write_index(&root, &entries)
        };
        drop(drain);
        result
    })
    .await
    .map_err(|cause| AppError::WorkerFailed(cause.to_string()))?;
    if result.is_ok() {
        let _ = app.emit("plugins:changed", ());
    }
    result
}

#[cfg(test)]
mod error_delivery_tests {
    use super::error_window;
    #[test]
    fn only_visible_explorers_can_consume_installation_errors() {
        assert!(error_window("main", true));
        assert!(error_window("explorer-1", true));
        assert!(error_window("explorer-warm-1", true));
        assert!(!error_window("explorer-warm-1", false));
        assert!(!error_window("main", false));
        assert!(!error_window("file-picker-1", true));
    }
}

#[tauri::command]
pub async fn ai_operations_snapshot()->Result<Value,AppError> {
    tauri::async_runtime::spawn_blocking(ai_operations::snapshot).await.map_err(|e|AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn ai_operation_resolve(consumer_package:String,operation_id:String,action:String)->Result<Value,AppError> {
    tauri::async_runtime::spawn_blocking(move||ai_operations::resolve(&consumer_package,&operation_id,&action)).await.map_err(|e|AppError::WorkerFailed(e.to_string()))?
}

/// The committed package controls legacy settings compatibility, never a renderer flag.
pub(crate) fn image_source_mode_at(profile:&Path)->Result<u8,AppError> {
    Ok(package::list(&profile.join("installed-plugins"))?.into_iter().find(|p|p.enabled&&p.manifest.id=="xnmp.trace-explorer"&&p.manifest.contributions.iter().any(|c|c=="openai-image")).map(|p|if p.manifest.sdk_version<3 {1}else{2}).unwrap_or(0))
}
