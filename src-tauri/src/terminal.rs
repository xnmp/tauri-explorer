//! Embedded terminal backend (issue #139).
//!
//! Spawns the user's shell in a PTY (`portable-pty`: Unix PTY / Windows
//! ConPTY) and streams output to the webview. One registry entry per live
//! terminal; each entry remembers its owning window label so terminals die
//! with their window (see `on_window_destroyed`, called from the run loop).
//!
//! Events (global emit, per-terminal names so windows can't cross-subscribe):
//!   `terminal-output-{id}` — chunk of shell output (String)
//!   `terminal-exit-{id}`   — shell exited (payload: exit code if known)

use crate::error::AppError;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

struct TerminalHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    window_label: String,
}

static TERMINALS: OnceLock<Mutex<HashMap<u64, TerminalHandle>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn terminals() -> &'static Mutex<HashMap<u64, TerminalHandle>> {
    TERMINALS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The user's shell: $SHELL on Unix; COMSPEC (fallback powershell) on Windows.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Drain the longest valid UTF-8 prefix from `pending`, leaving any
/// incomplete trailing multibyte sequence for the next read (so chunk
/// boundaries never corrupt characters). Genuinely invalid bytes are
/// replaced with U+FFFD and skipped rather than kept forever.
fn take_valid_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    let mut start = 0;
    loop {
        match std::str::from_utf8(&pending[start..]) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid_up_to = start + e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[start..valid_up_to]).unwrap());
                match e.error_len() {
                    Some(len) => {
                        // Invalid bytes — replace and continue past them.
                        out.push('\u{FFFD}');
                        start = valid_up_to + len;
                    }
                    None => {
                        // Incomplete trailing sequence — keep it for later.
                        pending.drain(..valid_up_to);
                        return out;
                    }
                }
            }
        }
    }
}

fn spawn_shell(
    window_label: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
) -> Result<u64, AppError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Other(format!("openpty failed: {e}")))?;

    let mut cmd = CommandBuilder::new(default_shell());
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(format!("shell spawn failed: {e}")))?;
    // The slave fd stays open in the child; drop our copy so EOF propagates.
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::Other(format!("pty reader failed: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::Other(format!("pty writer failed: {e}")))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    terminals().lock().unwrap().insert(
        id,
        TerminalHandle {
            writer,
            master: pair.master,
            killer,
            window_label,
        },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_valid_utf8(&mut pending);
                    if !text.is_empty() {
                        on_output(text);
                    }
                }
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code());
        terminals().lock().unwrap().remove(&id);
        on_exit(code);
    });

    Ok(id)
}

/// Kill every terminal owned by `label`. Reader threads observe EOF and
/// remove the registry entries themselves.
pub fn on_window_destroyed(label: &str) {
    let mut map = terminals().lock().unwrap();
    for handle in map.values_mut().filter(|h| h.window_label == label) {
        let _ = handle.killer.kill();
    }
}

// ─── Async Tauri commands ───────────────────────────────────────────────────

