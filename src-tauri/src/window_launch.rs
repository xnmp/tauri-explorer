//! Secondary Linux processes hand launches to the profile's owning runtime.
#[cfg(any(target_os = "linux", test))]
use crate::error::AppError;
use std::{collections::VecDeque, sync::Mutex};
use tauri::Manager;

#[derive(Default)]
pub struct Requests(Mutex<VecDeque<(String, String)>>);
impl Requests {
    #[cfg(any(target_os = "linux", test))]
    fn push(&self, target: String, path: String) -> Result<(), AppError> {
        if path.len() > 8192 || path.contains('\0') {
            return Err(AppError::Other("Invalid launch path".into()));
        }
        let mut requests = self.0.lock().unwrap_or_else(|cause| cause.into_inner());
        if requests.len() >= 64 {
            return Err(AppError::Other("Too many pending window launches".into()));
        }
        requests.push_back((target, path));
        Ok(())
    }
    fn take(&self, target: &str) -> Vec<String> {
        let mut requests = self.0.lock().unwrap_or_else(|cause| cause.into_inner());
        let mut paths = vec![];
        requests.retain(|(owner, path)| {
            if owner == target {
                paths.push(path.clone());
                false
            } else {
                true
            }
        });
        paths
    }
}

#[tauri::command]
pub fn take_window_launch_requests(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Vec<String> {
    app.state::<Requests>().take(window.label())
}

#[cfg(target_os = "linux")]
pub(super) fn routing_plugin() -> Result<tauri::plugin::TauriPlugin<tauri::Wry>, AppError> {
    use sha2::{Digest, Sha256};
    use tauri::Emitter;
    let profile = crate::config::config_dir()?.canonicalize()?;
    let id = format!(
        "io.github.xnmp.tauri_explorer.p{}",
        hex::encode(Sha256::digest(profile.as_os_str().as_encoded_bytes()))
    );
    Ok(tauri_plugin_single_instance::Builder::new()
        .dbus_id(id)
        .callback(|app, args, cwd| {
            let explicit = args.get(1).filter(|path| !path.starts_with("--"));
            let requested = if let Some(path) = explicit {
                let path = std::path::PathBuf::from(path);
                if path.is_absolute() {
                    path
                } else {
                    std::path::PathBuf::from(&cwd).join(path)
                }
            } else {
                let cwd = std::path::PathBuf::from(cwd);
                let executable = std::env::current_exe()
                    .ok()
                    .and_then(|path| path.parent().map(std::path::Path::to_path_buf));
                if crate::system::is_launcher_artifact_cwd(&cwd, executable.as_deref()) {
                    dirs::home_dir().unwrap_or(cwd)
                } else {
                    cwd
                }
            };
            let windows = app.webview_windows();
            let eligible = |window: &&tauri::WebviewWindow| {
                (window.label() == "main" || window.label().starts_with("explorer-"))
                    && window.is_visible().unwrap_or(false)
            };
            let window = windows
                .values()
                .filter(eligible)
                .find(|window| window.is_focused().unwrap_or(false))
                .or_else(|| windows.values().find(eligible));
            let label = window.map_or("main", |window| window.label());
            if let Err(cause) = app
                .state::<Requests>()
                .push(label.to_owned(), requested.to_string_lossy().into_owned())
            {
                log::warn!("Could not hand off window launch: {cause}");
                return;
            }
            // The native queue preserves launches that arrive before a renderer listener.
            let _ = app.emit_to(label, "explorer:launch-requested", ());
            if let Some(window) = window {
                let _ = window.set_focus();
            }
        })
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_early_requests_and_delivers_each_only_to_its_target() {
        let requests = Requests::default();
        requests.push("main".into(), "/first".into()).unwrap();
        requests.push("other".into(), "/other".into()).unwrap();
        requests.push("main".into(), "/second".into()).unwrap();
        assert_eq!(requests.take("picker"), Vec::<String>::new());
        assert_eq!(requests.take("main"), ["/first", "/second"]);
        assert!(requests.take("main").is_empty());
        assert_eq!(requests.take("other"), ["/other"]);
    }
    #[test]
    fn rejects_invalid_and_unbounded_launches_without_evicting_accepted_requests() {
        let requests = Requests::default();
        assert!(requests.push("main".into(), "nul\0path".into()).is_err());
        assert!(requests.push("main".into(), "x".repeat(8193)).is_err());
        for index in 0..64 {
            requests.push("main".into(), format!("/{index}")).unwrap();
        }
        assert!(requests.push("main".into(), "/overflow".into()).is_err());
        assert_eq!(requests.take("main").len(), 64);
    }
}
