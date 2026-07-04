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
//!   `terminal-cwd-{id}`    — shell reported a new cwd via OSC 7 (String path)
//!
//! cwd sync (issue #149): the reader thread scans output for OSC 7 escape
//! sequences (`ESC ] 7 ; file://host/path ST`) — the de-facto way shells report
//! their working directory — and both remembers the path on the registry entry
//! and emits it so the explorer can follow the shell. The reverse direction
//! (terminal follows explorer) needs to know whether a foreground command is
//! running before injecting a `cd`; `terminal_status` answers that.

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
    /// The spawned shell's pid; used for foreground-process-group busy
    /// detection. `None` if portable-pty couldn't report it.
    pid: Option<u32>,
    /// Last cwd the shell reported via OSC 7 (updated from the reader thread).
    shell_cwd: Option<String>,
}

/// A cwd-sync status snapshot for one terminal (issue #149).
#[derive(serde::Serialize)]
pub struct TerminalStatus {
    /// True when a foreground command is running (so injecting `cd` would
    /// clobber it). Always false on Windows (optimistic — see `is_busy`).
    busy: bool,
    /// Last cwd the shell reported via OSC 7, if any.
    cwd: Option<String>,
}

// ─── OSC 7 cwd parsing ───────────────────────────────────────────────────────

const OSC7_PREFIX: &str = "\x1b]7;";
/// Cap on the carried-over unterminated OSC 7 fragment, so a stream that opens
/// an OSC 7 and never closes it can't grow the carry buffer without bound.
const OSC7_MAX_CARRY: usize = 4096;

/// Stateful scanner that extracts cwd paths from OSC 7 sequences
/// (`ESC ] 7 ; file://<host><path>` terminated by BEL or ST) across arbitrary
/// chunk boundaries. Output is never consumed or altered — the scanner only
/// observes it; xterm ignores OSC 7 natively. Pure and unit-tested.
struct Osc7Scanner {
    /// Tail of the previous chunk that may be the start of, or an in-progress,
    /// OSC 7 sequence. Bounded by `OSC7_MAX_CARRY`.
    carry: String,
}

impl Osc7Scanner {
    fn new() -> Self {
        Self { carry: String::new() }
    }

    /// Feed a decoded text chunk; returns any complete cwd paths found.
    fn push(&mut self, chunk: &str) -> Vec<String> {
        let mut buf = std::mem::take(&mut self.carry);
        buf.push_str(chunk);
        let mut out = Vec::new();

        loop {
            let Some(start) = buf.find(OSC7_PREFIX) else {
                // No complete prefix. Keep only a trailing partial prefix
                // ("\x1b", "\x1b]", "\x1b]7") so a prefix split across the
                // boundary still matches next time; drop everything else.
                let keep = partial_prefix_len(&buf);
                self.carry = buf.split_off(buf.len() - keep);
                return out;
            };
            let after = start + OSC7_PREFIX.len();
            match find_osc_terminator(&buf[after..]) {
                Some((rel_end, term_len)) => {
                    let payload = &buf[after..after + rel_end];
                    if let Some(path) = parse_osc7_payload(payload) {
                        out.push(path);
                    }
                    buf = buf.split_off(after + rel_end + term_len);
                    // continue scanning the remainder
                }
                None => {
                    // Unterminated sequence: carry from its start, bounded.
                    let tail = &buf[start..];
                    self.carry = if tail.len() > OSC7_MAX_CARRY {
                        String::new()
                    } else {
                        tail.to_string()
                    };
                    return out;
                }
            }
        }
    }
}

/// Length of the longest suffix of `buf` that is a proper (non-empty) prefix of
/// the OSC 7 introducer, i.e. a prefix that got cut by a chunk boundary.
fn partial_prefix_len(buf: &str) -> usize {
    for k in (1..OSC7_PREFIX.len()).rev() {
        if buf.ends_with(&OSC7_PREFIX[..k]) {
            return k;
        }
    }
    0
}

