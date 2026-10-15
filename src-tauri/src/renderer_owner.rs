//! One native-window resource owns the current renderer incarnation. Resource
//! services share its cancellation identity, without retaining native windows.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
mod reload;
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
pub(crate) struct Owner(Arc<Lifetime>);

#[derive(Default, Debug)]
struct Lifetime {
    retired: AtomicBool,
    changed: tokio::sync::Notify,
}

impl Owner {
    pub(crate) fn retire(&self) {
        if !self.0.retired.swap(true, Ordering::AcqRel) {
            self.0.changed.notify_waiters();
        }
    }
    pub(crate) fn active(&self) -> bool {
        !self.0.retired.load(Ordering::Acquire)
    }

    /// Blocking workers share the same cancellation identity as async waiters.
    pub(crate) fn cancellation_flag(&self) -> &AtomicBool {
        &self.0.retired
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Install the waiter before checking the flag: notify_waiters does not
    /// retain a permit for a future that has not registered yet.
    pub(crate) async fn retired(&self) {
        let notified = self.0.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.active() {
            notified.await;
        }
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
        crate::files::media_preview::retire_owners();
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

/// One line per renderer loss, for every webview, in the format the startup
/// qualifier fails on. Neither Wry adapter logs a terminated page, so this is
/// the only record of the loss itself (#936). The epoch and app-run times
/// correlate it with the `Startup(...)` markers.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn log_termination<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &str,
    webview: &str,
    reason: Option<&str>,
) {
    let app_run_ms = app
        .try_state::<crate::system::StartupClock>()
        .map(|clock| clock.started.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(f64::NAN);
    log::warn!(
        "Renderer(web-content-terminated): window={window} webview={webview} epoch-ms={:.3} app-run-ms={:.1}{}",
        crate::system::epoch_ms_now(),
        app_run_ms,
        reason.map(|reason| format!(" reason={reason}")).unwrap_or_default(),
    );
}

/// The one recovery path for both WebKit ports (#942, #1138): record the loss,
/// retire the lost generation exactly as a document boundary does, then
/// recover the window under its reload budget. A deliberate API teardown is
/// retired too, but never reloaded.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn on_renderer_terminated(
    webview: &tauri::Webview,
    reason: Option<&str>,
    termination: reload::Termination,
) {
    let window = webview.window();
    log_termination(
        webview.app_handle(),
        window.label(),
        webview.label(),
        reason,
    );
    on_page_started(&window);
    reload::recover(webview, termination);
}

/// macOS reports WebContent loss through Wry's navigation delegate rather than
/// a per-page signal, and no reason: every loss is recovered.
#[cfg(target_os = "macos")]
pub fn on_web_content_terminated(webview: &tauri::Webview) {
    on_renderer_terminated(webview, None, reload::Termination::Lost);
}

/// WebKitGTK's `web-process-terminated` for every webview, not only pages
/// that acquire native ownership (whose lazy listener in `termination.rs`
/// also retires their generation; the extra advance only skips an unused
/// generation number). Connected when the webview is created, so it runs
/// before that listener and before any page can acknowledge a session.
#[cfg(target_os = "linux")]
pub fn termination_recovery() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("renderer-termination-recovery")
        .on_webview_ready(|webview| {
            let failed = webview.label().to_owned();
            let target = webview.clone();
            if let Err(error) = webview.with_webview(move |native| {
                use webkit2gtk::WebViewExt;
                native
                    .inner()
                    .connect_web_process_terminated(move |_, reason| {
                        let (reason, termination) = linux_termination(reason);
                        on_renderer_terminated(&target, Some(&reason), termination);
                    });
            }) {
                log::warn!("Renderer termination recovery unavailable for {failed}: {error}");
            }
        })
        .build()
}

/// WebKitGTK's reason as logged, and whether the loss is recovered: only an
/// API teardown (`webkit_web_view_terminate_web_process`) is deliberate.
#[cfg(target_os = "linux")]
fn linux_termination(
    reason: webkit2gtk::WebProcessTerminationReason,
) -> (String, reload::Termination) {
    use webkit2gtk::WebProcessTerminationReason as Reason;
    let termination = if reason == Reason::TerminatedByApi {
        reload::Termination::Deliberate
    } else {
        reload::Termination::Lost
    };
    let reason = match reason {
        Reason::Crashed => "crashed".into(),
        Reason::ExceededMemoryLimit => "exceeded-memory-limit".into(),
        Reason::TerminatedByApi => "terminated-by-api".into(),
        other => format!("{other:?}").to_lowercase(),
    };
    (reason, termination)
}

/// The committed document a renderer-loss reload restores (#942, #1138).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn on_document_committed<R: Runtime>(window: &Window<R>, url: &tauri::Url) {
    reload::record_document(window, url);
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
    })
    .await?;
    crate::file_history::register(owner, history_channel)?;
    Ok(session)
}

async fn acknowledge_session(
    slot: &WindowOwner,
    ensure: impl std::future::Future<Output = Result<(), AppError>>,
) -> Result<(String, Owner), AppError> {
    // Capture the requesting document before the UI-thread installation can
    // yield. A delayed old invocation must never adopt its replacement.
    let session = slot
        .scope
        .lock()
        .unwrap()
        .session()
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

#[cfg(test)]
#[path = "../test_support/renderer_reload.rs"]
mod reload_tests;
