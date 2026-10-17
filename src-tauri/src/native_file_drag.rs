//! Native source identity is captured before frontend IPC channels can reorder.

use crate::error::AppError;
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

#[cfg(target_os = "linux")]
mod linux_html5;
#[cfg(target_os = "linux")]
mod wayland_intent;

const EVENT: &str = "explorer-native-file-drag";

struct ObservationClock {
    id: String,
    origin: std::time::Instant,
}
impl Default for ObservationClock {
    fn default() -> Self {
        let mut identity = [0u8; 16];
        getrandom::fill(&mut identity).expect("native drag clock identity unavailable");
        Self {
            id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(identity),
            origin: std::time::Instant::now(),
        }
    }
}
impl ObservationClock {
    fn now(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1000.0
    }
}

#[derive(Serialize)]
pub struct ClockSample {
    id: String,
    now: f64,
}

#[tauri::command]
pub async fn native_file_drag_clock(
    sessions: tauri::State<'_, Sessions>,
) -> Result<ClockSample, AppError> {
    let registry = sessions
        .registry
        .lock()
        .map_err(|_| AppError::Other("Native drag clock unavailable".into()))?;
    Ok(registry.clock_sample())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum CopyPolicy {
    Modifier,
    Move,
    Link,
}

fn native_drag_options(source: Option<&Source>) -> Result<drag::Options, String> {
    // GTK3 Wayland maps GDK_ACTION_LINK to the protocol's Copy action.
    // Recent has shortcut authority only; no portable OS file drag preserves it.
    if source.is_some_and(|source| source.native_copy_policy == Some(CopyPolicy::Link)) {
        return Err("Shortcut sources cannot start native file drags".into());
    }
    Ok(drag::Options::default())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    session_id: String,
    gesture_sequence: u64,
    path: String,
    name: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_copy_policy: Option<CopyPolicy>,
    #[serde(default)]
    html5: bool,
}

impl Source {
    #[cfg(any(target_os = "linux", test))]
    fn uses_webkit_source(&self) -> bool {
        cfg!(target_os = "linux") && self.html5
    }
    fn needs_copy_intent(&self) -> bool {
        self.native_copy_policy != Some(CopyPolicy::Move)
    }
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
        || source.gesture_sequence == 0
        || source.gesture_sequence > 9_007_199_254_740_991
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

type NativeContext = usize;

#[derive(Clone)]
struct CapturedSource {
    original: Source,
    transport: Vec<String>,
    windows: bool,
    native_context: Option<NativeContext>,
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

struct Receiver {
    paths: Vec<PathBuf>,
    source: Option<CapturedSource>,
    native_context: Option<NativeContext>,
}

#[derive(Default)]
struct Registry {
    clock: ObservationClock,
    active: Option<(u64, String, Option<CapturedSource>)>,
    completed_gesture_sequence: u64,
    receivers: HashMap<String, Receiver>,
    pending: HashMap<usize, VecDeque<(wry::DragDropEvent, Event)>>,
    native_labels: HashMap<usize, String>,
}

impl Registry {
    fn clock_sample(&self) -> ClockSample {
        ClockSample {
            id: self.clock.id.clone(),
            now: self.clock.now(),
        }
    }
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
                native_context: None,
            }),
        ));
    }
    #[cfg(any(target_os = "linux", test))]
    fn bind_html5_context(&mut self, token: u64, context: NativeContext) {
        let Some((_, _, Some(source))) = self.active.as_mut().filter(|active| active.0 == token)
        else {
            return;
        };
        if !source.original.html5 {
            return;
        }
        source.native_context = Some(context);
        let source = source.clone();
        for receiver in self
            .receivers
            .values_mut()
            .filter(|receiver| receiver.native_context == Some(context))
        {
            if receiver_paths(&receiver.paths, source.windows) && source.matches(&receiver.paths) {
                receiver.source = Some(source.clone());
            }
        }
    }

    fn capture(&mut self, window: usize, event: &wry::DragDropEvent, copying: bool) {
        let observed_at = self.clock.now();
        self.capture_with_intent(window, event, copying, observed_at, |source| {
            #[cfg(target_os = "linux")]
            {
                wayland_intent::snapshot(&source.session_id)
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = source;
                None
            }
        });
    }
    fn capture_with_intent(
        &mut self,
        window: usize,
        event: &wry::DragDropEvent,
        copying: bool,
        observed_at: f64,
        intent: impl FnOnce(&Source) -> Option<Result<bool, String>>,
    ) {
        let mut copying = copying;
        if let wry::DragDropEvent::Drop { paths, .. } = event {
            let receiver = window.to_string();
            let raw_drop_context =
                wry::drag_drop_snapshot::source_window().filter(|context| *context != 0);
            let drop_context = wry::drag_drop_snapshot::source_token();
            if wry::drag_drop_snapshot::source_is_local() == Some(false)
                || self.receivers.get(&receiver).is_some_and(|entered| {
                    entered.native_context.is_some()
                        && (raw_drop_context.is_some()
                            || wry::drag_drop_snapshot::source_is_local().is_some())
                        && entered.native_context != drop_context
                })
            {
                self.leave(&receiver);
            }
            #[cfg(target_os = "linux")]
            let own_drop = wry::drag_drop_snapshot::source_is_local() == Some(true);
            #[cfg(not(target_os = "linux"))]
            let own_drop = false;
            if paths.iter().all(|path| path.is_absolute())
                && (own_drop
                    || self
                        .receivers
                        .get(&receiver)
                        .is_some_and(|receiver| receiver.native_context.is_some()))
                && self.receiver_source(&receiver, paths).is_none()
            {
                self.leave(&receiver);
                self.pending
                    .entry(window)
                    .or_default()
                    .push_back((event.clone(), Event::Leave));
                return;
            }
            if let Some(source) = self.receiver_source(&window.to_string(), paths) {
                // Listings have a fixed move policy. A missing keyboard restoration
                // must only cancel sources whose policy actually needs Ctrl.
                let modifier_intent = if source.original.needs_copy_intent() {
                    intent(&source.original)
                } else {
                    None
                };
                match modifier_intent {
                    Some(Ok(fresh)) => copying = fresh,
                    Some(Err(error)) => {
                        self.leave(&window.to_string());
                        // Keep a FIFO receipt for the queued native Drop and
                        // clear receiver feedback without authorizing a file
                        // mutation. Omitting this slot could consume a later
                        // gesture's Enter when the cancelled Drop is delivered.
                        self.pending
                            .entry(window)
                            .or_default()
                            .push_back((event.clone(), Event::Leave));
                        log::warn!("{error}");
                        return;
                    }
                    None => {}
                }
            }
        }
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
        #[cfg(target_os = "linux")]
        let external_source = wry::drag_drop_snapshot::source_is_local().map(|local| !local);
        #[cfg(not(target_os = "linux"))]
        let external_source = None;
        let event = match event {
            wry::DragDropEvent::Enter {
                paths,
                position: point,
            } => {
                let native_context = wry::drag_drop_snapshot::source_token();
                let mut source = self.enter_with_context(&receiver, paths, native_context);
                if external_source == Some(true) {
                    self.receivers.get_mut(&receiver).unwrap().source = None;
                    source = None;
                }
                Event::Enter {
                    paths: receiver_event_paths(paths, source.as_ref()),
                    position: position(*point),
                    source,
                    copy_modifier: Some(copying),
                    observed_at,
                    observation_clock: self.clock.id.clone(),
                    completed_gesture_sequence: self.completed_gesture_sequence,
                    external_source,
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
                    observation_clock: self.clock.id.clone(),
                    completed_gesture_sequence: self.completed_gesture_sequence,
                    external_source,
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
        if let Some((active_token, _, Some(source))) = &self.active {
            if *active_token == token {
                self.completed_gesture_sequence = self
                    .completed_gesture_sequence
                    .max(source.original.gesture_sequence);
            }
        }
        self.failed_start(token);
    }
    // A failed explicit start leaves the original HTML5 gesture alive on GTK.
    // Only real native completion can fence automatic HTML5 source recovery.
    fn failed_start(&mut self, token: u64) {
        if self.active.as_ref().is_some_and(|active| active.0 == token) {
            self.active = None;
        }
    }
    #[cfg(test)]
    fn enter(&mut self, receiver: &str, paths: &[PathBuf]) -> Option<Source> {
        self.enter_with_context(receiver, paths, None)
    }
    fn enter_with_context(
        &mut self,
        receiver: &str,
        paths: &[PathBuf],
        native_context: Option<NativeContext>,
    ) -> Option<Source> {
        let source = self
            .active
            .as_ref()
            .and_then(|active| active.2.as_ref())
            .filter(|source| {
                (!source.original.html5
                    || (source.native_context.is_some() && source.native_context == native_context))
                    && receiver_paths(paths, source.windows)
                    && source.matches(paths)
            })
            .cloned();
        self.receivers.insert(
            receiver.into(),
            Receiver {
                paths: paths.to_vec(),
                source: source.clone(),
                native_context,
            },
        );
        source.map(|source| source.original)
    }
    fn receiver_source(&self, receiver: &str, paths: &[PathBuf]) -> Option<&CapturedSource> {
        let entered = self.receivers.get(receiver)?;
        if transport_keys(&entered.paths, cfg!(target_os = "windows"))
            != transport_keys(paths, cfg!(target_os = "windows"))
        {
            return None;
        }
        entered
            .source
            .as_ref()
            .filter(|source| source.matches(paths))
    }
    fn receive_drop(&mut self, receiver: &str, paths: &[PathBuf]) -> Option<Source> {
        let source = self.receiver_source(receiver, paths).cloned();
        self.receivers.remove(receiver);
        source.map(|source| source.original)
    }
    #[cfg(any(target_os = "linux", test))]
    fn can_adopt_html5(&self, source: &Source) -> bool {
        source.gesture_sequence > self.completed_gesture_sequence
            && self
                .active
                .as_ref()
                .and_then(|active| active.2.as_ref())
                .is_none_or(|active| source.gesture_sequence > active.original.gesture_sequence)
    }
    fn end_html5(&mut self, owner: &str, source: &Source, owner_disposed: bool) -> bool {
        let matching = self
            .active
            .as_ref()
            .filter(|(_, window, captured)| {
                window == owner
                    && captured.as_ref().is_some_and(|captured| {
                        captured.original.session_id == source.session_id
                            && captured.original.gesture_sequence == source.gesture_sequence
                    })
            })
            .map(|active| active.0);
        if owner_disposed && matching.is_some() {
            return false;
        }
        self.completed_gesture_sequence =
            self.completed_gesture_sequence.max(source.gesture_sequence);
        if let Some(token) = matching {
            self.complete(token);
        }
        true
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
        if let Some(token) = self
            .active
            .as_ref()
            .filter(|active| active.1 == owner)
            .map(|active| active.0)
        {
            self.complete(token);
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
        observation_clock: String,
        completed_gesture_sequence: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        external_source: Option<bool>,
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
        observation_clock: String,
        completed_gesture_sequence: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        external_source: Option<bool>,
    },
    Leave,
}

// Copy intent and source identity are snapshotted at the platform callback,
// before Wry/Tao enqueue delivery. Never query keyboard state during dispatch.
pub fn install_snapshots(app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    wry::drag_drop_snapshot::set_source_resolver(Some(std::sync::Arc::new(|window, local| {
        if local == Some(true) {
            window.and_then(linux_html5::context_for_window)
        } else {
            None
        }
    })));
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

// Keep platform completion ordering importable for deterministic event-loop
// probes. The dispatcher may yield to another OS event before draining work.
fn complete_native_drag(
    retire: impl FnOnce() + Send + 'static,
    notify: impl FnOnce() + Send + 'static,
    enqueue: impl FnOnce(Box<dyn FnOnce() + Send>),
) {
    // Wry captures receiver identity in the platform callback. Queued receiver
    // snapshots survive retirement, but a later Enter must see no active source.
    retire();
    enqueue(Box::new(notify));
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Html5EndReason {
    Ended,
    OwnerDisposed,
}

#[tauri::command]
pub async fn end_html5_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    source: Source,
    reason: Html5EndReason,
) -> Result<(), AppError> {
    if source.session_id.is_empty()
        || source.gesture_sequence == 0
        || source.gesture_sequence > 9_007_199_254_740_991
    {
        return Err("Invalid HTML5 drag identity".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        let preserve_native = matches!(reason, Html5EndReason::OwnerDisposed)
            && linux_html5::native_active(window.label(), &source.session_id);
        #[cfg(not(target_os = "linux"))]
        let preserve_native = {
            let _ = reason;
            false
        };
        let retire = window
            .state::<Sessions>()
            .registry
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .end_html5(window.label(), &source, preserve_native);
        #[cfg(target_os = "linux")]
        if retire {
            linux_html5::finish(window.label(), &source.session_id);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = retire;
        let _ = send.send(());
    })
    .map_err(|error| AppError::Other(error.to_string()))?;
    receive
        .await
        .map_err(|error| AppError::Other(error.to_string()))
}

#[cfg(target_os = "linux")]
pub fn html5_source_lifecycle() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("html5-source-lifecycle")
        .on_webview_ready(|webview| {
            let owner = webview.label().to_owned();
            if let Err(error) = webview.with_webview(move |native| {
                linux_html5::watch(&owner, &native.inner());
            }) {
                log::warn!("Could not observe WebKit native source lifecycle: {error}");
            }
        })
        .build()
}

#[cfg(target_os = "linux")]
async fn adopt_html5_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    item: Vec<PathBuf>,
    source: Source,
    on_event: Channel<Completion>,
) -> Result<(), AppError> {
    let webview = app
        .get_webview_window(window.label())
        .ok_or("Source webview unavailable")?;
    let token = app
        .state::<Sessions>()
        .sequence
        .fetch_add(1, Ordering::Relaxed);
    let (send, receive) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |native| {
            let result = (|| -> Result<(), String> {
                let sessions = app.state::<Sessions>();
                {
                    let mut registry = sessions
                        .registry
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    if !registry.can_adopt_html5(&source) {
                        return Err("HTML5 source already ended".into());
                    }
                    registry.begin_prepared(
                        token,
                        window.label().into(),
                        Some(source.clone()),
                        &item,
                        false,
                    );
                }
                if source.needs_copy_intent() {
                    let monitor = window
                        .gtk_window()
                        .map_err(|error| error.to_string())
                        .and_then(|window| wayland_intent::begin(&window, &source.session_id));
                    if let Err(error) = monitor {
                        // Keep ownership and fail closed at Drop; rejection would
                        // route this source through an unverified modifier fallback.
                        wayland_intent::unavailable(&source.session_id, error);
                    }
                }
                let session = source.session_id.clone();
                let owner = window.label().to_owned();
                let completion_app = app.clone();
                let bind_app = app.clone();
                let completion_session = source.session_id.clone();
                let paths = source
                    .paths
                    .clone()
                    .unwrap_or_else(|| vec![source.path.clone()]);
                let observed = linux_html5::observe(
                    &owner,
                    &session,
                    paths,
                    &native.inner(),
                    move |context| {
                        bind_app
                            .state::<Sessions>()
                            .registry
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .bind_html5_context(token, context);
                    },
                    move |result| {
                        wayland_intent::finish(&completion_session);
                        let retire_app = completion_app.clone();
                        let notify_app = completion_app.clone();
                        complete_native_drag(
                            move || {
                                retire_app
                                    .state::<Sessions>()
                                    .registry
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner())
                                    .complete(token);
                            },
                            move || {
                                let _ = on_event.send(Completion {
                                    result,
                                    cursor_pos: drag::CursorPosition { x: 0, y: 0 },
                                });
                            },
                            move |notification| {
                                let queued = std::thread::spawn(move || {
                                    notify_app.run_on_main_thread(notification)
                                })
                                .join();
                                if !matches!(queued, Ok(Ok(()))) {
                                    log::warn!("Could not queue HTML5 drag completion");
                                }
                            },
                        );
                    },
                );
                if let Err(error) = observed {
                    wayland_intent::finish(&source.session_id);
                    sessions
                        .registry
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .end_html5(&owner, &source, false);
                    return Err(error);
                }
                Ok(())
            })();
            let _ = send.send(result);
        })
        .map_err(|error| AppError::Other(error.to_string()))?;
    receive
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn start_file_drag(
    app: tauri::AppHandle,
    window: tauri::Window,
    item: Vec<PathBuf>,
    image: String,
    source: Option<Source>,
    on_event: Channel<Completion>,
) -> Result<(), AppError> {
    if item.is_empty() || item.iter().any(|path| !path.is_absolute()) {
        return Err("Drag paths must be absolute and nonempty".into());
    }
    if source
        .as_ref()
        .is_some_and(|source| source.session_id.is_empty() || !matches(source, &item))
    {
        return Err("Drag source does not match the native files".into());
    }
    let options = native_drag_options(source.as_ref())?;
    #[cfg(target_os = "linux")]
    if source.as_ref().is_some_and(Source::uses_webkit_source) {
        return adopt_html5_file_drag(app, window, item, source.unwrap(), on_event).await;
    }
    let item =
        drag::prepare_file_paths(item).map_err(|error| AppError::Other(error.to_string()))?;
    let image = if let Some(data) = image.strip_prefix("data:image/png;base64,") {
        drag::Image::Raw(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|error| AppError::Other(error.to_string()))?,
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
        let intent_id = source.as_ref().map(|source| source.session_id.clone());
        #[cfg(target_os = "linux")]
        let callback_intent_id = intent_id.clone();
        #[cfg(target_os = "linux")]
        let native_window = window.gtk_window();
        #[cfg(not(target_os = "linux"))]
        let native_window = tauri::Result::Ok(window.clone());
        let result = native_window
            .map_err(|error| error.to_string())
            .and_then(|native_window| {
                #[cfg(target_os = "linux")]
                if let Some(source) = source.as_ref().filter(|source| source.needs_copy_intent()) {
                    wayland_intent::begin(&native_window, &source.session_id)?;
                }
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
                        #[cfg(target_os = "linux")]
                        if let Some(id) = &callback_intent_id {
                            wayland_intent::finish(id);
                        }
                        let app = callback_app.clone();
                        let on_event = on_event.clone();
                        let owner = app.clone();
                        complete_native_drag(
                            move || {
                                owner
                                    .state::<Sessions>()
                                    .registry
                                    .lock()
                                    .unwrap_or_else(|poison| poison.into_inner())
                                    .complete(token);
                            },
                            move || {
                                let _ = on_event.send(Completion { result, cursor_pos });
                            },
                            move |notification| {
                                // Main→main dispatch runs inline. Queue just
                                // notification behind already captured events;
                                // active-source retirement has already happened.
                                let queued = std::thread::spawn(move || {
                                    app.run_on_main_thread(notification)
                                })
                                .join();
                                if !matches!(queued, Ok(Ok(()))) {
                                    log::warn!("Could not queue native drag completion");
                                }
                            },
                        );
                    },
                    options,
                )
                .map_err(|error| error.to_string())
            });
        if result.is_err() {
            #[cfg(target_os = "linux")]
            if let Some(id) = &intent_id {
                wayland_intent::finish(id);
            }
            window
                .state::<Sessions>()
                .registry
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .failed_start(token);
        }
        let _ = send.send(result);
    })
    .map_err(|error| AppError::Other(error.to_string()))?;
    receive
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
        .map_err(AppError::from)
}

#[cfg(test)]
#[path = "../test_support/native_file_drag.rs"]
mod tests;
