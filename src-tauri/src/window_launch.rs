//! Secondary Linux processes hand launches (new windows, or `--new-tab` tabs)
//! to the profile's owning runtime.
#[cfg(any(target_os = "linux", test))]
use crate::error::AppError;
use std::{collections::VecDeque, sync::Mutex};
use tauri::Manager;

/// One launch handed over by a secondary process. `new_tab` asks the target
/// window to open `path` as a tab instead of opening a new window (#1478).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub path: String,
    pub new_tab: bool,
}

#[derive(Default)]
pub struct Requests(Mutex<VecDeque<(String, LaunchRequest)>>);
impl Requests {
    #[cfg(any(target_os = "linux", test))]
    fn push(&self, target: String, request: LaunchRequest) -> Result<(), AppError> {
        if request.path.len() > 8192 || request.path.contains('\0') {
            return Err(AppError::Other("Invalid launch path".into()));
        }
        let mut requests = self.0.lock().unwrap_or_else(|cause| cause.into_inner());
        if requests.len() >= 64 {
            return Err(AppError::Other("Too many pending window launches".into()));
        }
        requests.push_back((target, request));
        Ok(())
    }
    fn take(&self, target: &str) -> Vec<LaunchRequest> {
        let mut requests = self.0.lock().unwrap_or_else(|cause| cause.into_inner());
        let mut taken = vec![];
        requests.retain(|(owner, request)| {
            if owner == target {
                taken.push(request.clone());
                false
            } else {
                true
            }
        });
        taken
    }
}

#[tauri::command]
pub async fn take_window_launch_requests(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Vec<LaunchRequest> {
    app.state::<Requests>().take(window.label())
}

/// Explorer window labels in focus order, most recent last. A terminal
/// launch arrives while the terminal, not Explorer, is focused, so
/// `--new-tab` needs the last Explorer window the user focused (#1478).
#[derive(Default)]
pub struct FocusHistory(Mutex<Vec<String>>);
impl FocusHistory {
    fn record(&self, label: &str) {
        if !is_explorer_label(label) {
            return;
        }
        let mut labels = self.0.lock().unwrap_or_else(|cause| cause.into_inner());
        labels.retain(|known| known != label);
        if labels.len() >= 64 {
            labels.remove(0);
        }
        labels.push(label.to_owned());
    }
    fn forget(&self, label: &str) {
        let mut labels = self.0.lock().unwrap_or_else(|cause| cause.into_inner());
        labels.retain(|known| known != label);
    }
    #[cfg(any(target_os = "linux", test))]
    fn snapshot(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .clone()
    }
}

fn is_explorer_label(label: &str) -> bool {
    label == "main" || label.starts_with("explorer-")
}

/// Track Explorer window focus for launch routing.
pub(super) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let Some(history) = window.try_state::<FocusHistory>() else {
        return;
    };
    match event {
        tauri::WindowEvent::Focused(true) => history.record(window.label()),
        tauri::WindowEvent::Destroyed => history.forget(window.label()),
        _ => {}
    }
}

/// Native state of one window considered as a launch target.
#[cfg(any(target_os = "linux", test))]
struct Candidate<'a> {
    label: &'a str,
    visible: bool,
    focused: bool,
}

