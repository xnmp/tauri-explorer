//! The data-control owner against an in-process Wayland compositor (#927).
//!
//! The compositor speaks the real wire protocol through `wayland-server` and
//! implements just enough of a seat and of both data-control protocols: it
//! records the selection, announces every selection to every data device as
//! a compositor does, asks the selected source for its data through a pipe,
//! and cancels it as another client's selection would.

use super::{serve, Served};
use crate::clipboard::linux::wayland::{FILE_LIST_TYPE, OWNER_TYPE};
use std::io::Read;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};
use wayland_client::Connection;
use wayland_protocols::ext::data_control::v1::server as ext;
use wayland_protocols_wlr::data_control::v1::server as wlr;
use wayland_server::backend::{ClientData, ClientId, DisconnectReason};
use wayland_server::protocol::wl_seat;
use wayland_server::{
    Client, DataInit, Dispatch, Display, DisplayHandle, GlobalDispatch, New, Resource,
};

#[derive(Clone)]
enum Source {
    Ext(ext::ext_data_control_source_v1::ExtDataControlSourceV1),
    Wlr(wlr::zwlr_data_control_source_v1::ZwlrDataControlSourceV1),
}

#[derive(Clone)]
enum Device {
    Ext(ext::ext_data_control_device_v1::ExtDataControlDeviceV1),
    Wlr(wlr::zwlr_data_control_device_v1::ZwlrDataControlDeviceV1),
}

#[derive(Default)]
struct Compositor {
    /// Each source's offered types, by source.
    offered: Vec<(Source, Vec<String>)>,
    devices: Vec<Device>,
    selection: Option<Source>,
    /// Which protocol set the selection.
    protocol: Option<&'static str>,
}

impl Compositor {
    fn mime_types(&self, source: &Source) -> Vec<String> {
        self.offered
            .iter()
            .find(|(offered, _)| same(offered, source))
            .map(|(_, types)| types.clone())
            .unwrap_or_default()
    }

    /// Announce the selection to every data device, as a compositor does.
    fn announce(&self, handle: &DisplayHandle) {
        for device in &self.devices {
            self.announce_to(device, handle);
        }
    }

    /// Announce the selection to `device`. Its offer forwards each paste
    /// request to the selected source.
    fn announce_to(&self, device: &Device, handle: &DisplayHandle) {
        let Some(source) = self.selection.clone() else {
            match device {
                Device::Ext(device) => device.selection(None),
                Device::Wlr(device) => device.selection(None),
            }
            return;
        };
        let types = self.mime_types(&source);
        match device {
            Device::Ext(device) => {
                let Some(client) = device.client() else {
                    return;
                };
                let offer = client
                    .create_resource::<ext::ext_data_control_offer_v1::ExtDataControlOfferV1, _, Self>(
                        handle,
                        device.version(),
                        source,
                    )
                    .unwrap();
                device.data_offer(&offer);
                for mime in &types {
                    offer.offer(mime.clone());
                }
                device.selection(Some(&offer));
            }
            Device::Wlr(device) => {
                let Some(client) = device.client() else {
                    return;
                };
                let offer = client
                    .create_resource::<wlr::zwlr_data_control_offer_v1::ZwlrDataControlOfferV1, _, Self>(
                        handle,
                        device.version(),
                        source,
                    )
                    .unwrap();
                device.data_offer(&offer);
                for mime in &types {
                    offer.offer(mime.clone());
                }
                device.selection(Some(&offer));
            }
        }
    }

    /// Another client takes the selection: the compositor cancels ours.
    fn select(&mut self, source: Option<Source>, handle: &DisplayHandle) {
        if let Some(previous) = self.selection.take() {
            if !source.as_ref().is_some_and(|next| same(next, &previous)) {
                match previous {
                    Source::Ext(source) => source.cancelled(),
                    Source::Wlr(source) => source.cancelled(),
                }
            }
        }
        self.selection = source;
        self.announce(handle);
    }
}

/// Ask `source` for `mime_type`, written to `fd`.
fn request_data(source: &Source, mime_type: String, fd: std::os::fd::BorrowedFd<'_>) {
    match source {
        Source::Ext(source) => source.send(mime_type, fd),
        Source::Wlr(source) => source.send(mime_type, fd),
    }
}

fn same(a: &Source, b: &Source) -> bool {
    match (a, b) {
        (Source::Ext(a), Source::Ext(b)) => a.id() == b.id(),
        (Source::Wlr(a), Source::Wlr(b)) => a.id() == b.id(),
        _ => false,
    }
}

struct NoClientData;

impl ClientData for NoClientData {
    fn initialized(&self, _: ClientId) {}
    fn disconnected(&self, _: ClientId, _: DisconnectReason) {}
}

impl GlobalDispatch<wl_seat::WlSeat, ()> for Compositor {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<wl_seat::WlSeat>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ());
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for Compositor {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &wl_seat::WlSeat,
        _: wl_seat::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}

