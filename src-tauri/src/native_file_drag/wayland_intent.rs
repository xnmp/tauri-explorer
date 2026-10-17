//! GNOME consumes keyboard events during DnD. Read the *first* keyboard-focus
//! restoration snapshot on the source connection, never GTK's modifier cache
//! or a negotiated DnD action. Mutter emits this snapshot while finishing the
//! button-release handler, before it can process a subsequent key release.

use gtk::{gdk, prelude::*};
use std::{cell::RefCell, os::unix::fs::FileExt};
use wayland_client::{
    backend::{Backend, ObjectId},
    protocol::{wl_keyboard, wl_seat},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use xkbcommon::xkb;

thread_local! {
    static GESTURE: RefCell<Option<Gesture>> = const { RefCell::new(None) };
}

struct Gesture {
    id: String,
    monitor: Option<Monitor>,
    result: Option<Result<bool, String>>,
}

fn enabled(display: &gdk::Display) -> bool {
    display.type_().name() == "GdkWaylandDisplay"
        && std::env::var("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .split(':')
            .any(|desktop| desktop.eq_ignore_ascii_case("GNOME"))
}

pub(super) fn begin(window: &gtk::ApplicationWindow, id: &str) -> Result<(), String> {
    let display = window.display();
    if !enabled(&display) {
        return Ok(());
    }
    let seat = display.default_seat().ok_or("No native drag seat")?;
    if seat.keyboard().is_none() {
        return Err("Native drag keyboard unavailable".into());
    }
    // SAFETY: these are GDK Wayland objects; the monitor keeps the display and
    // seat alive. Guest mode neither owns nor disconnects GTK's connection.
    let (connection, native_seat) = unsafe {
        let raw_display =
            gdk_wayland_sys::gdk_wayland_display_get_wl_display(display.as_ptr().cast());
        let raw_seat = gdk_wayland_sys::gdk_wayland_seat_get_wl_seat(seat.as_ptr().cast());
        if raw_display.is_null() || raw_seat.is_null() {
            return Err("Native Wayland drag connection unavailable".into());
        }
        let connection =
            Connection::from_backend(Backend::from_foreign_display(raw_display.cast()));
        let seat_id = ObjectId::from_ptr(wl_seat::WlSeat::interface(), raw_seat.cast())
            .map_err(|error| error.to_string())?;
        let native_seat =
            wl_seat::WlSeat::from_id(&connection, seat_id).map_err(|error| error.to_string())?;
        (connection, native_seat)
    };
    let monitor = Monitor::new(connection, &native_seat, Some((display, seat)))?;
    GESTURE.with(|gesture| {
        *gesture.borrow_mut() = Some(Gesture {
            id: id.into(),
            monitor: Some(monitor),
            result: None,
        });
    });
    Ok(())
}

pub(super) fn snapshot(id: &str) -> Option<Result<bool, String>> {
    GESTURE.with(|gesture| {
        let mut gesture = gesture.borrow_mut();
        let gesture = gesture.as_mut()?;
        if gesture.id != id {
            return Some(Err("Native drop intent belongs to another gesture".into()));
        }
        if let Some(mut monitor) = gesture.monitor.take() {
            gesture.result = Some(monitor.snapshot());
        }
        gesture.result.clone()
    })
}

pub(super) fn finish(id: &str) {
    GESTURE.with(|gesture| {
        if let Some(gesture) = gesture
            .borrow_mut()
            .as_mut()
            .filter(|gesture| gesture.id == id)
        {
            if let Some(mut monitor) = gesture.monitor.take() {
                // Keep the immutable result through delayed receiver delivery,
                // but release the extra keyboard resource at source completion.
                gesture.result = Some(monitor.snapshot());
            }
        }
    });
}

struct Monitor {
    queue: EventQueue<Recorder>,
    keyboard: wl_keyboard::WlKeyboard,
    recorder: Recorder,
    // Dropped after the queue/proxy that borrow GTK's connection.
    _owner: Option<(gdk::Display, gdk::Seat)>,
}

impl Monitor {
    fn new(
        connection: Connection,
        seat: &wl_seat::WlSeat,
        owner: Option<(gdk::Display, gdk::Seat)>,
    ) -> Result<Self, String> {
        let queue = connection.new_event_queue();
        let keyboard = seat.get_keyboard(&queue.handle(), ());
        let mut monitor = Self {
            queue,
            keyboard,
            recorder: Recorder::default(),
            _owner: owner,
        };
        // Drain initial focus before GTK starts the grab. WebKit may already
        // have started its HTML5 grab by the time handoff IPC reaches us; in
        // that case there is no initial Enter, and the first restored focus is
        // the fresh snapshot. Otherwise require Leave before restoration.
        monitor
            .queue
            .roundtrip(&mut monitor.recorder)
            .map_err(|error| error.to_string())?;
        if monitor.recorder.keymap.is_none() {
            return Err("Native drag requires a source keyboard keymap".into());
        }
        monitor.recorder.left = !monitor.recorder.focused;
        monitor.recorder.armed = true;
        Ok(monitor)
    }

    fn snapshot(&mut self) -> Result<bool, String> {
        // This dispatches only our private queue, not GTK's default queue. The
        // compositor finishes its Drop/release handler before answering sync.
        self.queue
            .roundtrip(&mut self.recorder)
            .map_err(|error| error.to_string())?;
        self.recorder
            .snapshot
            .ok_or_else(|| "No fresh keyboard-focus snapshot; in-app drop cancelled".into())
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        if self.keyboard.version() >= 3 {
            self.keyboard.release();
        } else {
            let _ = self
                .keyboard
                .backend()
                .upgrade()
                .map(|backend| backend.destroy_object(&self.keyboard.id()));
        }
    }
}

#[derive(Default)]
struct Recorder {
    keymap: Option<xkb::Keymap>,
    focused: bool,
    armed: bool,
    left: bool,
    restored_serial: Option<u32>,
    snapshot: Option<bool>,
}

impl Recorder {
    fn record(&mut self, event: wl_keyboard::Event) {
        match event {
            wl_keyboard::Event::Keymap { format, fd, size } => {
                self.keymap = None;
                if format == WEnum::Value(wl_keyboard::KeymapFormat::XkbV1)
                    && size > 0
                    && size <= 4 * 1024 * 1024
                {
                    // Keymap FDs are shared memory, with no promised seek
                    // offset. Read at zero without changing the sender's offset.
                    let mut bytes = vec![0; size as usize];
                    if std::fs::File::from(fd).read_exact_at(&mut bytes, 0).is_ok() {
                        if let Ok(text) = String::from_utf8(bytes) {
                            self.keymap = xkb::Keymap::new_from_string(
                                &xkb::Context::new(xkb::CONTEXT_NO_FLAGS),
                                text,
                                xkb::KEYMAP_FORMAT_TEXT_V1,
                                xkb::KEYMAP_COMPILE_NO_FLAGS,
                            );
                        }
                    }
                }
            }
            wl_keyboard::Event::Enter { serial, .. } => {
                self.focused = true;
                if self.armed && self.left && self.snapshot.is_none() {
                    self.restored_serial = Some(serial);
                }
            }
            wl_keyboard::Event::Leave { .. } => {
                self.focused = false;
                if self.armed {
                    self.left = true;
                    self.restored_serial = None;
                }
            }
            wl_keyboard::Event::Modifiers {
                serial,
                mods_depressed,
                mods_latched,
                mods_locked,
                group,
            } if self.snapshot.is_none() && self.restored_serial == Some(serial) => {
                if let Some(keymap) = &self.keymap {
                    let mut state = xkb::State::new(keymap);
                    state.update_mask(mods_depressed, mods_latched, mods_locked, 0, 0, group);
                    self.snapshot = Some(
                        state.mod_name_is_active(xkb::MOD_NAME_CTRL, xkb::STATE_MODS_EFFECTIVE),
                    );
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, ()> for Recorder {
    fn event(
        state: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        state.record(event);
    }
}

#[cfg(test)]
#[path = "../../test_support/wayland_drag_intent_test.rs"]
mod tests;
