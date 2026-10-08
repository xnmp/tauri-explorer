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
    #[serde(default)]
    extensions: Vec<String>,
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

impl PickerOptions {
    fn validate(&self) -> Result<(), AppError> {
        if !matches!(self.mode.as_str(), "open" | "save")
            || self.title.len() > 200
            || self.extensions.len() > 32
            || self.extensions.iter().any(|extension| {
                extension.is_empty()
                    || extension.len() > 32
                    || !extension
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
            || self
                .filename
                .as_ref()
                .is_some_and(|name| name.contains(['\\', '/', '\0']))
        {
            return Err(AppError::Other("Invalid picker options".into()));
        }
        Ok(())
    }

    fn url(&self, token: &str) -> String {
        let mut parameters = url::form_urlencoded::Serializer::new(String::new());
        parameters
            .append_pair("picker", &self.mode)
            .append_pair("token", token)
            .append_pair("multiple", "0")
            .append_pair("directory", "0")
            .append_pair("title", &self.title);
        if let Some(directory) = &self.directory {
            parameters.append_pair("folder", directory);
        }
        if let Some(filename) = &self.filename {
            parameters.append_pair("name", filename);
        }
        for extension in &self.extensions {
            parameters.append_pair("extension", extension);
        }
        format!("/?{}", parameters.finish())
    }
}

#[tauri::command]
pub async fn pick_file(app: AppHandle, options: PickerOptions) -> Result<Option<String>, AppError> {
    options.validate()?;
    let token = format!("picker-native-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut pending = pending().lock().unwrap_or_else(|error| error.into_inner());
        if pending.len() >= 8 {
            return Err(AppError::Other("Too many file pickers are open".into()));
        }
        pending.insert(token.clone(), sender);
    }
    let url = options.url(&token);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn package_filter_reaches_picker_url_without_losing_folder_or_title() {
        let options: PickerOptions = serde_json::from_value(json!({
            "mode": "open", "title": "Install plugin package", "directory": "/Downloads/a & b",
            "extensions": ["teplugin", "TEPLUGIN"]
        }))
        .unwrap();
        options.validate().unwrap();
        let url = url::Url::parse(&format!(
            "https://app.local{}",
            options.url("picker-native-1")
        ))
        .unwrap();
        let pairs: Vec<_> = url.query_pairs().collect();
        assert_eq!(
            pairs
                .iter()
                .filter(|(key, _)| key == "extension")
                .map(|(_, value)| value.as_ref())
                .collect::<Vec<_>>(),
            ["teplugin", "TEPLUGIN"]
        );
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "folder" && value == "/Downloads/a & b"));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "title" && value == "Install plugin package"));
    }

    #[test]
    fn existing_open_and_save_options_remain_unfiltered() {
        for mode in ["open", "save"] {
            let options: PickerOptions =
                serde_json::from_value(json!({"mode": mode, "title": "Choose file"})).unwrap();
            options.validate().unwrap();
            assert!(!options.url("test").contains("extension="));
        }
    }

    #[test]
    fn rejects_malformed_or_unbounded_extension_filters() {
        for extensions in [
            json!([""]),
            json!([".teplugin"]),
            json!(["../teplugin"]),
            json!(["*"]),
            json!(["x".repeat(33)]),
            json!(vec!["teplugin"; 33]),
        ] {
            let options: PickerOptions = serde_json::from_value(
                json!({"mode": "open", "title": "Install", "extensions": extensions}),
            )
            .unwrap();
            assert!(options.validate().is_err());
        }
        assert!(serde_json::from_value::<PickerOptions>(
            json!({"mode":"open", "title":"Install", "extensions":null})
        )
        .is_err());
    }
}