/// Spawn the user's shell in a PTY at `cwd`. Returns the terminal id used in
/// the `terminal-output-{id}` / `terminal-exit-{id}` event names.
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    window: tauri::Window,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u64, AppError> {
    let label = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        let out_app = app.clone();
        // The id isn't known until spawn returns, so route through a cell the
        // closures read; spawn_shell only invokes them after registration.
        let id_cell = std::sync::Arc::new(OnceLock::new());
        let out_id = id_cell.clone();
        let exit_id = id_cell.clone();
        let id = spawn_shell(
            label,
            cwd,
            cols.max(2),
            rows.max(2),
            move |chunk| {
                if let Some(id) = out_id.get() {
                    let _ = out_app.emit(&format!("terminal-output-{id}"), chunk);
                }
            },
            move |code| {
                if let Some(id) = exit_id.get() {
                    let _ = app.emit(&format!("terminal-exit-{id}"), code);
                }
            },
        )?;
        let _ = id_cell.set(id);
        Ok(id)
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Write user input (keystrokes) to the terminal.
#[tauri::command]
pub async fn terminal_write(id: u64, data: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let mut map = terminals().lock().unwrap();
        let handle = map
            .get_mut(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| AppError::Other(format!("pty write failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Resize the PTY to match the xterm.js grid.
#[tauri::command]
pub async fn terminal_resize(id: u64, cols: u16, rows: u16) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let map = terminals().lock().unwrap();
        let handle = map
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        handle
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("pty resize failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Kill the terminal's shell. Registry cleanup and the exit event happen in
/// the reader thread when the PTY reaches EOF.
#[tauri::command]
pub async fn terminal_kill(id: u64) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let mut map = terminals().lock().unwrap();
        let handle = map
            .get_mut(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        handle
            .killer
            .kill()
            .map_err(|e| AppError::Other(format!("pty kill failed: {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn utf8_splitter_passes_complete_text_through() {
        let mut pending = "hello".as_bytes().to_vec();
        assert_eq!(take_valid_utf8(&mut pending), "hello");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_splitter_holds_back_incomplete_multibyte_suffix() {
        // "héllo" cut mid-'é' (0xC3 0xA9): first chunk ends after 0xC3.
        let bytes = "héllo".as_bytes();
        let mut pending = bytes[..2].to_vec(); // "h" + first byte of é
        assert_eq!(take_valid_utf8(&mut pending), "h");
        assert_eq!(pending, vec![bytes[1]]); // é's first byte retained

        pending.extend_from_slice(&bytes[2..]);
        assert_eq!(take_valid_utf8(&mut pending), "éllo");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_splitter_replaces_invalid_bytes_instead_of_stalling() {
        let mut pending = vec![b'a', 0xFF, b'b'];
        assert_eq!(take_valid_utf8(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_splitter_handles_empty_input() {
        let mut pending = Vec::new();
        assert_eq!(take_valid_utf8(&mut pending), "");
    }

    /// End-to-end PTY behavior: a real shell spawns in the requested cwd,
    /// echoes what we write, and exits — exercising spawn/write/kill and the
    /// reader thread's registry cleanup. Unix-only in CI terms (Windows CI
    /// covers this path via the e2e-tauri suite).
    #[test]
    #[cfg(unix)]
    fn pty_shell_runs_in_cwd_and_emits_output() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<Option<u32>>();

        let id = spawn_shell(
            "test-window".into(),
            Some(canonical.to_string_lossy().into_owned()),
            80,
            24,
            move |chunk| {
                let _ = tx.send(chunk);
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn failed");

        {
            let mut map = terminals().lock().unwrap();
            let handle = map.get_mut(&id).expect("terminal registered");
            handle.writer.write_all(b"pwd && exit\n").unwrap();
        }

        let mut output = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let exited = loop {
            if let Ok(code) = exit_rx.try_recv() {
                break code;
            }
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) {
                output.push_str(&chunk);
            }
            assert!(std::time::Instant::now() < deadline, "shell never exited; output: {output}");
        };
        while let Ok(chunk) = rx.try_recv() {
            output.push_str(&chunk);
        }

        assert!(
            output.contains(&*canonical.to_string_lossy()),
            "pwd output should contain the spawn cwd; got: {output}"
        );
        assert!(exited.is_some(), "exit code should be reported");
        assert!(
            !terminals().lock().unwrap().contains_key(&id),
            "registry entry should be removed after exit"
        );
    }

    #[test]
    #[cfg(unix)]
    fn on_window_destroyed_kills_only_that_windows_terminals() {
        let (exit_tx_a, exit_rx_a) = mpsc::channel::<Option<u32>>();
        let (exit_tx_b, exit_rx_b) = mpsc::channel::<Option<u32>>();

        let _a = spawn_shell("win-a".into(), None, 80, 24, |_| {}, move |c| {
            let _ = exit_tx_a.send(c);
        })
        .unwrap();
        let b = spawn_shell("win-b".into(), None, 80, 24, |_| {}, move |c| {
            let _ = exit_tx_b.send(c);
        })
        .unwrap();

        on_window_destroyed("win-a");

        // win-a's shell dies…
        assert!(
            exit_rx_a.recv_timeout(Duration::from_secs(10)).is_ok(),
            "window-a terminal should exit after on_window_destroyed"
        );
        // …while win-b's stays alive (no exit within a grace window).
        assert!(
            exit_rx_b.recv_timeout(Duration::from_millis(500)).is_err(),
            "window-b terminal must survive"
        );

        // Cleanup.
        terminals()
            .lock()
            .unwrap()
            .get_mut(&b)
            .map(|h| h.killer.kill());
        let _ = exit_rx_b.recv_timeout(Duration::from_secs(10));
    }
}
