//! Native source identity is captured before frontend IPC channels can reorder.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
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
    Link,
}

fn native_drag_options(source: Option<&Source>) -> drag::Options {
    drag::Options {
        mode: if source.is_some_and(|source| source.native_copy_policy == Some(CopyPolicy::Link)) {
            drag::DragMode::Link
        } else {
            drag::DragMode::default()
        },
        ..Default::default()
    }
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

fn matches(source: &Source, paths: &[PathBuf]) -> bool {
    matches_with(source, paths, cfg!(target_os = "windows"), |path| {
        dunce::canonicalize(path)
            .unwrap_or_else(|_| PathBuf::from(path))
            .to_string_lossy()
            .into_owned()
    })
}

// Filesystem resolution is injected so Windows transport rules can be tested
// on every host OS without interpreting Windows paths as POSIX paths.
fn matches_with(
    source: &Source,
    paths: &[PathBuf],
    windows: bool,
    canonicalize: impl Fn(&str) -> String,
) -> bool {
    let source_paths = source
        .paths
        .as_deref()
        .unwrap_or(std::slice::from_ref(&source.path));
    if source.session_id.is_empty()
        || !matches!(source.kind.as_str(), "file" | "directory")
        || !source_paths.contains(&source.path)
        || source_paths.iter().any(|path| {
            path.contains('\0')
                || if windows {
                    !(path.starts_with("\\\\")
                        || (path.as_bytes().get(1) == Some(&b':')
                            && matches!(path.as_bytes().get(2), Some(b'\\' | b'/'))))
                        || path.split(['\\', '/']).any(|part| part == "..")
                } else {
                    !PathBuf::from(path).is_absolute()
                        || PathBuf::from(path)
                            .components()
                            .any(|part| matches!(part, std::path::Component::ParentDir))
                }
        })
    {
        return false;
    }
    // Match vendor/drag's Windows Files transport: dunce resolves drive-path
    // links and keeps ordinary C:\ paths, while UNC paths pass through.
    let key = |path: &str| {
        if windows {
            let path = if path.starts_with("\\\\") {
                path.to_owned()
            } else {
                canonicalize(path)
            };
            path.replace('\\', "/")
        } else {
            path.to_owned()
        }
    };
    let mut expected: Vec<_> = source_paths.iter().map(|path| key(path)).collect();
    let mut actual: Vec<_> = paths
        .iter()
        .map(|path| key(&path.to_string_lossy()))
        .collect();
    expected.sort();
    actual.sort();
    !expected.is_empty() && expected == actual
}

fn receiver_paths(paths: &[PathBuf], windows: bool) -> bool {
    paths.iter().all(|path| {
        if windows {
            let path = path.to_string_lossy().replace('\\', "/");
            if path.starts_with("//") {
                path.split('/').filter(|part| !part.is_empty()).count() > 2
            } else {
                path.get(3..)
                    .is_some_and(|tail| tail.split('/').any(|part| !part.is_empty() && part != "."))
            }
        } else {
            path.to_string_lossy()
                .chars()
                .any(|character| character != '/')
        }
    })
}

#[derive(Clone)]
struct CapturedSource {
    original: Source,
    transport: Vec<String>,
    windows: bool,
}

fn transport_keys(paths: &[PathBuf], windows: bool) -> Vec<String> {
    let mut keys: Vec<_> = paths
        .iter()
        .map(|path| {
            let path = path.to_string_lossy();
            if windows {
                path.replace('\\', "/")
            } else {
                path.into_owned()
            }
        })
        .collect();
    keys.sort();
    keys
}

impl CapturedSource {
    fn matches(&self, paths: &[PathBuf]) -> bool {
        !self.transport.is_empty() && self.transport == transport_keys(paths, self.windows)
    }
}

#[derive(Default)]
struct Registry {
    active: Option<(u64, String, Option<CapturedSource>)>,
    receivers: HashMap<String, CapturedSource>,
    pending: HashMap<usize, VecDeque<(wry::DragDropEvent, Event)>>,
    native_labels: HashMap<usize, String>,
}

impl Registry {
    fn begin_prepared(
        &mut self,
        token: u64,
        owner: String,
        source: Option<Source>,
        transport: &[PathBuf],
        windows: bool,
    ) {
        self.active = Some((
            token,
            owner,
            source.map(|original| CapturedSource {
                original,
                transport: transport_keys(transport, windows),
                windows,
            }),
        ));
    }
    fn capture(&mut self, window: usize, event: &wry::DragDropEvent, copying: bool) {
        let observed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        self.capture_at(window, event, copying, observed_at);
    }
    fn capture_at(
        &mut self,
        window: usize,
        event: &wry::DragDropEvent,
        copying: bool,
        observed_at: f64,
    ) {
        let native = event.clone();
        let receiver = window.to_string();
        let position = |(x, y): (i32, i32)| tauri::PhysicalPosition {
            x: x as f64,
            y: y as f64,
        };
        let event = match event {
            wry::DragDropEvent::Enter {
                paths,
                position: point,
            } => {
                let source = self.enter(&receiver, paths);
                Event::Enter {
                    paths: receiver_event_paths(paths, source.as_ref()),
                    position: position(*point),
                    source,
                    copy_modifier: Some(copying),
                    observed_at,
                }
            }
            wry::DragDropEvent::Over { position: point } => Event::Over {
                position: position(*point),
                copy_modifier: Some(copying),
            },
            wry::DragDropEvent::Drop {
                paths,
                position: point,
            } => {
                let source = self.receive_drop(&receiver, paths);
                Event::Drop {
                    paths: receiver_event_paths(paths, source.as_ref()),
                    position: position(*point),
                    source,
                    copy_modifier: Some(copying),
                    observed_at,
                }
            }
            wry::DragDropEvent::Leave => {
                self.leave(&receiver);
                Event::Leave
            }
            _ => return,
        };
        self.pending
            .entry(window)
            .or_default()
            .push_back((native, event));
    }
    fn take(&mut self, window: usize, delivered: &tauri::DragDropEvent) -> Option<Event> {
        let (native, event) = self.pending.get_mut(&window)?.pop_front()?;
        if self.pending.get(&window).is_some_and(VecDeque::is_empty) {
            self.pending.remove(&window);
        }
        same_receiver_event(&native, delivered).then_some(event)
    }
    #[cfg(test)]
    fn begin(&mut self, token: u64, owner: String, source: Option<Source>) {
        let transport = source
            .as_ref()
            .map(|source| receiver_event_paths(&[], Some(source)))
            .unwrap_or_default();
        self.begin_prepared(
            token,
            owner,
            source,
            &transport,
            cfg!(target_os = "windows"),
        );
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
            .filter(|source| receiver_paths(paths, source.windows) && source.matches(paths))
            .cloned();
        self.receivers.remove(receiver);
        if let Some(source) = &source {
            self.receivers.insert(receiver.into(), source.clone());
        }
        source.map(|source| source.original)
    }
    fn receive_drop(&mut self, receiver: &str, paths: &[PathBuf]) -> Option<Source> {
        self.receivers
            .remove(receiver)
            .filter(|source| source.matches(paths))
            .map(|source| source.original)
    }
    fn leave(&mut self, receiver: &str) {
        self.receivers.remove(receiver);
    }
    fn destroyed(&mut self, owner: &str) {
        self.receivers.remove(owner);
        let ids: Vec<_> = self
            .native_labels
            .iter()
            .filter_map(|(id, label)| (label == owner).then_some(*id))
            .collect();
        for id in ids {
            self.native_labels.remove(&id);
            self.pending.remove(&id);
            self.leave(&id.to_string());
        }
        if self.active.as_ref().is_some_and(|active| active.1 == owner) {
            self.active = None;
        }
    }
    fn register_window(&mut self, id: usize, label: &str) {
        if self
            .native_labels
            .get(&id)
            .is_some_and(|previous| previous != label)
        {
            self.pending.remove(&id);
            self.leave(&id.to_string());
        }
        self.native_labels.insert(id, label.into());
    }
    fn window_event(
        &mut self,
        label: &str,
        event: &tauri::WindowEvent,
        native_id: impl FnOnce() -> Option<usize>,
    ) -> Option<Event> {
        // The runtime has already removed the native window at Destroyed.
        // Use the identity recorded during live events/platform observation.
        if matches!(event, tauri::WindowEvent::Destroyed) {
            self.destroyed(label);
            return None;
        }
        let id = native_id()?;
        self.register_window(id, label);
        match event {
            tauri::WindowEvent::DragDrop(delivered) => self.take(id, delivered),
            _ => None,
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
        observed_at: f64,
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
        observed_at: f64,
    },
    Leave,
}

// Copy intent and source identity are snapshotted at the platform callback,
// before Wry/Tao enqueue delivery. Never query keyboard state during dispatch.
pub fn install_snapshots(app: tauri::AppHandle) {
    wry::drag_drop_snapshot::set_observer(Some(std::sync::Arc::new(
        move |window, event, copying| {
            // A window can close before Tauri delivers its first queued drag
            // event. Associate the receiver at the platform callback itself.
            let label = app
                .webview_windows()
                .values()
                .find(|candidate| native_window_id(&candidate.as_ref().window()) == Some(window))
                .map(|candidate| candidate.label().to_owned());
            let Some(label) = label else {
                return;
            };
            let sessions = app.state::<Sessions>();
            let mut registry = sessions
                .registry
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            registry.register_window(window, &label);
            registry.capture(window, event, copying);
        },
    )));
}

fn native_window_id(window: &tauri::Window) -> Option<usize> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        window
            .gtk_window()
            .ok()
            .map(|window| window.as_ptr() as usize)
    }
    #[cfg(target_os = "windows")]
    {
        window.hwnd().ok().map(|window| window.0 as usize)
    }
    #[cfg(target_os = "macos")]
    {
        window.ns_window().ok().map(|window| window as usize)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = window;
        None
    }
}

