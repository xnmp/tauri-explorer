//! One native-window resource owns the current renderer incarnation. Resource
//! services share its cancellation identity, without retaining native windows.
mod scope;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod termination;

use crate::error::AppError;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::sync::OnceLock;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, Runtime, Window};

/// Cancellation identity for a native resource lifetime (renderer or request).
#[derive(Clone, Default, Debug)]
pub(crate) struct Owner(Arc<AtomicBool>);
impl Owner {
    pub(crate) fn retire(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub(crate) fn active(&self) -> bool {
        !self.0.load(Ordering::Acquire)
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
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
                "Native resource renderer session was not acknowledged".into(),
            ));
        }
        self.scope
            .lock()
            .unwrap()
            .owner(session_id)
            .ok_or_else(|| AppError::Other("Native resource renderer was replaced".into()))
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
    if let Some(owner) = owner {
        owner.retire();
        crate::git_watch::retire_owner(&owner);
        crate::files::fs_watcher::retire_owners();
        crate::file_history::retire_owners();
    }
}

/// Started is emitted at committed document loading, including same-URL reload.
/// Do not allocate an owner or start observation for windows that never acquire native resources.
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
pub async fn native_resource_session(
    webview: tauri::Webview,
    history_channel: tauri::ipc::Channel<crate::file_history::HistorySummary>,
) -> Result<String, AppError> {
    let slot = resource_owner(&mut webview.window().resources_table());
    let (session, owner) = acknowledge_session(&slot, async {
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        termination::ensure(&webview, &slot).await?;
        Ok(())
    }).await?;
    crate::file_history::register(owner, history_channel)?;
    Ok(session)
}

async fn acknowledge_session(
    slot: &WindowOwner,
    ensure: impl std::future::Future<Output = Result<(), AppError>>,
) -> Result<(String, Owner), AppError> {
    // Capture the requesting document before the UI-thread installation can
    // yield. A delayed old invocation must never adopt its replacement.
    let session = slot.scope.lock().unwrap().session()
        .ok_or_else(|| AppError::Other("Native window is closed".into()))?;
    ensure.await?;
    let owner = slot.watch_owner(&session)?;
    Ok((session, owner))
}

/// Acquire authority only after the current renderer acknowledged native coverage.
pub(crate) fn acquire_owner<R: Runtime>(
    window: &Window<R>,
    session_id: &str,
) -> Result<Owner, AppError> {
    resource_owner(&mut window.resources_table()).watch_owner(session_id)
}

/// Old-generation releases are harmless: native retirement owns their cleanup.
pub(crate) fn release_owner<R: Runtime>(window: &Window<R>, session_id: &str) -> Option<Owner> {
    resource_owner(&mut window.resources_table())
        .scope
        .lock()
        .unwrap()
        .owner(session_id)
}

#[cfg(test)]
#[path = "../test_support/renderer_owner.rs"]
mod tests;
