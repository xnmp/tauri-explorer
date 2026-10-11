//! Native source identity is captured before frontend IPC channels can reorder.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{ipc::Channel, Emitter, Manager};

const EVENT: &str = "explorer-native-file-drag";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum CopyPolicy {
    Modifier,
    Move,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    session_id: String,
    path: String,
    name: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_copy_policy: Option<CopyPolicy>,
}

fn path_key(path: &str) -> String {
    if cfg!(target_os = "windows") {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    }
}

fn matches(source: &Source, paths: &[PathBuf]) -> bool {
    let source_paths = source
        .paths
        .as_deref()
        .unwrap_or(std::slice::from_ref(&source.path));
    if source.session_id.is_empty()
        || !matches!(source.kind.as_str(), "file" | "directory")
        || !source_paths.contains(&source.path)
        || source_paths.iter().any(|path| {
            path.contains('\0')
                || !PathBuf::from(path).is_absolute()
                || PathBuf::from(path)
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
        })
    {
        return false;
    }
    let mut expected: Vec<_> = source_paths.iter().map(|path| path_key(path)).collect();
    let mut actual: Vec<_> = paths
        .iter()
        .map(|path| path_key(&path.to_string_lossy()))
        .collect();
    expected.sort();
    actual.sort();
    !expected.is_empty() && expected == actual
}

fn receiver_paths(paths: &[PathBuf]) -> bool {
    paths.iter().all(|path| {
        if cfg!(target_os = "windows") {
            path.components()
                .any(|part| matches!(part, std::path::Component::Normal(_)))
        } else {
            path.to_string_lossy()
                .chars()
                .any(|character| character != '/')
        }
    })
}

#[derive(Default)]
struct Registry {
    active: Option<(u64, String, Option<Source>)>,
    receivers: HashMap<String, Source>,
}

impl Registry {
    fn begin(&mut self, token: u64, owner: String, source: Option<Source>) {
        self.active = Some((token, owner, source));
    }
    fn complete(&mut self, token: u64) {
        if self.active.as_ref().is_some_and(|active| active.0 == token) {
            self.active = None;
        }
    }
    fn enter(&mut self, receiver: &str, paths: &[PathBuf]) -> Option<Source> {
        let source = self
            .active
            .as_ref()
            .and_then(|active| active.2.as_ref())
            .filter(|source| receiver_paths(paths) && matches(source, paths))
            .cloned();
        self.receivers.remove(receiver);
        if let Some(source) = &source {
            self.receivers.insert(receiver.into(), source.clone());
        }
        source
    }
    fn receive_drop(&mut self, receiver: &str, paths: &[PathBuf]) -> Option<Source> {
        self.receivers
            .remove(receiver)
            .filter(|source| matches(source, paths))
    }
    fn leave(&mut self, receiver: &str) {
        self.receivers.remove(receiver);
    }
    fn destroyed(&mut self, owner: &str) {
        self.receivers.remove(owner);
        if self.active.as_ref().is_some_and(|active| active.1 == owner) {
            self.active = None;
        }
    }
}

#[derive(Default)]
pub struct Sessions {
    registry: Mutex<Registry>,
    sequence: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum Event {
    Enter {
        paths: Vec<PathBuf>,
        position: tauri::PhysicalPosition<f64>,
        source: Option<Source>,
        copy_modifier: Option<bool>,
    },
    Over {
        position: tauri::PhysicalPosition<f64>,
        copy_modifier: Option<bool>,
    },
    Drop {
        paths: Vec<PathBuf>,
        position: tauri::PhysicalPosition<f64>,
        source: Option<Source>,
        copy_modifier: Option<bool>,
    },
    Leave,
}

// Native drag sessions can consume key events before they reach the webview.
// Snapshot the platform state at the receiver event, before IPC delivery.
#[cfg(target_os = "linux")]
fn current_copy_modifier(window: &tauri::Window) -> Option<bool> {
    use gtk::prelude::WidgetExt;
    let display = window.gtk_window().ok()?.display();
    let keymap = gtk::gdk::Keymap::for_display(&display)?;
    Some(keymap.modifier_state() & gtk::gdk::ModifierType::CONTROL_MASK.bits() != 0)
}

#[cfg(target_os = "windows")]
fn current_copy_modifier(_window: &tauri::Window) -> Option<bool> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    // The high bit reflects the current held state, independent of focus.
    Some(unsafe { GetAsyncKeyState(VK_CONTROL.0 as i32) } < 0)
}

