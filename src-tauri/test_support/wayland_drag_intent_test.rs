//! Real Wayland wire events on a second keyboard of the source connection.
//! The tiny compositor reproduces Mutter's Leave / Drop-time Enter+Modifiers
//! sequence; no key events are delivered while the simulated grab is active.
use super::*;
use std::{
    io::Write,
    os::{fd::AsFd, unix::net::UnixStream},
    sync::{mpsc, Arc},
    time::Duration,
};
use wayland_client::{
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_compositor, wl_registry, wl_surface},
};
use wayland_server::{
    protocol::{
        wl_compositor as server_compositor, wl_keyboard as server_keyboard, wl_seat as server_seat,
        wl_surface as server_surface,
    },
    Client, DataInit, Display, DisplayHandle, GlobalDispatch, New,
};

#[derive(Default)]
struct ClientState {
    enters: usize,
}
impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for ClientState {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
wayland_client::delegate_noop!(ClientState: ignore wl_seat::WlSeat);
wayland_client::delegate_noop!(ClientState: ignore wl_compositor::WlCompositor);
wayland_client::delegate_noop!(ClientState: ignore wl_surface::WlSurface);
impl Dispatch<wl_keyboard::WlKeyboard, ()> for ClientState {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if matches!(event, wl_keyboard::Event::Enter { .. }) {
            state.enters += 1;
        }
    }
}