macro_rules! data_control_server {
    (
        $name:literal,
        $variant:ident,
        $proto:ident,
        $manager_mod:ident :: $manager:ident,
        $device_mod:ident :: $device:ident,
        $source_mod:ident :: $source:ident,
        $offer_mod:ident :: $offer:ident
    ) => {
        impl GlobalDispatch<$proto::$manager_mod::$manager, ()> for Compositor {
            fn bind(
                _: &mut Self,
                _: &DisplayHandle,
                _: &Client,
                resource: New<$proto::$manager_mod::$manager>,
                _: &(),
                init: &mut DataInit<'_, Self>,
            ) {
                init.init(resource, ());
            }
        }

        impl Dispatch<$proto::$manager_mod::$manager, ()> for Compositor {
            fn request(
                state: &mut Self,
                _: &Client,
                _: &$proto::$manager_mod::$manager,
                request: $proto::$manager_mod::Request,
                _: &(),
                handle: &DisplayHandle,
                init: &mut DataInit<'_, Self>,
            ) {
                match request {
                    $proto::$manager_mod::Request::CreateDataSource { id } => {
                        let source = init.init(id, ());
                        state.offered.push((Source::$variant(source), Vec::new()));
                    }
                    $proto::$manager_mod::Request::GetDataDevice { id, .. } => {
                        let device = Device::$variant(init.init(id, ()));
                        state.announce_to(&device, handle);
                        state.devices.push(device);
                    }
                    _ => {}
                }
            }
        }

        impl Dispatch<$proto::$source_mod::$source, ()> for Compositor {
            fn request(
                state: &mut Self,
                _: &Client,
                source: &$proto::$source_mod::$source,
                request: $proto::$source_mod::Request,
                _: &(),
                _: &DisplayHandle,
                _: &mut DataInit<'_, Self>,
            ) {
                if let $proto::$source_mod::Request::Offer { mime_type } = request {
                    let key = Source::$variant(source.clone());
                    if let Some((_, types)) = state
                        .offered
                        .iter_mut()
                        .find(|(offered, _)| same(offered, &key))
                    {
                        types.push(mime_type);
                    }
                }
            }
        }

        impl Dispatch<$proto::$device_mod::$device, ()> for Compositor {
            fn request(
                state: &mut Self,
                _: &Client,
                _: &$proto::$device_mod::$device,
                request: $proto::$device_mod::Request,
                _: &(),
                handle: &DisplayHandle,
                _: &mut DataInit<'_, Self>,
            ) {
                if let $proto::$device_mod::Request::SetSelection { source } = request {
                    state.protocol = Some($name);
                    state.select(source.map(Source::$variant), handle);
                }
            }
        }

        impl Dispatch<$proto::$offer_mod::$offer, Source> for Compositor {
            fn request(
                _: &mut Self,
                _: &Client,
                _: &$proto::$offer_mod::$offer,
                request: $proto::$offer_mod::Request,
                source: &Source,
                _: &DisplayHandle,
                _: &mut DataInit<'_, Self>,
            ) {
                if let $proto::$offer_mod::Request::Receive { mime_type, fd } = request {
                    request_data(source, mime_type, fd.as_fd());
                }
            }
        }
    };
}

data_control_server!(
    "ext",
    Ext,
    ext,
    ext_data_control_manager_v1::ExtDataControlManagerV1,
    ext_data_control_device_v1::ExtDataControlDeviceV1,
    ext_data_control_source_v1::ExtDataControlSourceV1,
    ext_data_control_offer_v1::ExtDataControlOfferV1
);

data_control_server!(
    "wlr",
    Wlr,
    wlr,
    zwlr_data_control_manager_v1::ZwlrDataControlManagerV1,
    zwlr_data_control_device_v1::ZwlrDataControlDeviceV1,
    zwlr_data_control_source_v1::ZwlrDataControlSourceV1,
    zwlr_data_control_offer_v1::ZwlrDataControlOfferV1
);

struct Session {
    display: Display<Compositor>,
    compositor: Compositor,
    owner: std::thread::JoinHandle<Result<Served, String>>,
}

const TOKEN: &str = "0123456789abcdef0123456789abcdef";
const PAYLOAD: &[u8] = b"copy\nfile:///tmp/a%20b.txt";

fn display(ext_global: bool, wlr_global: bool) -> Display<Compositor> {
    let display = Display::<Compositor>::new().unwrap();
    let handle = display.handle();
    handle.create_global::<Compositor, wl_seat::WlSeat, ()>(7, ());
    if ext_global {
        handle.create_global::<Compositor, ext::ext_data_control_manager_v1::ExtDataControlManagerV1, ()>(1, ());
    }
    if wlr_global {
        handle.create_global::<Compositor, wlr::zwlr_data_control_manager_v1::ZwlrDataControlManagerV1, ()>(2, ());
    }
    display
}

