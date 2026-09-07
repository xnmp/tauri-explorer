//! Tauri adapter for the lazily started Git observation service.
mod service;
mod target;

use crate::error::AppError;
use notify::Watcher;
use service::{Lease, Service, Timing};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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
    target::install(target, |root, mode| watcher.watch(root, mode))?;
    Ok(Box::new(watcher))
}

fn service(app: &AppHandle) -> Result<&'static Service, AppError> {
    SERVICE
        .get_or_init(|| {
            let app = app.clone();
            Service::spawn(
                Box::new(native_observer),
                Box::new(move |key| {
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

#[tauri::command]
pub async fn git_watch_repo(app: AppHandle, repo_path: String) -> Result<Lease, AppError> {
    service(&app)?.acquire(repo_path).await
}

#[tauri::command]
pub async fn git_unwatch_repo(app: AppHandle, lease_id: String) -> Result<(), AppError> {
    service(&app)?.release(lease_id).await
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
