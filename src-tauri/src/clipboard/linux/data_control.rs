//! The Wayland Cut owner: a data-control clipboard source (#927).
//!
//! `wl-copy` offers one payload per process, so the selection it serves is
//! byte-identical to what a file manager, a clipboard manager or an earlier
//! write offers for the same files. A Cut proven by reading those bytes back
//! could be credited with another client's offer. This owner offers the file
//! list and, as a private type, the write's random token, so reading the token
//! back names this exact write.
//!
//! The owner runs as a separate process, the app's own executable in a private
//! mode, so that it behaves like the `wl-copy --foreground` owner it replaces:
//! it exits when another client takes the selection, the backend stops it by
//! killing it, and the last owner keeps serving after the app quits.
//!
//! Data-control (`ext-data-control-v1`, or wlroots'
//! `zwlr-data-control-unstable-v1`) sets the selection without keyboard focus.
//! Compositors without it make the owner exit with `NO_DATA_CONTROL_EXIT`;
//! the backend then serves Copy through `wl-copy` and refuses Cut.

use super::wayland::{FILE_LIST_TYPE, OWNER_TYPE};
use std::io::{Read, Write};
use std::sync::Arc;
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{event_created_child, Connection, Dispatch, QueueHandle};
use wayland_protocols::ext::data_control::v1::client as ext;
use wayland_protocols_wlr::data_control::v1::client as wlr;

/// Selects this mode as the executable's only argument.
pub(super) const MARKER: &str = "--te-wayland-clipboard-owner-v1";
/// The compositor offers no data-control protocol.
pub(super) const NO_DATA_CONTROL_EXIT: i32 = 3;
const FAILED_EXIT: i32 = 1;
const USAGE_EXIT: i32 = 64;

/// Run the owner when the process was started in its mode. Call before any
/// application initialization.
pub(crate) fn early_mode() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(MARKER)) {
        return None;
    }
    if args.next().is_some() {
        return Some(USAGE_EXIT);
    }
    let mut request = Vec::new();
    if std::io::stdin().read_to_end(&mut request).is_err() {
        return Some(USAGE_EXIT);
    }
    let Some((token, payload)) = decode_request(&request) else {
        return Some(USAGE_EXIT);
    };
    let Ok(connection) = Connection::connect_to_env() else {
        return Some(FAILED_EXIT);
    };
    Some(match serve(&connection, offers(token, payload)) {
        Ok(Served::Replaced) => 0,
        Ok(Served::NoDataControl) => NO_DATA_CONTROL_EXIT,
        Err(_) => FAILED_EXIT,
    })
}

/// What the owner reads on stdin: the token, a newline, then the payload.
pub(super) fn encode_request(token: &str, payload: &[u8]) -> Vec<u8> {
    let mut request = Vec::with_capacity(token.len() + 1 + payload.len());
    request.extend_from_slice(token.as_bytes());
    request.push(b'\n');
    request.extend_from_slice(payload);
    request
}

fn decode_request(request: &[u8]) -> Option<(&[u8], &[u8])> {
    let split = request.iter().position(|byte| *byte == b'\n')?;
    let (token, payload) = (&request[..split], &request[split + 1..]);
    (!token.is_empty() && !payload.is_empty()).then_some((token, payload))
}