/// Start a compositor with the given globals and connect an owner to it.
fn start(ext_global: bool, wlr_global: bool) -> Session {
    let display = display(ext_global, wlr_global);
    let (server_end, client_end) = UnixStream::pair().unwrap();
    display
        .handle()
        .insert_client(server_end, Arc::new(NoClientData))
        .unwrap();
    let owner = std::thread::spawn(move || {
        let connection = Connection::from_socket(client_end).map_err(|e| e.to_string())?;
        serve(
            &connection,
            vec![
                (FILE_LIST_TYPE.to_owned(), PAYLOAD.to_vec()),
                (OWNER_TYPE.to_owned(), TOKEN.as_bytes().to_vec()),
            ],
        )
    });
    Session {
        display,
        compositor: Compositor::default(),
        owner,
    }
}

impl Session {
    /// Run the compositor until `done` holds or the owner thread ends.
    fn pump_until(&mut self, done: impl Fn(&Compositor) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done(&self.compositor) && !self.owner.is_finished() {
            assert!(Instant::now() < deadline, "the compositor never saw it");
            self.display.dispatch_clients(&mut self.compositor).unwrap();
            self.display.flush_clients().unwrap();
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Paste `mime_type` from the selection, as another client would.
    fn paste(&mut self, mime_type: &str) -> Vec<u8> {
        let (mut reader, writer) = std::io::pipe().unwrap();
        let source = self.compositor.selection.as_ref().expect("a selection");
        request_data(source, mime_type.to_owned(), writer.as_fd());
        self.display.flush_clients().unwrap();
        drop(writer);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        bytes
    }

    /// Another client takes the selection: the compositor cancels ours.
    fn replace_selection(mut self) -> Result<Served, String> {
        assert!(self.compositor.selection.is_some());
        self.compositor.select(None, &self.display.handle());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.owner.is_finished() {
            assert!(Instant::now() < deadline, "the owner never exited");
            self.display.dispatch_clients(&mut self.compositor).unwrap();
            self.display.flush_clients().unwrap();
            std::thread::sleep(Duration::from_millis(1));
        }
        self.owner.join().unwrap()
    }
}

fn assert_serves_until_replaced(ext_global: bool, wlr_global: bool, protocol: &str) {
    let mut session = start(ext_global, wlr_global);
    session.pump_until(|compositor| compositor.selection.is_some());
    assert_eq!(session.compositor.protocol, Some(protocol));
    let selection = session.compositor.selection.clone().unwrap();
    assert_eq!(
        session.compositor.mime_types(&selection),
        vec![FILE_LIST_TYPE.to_owned(), OWNER_TYPE.to_owned()],
        "the file list first, so it stays the preferred type"
    );
    assert_eq!(
        session.paste(FILE_LIST_TYPE),
        PAYLOAD,
        "unchanged file list"
    );
    assert_eq!(
        session.paste(OWNER_TYPE),
        TOKEN.as_bytes(),
        "this write's token"
    );
    assert_eq!(session.paste("text/plain"), b"", "nothing else is offered");
    assert!(
        !session.owner.is_finished(),
        "the owner serves until replaced"
    );
    assert_eq!(session.replace_selection(), Ok(Served::Replaced));
}

#[test]
fn the_owner_offers_its_token_beside_the_file_list_until_replaced() {
    assert_serves_until_replaced(true, false, "ext");
    assert_serves_until_replaced(false, true, "wlr");
    // The standard protocol wins where a compositor offers both.
    assert_serves_until_replaced(true, true, "ext");
}

#[test]
fn without_data_control_the_owner_reports_it_and_sets_nothing() {
    let mut session = start(false, false);
    session.pump_until(|_| false);
    assert_eq!(session.owner.join().unwrap(), Ok(Served::NoDataControl));
    assert!(session.compositor.selection.is_none());
}

#[test]
fn the_request_framing_round_trips_and_rejects_malformed_input() {
    let request = super::encode_request(TOKEN, PAYLOAD);
    assert_eq!(
        super::decode_request(&request),
        Some((TOKEN.as_bytes(), PAYLOAD))
    );
    assert_eq!(super::decode_request(b"no newline"), None);
    assert_eq!(super::decode_request(b"\ncopy\nfile:///a"), None);
    assert_eq!(super::decode_request(b"token\n"), None);
}

/// Serve this compositor, with both data-control protocols, on a socket at
/// `path` for the rest of the test process, so real clients (the app's owner
/// process, `wl-paste`, `wl-copy`) can use it. See the real-owner test in
/// `wayland.rs`.
pub(in crate::clipboard::linux) fn serve_on_socket(path: std::path::PathBuf) {
    let socket = wayland_server::ListeningSocket::bind_absolute(path).unwrap();
    std::thread::spawn(move || {
        let mut display = display(true, true);
        let mut compositor = Compositor::default();
        loop {
            while let Some(stream) = socket.accept().unwrap() {
                display
                    .handle()
                    .insert_client(stream, Arc::new(NoClientData))
                    .unwrap();
            }
            display.dispatch_clients(&mut compositor).unwrap();
            display.flush_clients().unwrap();
            std::thread::sleep(Duration::from_millis(1));
        }
    });
}
