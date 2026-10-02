//! Recovery of a window whose web-content process terminated (#942).
//!
//! WKWebView does not reload a page whose WebContent process died; Apple's
//! guidance for `webViewWebContentProcessDidTerminate` is that the app reloads
//! it. A page that crashes on every boot must not reload forever, so each
//! concrete native window carries a sliding-window reload budget. The decision
//! is pure; the macOS adapter below only logs and applies it.
use std::time::{Duration, Instant};
#[cfg(target_os = "macos")]
use tauri::Manager as _;

/// Query marker telling the reloaded document it replaces a lost renderer, so
/// it restores the window's own persisted session instead of re-running
/// one-shot launch requests (`src/lib/domain/window-launch-plan.ts`).
pub(crate) const RECOVERY_QUERY_KEY: &str = "rendererRecovery";

/// A warm window's parking request (`src/lib/state/warm-window.ts`). Only an
/// activated warm window is ever reloaded, and it keeps this parameter in its
/// URL for life; a document loaded with it would park a visible window and
/// re-register it with the pool. Removed rather than merely overridden by the
/// marker, so no parking check can read it.
const PARKED_QUERY_KEY: &str = "warm";

#[derive(Clone, Copy, Debug)]
pub(crate) struct ReloadLimit {
    pub max_reloads: usize,
    pub period: Duration,
}

/// The CI crash (#936) hit about 1.5% of launches, so four consecutive losses of a
/// healthy page are vanishingly rare, while a page that dies on every boot
/// stops after three short-lived attempts instead of flashing indefinitely.
pub(crate) const RELOAD_LIMIT: ReloadLimit = ReloadLimit {
    max_reloads: 3,
    period: Duration::from_secs(60),
};

