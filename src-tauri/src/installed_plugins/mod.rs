//! Generic installed-package services; provider implementation stays external.
mod backend;
mod lifecycle;
#[cfg(target_os = "linux")]
mod ownership;
mod package;
pub(crate) mod provenance;
#[cfg(target_os = "linux")]
mod queue;
use crate::{config, error::AppError};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard},
};
use tauri::Emitter;
static LIFECYCLE: RwLock<()> = RwLock::new(());
pub(super) fn read_lifecycle() -> Result<RwLockReadGuard<'static, ()>, AppError> {
    LIFECYCLE
        .read()
        .map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))
}
static MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
static PENDING_INSTALL_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());
#[cfg(target_os = "linux")]
static PROFILE_OWNER: Mutex<Option<std::fs::File>> = Mutex::new(None);
#[cfg(target_os = "linux")]
static QUEUE_WORKER: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
pub(super) fn initialize(app: tauri::AppHandle) -> Result<(), AppError> {
    if crate::portal::is_portal_mode() {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    let owner = ownership::acquire(&config::config_dir()?.canonicalize()?)?;
    lifecycle::recover(&root()?)?;
    backend::initialize(app.clone());
    #[cfg(target_os = "linux")]
    {
        *PROFILE_OWNER
            .lock()
            .unwrap_or_else(|cause| cause.into_inner()) = Some(owner);
        let directory = config::config_dir()?.join("pending-plugins");
        if !matches!(std::fs::symlink_metadata(&directory), Err(cause) if cause.kind() == std::io::ErrorKind::NotFound)
        {
            let worker = std::thread::spawn(move || {
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
            });
            *QUEUE_WORKER
                .lock()
                .unwrap_or_else(|cause| cause.into_inner()) = Some(worker);
        }
    }
    Ok(())
}
pub(super) fn shutdown() {
    backend::shutdown();
    #[cfg(target_os = "linux")]
    {
        if let Some(worker) = QUEUE_WORKER
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take()
        {
            let _ = worker.join();
        }
        // Stop new mutations and let in-flight commits or rollback finish before
        // another process can acquire this profile and recover its journal.
        let _settled = LIFECYCLE.write().unwrap_or_else(|cause| cause.into_inner());
        PROFILE_OWNER
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take();
    }
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
    let _guard = MUTATIONS
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| AppError::Other("Plugin installation lock is unavailable".into()))?;
    let _lifecycle = write_lifecycle()?;
    lifecycle::install(&root()?, path)
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
    package_id: String,
    method: String,
    params: Value,
) -> Result<Value, AppError> {
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
        backend::call(&package_id, &method, params)
    })
    .await
    .map_err(|error| AppError::WorkerFailed(error.to_string()))?
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
        let _guard = MUTATIONS
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| AppError::Other("Plugin installation lock is unavailable".into()))?;
        let _lifecycle = write_lifecycle()?;
        if backend::busy(&id) {
            return Err(AppError::Other(
                "Finish active plugin operations before removing this package".into(),
            ));
        }
        backend::retire(&id);
        package::uninstall(&root()?, &id)
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
        let _guard = write_lifecycle()?;
        let root = root()?;
        let mut entries = package::list(&root)?;
        let entry = entries
            .iter_mut()
            .find(|entry| entry.manifest.id == id)
            .ok_or_else(|| AppError::Other("Plugin package is not installed".into()))?;
        entry.enabled = enabled;
        package::write_index(&root, &entries)
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
