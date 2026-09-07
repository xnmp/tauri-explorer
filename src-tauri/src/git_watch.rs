//! Tauri adapter for the lazily started Git observation service.
mod scope;
mod service;
mod target;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod termination;

use crate::error::AppError;
use notify::Watcher;
use service::{Lease, Owner, Service, Timing};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, Window};

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

// Window-local resources distinguish native incarnations even when a label is
// reused. A retired slot stays with old Window clones, not in a global tombstone
// registry. Lookup/creation and destruction share the resource-table lock.
#[derive(Default)]
struct WindowOwner {
    scope: Mutex<scope::RendererScope>,
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    termination: OnceLock<()>,
}
impl WindowOwner {
    fn watch_owner(&self, session_id: &str) -> Result<Owner, AppError> {
        // Enforce native coverage even for callers that bypass the JS wrapper.
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if self.termination.get().is_none() {
            return Err(AppError::Other(
                "Git observation renderer session was not acknowledged".into(),
            ));
        }
        self.scope
            .lock()
            .unwrap()
            .owner(session_id)
            .ok_or_else(|| AppError::Other("Git observation renderer was replaced".into()))
    }
}

impl tauri::Resource for WindowOwner {}

fn existing_owner(resources: &tauri::ResourceTable) -> Option<Arc<WindowOwner>> {
    resources
        .names()
        .find_map(|(id, _)| resources.get::<WindowOwner>(id).ok())
}

fn resource_owner(resources: &mut tauri::ResourceTable) -> Arc<WindowOwner> {
    existing_owner(resources).unwrap_or_else(|| {
        let owner = Arc::new(WindowOwner::default());
        resources.add_arc(owner.clone());
        owner
    })
}

fn retire(owner: Option<Owner>) {
    if let (Some(owner), Some(Ok(service))) = (owner, SERVICE.get()) {
        service.retire(&owner);
    }
}

/// Started is emitted at committed document loading, including same-URL reload.
/// Do not allocate an owner or start observation for windows that never use Git.
pub fn on_page_started<R: Runtime>(window: &Window<R>) {
    let resources = window.resources_table();
    let retired = existing_owner(&resources).and_then(|slot| slot.scope.lock().unwrap().advance());
    drop(resources);
    retire(retired);
}

/// Called with the concrete native window, including windows which never
/// acquired a watch. A delayed first command therefore sees a retired owner.
pub fn on_window_destroyed<R: Runtime>(window: &Window<R>) {
    let owner = {
        let mut resources = window.resources_table();
        resource_owner(&mut resources).scope.lock().unwrap().close()
    };
    retire(owner);
}

/// A renderer acknowledges its generation before sending any watch commands.
/// Its JS realm caches the result; a replaced document cannot adopt a late reply.
#[tauri::command]
pub async fn git_watch_session(webview: tauri::Webview) -> Result<String, AppError> {
    let slot = resource_owner(&mut webview.window().resources_table());
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    termination::ensure(&webview, &slot).await?;
    // A load/close may have occurred while registration waited on the UI thread.
    let session = slot.scope.lock().unwrap().session();
    session.ok_or_else(|| AppError::Other("Native window is closed".into()))
}

#[tauri::command]
pub async fn git_watch_repo(
    app: AppHandle,
    window: Window,
    repo_path: String,
    session_id: String,
) -> Result<Lease, AppError> {
    let owner = resource_owner(&mut window.resources_table()).watch_owner(&session_id)?;
    service(&app)?.acquire(&owner, repo_path).await
}

#[tauri::command]
pub async fn git_unwatch_repo(
    app: AppHandle,
    window: Window,
    lease_id: String,
    session_id: String,
) -> Result<(), AppError> {
    let owner = resource_owner(&mut window.resources_table())
        .scope
        .lock()
        .unwrap()
        .owner(&session_id);
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
