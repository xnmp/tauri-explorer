//! Tauri adapter for the lazily started Git observation service.
mod service;
mod target;

use crate::error::AppError;
use notify::Watcher;
use service::{Lease, Service, Timing};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};

static SERVICE: OnceLock<Result<Service, String>> = OnceLock::new();

fn native_observer(
    target: &target::Target,
    callback: service::Callback,
) -> Result<service::Observer, AppError> {
    let mut watcher: Box<dyn Watcher + Send> =
        if target.key.starts_with("//") || target.key.starts_with("\\\\") {
            Box::new(
                notify::PollWatcher::new(
                    callback,
                    notify::Config::default().with_poll_interval(Duration::from_secs(15)),
                )
                .map_err(|error| AppError::Other(error.to_string()))?,
            )
        } else {
            Box::new(
                notify::recommended_watcher(callback)
                    .map_err(|error| AppError::Other(error.to_string()))?,
            )
        };
    target::install(target, |root, mode| {
        let result = watcher.watch(root, mode);
        log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
            "git physical registration key={:?} path={root:?} mode={mode:?} result={result:?}",
            target.key);
        result
    })?;
    Ok(Box::new(watcher))
}

fn service(app: &AppHandle) -> Result<&'static Service, AppError> {
    SERVICE
        .get_or_init(|| {
            let app = app.clone();
            Service::spawn(
                Box::new(native_observer),
                Box::new(move |key| {
                    #[cfg(all(target_os = "linux", feature = "e2e-renderer-recovery"))]
                    if let Some(observation) = crate::git_observation_probe::payload(key) {
                        return app
                            .emit("git-status-changed", observation)
                            .map_err(|error| error.to_string());
                    }
                    app.emit("git-status-changed", key)
                        .map_err(|error| error.to_string())
                }),
                Timing::default(),
            )
            .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| AppError::Other(error.clone()))
}

/// Native lifetime callbacks only wake an existing observation worker.
pub(crate) fn retire_owner(owner: &crate::renderer_owner::Owner) {
    if let Some(Ok(service)) = SERVICE.get() {
        service.retire(owner);
    }
}

#[tauri::command]
pub async fn git_watch_repo(
    app: AppHandle,
    window: Window,
    repo_path: String,
    session_id: String,
) -> Result<Lease, AppError> {
    let owner = crate::renderer_owner::acquire_owner(&window, &session_id)?;
    service(&app)?.acquire(&owner, repo_path).await
}

#[tauri::command]
pub async fn git_unwatch_repo(
    app: AppHandle,
    window: Window,
    lease_id: String,
    session_id: String,
) -> Result<(), AppError> {
    let owner = crate::renderer_owner::release_owner(&window, &session_id);
    match owner {
        Some(owner) => service(&app)?.release(&owner, lease_id).await,
        None => Ok(()), // Native retirement already owns old-generation cleanup.
    }
}

/// Called after the native event loop finishes. Also avoids starting a worker
/// at all in sessions which never use Git observation.
pub fn shutdown() {
    if let Some(Ok(service)) = SERVICE.get() {
        service.stop();
    }
}

#[cfg(test)]
#[path = "../test_support/git_watch.rs"]
mod tests;
