//! Generic installed-package services; provider implementation stays external.
mod backend;
mod lifecycle;
mod package;
pub(crate) mod provenance;
use crate::{config, error::AppError};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock, RwLockReadGuard},
};
use tauri::Emitter;
static LIFECYCLE: RwLock<()> = RwLock::new(());
pub(super) fn read_lifecycle() -> Result<RwLockReadGuard<'static, ()>, AppError> {
    LIFECYCLE
        .read()
        .map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))
}
static MUTATIONS: OnceLock<Mutex<()>> = OnceLock::new();
pub(super) fn initialize(app: tauri::AppHandle) -> Result<(), AppError> {
    lifecycle::recover(&root()?)?;
    backend::initialize(app);
    Ok(())
}
pub(super) fn shutdown() {
    backend::shutdown();
}
fn root() -> Result<PathBuf, AppError> {
    Ok(config::config_dir()?.join("installed-plugins"))
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
        let _guard = MUTATIONS
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| AppError::Other("Plugin installation lock is unavailable".into()))?;
        let _lifecycle = LIFECYCLE
            .write()
            .map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
        serde_json::to_value(lifecycle::install(&root()?, Path::new(&path))?)
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
        let _lifecycle = LIFECYCLE
            .write()
            .map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
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
        let _guard = LIFECYCLE
            .write()
            .map_err(|_| AppError::Other("Plugin lifecycle lock is unavailable".into()))?;
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