/// Reloads issued for one native window, newest last, pruned to the period.
#[derive(Clone, Debug, Default)]
pub(crate) struct ReloadHistory(Vec<Instant>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Recovery {
    /// Load a fresh document; `attempt` counts reloads within the period.
    Reload { attempt: usize },
    /// The budget is spent: leave the window as it is and say so.
    Exhausted { recent: usize },
    /// A parked warm window is not user-facing. Retire it; the pool replaces
    /// it on demand and a pending claim falls back to a fresh window.
    RetireParked,
}

impl Recovery {
    pub(crate) fn describe(self, limit: ReloadLimit) -> String {
        let budget = format!(
            "limit={} period-s={}",
            limit.max_reloads,
            limit.period.as_secs()
        );
        match self {
            Self::Reload { attempt } => format!("decision=reload attempt={attempt} {budget}"),
            Self::Exhausted { recent } => format!("decision=exhausted recent={recent} {budget}"),
            Self::RetireParked => "decision=retire-parked".to_owned(),
        }
    }
}

/// Decide how to recover from one renderer termination. Returns the decision
/// and the window's successor history; neither input is modified.
pub(crate) fn plan(
    history: &ReloadHistory,
    parked: bool,
    limit: ReloadLimit,
    now: Instant,
) -> (Recovery, ReloadHistory) {
    if parked {
        return (Recovery::RetireParked, history.clone());
    }
    // An instant later than `now` saturates to zero and still counts.
    let recent: Vec<Instant> = history
        .0
        .iter()
        .copied()
        .filter(|&at| now.saturating_duration_since(at) < limit.period)
        .collect();
    if recent.len() >= limit.max_reloads {
        let count = recent.len();
        return (Recovery::Exhausted { recent: count }, ReloadHistory(recent));
    }
    let attempt = recent.len() + 1;
    let next = recent.into_iter().chain(std::iter::once(now)).collect();
    (Recovery::Reload { attempt }, ReloadHistory(next))
}

/// The document to load in place of the lost one: the same URL without its
/// parking request and with the recovery marker set once. `None` for a URL
/// with no hierarchy to carry a query (`about:blank` before the first
/// commit), where a plain reload is all that is possible.
pub(crate) fn recovery_url(current: &tauri::Url) -> Option<tauri::Url> {
    if current.cannot_be_a_base() {
        return None;
    }
    let retained: Vec<(String, String)> = current
        .query_pairs()
        .filter(|(key, _)| key != RECOVERY_QUERY_KEY && key != PARKED_QUERY_KEY)
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let mut next = current.clone();
    next.set_fragment(None);
    next.query_pairs_mut()
        .clear()
        .extend_pairs(retained)
        .append_pair(RECOVERY_QUERY_KEY, "1");
    Some(next)
}

/// Per native window: its reload budget and the last document it committed.
/// Kept apart from the renderer scope so recording a document never changes
/// generation numbering, and dropped with the window's resource table, so a
/// reused label starts with a fresh budget.
#[cfg(target_os = "macos")]
#[derive(Default)]
pub(super) struct WindowRecovery {
    reloads: std::sync::Mutex<ReloadHistory>,
    // WKWebView's URL getter is unusable after a crash: WebKit resets the
    // page load state, and Wry unwraps the then-nil URL. The committed URL
    // from Tauri's page-load event is the one to restore.
    document: std::sync::Mutex<Option<tauri::Url>>,
}

#[cfg(target_os = "macos")]
impl tauri::Resource for WindowRecovery {}

#[cfg(target_os = "macos")]
fn window_recovery<R: tauri::Runtime>(window: &tauri::Window<R>) -> std::sync::Arc<WindowRecovery> {
    let mut resources = window.resources_table();
    let existing = resources
        .names()
        .find_map(|(id, _)| resources.get::<WindowRecovery>(id).ok());
    existing.unwrap_or_else(|| {
        let recovery = std::sync::Arc::new(WindowRecovery::default());
        resources.add_arc(recovery.clone());
        recovery
    })
}

/// Remember the document a window committed, for a later recovery.
#[cfg(target_os = "macos")]
pub(super) fn record_document<R: tauri::Runtime>(window: &tauri::Window<R>, url: &tauri::Url) {
    let recovery = window_recovery(window);
    *recovery
        .document
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(url.clone());
}

/// macOS adapter: called from Wry's `webViewWebContentProcessDidTerminate`.
/// Every effect leaves the delegate callback first: navigation and window
/// destruction round-trip through the event loop, which must not re-enter
/// WebKit while it is still reporting the termination.
#[cfg(target_os = "macos")]
pub(super) fn recover(webview: &tauri::Webview) {
    let window = webview.window();
    let label = window.label().to_owned();
    let parked = crate::warm_pool::is_parked(&label);
    let recovery = window_recovery(&window);
    let decision = {
        let mut history = recovery
            .reloads
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (decision, next) = plan(&history, parked, RELOAD_LIMIT, Instant::now());
        *history = next;
        decision
    };
    let target = recovery
        .document
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .and_then(recovery_url);
    let line = format!(
        "Renderer(recovery): window={label} webview={} {}",
        webview.label(),
        decision.describe(RELOAD_LIMIT)
    );
    match decision {
        Recovery::Exhausted { .. } => log::error!("{line}"),
        Recovery::RetireParked => {
            log::warn!("{line}");
            let app = tauri::Manager::app_handle(webview).clone();
            tauri::async_runtime::spawn(async move {
                crate::warm_pool::retire_parked(&app, &label);
            });
        }
        Recovery::Reload { .. } => {
            let document = if target.is_some() {
                "recorded"
            } else {
                "unrecorded"
            };
            log::warn!("{line} document={document}");
            let webview = webview.clone();
            tauri::async_runtime::spawn(async move {
                // The lost document's PTYs are window-label scoped and the new
                // document cannot reattach them; end them as a closing window
                // does, before the new document can reserve its own.
                crate::terminal::on_window_destroyed(&label);
                // Without a committed document only WebKit's own reload of
                // its back-forward item is possible; it lacks the marker.
                let outcome = match target {
                    Some(url) => webview.navigate(url),
                    None => webview.reload(),
                };
                if let Err(error) = outcome {
                    log::error!(
                        "Renderer(recovery): window={label} decision=reload-failed error={error}"
                    );
                }
            });
        }
    }
}
