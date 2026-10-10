//! Generic installed-package services; provider implementation stays external.
mod ai_operations;
mod backend;
mod diagnostics;
mod job_bridge;
mod lifecycle;
mod ownership;
mod package;
mod process_run;
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
#[cfg(all(test, target_os = "linux"))]
mod startup_native_tests;
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
    let guard = crate::native_deadline::read(&LIFECYCLE, "Plugin lifecycle lock is unavailable")?;
    if backend::is_closing() {
        return Err(AppError::Other("Plugin host is shutting down".into()));
    }
    Ok(guard)
}
static MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
static PENDING_INSTALL_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PROFILE_OWNER: Mutex<Option<ownership::ProfileOwner>> = Mutex::new(None);
#[cfg(target_os = "linux")]
static QUEUE_WORKER: queue::WorkerSlot = Mutex::new(None);
const NOT_OWNER: &str = "Another Tauri Explorer process owns this plugin profile; AI operations and plugin changes are available there until it exits";
const STORAGE_DEFERRED: &str =
    "AI operation storage requires recovery; queued package changes were deferred";
pub(super) fn initialize(app: tauri::AppHandle) -> Result<(), AppError> {
    if crate::portal::is_portal_mode() {
        return Ok(());
    }
    backend::initialize(app.clone());
    // Ordinary browsing, and legacy backends with no durable AI involvement,
    // stay available when the profile is owned elsewhere or its AI ledger is
    // damaged. Package rollback and queued updates wait for readable claims.
    let services = mutation_lock().and_then(|_initializing| bootstrap_services());
    if let Err(cause) = &services {
        log::warn!("Plugin AI services are unavailable: {cause}");
        let owned = PROFILE_OWNER
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .is_some();
        PENDING_INSTALL_ERRORS
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .push(if owned { STORAGE_DEFERRED } else { NOT_OWNER }.into());
    }
    #[cfg(target_os = "linux")]
    {
        let directory = config::config_dir()?.join("pending-plugins");
        if services.is_ok()
            && !matches!(std::fs::symlink_metadata(&directory), Err(cause) if cause.kind() == std::io::ErrorKind::NotFound)
        {
            let notify = app.clone();
            let spawned = queue::publish_worker(&QUEUE_WORKER, backend::is_closing, || {
                std::thread::Builder::new()
                    .name("plugin-install-queue".into())
                    .spawn(move || {
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
                    })
            });
            // Queued files stay in place, so a refused worker retries next launch.
            if let Err(cause) = spawned {
                PENDING_INSTALL_ERRORS
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .push(format!(
                        "Queued plugin installation will retry on next launch: {cause}"
                    ));
                let _ = notify.emit("plugins:changed", ());
            }
        }
    }
    Ok(())
}
/// Profile ownership, then the durable ledger, then startup recovery. The
/// caller holds the mutation lock. Each step is retryable: nothing is marked
/// ready until all succeed, and a process that cannot own the profile never
/// opens its ledger, recovers its claims or starts service participants.
fn bootstrap_services() -> Result<(), AppError> {
    if backend::ownership_ready() {
        return Ok(());
    }
    let profile = config::config_dir()?;
    {
        let mut owner = PROFILE_OWNER
            .lock()
            .unwrap_or_else(|cause| cause.into_inner());
        if owner.is_none() {
            *owner = Some(
                ownership::acquire(&profile.canonicalize()?).map_err(|cause| {
                    log::warn!("Plugin profile ownership refused: {cause}");
                    AppError::Other(NOT_OWNER.into())
                })?,
            );
        }
    }
    // Reconstruct native metadata under this bootstrap gate so newly scheduled
    // reconciliation cannot race readiness. Service participants cannot have
    // started yet; no provider RPC or candidate handshake occurs under it.
    let _bootstrap = write_lifecycle()?;
    service_host::initialize(&profile)?;
    lifecycle::recover(&root()?)?;
    service_bridge::recover_startup()?;
    job_bridge::initialize()?;
    backend::finish_initialize();
    Ok(())
}
/// Explicit service actions retry a bootstrap that failed earlier, e.g. once
/// another process released the profile or transient storage errors cleared.
fn ensure_services() -> Result<(), AppError> {
    if backend::ownership_ready() {
        return Ok(());
    }
    let _initializing = mutation_lock()?;
    bootstrap_services()
}
/// Opportunistic retry from frequent read paths: bounded to one attempt per
/// interval and never waits behind a running package mutation.
fn retry_services() {
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    if backend::ownership_ready() {
        return;
    }
    {
        let mut last = LAST.lock().unwrap_or_else(|cause| cause.into_inner());
        if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(2)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let Some(_initializing) = MUTATIONS.get_or_init(|| Mutex::new(())).try_lock().ok() else {
        return;
    };
    if !backend::is_closing() {
        if let Err(cause) = bootstrap_services() {
            log::debug!("Plugin AI services remain unavailable: {cause}");
        }
    }
}
/// Without ready AI services only legacy (SDK 1/2) backends start, and only
/// when nothing durable can involve them: no interrupted package change is
/// awaiting rollback and, when the ledger is readable, no claim names them.
/// SDK 3 packages are service participants and wait for recovery.
fn degraded_backend_allowed(installed: &package::Installed) -> Result<bool, AppError> {
    if installed.manifest.sdk_version >= 3 || root()?.join("upgrade-pending").exists() {
        return Ok(false);
    }
    let Ok(store) = service_host::store() else {
        return Ok(true);
    };
    let id = &installed.manifest.id;
    Ok(!store
        .claims()?
        .iter()
        .any(|a| &a.consumer.package_id == id || &a.provider.package_id == id))
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
    PROFILE_OWNER
        .lock()
        .unwrap_or_else(|cause| cause.into_inner())
        .take();
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
    let guard = crate::native_deadline::lock(
        MUTATIONS.get_or_init(|| Mutex::new(())),
        "Plugin installation lock is unavailable",
    )?;
    if backend::is_closing() {
        return Err(AppError::Other("Plugin host is shutting down".into()));
    }
    Ok(guard)
}
#[cfg(all(test, target_os = "linux"))]
fn drain_idle(id: &str) -> Result<backend::DrainGuard, AppError> {
    lifecycle::drain_idle(service_host::store()?, id)
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
    ensure_services()?;
    let root = root()?;
    let profile = lifecycle::Profile {
        root: &root,
        store: service_host::store()?,
    };
    let installed = lifecycle::upgrade(&profile, path, &backend::preflight_candidate)?;
    if installed.enabled {
        if let Err(cause) = backend::activate(&installed.manifest.id) {
            log::warn!("Installed plugin activation will retry on next use: {cause}");
        }
    } else {
        backend::retire(&installed.manifest.id);
    }
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
    let origin_label = window.label().to_owned();
    let entered = std::time::SystemTime::now();
    tauri::async_runtime::spawn_blocking(move || {
        retry_services();
        let _guard = read_lifecycle()?;
        if !package::list(&root()?)?
            .iter()
            .any(|entry| entry.manifest.id == package_id && entry.enabled)
        {
            return Err(AppError::Other(
                "Plugin package is disabled or removed".into(),
            ));
        }
        let _lease = backend::CallLease::acquire_method(&package_id, &method)?;
        drop(_guard);
        backend::call_with_origin(&package_id, &method, params, &origin_label, entered)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
}

#[tauri::command]
pub async fn plugin_jobs_snapshot(window: tauri::WebviewWindow) -> Result<Value, AppError> {
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        retry_services();
        job_bridge::snapshot(&label)
    })
    .await
    .map_err(|e| AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn plugin_job_cancel(job_key: String) -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_services()?;
        job_bridge::cancel(&job_key)
    })
    .await
    .map_err(|e| AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn plugin_job_resume(job_key: String) -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_services()?;
        job_bridge::resume(&job_key)
    })
    .await
    .map_err(|e| AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn plugin_job_dismiss(job_key: String) -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_services()?;
        job_bridge::dismiss(&job_key)
    })
    .await
    .map_err(|e| AppError::WorkerFailed(e.to_string()))?
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
        ensure_services()?;
        let root = root()?;
        lifecycle::uninstall(
            &lifecycle::Profile {
                root: &root,
                store: service_host::store()?,
            },
            &id,
        )
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
        ensure_services()?;
        let root = root()?;
        lifecycle::set_enabled(
            &lifecycle::Profile {
                root: &root,
                store: service_host::store()?,
            },
            &id,
            enabled,
        )
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
pub async fn ai_operations_snapshot() -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        retry_services();
        ai_operations::snapshot()
    })
    .await
    .map_err(|e| AppError::WorkerFailed(e.to_string()))?
}
#[tauri::command]
pub async fn ai_operation_resolve(
    consumer_package: String,
    operation_id: String,
    action: String,
) -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_services()?;
        ai_operations::resolve(&consumer_package, &operation_id, &action)
    })
    .await
    .map_err(|e| AppError::WorkerFailed(e.to_string()))?
}

/// The committed package controls legacy settings compatibility, never a renderer flag.
pub(crate) fn image_source_mode_at(profile: &Path) -> Result<u8, AppError> {
    Ok(package::list(&profile.join("installed-plugins"))?
        .into_iter()
        .find(|p| {
            p.enabled
                && p.manifest.id == "xnmp.trace-explorer"
                && p.manifest.contributions.iter().any(|c| c == "openai-image")
        })
        .map(|p| if p.manifest.sdk_version < 3 { 1 } else { 2 })
        .unwrap_or(0))
}