/// Choose the window that receives a secondary-process launch: the focused
/// visible Explorer window, else the most recently focused visible one, else
/// any visible one (lowest label, for determinism). Parked warm windows are
/// hidden and never eligible.
#[cfg(any(target_os = "linux", test))]
fn choose_target(candidates: &[Candidate<'_>], recent: &[String]) -> Option<String> {
    let mut eligible: Vec<&Candidate<'_>> = candidates
        .iter()
        .filter(|candidate| is_explorer_label(candidate.label) && candidate.visible)
        .collect();
    eligible.sort_by_key(|candidate| candidate.label);
    eligible
        .iter()
        .find(|candidate| candidate.focused)
        .or_else(|| {
            recent.iter().rev().find_map(|label| {
                eligible
                    .iter()
                    .find(|candidate| candidate.label == label.as_str())
            })
        })
        .or_else(|| eligible.first())
        .map(|candidate| candidate.label.to_owned())
}

/// Resolve a forwarded command line (program name first) to the launch it
/// requests, relative to the secondary process's working directory.
/// Linux-only, like the single-instance hand-off that calls it: its tests
/// assume POSIX paths (#1488).
#[cfg(target_os = "linux")]
fn resolve_request(
    args: &[String],
    cwd: &str,
    executable_dir: Option<&std::path::Path>,
    home: Option<std::path::PathBuf>,
) -> LaunchRequest {
    let parsed = crate::launch_args::parse(args.iter().skip(1));
    let cwd = std::path::PathBuf::from(cwd);
    let path = match parsed.path {
        Some(path) => {
            let path = std::path::PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        }
        None if crate::system::is_launcher_artifact_cwd(&cwd, executable_dir) => {
            home.unwrap_or(cwd)
        }
        None => cwd,
    };
    LaunchRequest {
        path: path.to_string_lossy().into_owned(),
        new_tab: parsed.new_tab,
    }
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
            let executable = std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(std::path::Path::to_path_buf));
            let mut request = resolve_request(&args, &cwd, executable.as_deref(), dirs::home_dir());
            let windows = app.webview_windows();
            let candidates: Vec<Candidate<'_>> = windows
                .values()
                .map(|window| Candidate {
                    label: window.label(),
                    visible: window.is_visible().unwrap_or(false),
                    focused: window.is_focused().unwrap_or(false),
                })
                .collect();
            let recent = app.state::<FocusHistory>().snapshot();
            let target = choose_target(&candidates, &recent);
            // A tab needs a shown window to live in; otherwise open a window.
            request.new_tab &= target.is_some();
            let label = target.unwrap_or_else(|| "main".to_owned());
            let new_tab = request.new_tab;
            if let Err(cause) = app.state::<Requests>().push(label.clone(), request) {
                log::warn!("Could not hand off window launch: {cause}");
                return;
            }
            // The native queue preserves launches that arrive before a renderer listener.
            let _ = app.emit_to(label.as_str(), "explorer:launch-requested", ());
            if let Some(window) = windows.get(&label) {
                if new_tab && window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                }
                let _ = window.set_focus();
            }
        })
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str) -> LaunchRequest {
        LaunchRequest {
            path: path.into(),
            new_tab: false,
        }
    }
    fn tab(path: &str) -> LaunchRequest {
        LaunchRequest {
            path: path.into(),
            new_tab: true,
        }
    }
    #[cfg(target_os = "linux")]
    fn argv(list: &[&str]) -> Vec<String> {
        std::iter::once("tauri-explorer")
            .chain(list.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn preserves_early_requests_and_delivers_each_only_to_its_target() {
        let requests = Requests::default();
        requests.push("main".into(), request("/first")).unwrap();
        requests.push("other".into(), request("/other")).unwrap();
        requests.push("main".into(), tab("/second")).unwrap();
        assert_eq!(requests.take("picker"), Vec::<LaunchRequest>::new());
        assert_eq!(requests.take("main"), [request("/first"), tab("/second")]);
        assert!(requests.take("main").is_empty());
        assert_eq!(requests.take("other"), [request("/other")]);
    }

    #[test]
    fn rejects_invalid_and_unbounded_launches_without_evicting_accepted_requests() {
        let requests = Requests::default();
        assert!(requests.push("main".into(), request("nul\0path")).is_err());
        assert!(requests
            .push("main".into(), request(&"x".repeat(8193)))
            .is_err());
        for index in 0..64 {
            requests
                .push("main".into(), request(&format!("/{index}")))
                .unwrap();
        }
        assert!(requests.push("main".into(), request("/overflow")).is_err());
        assert_eq!(requests.take("main").len(), 64);
    }

    #[test]
    fn serializes_requests_for_the_renderer_in_camel_case() {
        assert_eq!(
            serde_json::to_value(tab("/work")).unwrap(),
            serde_json::json!({ "path": "/work", "newTab": true })
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolves_new_tab_before_or_after_relative_and_absolute_paths() {
        let home = Some(std::path::PathBuf::from("/home/alice"));
        assert_eq!(
            resolve_request(&argv(&["--new-tab", "docs"]), "/work", None, home.clone()),
            tab("/work/docs")
        );
        assert_eq!(
            resolve_request(&argv(&["/abs", "--new-tab"]), "/work", None, home.clone()),
            tab("/abs")
        );
        assert_eq!(
            resolve_request(&argv(&["--new-tab"]), "/work", None, home.clone()),
            tab("/work"),
            "a flag without a path opens the launching directory"
        );
        assert_eq!(
            resolve_request(&argv(&["docs"]), "/work", None, home.clone()),
            request("/work/docs"),
            "without the flag a launch still opens a window"
        );
        assert_eq!(
            resolve_request(
                &argv(&["--new-tab"]),
                "/opt/app",
                Some("/opt/app".as_ref()),
                home
            ),
            tab("/home/alice"),
            "launcher-artifact cwds still fall back to home"
        );
    }

    #[test]
    fn targets_the_focused_then_most_recently_focused_visible_explorer_window() {
        let window = |label, visible, focused| Candidate {
            label,
            visible,
            focused,
        };
        let history = FocusHistory::default();
        history.record("explorer-b");
        history.record("picker-1");
        history.record("explorer-a");
        history.record("explorer-b");
        assert_eq!(history.snapshot(), ["explorer-a", "explorer-b"]);

        let windows = [
            window("main", true, false),
            window("explorer-a", true, false),
            window("explorer-b", true, false),
            window("picker-1", true, true),
        ];
        assert_eq!(
            choose_target(&windows, &history.snapshot()).as_deref(),
            Some("explorer-b"),
            "a focused picker or terminal must not hide the last Explorer window"
        );

        let focused = [
            window("main", true, false),
            window("explorer-a", true, true),
        ];
        assert_eq!(
            choose_target(&focused, &history.snapshot()).as_deref(),
            Some("explorer-a")
        );

        history.forget("explorer-b");
        assert_eq!(
            choose_target(&windows, &history.snapshot()).as_deref(),
            Some("explorer-a")
        );

        let parked = [
            window("explorer-a", false, false),
            window("main", true, false),
        ];
        assert_eq!(
            choose_target(&parked, &history.snapshot()).as_deref(),
            Some("main"),
            "hidden (parked warm) windows are never targets"
        );
        assert_eq!(
            choose_target(&[window("explorer-a", false, false)], &[]),
            None
        );
    }
}