fn receiver_event_paths(paths: &[PathBuf], source: Option<&Source>) -> Vec<PathBuf> {
    // The native transport may resolve a Windows directory link. Once the
    // entire transport set is verified, carry original paths alongside source
    // metadata so the frontend's multiset admission preserves link identity.
    source
        .map(|source| {
            source
                .paths
                .as_deref()
                .unwrap_or(std::slice::from_ref(&source.path))
                .iter()
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_else(|| paths.to_vec())
}

fn same_receiver_event(native: &wry::DragDropEvent, delivered: &tauri::DragDropEvent) -> bool {
    let position_matches = |(x, y): (i32, i32), point: &tauri::PhysicalPosition<f64>| {
        point.x == x as f64 && point.y == y as f64
    };
    match (native, delivered) {
        (
            wry::DragDropEvent::Enter { paths: a, position },
            tauri::DragDropEvent::Enter {
                paths: b,
                position: point,
            },
        )
        | (
            wry::DragDropEvent::Drop { paths: a, position },
            tauri::DragDropEvent::Drop {
                paths: b,
                position: point,
            },
        ) => a == b && position_matches(*position, point),
        (wry::DragDropEvent::Over { position }, tauri::DragDropEvent::Over { position: point }) => {
            position_matches(*position, point)
        }
        (wry::DragDropEvent::Leave, tauri::DragDropEvent::Leave) => true,
        _ => false,
    }
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let sessions = window.state::<Sessions>();
    let mut registry = sessions
        .registry
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let captured = registry.window_event(window.label(), event, || native_window_id(window));
    if matches!(event, tauri::WindowEvent::DragDrop(_)) && captured.is_none() {
        log::warn!("Discarding native drop event without its platform snapshot");
    }
    drop(registry);
    if let Some(event) = captured {
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
    let item = drag::prepare_file_paths(item).map_err(|error| error.to_string())?;
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
                let options = native_drag_options(source.as_ref());
                window
                    .state::<Sessions>()
                    .registry
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .begin_prepared(
                        token,
                        window.label().into(),
                        source,
                        &item,
                        cfg!(target_os = "windows"),
                    );
                #[cfg(target_os = "windows")]
                let native_item = item;
                #[cfg(not(target_os = "windows"))]
                let native_item = drag::DragItem::Files(item);
                #[cfg(target_os = "windows")]
                let start_drag = drag::start_drag_prepared;
                #[cfg(not(target_os = "windows"))]
                let start_drag = drag::start_drag;
                start_drag(
                    &native_window,
                    native_item,
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
                    options,
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
