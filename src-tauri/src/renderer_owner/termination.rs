//! Native renderer lifetime signals, installed only when a page requests resource
//! ownership. Each application window contains one native Webview for its life.
use super::{retire, WindowOwner};
use crate::error::AppError;
use std::sync::{Arc, Weak};

pub(super) async fn ensure(
    webview: &tauri::Webview,
    slot: &Arc<WindowOwner>,
) -> Result<(), AppError> {
    if slot.termination.get().is_some() {
        return Ok(());
    }
    let weak = Arc::downgrade(slot);
    let (send, receive) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |native| {
            let result = weak
                .upgrade()
                .ok_or_else(|| AppError::Other("Native window is closed".into()))
                .and_then(|slot| {
                    // UI-thread callbacks serialize registration. Store success
                    // here, even if the awaiting IPC was cancelled, so retries
                    // and concurrent requests cannot duplicate native handlers.
                    if slot.termination.get().is_none() {
                        install(native, Arc::downgrade(&slot))?;
                        let _ = slot.termination.set(());
                    }
                    Ok(())
                });
            let _ = send.send(result);
        })
        .map_err(|error| AppError::Other(error.to_string()))?;
    receive
        .await
        .map_err(|_| AppError::Other("Native renderer registration was interrupted".into()))?
}

fn terminated(weak: &Weak<WindowOwner>) {
    if let Some(slot) = weak.upgrade() {
        let old = slot.scope.lock().unwrap().advance();
        retire(old);
    }
}

#[cfg(target_os = "linux")]
fn install(
    native: tauri::webview::PlatformWebview,
    slot: Weak<WindowOwner>,
) -> Result<(), AppError> {
    use webkit2gtk::WebViewExt;
    // The native Webview owns the handler until destruction; the weak capture
    // cannot keep either the window or its resource owner alive.
    native
        .inner()
        .connect_web_process_terminated(move |_, _| terminated(&slot));
    Ok(())
}

#[cfg(target_os = "windows")]
fn install(
    native: tauri::webview::PlatformWebview,
    slot: Weak<WindowOwner>,
) -> Result<(), AppError> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            // Subframe/GPU failures and unresponsiveness leave the owning page
            // alive. Retiring it would silently disable a functioning consumer.
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
            {
                terminated(&slot);
            }
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe {
        native
            .controller()
            .CoreWebView2()
            .and_then(|view| view.add_ProcessFailed(&handler, &mut token))
    }
    .map_err(|error| AppError::Other(error.to_string()))
}
