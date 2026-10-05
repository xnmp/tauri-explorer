//! Application-owned open/save picker, shared by installable plugins.
use crate::error::AppError;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Manager};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PickerOptions {
    mode: String,
    title: String,
    #[serde(default)]
    directory: Option<String>,
    #[serde(default)]
    filename: Option<String>,
}
type Pending = HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>;
static PENDING: OnceLock<Mutex<Pending>> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
fn pending() -> &'static Mutex<Pending> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}
fn resolve(token: &str, path: Option<String>) -> bool {
    let sender = pending()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(token);
    if let Some(sender) = sender {
        let _ = sender.send(path);
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn pick_file(app: AppHandle, options: PickerOptions) -> Result<Option<String>, AppError> {
    if !matches!(options.mode.as_str(), "open" | "save")
        || options.title.len() > 200
        || options
            .filename
            .as_ref()
            .is_some_and(|name| name.contains(['\\', '/', '\0']))
    {
        return Err(AppError::Other("Invalid picker options".into()));
    }
    let token = format!("picker-native-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut pending = pending().lock().unwrap_or_else(|error| error.into_inner());
        if pending.len() >= 8 {
            return Err(AppError::Other("Too many file pickers are open".into()));
        }
        pending.insert(token.clone(), sender);
    }
    let url = {
        let mut parameters = url::form_urlencoded::Serializer::new(String::new());
        parameters
            .append_pair("picker", &options.mode)
            .append_pair("token", &token)
            .append_pair("multiple", "0")
            .append_pair("directory", "0")
            .append_pair("title", &options.title);
        if let Some(directory) = &options.directory {
            parameters.append_pair("folder", directory);
        }
        if let Some(filename) = &options.filename {
            parameters.append_pair("name", filename);
        }
        format!("/?{}", parameters.finish())
    };
    let owner = app.clone();
    let label = token.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        match tauri::WebviewWindowBuilder::new(&owner, &label, tauri::WebviewUrl::App(url.into()))
            .title(options.title)
            .inner_size(900.0, 560.0)
            .center()
            .decorations(false)
            .accept_first_mouse(true)
            .build()
        {
            Ok(window) => window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    resolve(&label, None);
                }
            }),
            Err(error) => {
                log::warn!("File picker could not open: {error}");
                resolve(&label, None);
            }
        }
    }) {
        resolve(&token, None);
        return Err(AppError::Other(format!(
            "File picker could not open: {error}"
        )));
    }
    let outcome = receiver.await.unwrap_or(None);
    if let Some(window) = app.get_webview_window(&token) {
        let _ = window.close();
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn picker_respond(
    window: tauri::WebviewWindow,
    token: String,
    paths: Vec<String>,
    cancelled: bool,
) {
    // A picker can resolve only the request that created its own window.
    if window.label() != token {
        return;
    }
    let handled = resolve(
        &token,
        if cancelled {
            None
        } else {
            paths.first().cloned()
        },
    );
    #[cfg(target_os = "linux")]
    if !handled {
        crate::portal::picker_respond(token, paths, cancelled).await;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = handled;
}
