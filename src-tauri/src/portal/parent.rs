//! Native cross-process parenting uses the portal's exported window identifier.
//! GTK calls must run on the main thread, before showing the picker.
use gtk::{
    gdk,
    glib::{prelude::*, translate::*},
    prelude::*,
};

use super::parent_identifier::{parse, Parent};

pub(super) fn attach(
    window: &gtk::ApplicationWindow,
    identifier: &str,
) -> Result<(), &'static str> {
    if identifier.is_empty() {
        return Ok(());
    }
    let parent = parse(identifier).ok_or("invalid parent window identifier")?;
    window.realize();
    let surface = window.window().ok_or("picker has no native surface")?;
    let display = surface.display();
    match parent {
        Parent::Wayland(handle) => {
            // Check the GObject type before passing a GdkWindow to backend-specific FFI.
            let wayland_type = unsafe {
                gtk::glib::Type::from_glib(gdk_wayland_sys::gdk_wayland_window_get_type())
            };
            if !surface.type_().is_a(wayland_type) {
                return Err("parent and picker use different display backends");
            }
            // SAFETY: GTK main thread; live Wayland window and NUL-terminated handle.
            let surface_ptr: *mut gdk::ffi::GdkWindow = surface.to_glib_none().0;
            let accepted = unsafe {
                gdk_wayland_sys::gdk_wayland_window_set_transient_for_exported(
                    surface_ptr as *mut _,
                    handle.as_ptr(),
                )
            };
            if accepted == 0 {
                return Err("compositor could not import parent handle");
            }
        }
        Parent::X11(xid) => {
            let x11_type =
                unsafe { gtk::glib::Type::from_glib(gdk_x11_sys::gdk_x11_display_get_type()) };
            if !display.type_().is_a(x11_type) {
                return Err("parent and picker use different display backends");
            }
            // SAFETY: live X11 display on GTK main thread; GTK validates the foreign XID.
            let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
            let pointer = unsafe {
                gdk_x11_sys::gdk_x11_window_foreign_new_for_display(
                    display_ptr as *mut _,
                    xid.into(),
                )
            };
            if pointer.is_null() {
                return Err("source window no longer exists");
            }
            let foreign: gdk::Window = unsafe { from_glib_full(pointer) };
            surface.set_transient_for(&foreign);
            let bounds = foreign.frame_extents();
            let (width, height) = window.size();
            window.move_(
                bounds.x() + (bounds.width() - width) / 2,
                bounds.y() + (bounds.height() - height) / 2,
            );
        }
    }
    window.set_modal(true);
    window.set_type_hint(gdk::WindowTypeHint::Dialog);
    Ok(())
}