struct Server {
    surface: Option<server_surface::WlSurface>,
    keyboards: Vec<server_keyboard::WlKeyboard>,
    keymap: std::fs::File,
    keymap_size: u32,
    ctrl_mask: u32,
    initial_ctrl: bool,
    initial_focus: bool,
}
impl GlobalDispatch<server_seat::WlSeat, ()> for Server {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<server_seat::WlSeat>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        let seat = init.init(resource, ());
        seat.capabilities(server_seat::Capability::Keyboard);
    }
}
impl GlobalDispatch<server_compositor::WlCompositor, ()> for Server {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<server_compositor::WlCompositor>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ());
    }
}
impl wayland_server::Dispatch<server_compositor::WlCompositor, ()> for Server {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &server_compositor::WlCompositor,
        request: server_compositor::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            server_compositor::Request::CreateSurface { id } => {
                state.surface = Some(init.init(id, ()));
            }
            _ => panic!("unexpected compositor request"),
        }
    }
}
impl wayland_server::Dispatch<server_seat::WlSeat, ()> for Server {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &server_seat::WlSeat,
        request: server_seat::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let server_seat::Request::GetKeyboard { id } = request {
            let keyboard = init.init(id, ());
            keyboard.keymap(
                server_keyboard::KeymapFormat::XkbV1,
                state.keymap.as_fd(),
                state.keymap_size,
            );
            if state.initial_focus {
                keyboard.enter(1, state.surface.as_ref().unwrap(), vec![]);
                keyboard.modifiers(
                    1,
                    if state.initial_ctrl {
                        state.ctrl_mask
                    } else {
                        0
                    },
                    0,
                    0,
                    0,
                );
            }
            state.keyboards.push(keyboard);
        }
    }
}
impl wayland_server::Dispatch<server_keyboard::WlKeyboard, ()> for Server {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &server_keyboard::WlKeyboard,
        _: server_keyboard::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl wayland_server::Dispatch<server_surface::WlSurface, ()> for Server {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &server_surface::WlSurface,
        _: server_surface::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}

struct ClientData;
impl wayland_server::backend::ClientData for ClientData {}

enum Command {
    Restore {
        ctrl: bool,
        afterwards: bool,
        reply: mpsc::Sender<()>,
    },
    Stop,
}

struct Fixture {
    source: Connection,
    source_queue: EventQueue<ClientState>,
    seat: wl_seat::WlSeat,
    commands: mpsc::Sender<Command>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(initial_ctrl: bool) -> Self {
        Self::with_initial_focus(initial_ctrl, true)
    }
    fn with_initial_focus(initial_ctrl: bool, initial_focus: bool) -> Self {
        let keymap = xkb::Keymap::new_from_names(
            &xkb::Context::new(xkb::CONTEXT_NO_FLAGS),
            "",
            "",
            "us",
            "",
            None,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .unwrap();
        let ctrl_mask = 1 << keymap.mod_get_index(xkb::MOD_NAME_CTRL);
        let text = keymap.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(text.as_bytes()).unwrap();
        file.write_all(&[0]).unwrap();
        let mut server = Server {
            surface: None,
            keyboards: vec![],
            keymap: file,
            keymap_size: text.len() as u32 + 1,
            ctrl_mask,
            initial_ctrl,
            initial_focus,
        };
        let mut display = Display::<Server>::new().unwrap();
        let mut handle = display.handle();
        handle.create_global::<Server, server_seat::WlSeat, _>(7, ());
        handle.create_global::<Server, server_compositor::WlCompositor, _>(4, ());
        let (client_socket, server_socket) = UnixStream::pair().unwrap();
        handle
            .insert_client(server_socket, Arc::new(ClientData))
            .unwrap();
        let (commands, receive) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            loop {
                if let Ok(command) = receive.try_recv() {
                    match command {
                        Command::Stop => break,
                        Command::Restore {
                            ctrl,
                            afterwards,
                            reply,
                        } => {
                            for keyboard in &server.keyboards {
                                let surface = server.surface.as_ref().unwrap();
                                if server.initial_focus {
                                    keyboard.leave(2, surface);
                                }
                                keyboard.modifiers(2, if !ctrl { ctrl_mask } else { 0 }, 0, 0, 0);
                                // Mutter emits this pair synchronously after Drop.
                                keyboard.enter(3, surface, vec![]);
                                keyboard.modifiers(3, if ctrl { ctrl_mask } else { 0 }, 0, 0, 0);
                                // A key transition after Drop is already queued
                                // before the client gets CPU time again.
                                keyboard.modifiers(
                                    4,
                                    if afterwards { ctrl_mask } else { 0 },
                                    0,
                                    0,
                                    0,
                                );
                            }
                            display.flush_clients().unwrap();
                            reply.send(()).unwrap();
                        }
                    }
                }
                display.dispatch_clients(&mut server).unwrap();
                display.flush_clients().unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let source = Connection::from_socket(client_socket).unwrap();
        let (globals, mut source_queue) = registry_queue_init::<ClientState>(&source).unwrap();
        let qh = source_queue.handle();
        let seat = globals
            .bind::<wl_seat::WlSeat, _, _>(&qh, 7..=7, ())
            .unwrap();
        let compositor = globals
            .bind::<wl_compositor::WlCompositor, _, _>(&qh, 4..=4, ())
            .unwrap();
        let _surface = compositor.create_surface(&qh, ());
        let _keyboard = seat.get_keyboard(&qh, ());
        source_queue.roundtrip(&mut ClientState::default()).unwrap();
        Self {
            source,
            source_queue,
            seat,
            commands,
            thread: Some(thread),
        }
    }
    fn monitor(&self) -> Monitor {
        // Same foreign-display/proxy import as production, without GTK or a GUI.
        // SAFETY: Fixture owns the connection/seat until after Monitor is dropped.
        let (connection, seat) = unsafe {
            let connection = Connection::from_backend(Backend::from_foreign_display(
                self.source.backend().display_ptr(),
            ));
            let id =
                ObjectId::from_ptr(wl_seat::WlSeat::interface(), self.seat.id().as_ptr()).unwrap();
            let seat = wl_seat::WlSeat::from_id(&connection, id).unwrap();
            (connection, seat)
        };
        Monitor::new(connection, &seat, None).unwrap()
    }
    fn restore(&self, ctrl: bool, afterwards: bool) {
        let (reply, receive) = mpsc::channel();
        self.commands
            .send(Command::Restore {
                ctrl,
                afterwards,
                reply,
            })
            .unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
fn drop_intent_uses_fresh_protocol_snapshot_and_survives_later_key_changes() {
    for (initial_ctrl, at_drop) in [(false, true), (true, true), (true, false), (false, false)] {
        let mut fixture = Fixture::new(initial_ctrl);
        GESTURE.with(|gesture| {
            *gesture.borrow_mut() = Some(Gesture {
                id: "wire-gesture".into(),
                monitor: Some(fixture.monitor()),
                result: None,
            })
        });
        let paths = vec![std::path::PathBuf::from("/source/file.txt")];
        let mut registry = crate::native_file_drag::Registry::default();
        registry.begin(
            1,
            "source".into(),
            Some(crate::native_file_drag::Source {
                session_id: "wire-gesture".into(),
                gesture_sequence: 1,
                path: "/source/file.txt".into(),
                paths: None,
                name: "file.txt".into(),
                kind: "file".into(),
                native_copy_policy: Some(crate::native_file_drag::CopyPolicy::Modifier),
                html5: false,
            }),
        );
        registry.capture(
            42,
            &wry::DragDropEvent::Enter {
                paths: paths.clone(),
                position: (20, 30),
            },
            initial_ctrl,
        );
        registry
            .take(
                42,
                &tauri::DragDropEvent::Enter {
                    paths: paths.clone(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap();
        fixture.restore(at_drop, !at_drop);
        // Exercise the production source channel -> native callback -> emitted
        // payload, not merely the recorder's intermediate boolean.
        registry.capture(
            42,
            &wry::DragDropEvent::Drop {
                paths: paths.clone(),
                position: (20, 30),
            },
            initial_ctrl,
        );
        let payload = serde_json::to_value(
            registry
                .take(
                    42,
                    &tauri::DragDropEvent::Drop {
                        paths,
                        position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            payload["copyModifier"], at_drop,
            "initial Ctrl={initial_ctrl}"
        );
        assert_eq!(payload["source"]["sessionId"], "wire-gesture");
        assert_eq!(
            snapshot("wire-gesture").unwrap().unwrap(),
            at_drop,
            "snapshot is immutable"
        );
        GESTURE.with(|gesture| *gesture.borrow_mut() = None);
        let mut source_state = ClientState::default();
        fixture.source_queue.roundtrip(&mut source_state).unwrap();
        assert_eq!(
            source_state.enters, 1,
            "observer must not steal the source keyboard's events"
        );
    }
}

#[test]
fn initial_focus_and_initial_ctrl_cannot_substitute_for_a_drop_snapshot() {
    let fixture = Fixture::new(true);
    let mut monitor = fixture.monitor();
    assert!(monitor.snapshot().is_err());
}

#[test]
fn source_completion_releases_keyboard_but_retains_gesture_bound_intent() {
    let fixture = Fixture::new(false);
    GESTURE.with(|gesture| {
        *gesture.borrow_mut() = Some(Gesture {
            id: "gesture-one".into(),
            monitor: Some(fixture.monitor()),
            result: None,
        })
    });
    finish("previous-gesture");
    GESTURE.with(|gesture| assert!(gesture.borrow().as_ref().unwrap().monitor.is_some()));
    fixture.restore(true, false);
    finish("gesture-one");
    GESTURE.with(|gesture| assert!(gesture.borrow().as_ref().unwrap().monitor.is_none()));
    assert!(snapshot("gesture-one").unwrap().unwrap());
    assert!(snapshot("different-gesture").unwrap().is_err());
    assert!(snapshot("gesture-one").unwrap().unwrap());
    GESTURE.with(|gesture| *gesture.borrow_mut() = None);
}

#[test]
fn handoff_after_webkit_already_grabbed_keyboard_uses_first_restoration() {
    let fixture = Fixture::with_initial_focus(false, false);
    let mut monitor = fixture.monitor();
    fixture.restore(true, false);
    assert!(monitor.snapshot().unwrap());
}