fn offers(token: &[u8], payload: &[u8]) -> Vec<(String, Vec<u8>)> {
    vec![
        (FILE_LIST_TYPE.to_owned(), payload.to_vec()),
        (OWNER_TYPE.to_owned(), token.to_vec()),
    ]
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Served {
    /// Another client took the selection.
    Replaced,
    NoDataControl,
}

struct State {
    offers: Arc<Vec<(String, Vec<u8>)>>,
    ended: Option<Result<Served, String>>,
}

impl State {
    /// Write the offered bytes of `mime_type` to a paste request's pipe. A
    /// helper thread writes, so a reader that stalls cannot keep this owner
    /// from seeing that it lost the selection.
    fn send(&self, mime_type: &str, fd: std::os::fd::OwnedFd) {
        let offers = Arc::clone(&self.offers);
        let mime_type = mime_type.to_owned();
        std::thread::spawn(move || {
            if let Some((_, bytes)) = offers.iter().find(|(offered, _)| *offered == mime_type) {
                // The reader may close early; nothing else can be done.
                let _ = std::fs::File::from(fd).write_all(bytes);
            }
        });
    }
}

/// Set the selection to `offers` and serve it until another client takes it.
pub(super) fn serve(
    connection: &Connection,
    offers: Vec<(String, Vec<u8>)>,
) -> Result<Served, String> {
    let (globals, mut queue) = registry_queue_init::<State>(connection)
        .map_err(|error| format!("Wayland registry: {error}"))?;
    let handle = queue.handle();
    let ext_manager = globals
        .bind::<ext::ext_data_control_manager_v1::ExtDataControlManagerV1, _, _>(&handle, 1..=1, ())
        .ok();
    let wlr_manager = globals
        .bind::<wlr::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1, _, _>(
            &handle,
            1..=1,
            (),
        )
        .ok();
    if ext_manager.is_none() && wlr_manager.is_none() {
        return Ok(Served::NoDataControl);
    }
    let seat: wl_seat::WlSeat = globals
        .bind(&handle, 1..=1, ())
        .map_err(|error| format!("Wayland seat: {error}"))?;
    let mime_types: Vec<String> = offers.iter().map(|(mime, _)| mime.clone()).collect();
    let mut state = State {
        offers: Arc::new(offers),
        ended: None,
    };
    // The manager, source and device proxies stay alive for the whole loop.
    let _owned = match (ext_manager, wlr_manager) {
        (Some(manager), _) => Owned::Ext(ext_publish(&manager, &seat, &mime_types, &handle)),
        (None, Some(manager)) => Owned::Wlr(wlr_publish(&manager, &seat, &mime_types, &handle)),
        (None, None) => unreachable!("checked above"),
    };
    while state.ended.is_none() {
        queue
            .blocking_dispatch(&mut state)
            .map_err(|error| format!("Wayland connection: {error}"))?;
    }
    state.ended.unwrap_or(Ok(Served::Replaced))
}

#[allow(dead_code)] // Held, never read: the proxies must outlive the loop.
enum Owned {
    Ext(
        (
            ext::ext_data_control_source_v1::ExtDataControlSourceV1,
            ext::ext_data_control_device_v1::ExtDataControlDeviceV1,
        ),
    ),
    Wlr(
        (
            wlr::zwlr_data_control_source_v1::ZwlrDataControlSourceV1,
            wlr::zwlr_data_control_device_v1::ZwlrDataControlDeviceV1,
        ),
    ),
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
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

impl Dispatch<wl_seat::WlSeat, ()> for State {
    fn event(
        _: &mut Self,
        _: &wl_seat::WlSeat,
        _: wl_seat::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

/// The two data-control protocols are identical apart from their names.
macro_rules! data_control_protocol {
    (
        $publish:ident,
        $manager_mod:ident :: $manager:ident,
        $device_mod:ident :: $device:ident,
        $source_mod:ident :: $source:ident,
        $offer_mod:ident :: $offer:ident,
        $proto:ident
    ) => {
        fn $publish(
            manager: &$proto::$manager_mod::$manager,
            seat: &wl_seat::WlSeat,
            mime_types: &[String],
            handle: &QueueHandle<State>,
        ) -> ($proto::$source_mod::$source, $proto::$device_mod::$device) {
            let source = manager.create_data_source(handle, ());
            for mime_type in mime_types {
                source.offer(mime_type.clone());
            }
            let device = manager.get_data_device(seat, handle, ());
            device.set_selection(Some(&source));
            (source, device)
        }

        impl Dispatch<$proto::$manager_mod::$manager, ()> for State {
            fn event(
                _: &mut Self,
                _: &$proto::$manager_mod::$manager,
                _: $proto::$manager_mod::Event,
                _: &(),
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
            }
        }

        impl Dispatch<$proto::$source_mod::$source, ()> for State {
            fn event(
                state: &mut Self,
                source: &$proto::$source_mod::$source,
                event: $proto::$source_mod::Event,
                _: &(),
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
                match event {
                    $proto::$source_mod::Event::Send { mime_type, fd } => state.send(&mime_type, fd),
                    $proto::$source_mod::Event::Cancelled => {
                        source.destroy();
                        state.ended = Some(Ok(Served::Replaced));
                    }
                    _ => {}
                }
            }
        }

        impl Dispatch<$proto::$device_mod::$device, ()> for State {
            fn event(
                state: &mut Self,
                _: &$proto::$device_mod::$device,
                event: $proto::$device_mod::Event,
                _: &(),
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
                match event {
                    // Every selection change announces an offer; this owner
                    // never reads one.
                    $proto::$device_mod::Event::Selection { id: Some(offer) }
                    | $proto::$device_mod::Event::PrimarySelection { id: Some(offer) } => {
                        offer.destroy();
                    }
                    $proto::$device_mod::Event::Finished => {
                        state.ended = Some(Err("the data-control device was finished".into()));
                    }
                    _ => {}
                }
            }

            event_created_child!(State, $proto::$device_mod::$device, [
                $proto::$device_mod::EVT_DATA_OFFER_OPCODE => ($proto::$offer_mod::$offer, ()),
            ]);
        }

        impl Dispatch<$proto::$offer_mod::$offer, ()> for State {
            fn event(
                _: &mut Self,
                _: &$proto::$offer_mod::$offer,
                _: $proto::$offer_mod::Event,
                _: &(),
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
            }
        }
    };
}

data_control_protocol!(
    ext_publish,
    ext_data_control_manager_v1::ExtDataControlManagerV1,
    ext_data_control_device_v1::ExtDataControlDeviceV1,
    ext_data_control_source_v1::ExtDataControlSourceV1,
    ext_data_control_offer_v1::ExtDataControlOfferV1,
    ext
);

data_control_protocol!(
    wlr_publish,
    zwlr_data_control_manager_v1::ZwlrDataControlManagerV1,
    zwlr_data_control_device_v1::ZwlrDataControlDeviceV1,
    zwlr_data_control_source_v1::ZwlrDataControlSourceV1,
    zwlr_data_control_offer_v1::ZwlrDataControlOfferV1,
    wlr
);

#[cfg(test)]
#[path = "../../../test_support/wayland_data_control_compositor.rs"]
pub(super) mod tests;
