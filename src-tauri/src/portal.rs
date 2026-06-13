//! xdg-desktop-portal FileChooser backend (Linux).
//!
//! Lets tauri-explorer serve as the system file picker: when an app (e.g.
//! a browser picking a download location) calls the FileChooser portal,
//! xdg-desktop-portal routes the request to this D-Bus service, which pops
//! a lightweight picker window (address bar + miller columns) and returns
//! the chosen URIs.
//!
//! Activation: `tauri-explorer --file-chooser-portal` (see packaging/ for
//! the .portal and D-Bus .service files and README for portals.conf).
//! The module is gated to Linux at the `mod` declaration in lib.rs.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const PORTAL_BUS_NAME: &str = "org.freedesktop.impl.portal.desktop.tauri_explorer";
const PORTAL_OBJECT_PATH: &str = "/org/freedesktop/portal/desktop";

/// Response codes defined by the portal spec.
const RESPONSE_SUCCESS: u32 = 0;
const RESPONSE_CANCELLED: u32 = 1;

/// Did the user pick something, or bail?
pub struct PickerOutcome {
    pub cancelled: bool,
    /// Absolute filesystem paths of the selection.
    pub paths: Vec<String>,
}

type PendingMap = Mutex<HashMap<String, tokio::sync::oneshot::Sender<PickerOutcome>>>;

static PENDING: OnceLock<PendingMap> = OnceLock::new();
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static PendingMap {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True when this process was started as the portal backend service.
pub fn is_portal_mode() -> bool {
    std::env::args().any(|a| a == "--file-chooser-portal")
}

/// Frontend → backend: the picker window's verdict.
#[tauri::command]
pub async fn picker_respond(token: String, paths: Vec<String>, cancelled: bool) {
    resolve(&token, PickerOutcome { cancelled, paths });
}

fn resolve(token: &str, outcome: PickerOutcome) {
    let sender = pending()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(token);
    if let Some(tx) = sender {
        let _ = tx.send(outcome);
    }
}

// ─── Option parsing helpers (pure, unit-tested) ─────────────────────────────

pub fn opt_bool(options: &HashMap<String, OwnedValue>, key: &str) -> bool {
    options
        .get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}

pub fn opt_string(options: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(|v| <&str>::try_from(v).ok())
        .map(|s| s.to_string())
}

/// `current_folder` arrives as a NUL-terminated byte array (ay).
pub fn opt_path_bytes(options: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
    let value = options.get(key)?;
    let bytes = Vec::<u8>::try_from(value.try_clone().ok()?).ok()?;
    let trimmed: Vec<u8> = bytes.into_iter().take_while(|b| *b != 0).collect();
    let s = String::from_utf8(trimmed).ok()?;
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Convert absolute paths to file:// URIs (percent-encoded).
pub fn paths_to_uris(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|p| url::Url::from_file_path(Path::new(p)).ok())
        .map(|u| u.to_string())
        .collect()
}

// ─── Picker window ──────────────────────────────────────────────────────────

struct PickerRequest {
    mode: &'static str, // "open" | "save"
    title: String,
    multiple: bool,
    directory: bool,
    current_folder: Option<String>,
    current_name: Option<String>,
}

/// Open a picker window and wait for the user's verdict.
async fn run_picker(app: &AppHandle, req: PickerRequest) -> PickerOutcome {
    let token = format!(
        "picker-{}-{}",
        std::process::id(),
        NEXT_TOKEN.fetch_add(1, Ordering::SeqCst)
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(token.clone(), tx);

    let mut query = format!(
        "picker={}&token={}&multiple={}&directory={}",
        req.mode, token, req.multiple as u8, req.directory as u8
    );
    if let Some(folder) = &req.current_folder {
        query.push_str(&format!("&folder={}", urlencode(folder)));
    }
    if let Some(name) = &req.current_name {
        query.push_str(&format!("&name={}", urlencode(name)));
    }
    if !req.title.is_empty() {
        query.push_str(&format!("&title={}", urlencode(&req.title)));
    }

    let app_for_window = app.clone();
    let window_token = token.clone();
    let title = if req.title.is_empty() {
        "Select".to_string()
    } else {
        req.title.clone()
    };
    let main_thread_result = app.run_on_main_thread(move || {
        let url = format!("index.html?{}", query);
        let built = tauri::WebviewWindowBuilder::new(
            &app_for_window,
            window_token.clone(),
            tauri::WebviewUrl::App(url.into()),
        )
        .title(title)
        .inner_size(900.0, 560.0)
        .center()
        .decorations(false)
        .accept_first_mouse(true)
        .build();

        match built {
            Ok(window) => {
                // Closing the window without choosing = cancel.
                let close_token = window_token.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        resolve(
                            &close_token,
                            PickerOutcome {
                                cancelled: true,
                                paths: vec![],
                            },
                        );
                    }
                });
            }
            Err(e) => {
                log::error!("portal: failed to create picker window: {e}");
                resolve(
                    &window_token,
                    PickerOutcome {
                        cancelled: true,
                        paths: vec![],
                    },
                );
            }
        }
    });
    if main_thread_result.is_err() {
        resolve(
            &token,
            PickerOutcome {
                cancelled: true,
                paths: vec![],
            },
        );
    }

    let outcome = rx.await.unwrap_or(PickerOutcome {
        cancelled: true,
        paths: vec![],
    });

    // Close the picker window if it's still around.
    if let Some(window) = tauri::Manager::get_webview_window(app, &token) {
        let _ = window.close();
    }
    outcome
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn outcome_to_reply(outcome: PickerOutcome) -> (u32, HashMap<String, OwnedValue>) {
    if outcome.cancelled || outcome.paths.is_empty() {
        return (RESPONSE_CANCELLED, HashMap::new());
    }
    let uris = paths_to_uris(&outcome.paths);
    if uris.is_empty() {
        return (RESPONSE_CANCELLED, HashMap::new());
    }
    let mut results = HashMap::new();
    if let Ok(value) = OwnedValue::try_from(Value::from(uris)) {
        results.insert("uris".to_string(), value);
    }
    (RESPONSE_SUCCESS, results)
}