#[cfg(target_os = "macos")]
fn current_copy_modifier(_window: &tauri::Window) -> Option<bool> {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    Some(NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Option))
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn current_copy_modifier(_window: &tauri::Window) -> Option<bool> {
    None
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let sessions = window.state::<Sessions>();
    let mut registry = sessions
        .registry
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let event = match event {
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { paths, position }) => {
            Some(Event::Enter {
                paths: paths.clone(),
                position: *position,
                source: registry.enter(window.label(), paths),
                copy_modifier: current_copy_modifier(window),
            })
        }
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Over { position }) => {
            Some(Event::Over {
                position: *position,
                copy_modifier: current_copy_modifier(window),
            })
        }
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) => {
            Some(Event::Drop {
                paths: paths.clone(),
                position: *position,
                source: registry.receive_drop(window.label(), paths),
                copy_modifier: current_copy_modifier(window),
            })
        }
        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave) => {
            registry.leave(window.label());
            Some(Event::Leave)
        }
        tauri::WindowEvent::Destroyed => {
            registry.destroyed(window.label());
            None
        }
        _ => None,
    };
    drop(registry);
    if let Some(event) = event {
        let _ = window.emit_to(
            tauri::EventTarget::Webview {
                label: window.label().into(),
            },
            EVENT,
            event,
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    result: drag::DragResult,
    cursor_pos: drag::CursorPosition,
}

#[tauri::command]
pub async fn start_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    item: Vec<PathBuf>,
    image: String,
    source: Option<Source>,
    on_event: Channel<Completion>,
) -> Result<(), String> {
    if item.is_empty() || item.iter().any(|path| !path.is_absolute()) {
        return Err("Drag paths must be absolute and nonempty".into());
    }
    if source
        .as_ref()
        .is_some_and(|source| source.session_id.is_empty() || !matches(source, &item))
    {
        return Err("Drag source does not match the native files".into());
    }
    let image = if let Some(data) = image.strip_prefix("data:image/png;base64,") {
        drag::Image::Raw(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|error| error.to_string())?,
        )
    } else {
        drag::Image::File(PathBuf::from(image))
    };
    let token = app
        .state::<Sessions>()
        .sequence
        .fetch_add(1, Ordering::Relaxed);
    let (send, receive) = tokio::sync::oneshot::channel();
    let callback_app = app.clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        let native_window = window.gtk_window();
        #[cfg(not(target_os = "linux"))]
        let native_window = tauri::Result::Ok(window.clone());
        let result = native_window
            .map_err(|error| error.to_string())
            .and_then(|native_window| {
                window
                    .state::<Sessions>()
                    .registry
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .begin(token, window.label().into(), source);
                drag::start_drag(
                    &native_window,
                    drag::DragItem::Files(item),
                    image,
                    move |result, cursor_pos| {
                        let app = callback_app.clone();
                        let on_event = on_event.clone();
                        // A direct main→main dispatch executes immediately. Dispatch
                        // from a worker and wait only for queue admission, so Enter/
                        // Drop already queued by Wry precede source retirement. No
                        // later OS gesture can enter between completion and admission.
                        let queued = std::thread::spawn(move || {
                            let owner = app.clone();
                            app.run_on_main_thread(move || {
                                owner
                                    .state::<Sessions>()
                                    .registry
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner())
                                    .complete(token);
                                let _ = on_event.send(Completion { result, cursor_pos });
                            })
                        })
                        .join();
                        if !matches!(queued, Ok(Ok(()))) {
                            log::warn!("Could not queue native drag completion");
                        }
                    },
                    drag::Options::default(),
                )
                .map_err(|error| error.to_string())
            });
        if result.is_err() {
            window
                .state::<Sessions>()
                .registry
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .complete(token);
        }
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "../test_support/native_file_drag.rs"]
mod tests;