/// Find the OSC string terminator in `rest`: BEL (`\x07`, len 1) or ST
/// (`ESC \`, len 2). Returns `(byte_index, terminator_len)`. `None` if no
/// complete terminator is present yet (including a trailing lone ESC that may
/// become an ST). BEL/ESC are ASCII, so byte indices land on char boundaries.
fn find_osc_terminator(rest: &str) -> Option<(usize, usize)> {
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x07 => return Some((i, 1)),
            0x1b => {
                return match bytes.get(i + 1) {
                    Some(b'\\') => Some((i, 2)),
                    // Lone trailing ESC — could still become ST next chunk.
                    None => None,
                    // ESC followed by anything else isn't a valid ST; skip it.
                    Some(_) => {
                        i += 1;
                        continue;
                    }
                };
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parse an OSC 7 payload (`file://<host><path>`) into a decoded path. The host
/// part is ignored; the path is percent-decoded.
fn parse_osc7_payload(payload: &str) -> Option<String> {
    let rest = payload.strip_prefix("file://")?;
    // The path begins at the first '/' after the (possibly empty) host.
    let slash = rest.find('/')?;
    Some(percent_decode(&rest[slash..]))
}

/// Percent-decode a URI path, interpreting decoded bytes as UTF-8 (lossy).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
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

/// The four zsh startup-file shims (issue #149). zsh loads `.zshenv`,
/// `.zprofile`, `.zshrc`, `.zlogin` from `$ZDOTDIR`; pointing `ZDOTDIR` at a
/// shim dir lets us inject an OSC 7 cwd-reporting hook while still sourcing the
/// user's real startup files. Mirrors VS Code's zsh shell-integration layout:
/// each shim temporarily restores the user's `ZDOTDIR`, sources the matching
/// user file, then restores the shim dir so the remaining shims still run.
/// Pure (no paths baked in — the dirs come from env vars) so it is unit-tested.
#[cfg(unix)]
fn zsh_shim_files() -> [(&'static str, String); 4] {
    // Shared preamble: source the user's equivalent startup file (if any) with
    // ZDOTDIR pointed at their real dir, then restore the shim dir.
    let source = |user_file: &str| -> String {
        format!(
            "# tauri-explorer zsh shell integration (issue #149) — do not edit.\n\
             USER_ZDOTDIR=\"${{_TE_ORIG_ZDOTDIR:-$HOME}}\"\n\
             if [[ -f \"$USER_ZDOTDIR/{user_file}\" ]]; then\n\
             \x20 ZDOTDIR=\"$USER_ZDOTDIR\"\n\
             \x20 source \"$USER_ZDOTDIR/{user_file}\"\n\
             fi\n\
             ZDOTDIR=\"${{_TE_SHIM_ZDOTDIR:-$ZDOTDIR}}\"\n"
        )
    };
    let mut zshrc = source(".zshrc");
    zshrc.push_str(
        "\n# Report cwd via OSC 7 so the file explorer can follow the shell.\n\
         _tauri_explorer_osc7() { printf '\\033]7;file://%s%s\\033\\\\' \"${HOST}\" \"${PWD}\" }\n\
         autoload -Uz add-zsh-hook 2>/dev/null && { add-zsh-hook chpwd _tauri_explorer_osc7; _tauri_explorer_osc7 }\n",
    );
    [
        (".zshenv", source(".zshenv")),
        (".zprofile", source(".zprofile")),
        (".zshrc", zshrc),
        (".zlogin", source(".zlogin")),
    ]
}

/// Best-effort: install the zsh OSC 7 shim and point the shell at it. Any
/// failure degrades gracefully to spawning without cwd reporting.
#[cfg(unix)]
fn install_zsh_shim(cmd: &mut CommandBuilder) {
    let Some(cache) = dirs::cache_dir() else { return };
    let shim = cache.join("tauri-explorer").join("zsh-shim");
    // Recreate fresh each spawn so a stale/edited shim can't linger.
    let _ = std::fs::remove_dir_all(&shim);
    if let Err(e) = std::fs::create_dir_all(&shim) {
        log::warn!("zsh OSC 7 shim: create_dir_all failed: {e}");
        return;
    }
    for (name, body) in zsh_shim_files() {
        if let Err(e) = std::fs::write(shim.join(name), body) {
            log::warn!("zsh OSC 7 shim: write {name} failed: {e}");
            return;
        }
    }
    if let Ok(orig) = std::env::var("ZDOTDIR") {
        cmd.env("_TE_ORIG_ZDOTDIR", orig);
    }
    let shim = shim.to_string_lossy().into_owned();
    cmd.env("_TE_SHIM_ZDOTDIR", &shim);
    cmd.env("ZDOTDIR", &shim);
}

/// Whether a foreground command is running: on Unix, the PTY's foreground
/// process group differs from the shell's own pid. Windows has no equivalent
/// tty semantics, so we optimistically report idle (an injected `cd` there
/// runs after the current line at worst).
#[allow(unused_variables)]
fn is_busy(handle: &TerminalHandle) -> bool {
    #[cfg(unix)]
    {
        let (Some(fd), Some(pid)) = (handle.master.as_raw_fd(), handle.pid) else {
            return false;
        };
        let fg = unsafe { libc::tcgetpgrp(fd) };
        // fg < 0 ⇒ no controlling terminal / error; treat as idle.
        fg >= 0 && fg as u32 != pid
    }
    #[cfg(windows)]
    {
        false
    }
}

fn spawn_shell(
    window_label: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    on_cwd: impl Fn(String) + Send + 'static,
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

    let shell = default_shell();
    let shell_basename = std::path::Path::new(&shell)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(dir);
    }
    // zsh doesn't emit OSC 7 by default — install a shim that does. bash's
    // PROMPT_COMMAND fallback is unreliable (a user bashrc routinely overwrites
    // it), so it's skipped for now; fish emits OSC 7 natively.
    #[cfg(unix)]
    if shell_basename == "zsh" {
        install_zsh_shim(&mut cmd);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(format!("shell spawn failed: {e}")))?;
    // The slave fd stays open in the child; drop our copy so EOF propagates.
    drop(pair.slave);

    let pid = child.process_id();
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
    terminals()
        .lock()
        .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?
        .insert(
        id,
        TerminalHandle {
            writer,
            master: pair.master,
            killer,
            window_label,
            pid,
            shell_cwd: None,
        },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut scanner = Osc7Scanner::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_valid_utf8(&mut pending);
                    if !text.is_empty() {
                        // Observe OSC 7 cwd reports before forwarding output;
                        // output itself is passed through unchanged.
                        for cwd in scanner.push(&text) {
                            // Reader thread (returns ()): recover the registry
                            // rather than panic if another holder poisoned it.
                            if let Some(h) =
                                terminals().lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id)
                            {
                                h.shell_cwd = Some(cwd.clone());
                            }
                            on_cwd(cwd);
                        }
                        on_output(text);
                    }
                }
            }
        }
        let code = child.wait().ok().map(|status| status.exit_code());
        terminals().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        on_exit(code);
    });

    Ok(id)
}

