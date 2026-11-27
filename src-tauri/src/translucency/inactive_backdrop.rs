//! Keep a Windows system backdrop drawn while its window is inactive (#1903).
//!
//! DWM draws Mica and system-backdrop acrylic only on a window whose frame is
//! active, and paints a solid fallback once it deactivates. The frame's state
//! is whatever `DefWindowProc` last handled for `WM_NCACTIVATE`. This subclass
//! lets every handler below it, tao's included, see the real deactivation, so
//! focus events and `Window::is_focused` stay true to the OS. Then it hands
//! `DefWindowProc` an activation directly, which bypasses the subclass chain, so
//! DWM keeps drawing the backdrop. Windows has no documented switch for this.
//! If a build stops honouring the frame state, the window falls back to the
//! stock behaviour (the material while focused, a solid colour otherwise).
//!
//! Explorer windows have no native caption on Windows (`decorations(false)`),
//! so an active frame changes only DWM's border and shadow, which stay in
//! their focused style.
//!
//! tao's `Window::set_theme` (the app's `set_window_theme`, run by every
//! window when the theme changes) redraws the frame by calling `DefWindowProc`
//! for `WM_NCACTIVATE` directly. For an inactive window the last call is a
//! deactivation. That runs inside tao's handler for its registered
//! `Tao::ChangeTheme` message, so the frame is re-activated after that
//! message too. The name is private to tao: if tao renames it, a theme change
//! leaves an inactive window solid until it is next activated, and nothing
//! worse.

use std::sync::OnceLock;

use tauri::{Runtime, Window};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, RegisterWindowMessageW, WM_NCACTIVATE, WM_NCDESTROY,
};

/// Identifies this subclass among the window's others. Ids are scoped per
/// subclass procedure, so any value works; this one names the issue.
const SUBCLASS_ID: usize = 1903;

/// tao's theme-change message (`CHANGE_THEME_MSG_ID` in tao's Windows event
/// loop). Registered window messages are global by name, so registering the
/// same name yields tao's id. `None` if registration failed.
fn tao_change_theme_message() -> Option<u32> {
    static MESSAGE: OnceLock<Option<u32>> = OnceLock::new();
    *MESSAGE.get_or_init(|| {
        // SAFETY: registers a constant, NUL-terminated name.
        let id = unsafe { RegisterWindowMessageW(w!("Tao::ChangeTheme")) };
        (id != 0).then_some(id)
    })
}

/// Installs the subclass on `window`'s native window. Safe to call more than
/// once: `SetWindowSubclass` with the same procedure and id replaces itself.
pub fn keep_backdrop_while_inactive<R: Runtime>(window: &Window<R>) {
    let label = window.label().to_owned();
    let hwnd = match window.hwnd() {
        // `HWND` is not `Send`; carry the raw handle to the UI thread.
        Ok(hwnd) => hwnd.0 as isize,
        Err(error) => {
            log::warn!("Inactive backdrop unavailable for {label}: {error}");
            return;
        }
    };
    // Resolve the message id before any message needs it.
    let _ = tao_change_theme_message();
    // A subclass can only be installed from the thread that owns the window.
    // Already on that thread (setup, page-load hooks), this runs at once.
    let installed = window.run_on_main_thread(move || {
        let hwnd = HWND(hwnd as *mut _);
        // SAFETY: `hwnd` is a live top-level window owned by this (the UI)
        // thread; the procedure is a `'static` fn with no reference data.
        let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) };
        if !ok.as_bool() {
            log::warn!("Inactive backdrop: SetWindowSubclass failed for {label}");
        }
    });
    if let Err(error) = installed {
        log::warn!("Inactive backdrop: could not reach the UI thread: {error}");
    }
}

/// Lets the rest of the chain handle `msg`, then marks the frame active for
/// DWM without telling the chain.
///
/// # Safety
/// Must be called from a subclass procedure, with the message it received.
unsafe fn forward_then_activate_frame(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: forwarding the message this procedure received.
    let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    // SAFETY: `hwnd` is the live window this message was sent to.
    unsafe { DefWindowProcW(hwnd, WM_NCACTIVATE, WPARAM(1), LPARAM(0)) };
    result
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        // SAFETY (all arms): forwarding the message this procedure received.
        WM_NCACTIVATE if wparam.0 == 0 => unsafe {
            forward_then_activate_frame(hwnd, msg, wparam, lparam)
        },
        _ if Some(msg) == tao_change_theme_message() => unsafe {
            forward_then_activate_frame(hwnd, msg, wparam, lparam)
        },
        WM_NCDESTROY => unsafe {
            // Removing this procedure's own subclass while its window is
            // destroyed, as `SetWindowSubclass`'s documentation requires.
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        },
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
}
