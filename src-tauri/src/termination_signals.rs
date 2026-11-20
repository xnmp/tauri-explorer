//! Orderly exit on SIGTERM, SIGINT and SIGHUP (#1686).
//!
//! Their default action ends the process with no cleanup, which the session
//! marker would report as an unclean exit, although each is a request to
//! stop: `kill`, `systemctl stop`, a terminal closing, logout's SIGTERM.
//! On the first one the marker is removed at once (the stop was requested,
//! whatever happens next) and the app is asked to exit normally. If that
//! has not finished after `GRACE`, or a second signal arrives, the signal's
//! default action ends the process as it always did.

use std::time::Duration;
use tokio::signal::unix::{signal, Signal, SignalKind};

const GRACE: Duration = Duration::from_secs(5);

fn restore_default_and_raise(signo: i32) -> ! {
    unsafe {
        libc::signal(signo, libc::SIG_DFL);
        libc::raise(signo);
    }
    // Unreachable for these signals; exit as a shell would report them.
    std::process::exit(128 + signo)
}

/// Listen for the three signals. Registration completes before this returns,
/// so a signal sent afterwards is never handled by the default action.
/// `request_exit` starts the orderly exit (`AppHandle::exit` in the app).
pub(crate) fn install(request_exit: impl Fn() + Send + 'static) -> std::io::Result<()> {
    let register = |kind: SignalKind, signo: i32| -> std::io::Result<(Signal, i32)> {
        Ok((signal(kind)?, signo))
    };
    // Registration needs the runtime's signal driver, not an async context.
    let runtime = tauri::async_runtime::handle();
    let mut streams = {
        let _context = runtime.inner().enter();
        [
            register(SignalKind::terminate(), libc::SIGTERM)?,
            register(SignalKind::interrupt(), libc::SIGINT)?,
            register(SignalKind::hangup(), libc::SIGHUP)?,
        ]
    };
    tauri::async_runtime::spawn(async move {
        let mut requested = false;
        loop {
            let [(term, term_no), (int, int_no), (hup, hup_no)] = &mut streams;
            let signo = tokio::select! {
                _ = term.recv() => *term_no,
                _ = int.recv() => *int_no,
                _ = hup.recv() => *hup_no,
            };
            if requested {
                restore_default_and_raise(signo);
            }
            requested = true;
            log::info!("Exit(signal): {signo}; exiting in an orderly way");
            crate::session_marker::disarm();
            request_exit();
            let _ = std::thread::Builder::new()
                .name("exit-deadline".into())
                .spawn(move || {
                    std::thread::sleep(GRACE);
                    restore_default_and_raise(signo);
                });
        }
    });
    Ok(())
}