/// Kill every terminal owned by `label`. Reader threads observe EOF and
/// remove the registry entries themselves.
pub fn on_window_destroyed(label: &str) {
    // Returns (): recover the registry rather than panic on a poisoned lock.
    let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
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
        let cwd_id = id_cell.clone();
        let cwd_app = app.clone();
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
            move |path| {
                if let Some(id) = cwd_id.get() {
                    let _ = cwd_app.emit(&format!("terminal-cwd-{id}"), path);
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
        let mut map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
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
        let map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
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
        let mut map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
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

/// Report whether a foreground command is running and the shell's last-known
/// cwd (issue #149). The frontend uses `busy` to decide between injecting a
/// `cd` now or queuing it, and `cwd` to skip redundant cd's (loop guard).
#[tauri::command]
pub async fn terminal_status(id: u64) -> Result<TerminalStatus, AppError> {
    tokio::task::spawn_blocking(move || {
        let map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
        let handle = map
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        Ok(TerminalStatus {
            busy: is_busy(handle),
            cwd: handle.shell_cwd.clone(),
        })
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
            |_| {},
        )
        .expect("spawn failed");

        {
            let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
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
            !terminals().lock().unwrap_or_else(|e| e.into_inner()).contains_key(&id),
            "registry entry should be removed after exit"
        );
    }

    #[test]
    #[cfg(unix)]
    fn on_window_destroyed_kills_only_that_windows_terminals() {
        let (exit_tx_a, exit_rx_a) = mpsc::channel::<Option<u32>>();
        let (exit_tx_b, exit_rx_b) = mpsc::channel::<Option<u32>>();

        let _a = spawn_shell(
            "win-a".into(),
            None,
            80,
            24,
            |_| {},
            move |c| {
                let _ = exit_tx_a.send(c);
            },
            |_| {},
        )
        .unwrap();
        let b = spawn_shell(
            "win-b".into(),
            None,
            80,
            24,
            |_| {},
            move |c| {
                let _ = exit_tx_b.send(c);
            },
            |_| {},
        )
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

    // ─── OSC 7 scanner ───────────────────────────────────────────────────────

    /// Build an OSC 7 sequence for `path` with the given terminator.
    fn osc7(path: &str, term: &str) -> String {
        format!("\x1b]7;file://host{path}{term}")
    }

    #[test]
    fn osc7_parses_complete_sequence_with_bel() {
        let mut s = Osc7Scanner::new();
        assert_eq!(s.push(&osc7("/home/user", "\x07")), vec!["/home/user"]);
        assert!(s.carry.is_empty());
    }

    #[test]
    fn osc7_parses_complete_sequence_with_st() {
        let mut s = Osc7Scanner::new();
        assert_eq!(s.push(&osc7("/var/log", "\x1b\\")), vec!["/var/log"]);
    }

    #[test]
    fn osc7_percent_decodes_path() {
        let mut s = Osc7Scanner::new();
        // "/my dir/café" → spaces and UTF-8 percent-encoded.
        let seq = osc7("/my%20dir/caf%C3%A9", "\x07");
        assert_eq!(s.push(&seq), vec!["/my dir/café"]);
    }

    #[test]
    fn osc7_ignores_host_part() {
        let mut s = Osc7Scanner::new();
        // Empty host (file:///path) and named host both yield the same path.
        assert_eq!(s.push("\x1b]7;file:///tmp\x07"), vec!["/tmp"]);
        assert_eq!(s.push("\x1b]7;file://myhost/tmp\x07"), vec!["/tmp"]);
    }

    #[test]
    fn osc7_handles_split_at_every_internal_boundary() {
        let seq = osc7("/home/user/project", "\x1b\\");
        for cut in 1..seq.len() {
            // Only split on char boundaries (the sequence is ASCII here).
            if !seq.is_char_boundary(cut) {
                continue;
            }
            let mut s = Osc7Scanner::new();
            let mut got = s.push(&seq[..cut]);
            got.extend(s.push(&seq[cut..]));
            assert_eq!(got, vec!["/home/user/project"], "split at byte {cut}");
        }
    }

    #[test]
    fn osc7_extracts_multiple_sequences_in_one_chunk() {
        let mut s = Osc7Scanner::new();
        let chunk = format!("{}{}", osc7("/a", "\x07"), osc7("/b", "\x1b\\"));
        assert_eq!(s.push(&chunk), vec!["/a", "/b"]);
    }

    #[test]
    fn osc7_preserves_interleaved_normal_output() {
        let mut s = Osc7Scanner::new();
        // Normal text around and between sequences must not corrupt parsing,
        // and text-only chunks yield nothing.
        assert_eq!(s.push("hello world\n"), Vec::<String>::new());
        let chunk = format!("prompt$ {}output line\n", osc7("/work", "\x07"));
        assert_eq!(s.push(&chunk), vec!["/work"]);
    }

    #[test]
    fn osc7_oversized_unterminated_carry_does_not_stall() {
        let mut s = Osc7Scanner::new();
        // An OSC 7 that opens but never terminates, longer than the carry cap:
        // the carry must be dropped rather than grow forever.
        let garbage = format!("\x1b]7;file://host/{}", "x".repeat(OSC7_MAX_CARRY + 100));
        assert_eq!(s.push(&garbage), Vec::<String>::new());
        assert!(s.carry.is_empty(), "oversized carry should be discarded");
        // The scanner still works afterwards.
        assert_eq!(s.push(&osc7("/recovered", "\x07")), vec!["/recovered"]);
    }

    #[test]
    fn osc7_unterminated_within_cap_is_carried_and_completed_later() {
        let mut s = Osc7Scanner::new();
        assert_eq!(s.push("\x1b]7;file://host/partial"), Vec::<String>::new());
        assert!(!s.carry.is_empty());
        assert_eq!(s.push("/more\x07"), vec!["/partial/more"]);
    }

    // ─── zsh shim contents ───────────────────────────────────────────────────

    #[test]
    #[cfg(unix)]
    fn zsh_shim_files_cover_all_startup_files_and_emit_osc7() {
        let files = zsh_shim_files();
        let names: Vec<&str> = files.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, [".zshenv", ".zprofile", ".zshrc", ".zlogin"]);

        for (name, body) in &files {
            // Each shim sources the user's equivalent and restores the shim dir.
            assert!(body.contains(&format!("$USER_ZDOTDIR/{name}")), "{name} sources user file");
            assert!(body.contains("_TE_SHIM_ZDOTDIR"), "{name} restores shim dir");
        }

        let zshrc = &files[2].1;
        assert!(zshrc.contains("_tauri_explorer_osc7"), "zshrc adds the OSC 7 hook");
        assert!(zshrc.contains("add-zsh-hook chpwd"), "zshrc registers a chpwd hook");
        assert!(zshrc.contains("file://"), "zshrc emits an OSC 7 file:// sequence");
    }

    // ─── busy detection ──────────────────────────────────────────────────────

    /// A real shell reports idle at its prompt, busy while a foreground command
    /// runs, then idle again once it finishes — the signal `terminal_status`
    /// exposes for queued-cd logic.
    #[test]
    #[cfg(unix)]
    fn busy_detection_tracks_foreground_command() {
        let (exit_tx, _exit_rx) = mpsc::channel::<Option<u32>>();
        let id = spawn_shell("busy-test".into(), None, 80, 24, |_| {}, move |c| {
            let _ = exit_tx.send(c);
        }, |_| {})
        .expect("spawn failed");

        let busy_now = || {
            let map = terminals().lock().unwrap_or_else(|e| e.into_inner());
            is_busy(map.get(&id).expect("registered"))
        };

        // Let the shell reach its prompt.
        let idle_deadline = std::time::Instant::now() + Duration::from_secs(5);
        while busy_now() {
            assert!(std::time::Instant::now() < idle_deadline, "shell never became idle");
            std::thread::sleep(Duration::from_millis(50));
        }

        // Start a foreground command.
        {
            let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
            map.get_mut(&id).unwrap().writer.write_all(b"sleep 2\n").unwrap();
        }

        // Poll until busy is observed.
        let busy_deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if busy_now() {
                break;
            }
            assert!(std::time::Instant::now() < busy_deadline, "sleep never registered as busy");
            std::thread::sleep(Duration::from_millis(20));
        }

        // …and idle again after it finishes.
        let done_deadline = std::time::Instant::now() + Duration::from_secs(6);
        while busy_now() {
            assert!(std::time::Instant::now() < done_deadline, "shell stayed busy after sleep");
            std::thread::sleep(Duration::from_millis(50));
        }

        terminals().lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id).map(|h| h.killer.kill());
    }

    /// If `zsh` is installed, spawning through `spawn_shell` should produce an
    /// OSC 7 sequence in output within a short window (the shim's startup hook).
    #[test]
    #[cfg(unix)]
    fn zsh_shim_emits_osc7_on_startup() {
        // Skip when zsh isn't available on the test machine.
        let has_zsh = std::process::Command::new("which")
            .arg("zsh")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_zsh {
            eprintln!("skipping zsh_shim_emits_osc7_on_startup: zsh not installed");
            return;
        }

        // Force the shell to zsh for this spawn regardless of $SHELL.
        let prev_shell = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", "zsh");

        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        let (tx, rx) = mpsc::channel::<String>();
        let (cwd_tx, cwd_rx) = mpsc::channel::<String>();
        let id = spawn_shell(
            "zsh-osc7".into(),
            Some(canonical.to_string_lossy().into_owned()),
            80,
            24,
            move |chunk| {
                let _ = tx.send(chunk);
            },
            |_| {},
            move |path| {
                let _ = cwd_tx.send(path);
            },
        )
        .expect("spawn failed");

        // Restore SHELL so we don't leak state to other tests.
        match prev_shell {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }

        let got_cwd = cwd_rx.recv_timeout(Duration::from_secs(8));
        // Drain any output for diagnostics.
        let mut output = String::new();
        while let Ok(chunk) = rx.try_recv() {
            output.push_str(&chunk);
        }
        terminals().lock().unwrap_or_else(|e| e.into_inner()).get_mut(&id).map(|h| h.killer.kill());

        assert!(
            got_cwd.is_ok(),
            "expected an OSC 7 cwd event from zsh startup; output: {output}"
        );
    }
}