// ─── D-Bus interface ────────────────────────────────────────────────────────

struct FileChooserBackend {
    app: AppHandle,
}

#[zbus::interface(name = "org.freedesktop.impl.portal.FileChooser")]
impl FileChooserBackend {
    async fn open_file(
        &self,
        _handle: ObjectPath<'_>,
        _app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let req = PickerRequest {
            mode: "open",
            title,
            multiple: opt_bool(&options, "multiple"),
            directory: opt_bool(&options, "directory"),
            current_folder: opt_path_bytes(&options, "current_folder"),
            current_name: None,
        };
        outcome_to_reply(run_picker(&self.app, req).await)
    }

    async fn save_file(
        &self,
        _handle: ObjectPath<'_>,
        _app_id: String,
        _parent_window: String,
        title: String,
        options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        let req = PickerRequest {
            mode: "save",
            title,
            multiple: false,
            directory: false,
            current_folder: opt_path_bytes(&options, "current_folder"),
            current_name: opt_string(&options, "current_name"),
        };
        outcome_to_reply(run_picker(&self.app, req).await)
    }

    /// Batch save (used by very few apps) — not supported; apps fall back.
    async fn save_files(
        &self,
        _handle: ObjectPath<'_>,
        _app_id: String,
        _parent_window: String,
        _title: String,
        _options: HashMap<String, OwnedValue>,
    ) -> (u32, HashMap<String, OwnedValue>) {
        (RESPONSE_CANCELLED, HashMap::new())
    }
}

/// Acquire the portal bus name and serve the FileChooser interface.
/// Called from setup() when running with --file-chooser-portal.
pub fn start_portal_service(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let backend = FileChooserBackend { app };
        match zbus::connection::Builder::session()
            .and_then(|b| b.name(PORTAL_BUS_NAME))
            .and_then(|b| b.serve_at(PORTAL_OBJECT_PATH, backend))
        {
            Ok(builder) => match builder.build().await {
                Ok(connection) => {
                    log::info!("portal: serving FileChooser as {PORTAL_BUS_NAME}");
                    // Keep the connection alive for the process lifetime.
                    std::mem::forget(connection);
                }
                Err(e) => log::error!("portal: failed to connect to session bus: {e}"),
            },
            Err(e) => log::error!("portal: failed to configure bus connection: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn val(v: Value<'static>) -> OwnedValue {
        OwnedValue::try_from(v).unwrap()
    }

    #[test]
    fn parses_bool_and_string_options() {
        let mut options = HashMap::new();
        options.insert("multiple".to_string(), val(Value::from(true)));
        options.insert("current_name".to_string(), val(Value::from("a.txt")));

        assert!(opt_bool(&options, "multiple"));
        assert!(!opt_bool(&options, "directory")); // absent → false
        assert_eq!(
            opt_string(&options, "current_name").as_deref(),
            Some("a.txt")
        );
        assert_eq!(opt_string(&options, "missing"), None);
    }

    #[test]
    fn parses_nul_terminated_current_folder() {
        let mut options = HashMap::new();
        options.insert(
            "current_folder".to_string(),
            val(Value::from(b"/home/user/Downloads\0".to_vec())),
        );
        assert_eq!(
            opt_path_bytes(&options, "current_folder").as_deref(),
            Some("/home/user/Downloads")
        );

        // Empty / missing degrade to None.
        options.insert("empty".to_string(), val(Value::from(b"\0".to_vec())));
        assert_eq!(opt_path_bytes(&options, "empty"), None);
        assert_eq!(opt_path_bytes(&options, "missing"), None);
    }

    #[test]
    fn converts_paths_to_percent_encoded_file_uris() {
        let uris = paths_to_uris(&[
            "/home/user/plain.txt".to_string(),
            "/home/user/with space & stuff.txt".to_string(),
            "relative/ignored.txt".to_string(), // non-absolute → dropped
        ]);
        assert_eq!(
            uris,
            vec![
                "file:///home/user/plain.txt",
                "file:///home/user/with%20space%20&%20stuff.txt",
            ]
        );
    }

    #[test]
    fn cancelled_outcomes_produce_cancelled_reply() {
        let (code, results) = outcome_to_reply(PickerOutcome {
            cancelled: true,
            paths: vec!["/tmp/x".into()],
        });
        assert_eq!(code, RESPONSE_CANCELLED);
        assert!(results.is_empty());

        let (code, _) = outcome_to_reply(PickerOutcome {
            cancelled: false,
            paths: vec![],
        });
        assert_eq!(code, RESPONSE_CANCELLED);
    }

    #[test]
    fn successful_outcomes_carry_uris() {
        let (code, results) = outcome_to_reply(PickerOutcome {
            cancelled: false,
            paths: vec!["/tmp/chosen.txt".into()],
        });
        assert_eq!(code, RESPONSE_SUCCESS);
        let value = results.get("uris").expect("uris present");
        let uris = Vec::<String>::try_from(value.try_clone().unwrap()).unwrap();
        assert_eq!(uris, vec!["file:///tmp/chosen.txt"]);
    }
}
