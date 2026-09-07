//! Embedded terminal backend (issue #139).
//!
//! Spawns the user's shell in a PTY (`portable-pty`: Unix PTY / Windows
//! ConPTY) and streams output to the webview. One registry entry per live
//! terminal; each entry remembers its owning window label so terminals die
//! with their window (see `on_window_destroyed`, called from the run loop).
//!
//! Events (targeted to the owning window and named per terminal):
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
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;

struct TerminalHandle {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: SharedMaster,
    child: SharedChild,
    /// The spawned shell's pid; used for foreground-process-group busy
    /// detection. `None` if portable-pty couldn't report it.
    pid: Option<u32>,
    /// Last cwd the shell reported via OSC 7 (updated from the reader thread).
    shell_cwd: Option<String>,
}

/// Reservation, startup, and the running PTY share one window-owned identity.
/// A cancelled startup can finish preparing a PTY, but cannot publish it.
struct TerminalSlot {
    window_label: String,
    token: Arc<AtomicBool>,
    phase: TerminalPhase,
}

enum TerminalPhase {
    Reserved,
    Starting,
    Running(TerminalHandle),
}

impl TerminalSlot {
    fn reserved(window_label: String) -> Self {
        Self {
            window_label,
            token: Arc::new(AtomicBool::new(false)),
            phase: TerminalPhase::Reserved,
        }
    }

    fn check_owner(&self, label: &str) -> Result<(), AppError> {
        if self.window_label != label {
            return Err(AppError::Other("Terminal belongs to another window".into()));
        }
        Ok(())
    }

    fn begin(&mut self, label: &str) -> Result<Arc<AtomicBool>, AppError> {
        self.check_owner(label)?;
        if !matches!(self.phase, TerminalPhase::Reserved) {
            return Err(AppError::Other("Terminal has already been started".into()));
        }
        self.phase = TerminalPhase::Starting;
        Ok(self.token.clone())
    }

    fn is_current(&self, token: &Arc<AtomicBool>) -> bool {
        Arc::ptr_eq(&self.token, token) && !token.load(Ordering::Relaxed)
    }
}

/// What `terminal_spawn` actually started (#409): the frontend must speak the
/// spawned shell's dialect — cd syntax, clear-line byte, and path style all
/// differ between cmd/PowerShell and a (possibly WSL) POSIX shell.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnInfo {
    id: u64,
    /// "posix" | "cmd" | "powershell"
    shell_kind: String,
    /// Set when the shell is `wsl.exe` into this distro (#378): the shell
    /// speaks Linux paths that map to `\\wsl.localhost\<distro>\…`.
    wsl_distro: Option<String>,
}

/// Classify a shell executable path into the dialect family the frontend
/// needs ("cmd" | "powershell" | "posix").
fn classify_shell(shell: &str) -> &'static str {
    // Split on both separators by hand: std::path::Path only understands the
    // host platform's separator, and this must classify Windows paths in
    // platform-independent unit tests too.
    let file = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let base = file
        .strip_suffix(".exe")
        .or_else(|| file.strip_suffix(".EXE"))
        .unwrap_or(file)
        .to_lowercase();
    match base.as_str() {
        "cmd" => "cmd",
        "powershell" | "pwsh" => "powershell",
        _ => "posix",
    }
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
        Self {
            carry: String::new(),
        }
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
                OscTerm::Terminated { end, len } => {
                    let payload = &buf[after..after + end];
                    if let Some(path) = parse_osc7_payload(payload) {
                        out.push(path);
                    }
                    buf = buf.split_off(after + end + len);
                    // continue scanning the remainder
                }
                OscTerm::Restart { at } => {
                    // A fresh `ESC ]` (new OSC introducer) arrived before this
                    // sequence terminated. Treat it as an implicit terminator:
                    // discard the abandoned fragment and resume scanning at the
                    // new introducer, so a later complete OSC 7 still wins.
                    buf = buf.split_off(after + at);
                    // continue scanning from the new introducer
                }
                OscTerm::Incomplete => {
                    // Unterminated sequence: carry from its start, bounded
                    // per-sequence so one runaway OSC 7 can't grow memory.
                    let tail = &buf[start..];
                    if tail.len() > OSC7_MAX_CARRY {
                        log::warn!(
                            "OSC 7: dropping unterminated sequence exceeding {OSC7_MAX_CARRY}-byte carry cap"
                        );
                        self.carry = String::new();
                    } else {
                        self.carry = tail.to_string();
                    }
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

/// Outcome of scanning an OSC 7 payload region for its end.
enum OscTerm {
    /// A real string terminator (BEL or ST) ends the payload at byte `end`,
    /// occupying `len` bytes (1 for BEL, 2 for ST).
    Terminated { end: usize, len: usize },
    /// A fresh OSC introducer (`ESC ]`) began at byte `at` before any
    /// terminator — the current sequence is abandoned; resume scanning there.
    Restart { at: usize },
    /// No terminator (or restart) present yet; carry for the next chunk.
    Incomplete,
}

/// Find where the OSC 7 payload in `rest` ends: a BEL (`\x07`, len 1) or ST
/// (`ESC \`, len 2) terminator, or a fresh OSC introducer (`ESC ]`) that
/// implicitly abandons this sequence. `Incomplete` if none is present yet
/// (including a trailing lone ESC that may become an ST next chunk). BEL/ESC
/// are ASCII, so byte indices land on char boundaries.
fn find_osc_terminator(rest: &str) -> OscTerm {
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x07 => return OscTerm::Terminated { end: i, len: 1 },
            0x1b => {
                return match bytes.get(i + 1) {
                    Some(b'\\') => OscTerm::Terminated { end: i, len: 2 },
                    // A new OSC starts here (`ESC ]`): implicit terminator.
                    Some(b']') => OscTerm::Restart { at: i },
                    // Lone trailing ESC — could still become ST next chunk.
                    None => OscTerm::Incomplete,
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
    OscTerm::Incomplete
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

static TERMINALS: OnceLock<Mutex<HashMap<u64, TerminalSlot>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn terminals() -> &'static Mutex<HashMap<u64, TerminalSlot>> {
    TERMINALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_terminal(window_label: &str) -> Result<u64, AppError> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    terminals()
        .lock()
        .map_err(|error| AppError::Other(format!("terminals registry lock poisoned: {error}")))?
        .insert(id, TerminalSlot::reserved(window_label.to_owned()));
    Ok(id)
}

fn begin_terminal(id: u64, window_label: &str) -> Result<Arc<AtomicBool>, AppError> {
    terminals()
        .lock()
        .map_err(|error| AppError::Other(format!("terminals registry lock poisoned: {error}")))?
        .get_mut(&id)
        .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?
        .begin(window_label)
}

fn remove_if_token(id: u64, token: &Arc<AtomicBool>) {
    let mut map = terminals()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if map
        .get(&id)
        .is_some_and(|slot| Arc::ptr_eq(&slot.token, token))
    {
        map.remove(&id);
    }
}

type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

fn terminate_child(child: &mut dyn Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let Some(pid) = child.process_id() else {
            return child.kill();
        };
        let _ = child.try_wait()?;
        let signal_group = |signal| {
            let result = unsafe { libc::kill(-(pid as i32), signal) };
            if result == 0 {
                Ok(())
            } else {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        };
        signal_group(libc::SIGHUP)?;
        for _ in 0..5 {
            if child.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        signal_group(libc::SIGKILL)
    }
    #[cfg(not(unix))]
    {
        child.kill()
    }
}

fn kill_child(child: &SharedChild) -> std::io::Result<()> {
    let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
    terminate_child(child.as_mut())
}

fn wait_for_child(child: &SharedChild) -> Option<portable_pty::ExitStatus> {
    loop {
        let status = child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .try_wait();
        match status {
            Ok(Some(status)) => return Some(status),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

#[cfg(unix)]
fn wait_pty_readable(master: &SharedMaster, timeout_ms: i32) -> std::io::Result<bool> {
    // The reader's Arc keeps this stable master (and its fd) alive. Only the
    // descriptor lookup needs the mutex: holding it during poll can starve
    // status/resize indefinitely as the idle reader repeatedly reacquires it.
    let fd = {
        let master = master.lock().unwrap_or_else(|error| error.into_inner());
        master
            .as_raw_fd()
            .ok_or_else(|| std::io::Error::other("PTY master has no file descriptor"))?
    };
    let mut poll_fd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
    if result < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(result > 0)
    }
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
    let Some(cache) = dirs::cache_dir() else {
        return;
    };
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
fn is_busy(master: &dyn MasterPty, pid: Option<u32>) -> bool {
    #[cfg(unix)]
    {
        let (Some(fd), Some(pid)) = (master.as_raw_fd(), pid) else {
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

use crate::wsl::parse_wsl_unc;

#[allow(clippy::too_many_arguments)] // three of these are the event callbacks
fn spawn_shell(
    id: u64,
    window_label: String,
    token: Arc<AtomicBool>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    on_cwd: impl Fn(String) + Send + 'static,
) -> Result<TerminalSpawnInfo, AppError> {
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
    // Windows + WSL folder (#378): cmd.exe refuses a UNC working directory
    // (falls back to C:\Windows) and PowerShell lands in ~, so a pane inside
    // \\wsl$\… gets a wsl.exe shell started in the equivalent Linux path
    // instead of the default shell.
    let wsl_target = if cfg!(windows) {
        cwd.as_deref().and_then(parse_wsl_unc)
    } else {
        None
    };
    let mut cmd = if let Some((distro, linux_path)) = &wsl_target {
        let mut c = CommandBuilder::new("wsl.exe");
        c.args(["-d", distro, "--cd", linux_path]);
        c
    } else {
        CommandBuilder::new(&shell)
    };
    cmd.env("TERM", "xterm-256color");
    if wsl_target.is_none() {
        if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
            cmd.cwd(dir);
        }
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
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = terminate_child(child.as_mut());
            let _ = child.wait();
            remove_if_token(id, &token);
            return Err(AppError::Other(format!("pty reader failed: {error}")));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = terminate_child(child.as_mut());
            let _ = child.wait();
            remove_if_token(id, &token);
            return Err(AppError::Other(format!("pty writer failed: {error}")));
        }
    };

    let child = {
        let mut map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
        let publish = map.get_mut(&id).filter(|slot| {
            slot.window_label == window_label
                && slot.is_current(&token)
                && matches!(slot.phase, TerminalPhase::Starting)
        });
        if publish.is_none() {
            drop(map);
            let _ = terminate_child(child.as_mut());
            let _ = child.wait();
            return Err(AppError::Other(format!(
                "terminal {id} startup was cancelled"
            )));
        }
        let child = Arc::new(Mutex::new(child));
        let master = Arc::new(Mutex::new(pair.master));
        publish.expect("checked above").phase = TerminalPhase::Running(TerminalHandle {
            writer: Arc::new(Mutex::new(writer)),
            master: master.clone(),
            child: child.clone(),
            pid,
            shell_cwd: None,
        });
        (child, master)
    };
    let (child, _reader_master) = child;

    let reader_token = token.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let mut scanner = Osc7Scanner::new();
        loop {
            #[cfg(unix)]
            {
                if reader_token.load(Ordering::Relaxed) {
                    break;
                }
                match wait_pty_readable(&_reader_master, 50) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(_) => break,
                }
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_valid_utf8(&mut pending);
                    if !text.is_empty() {
                        // Observe OSC 7 cwd reports before forwarding output;
                        // output itself is passed through unchanged.
                        for cwd in scanner.push(&text) {
                            // Reader thread (returns ()): recover the registry
                            // rather than panic if another holder poisoned it.
                            let should_emit = {
                                let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(TerminalSlot {
                                    token: current_token,
                                    phase: TerminalPhase::Running(handle),
                                    ..
                                }) = map.get_mut(&id)
                                {
                                    if Arc::ptr_eq(current_token, &reader_token)
                                        && !reader_token.load(Ordering::Relaxed)
                                    {
                                        handle.shell_cwd = Some(cwd.clone());
                                        true
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            };
                            if should_emit {
                                on_cwd(cwd);
                            }
                        }
                        if !reader_token.load(Ordering::Relaxed) {
                            on_output(text);
                        }
                    }
                }
            }
        }
    });

    std::thread::spawn(move || {
        let code = wait_for_child(&child).map(|status| status.exit_code());
        remove_if_token(id, &token);
        if !token.load(Ordering::Relaxed) {
            on_exit(code);
        }
    });

    Ok(TerminalSpawnInfo {
        id,
        shell_kind: if wsl_target.is_some() {
            "posix".to_string()
        } else {
            classify_shell(&shell).to_string()
        },
        wsl_distro: wsl_target.map(|(distro, _)| distro),
    })
}

/// Kill every terminal owned by `label`. Reader threads observe EOF and
/// remove the registry entries themselves.
pub fn on_window_destroyed(label: &str) {
    // Returns (): recover the registry rather than panic on a poisoned lock.
    let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
    let mut children = Vec::new();
    map.retain(|_, slot| {
        if slot.window_label != label {
            return true;
        }
        slot.token.store(true, Ordering::Relaxed);
        if let TerminalPhase::Running(handle) = &slot.phase {
            children.push(handle.child.clone());
            return true;
        }
        false
    });
    drop(map);
    for child in children {
        let _ = kill_child(&child);
    }
}

// ─── Async Tauri commands ───────────────────────────────────────────────────

/// Reserve a terminal id BEFORE spawning, so the frontend can register its
/// output/exit/cwd listeners first. Without this, a fast shell emits its
/// prompt into the listener-registration gap and the terminal opens blank
/// (#201 — reproduced repeatedly by the Linux CI smoke suite).
#[tauri::command]
pub async fn terminal_reserve_id(window: tauri::Window) -> Result<u64, AppError> {
    reserve_terminal(window.label())
}

/// Spawn the user's shell in a PTY at `cwd`, emitting on the
/// `terminal-output-{id}` / `terminal-exit-{id}` / `terminal-cwd-{id}`
/// events for the RESERVED id (see `terminal_reserve_id`).
#[tauri::command]
pub async fn terminal_spawn(
    window: tauri::Window,
    id: u64,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSpawnInfo, AppError> {
    let label = window.label().to_string();
    let token = begin_terminal(id, &label)?;
    let cleanup_token = token.clone();
    let task = tokio::task::spawn_blocking(move || {
        let output_window = window.clone();
        let cwd_window = window.clone();
        let result = spawn_shell(
            id,
            label,
            token.clone(),
            cwd,
            cols.max(2),
            rows.max(2),
            move |chunk| {
                let _ = output_window.emit(&format!("terminal-output-{id}"), chunk);
            },
            move |code| {
                let _ = window.emit(&format!("terminal-exit-{id}"), code);
            },
            move |path| {
                let _ = cwd_window.emit(&format!("terminal-cwd-{id}"), path);
            },
        );
        if result.is_err() {
            remove_if_token(id, &token);
        }
        result
    });
    match task.await {
        Ok(result) => result,
        Err(error) => {
            cleanup_token.store(true, Ordering::Relaxed);
            remove_if_token(id, &cleanup_token);
            Err(AppError::Other(format!("Task join error: {error}")))
        }
    }
}

/// Write user input (keystrokes) to the terminal.
#[tauri::command]
pub async fn terminal_write(window: tauri::Window, id: u64, data: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
        let slot = map
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        slot.check_owner(window.label())?;
        let TerminalPhase::Running(handle) = &slot.phase else {
            return Err(AppError::Other(format!("terminal {id} is not running")));
        };
        let writer = handle.writer.clone();
        drop(map);
        let result = writer
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .write_all(data.as_bytes())
            .map_err(|e| AppError::Other(format!("pty write failed: {e}")));
        result
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Resize the PTY to match the xterm.js grid.
#[tauri::command]
pub async fn terminal_resize(
    window: tauri::Window,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
        let slot = map
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        slot.check_owner(window.label())?;
        let TerminalPhase::Running(handle) = &slot.phase else {
            return Err(AppError::Other(format!("terminal {id} is not running")));
        };
        let master = handle.master.clone();
        drop(map);
        let result = master
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("pty resize failed: {e}")));
        result
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Kill the terminal's shell. Registry cleanup and the exit event happen in
/// the reader thread when the PTY reaches EOF.
#[tauri::command]
pub async fn terminal_kill(window: tauri::Window, id: u64) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let mut map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
        let slot = map
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        slot.check_owner(window.label())?;
        let slot = map
            .remove(&id)
            .expect("terminal existed while registry locked");
        slot.token.store(true, Ordering::Relaxed);
        drop(map);
        match slot.phase {
            TerminalPhase::Running(handle) => kill_child(&handle.child)
                .map_err(|e| AppError::Other(format!("pty kill failed: {e}"))),
            TerminalPhase::Reserved | TerminalPhase::Starting => Ok(()),
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Report whether a foreground command is running and the shell's last-known
/// cwd (issue #149). The frontend uses `busy` to decide between injecting a
/// `cd` now or queuing it, and `cwd` to skip redundant cd's (loop guard).
#[tauri::command]
pub async fn terminal_status(window: tauri::Window, id: u64) -> Result<TerminalStatus, AppError> {
    tokio::task::spawn_blocking(move || {
        let map = terminals()
            .lock()
            .map_err(|e| AppError::Other(format!("terminals registry lock poisoned: {e}")))?;
        let slot = map
            .get(&id)
            .ok_or_else(|| AppError::NotFound(format!("terminal {id}")))?;
        slot.check_owner(window.label())?;
        let TerminalPhase::Running(handle) = &slot.phase else {
            return Err(AppError::Other(format!("terminal {id} is not running")));
        };
        let master = handle.master.clone();
        let pid = handle.pid;
        let cwd = handle.shell_cwd.clone();
        drop(map);
        let master = master.lock().unwrap_or_else(|error| error.into_inner());
        Ok(TerminalStatus {
            busy: is_busy(master.as_ref(), pid),
            cwd,
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

    fn reserve_started(label: &str) -> (u64, Arc<AtomicBool>) {
        let id = reserve_terminal(label).unwrap();
        let token = begin_terminal(id, label).unwrap();
        (id, token)
    }

    fn running_child(id: u64) -> SharedChild {
        let map = terminals()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let slot = map.get(&id).expect("terminal registered");
        let TerminalPhase::Running(handle) = &slot.phase else {
            panic!("terminal not running")
        };
        handle.child.clone()
    }

    fn kill_test_terminal(id: u64) {
        let _ = kill_child(&running_child(id));
    }

    #[test]
    fn reservation_claim_is_atomic_and_window_owned() {
        let id = reserve_terminal("owner").unwrap();
        assert!(begin_terminal(id, "other-window").is_err());
        let token = begin_terminal(id, "owner").unwrap();
        assert!(begin_terminal(id, "owner").is_err());
        on_window_destroyed("owner");
        assert!(token.load(Ordering::Relaxed));
    }

    #[test]
    #[cfg(unix)]
    fn cancelled_startup_cannot_publish_a_late_pty() {
        let (id, token) = reserve_started("owner");
        token.store(true, Ordering::Relaxed);
        terminals()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);

        let result = spawn_shell(
            id,
            "owner".into(),
            token,
            None,
            80,
            24,
            |_| panic!("cancelled startup published output"),
            |_| panic!("cancelled startup published exit"),
            |_| panic!("cancelled startup published cwd"),
        );

        assert!(result.is_err());
        assert!(!terminals()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&id));
    }

    #[test]
    fn window_destruction_cancels_reserved_and_starting_slots_only_for_owner() {
        let reserved = reserve_terminal("closing").unwrap();
        let (starting, starting_token) = reserve_started("closing");
        let survivor = reserve_terminal("survivor").unwrap();

        on_window_destroyed("closing");

        let map = terminals()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(!map.contains_key(&reserved));
        assert!(!map.contains_key(&starting));
        assert!(starting_token.load(Ordering::Relaxed));
        assert!(map.contains_key(&survivor));
        drop(map);
        on_window_destroyed("survivor");
    }

    #[test]
    #[cfg(unix)]
    fn actual_child_kill_escalates_when_shell_ignores_hangup() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "trap '' HUP; (trap '' HUP; while :; do sleep 1; done) & echo ready; wait",
            ])
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");

        let child: SharedChild = Arc::new(Mutex::new(Box::new(child)));
        kill_child(&child).unwrap();
        let status = child.lock().unwrap().wait().unwrap();
        assert_ne!(status.exit_code(), 0);
    }

    #[test]
    #[cfg(unix)]
    fn waiter_releases_child_lock_while_process_remains_alive() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "echo ready; exec >/dev/null 2>&1; trap '' HUP; while :; do sleep 1; done",
            ])
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");

        let child: SharedChild = Arc::new(Mutex::new(Box::new(child)));
        let waiter_child = child.clone();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = wait_for_child(&waiter_child);
            let _ = done_tx.send(());
        });
        std::thread::sleep(Duration::from_millis(50));
        kill_child(&child).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_secs(3)).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn window_teardown_releases_pty_while_foreground_job_ignores_hangup() {
        let (id, token) = reserve_started("job-control-owner");
        spawn_shell(
            id,
            "job-control-owner".into(),
            token,
            None,
            80,
            24,
            |_| {},
            |_| {},
            |_| {},
        )
        .unwrap();
        let (writer, master, shell_pid) = {
            let map = terminals()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let TerminalPhase::Running(handle) = &map.get(&id).unwrap().phase else {
                panic!("terminal not running")
            };
            (
                handle.writer.clone(),
                handle.master.clone(),
                handle.pid.unwrap(),
            )
        };
        writer
            .lock()
            .unwrap()
            .write_all(b"sh -c 'trap \"\" HUP; while :; do sleep 1; done'\n")
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let foreground_group = loop {
            let master = master.lock().unwrap();
            let foreground = unsafe { libc::tcgetpgrp(master.as_raw_fd().unwrap()) };
            drop(master);
            if foreground > 0 && foreground as u32 != shell_pid {
                break foreground;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "foreground job never started"
            );
            std::thread::sleep(Duration::from_millis(20));
        };

        on_window_destroyed("job-control-owner");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while terminals().lock().unwrap().contains_key(&id) {
            assert!(
                std::time::Instant::now() < deadline,
                "owned shell was not reaped"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        // Descendant process-tree policy is intentionally separate from PTY
        // ownership. Clean the hostile fixture's distinct job-control group.
        unsafe { libc::kill(-foreground_group, libc::SIGKILL) };
    }

    #[test]
    #[cfg(unix)]
    fn blocked_terminal_writer_does_not_hold_registry_lock() {
        let (id, token) = reserve_started("blocked-writer");
        spawn_shell(
            id,
            "blocked-writer".into(),
            token,
            None,
            80,
            24,
            |_| {},
            |_| {},
            |_| {},
        )
        .unwrap();
        let writer = {
            let map = terminals()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let TerminalPhase::Running(handle) = &map.get(&id).unwrap().phase else {
                panic!("terminal not running")
            };
            handle.writer.clone()
        };
        let _blocked_writer = writer.lock().unwrap();

        let unrelated = reserve_terminal("unrelated").unwrap();
        assert!(terminals().lock().unwrap().contains_key(&unrelated));
        on_window_destroyed("unrelated");
        kill_test_terminal(id);
    }

    #[test]
    fn shells_classify_into_dialect_families() {
        assert_eq!(classify_shell(r"C:\Windows\system32\cmd.exe"), "cmd");
        assert_eq!(
            classify_shell(r"C:\...\WindowsPowerShell\v1.0\powershell.exe"),
            "powershell"
        );
        assert_eq!(classify_shell("pwsh.exe"), "powershell");
        assert_eq!(classify_shell("/bin/zsh"), "posix");
        assert_eq!(classify_shell("/usr/bin/fish"), "posix");
        assert_eq!(classify_shell(""), "posix");
    }

    // parse_wsl_unc's tests live with it in crate::wsl.

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

        let (id, token) = reserve_started("test-window");
        let id = spawn_shell(
            id,
            "test-window".into(),
            token,
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
        .expect("spawn failed")
        .id;

        {
            let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
            let slot = map.get_mut(&id).expect("terminal registered");
            let TerminalPhase::Running(handle) = &mut slot.phase else {
                panic!("not running")
            };
            handle
                .writer
                .lock()
                .unwrap()
                .write_all(b"pwd && exit\n")
                .unwrap();
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
            assert!(
                std::time::Instant::now() < deadline,
                "shell never exited; output: {output}"
            );
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
            !terminals()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&id),
            "registry entry should be removed after exit"
        );
    }

    #[test]
    #[cfg(unix)]
    fn on_window_destroyed_kills_only_that_windows_terminals() {
        let (exit_tx_a, _exit_rx_a) = mpsc::channel::<Option<u32>>();
        let (exit_tx_b, exit_rx_b) = mpsc::channel::<Option<u32>>();

        let (a_id, a_token) = reserve_started("win-a");
        let _a = spawn_shell(
            a_id,
            "win-a".into(),
            a_token,
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
        let (b_id, b_token) = reserve_started("win-b");
        let b = spawn_shell(
            b_id,
            "win-b".into(),
            b_token,
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

        // win-a's shell is retained until its reader reaps it, then removed.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while terminals()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(&_a.id)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "window-a terminal was not reaped after on_window_destroyed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // …while win-b's stays alive (no exit within a grace window).
        assert!(
            exit_rx_b.recv_timeout(Duration::from_millis(500)).is_err(),
            "window-b terminal must survive"
        );

        // Cleanup.
        kill_test_terminal(b.id);
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

    #[test]
    fn osc7_fresh_introducer_implicitly_terminates_previous_in_one_chunk() {
        let mut s = Osc7Scanner::new();
        // An unterminated OSC 7 followed immediately by a complete one: the
        // fresh `ESC ]` implicitly ends the first (discarding it), so only the
        // second sequence's cwd is parsed — it must win.
        let chunk = format!("\x1b]7;file://host/first{}", osc7("/second", "\x07"));
        assert_eq!(s.push(&chunk), vec!["/second"]);
        assert!(s.carry.is_empty());
    }

    #[test]
    fn osc7_fresh_introducer_across_chunks_discards_stale_and_parses_new() {
        let mut s = Osc7Scanner::new();
        // First chunk opens an OSC 7 that never terminates (carried over).
        assert_eq!(s.push("\x1b]7;file://host/stale"), Vec::<String>::new());
        assert!(!s.carry.is_empty());
        // A brand-new OSC 7 arrives next chunk; the stale carried fragment must
        // be discarded and the new one parsed.
        assert_eq!(s.push(&osc7("/fresh", "\x07")), vec!["/fresh"]);
        assert!(s.carry.is_empty());
    }

    #[test]
    fn osc7_oversized_sequence_followed_by_fresh_one_recovers() {
        let mut s = Osc7Scanner::new();
        // A very long unterminated OSC 7 followed by a complete one in the same
        // chunk: the fresh introducer implicitly terminates the oversized one,
        // so `/after` is parsed and nothing is carried.
        let big = "y".repeat(OSC7_MAX_CARRY + 10);
        let chunk = format!("\x1b]7;file://host/{big}{}", osc7("/after", "\x07"));
        assert_eq!(s.push(&chunk), vec!["/after"]);
        assert!(s.carry.is_empty());
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
            assert!(
                body.contains(&format!("$USER_ZDOTDIR/{name}")),
                "{name} sources user file"
            );
            assert!(
                body.contains("_TE_SHIM_ZDOTDIR"),
                "{name} restores shim dir"
            );
        }

        let zshrc = &files[2].1;
        assert!(
            zshrc.contains("_tauri_explorer_osc7"),
            "zshrc adds the OSC 7 hook"
        );
        assert!(
            zshrc.contains("add-zsh-hook chpwd"),
            "zshrc registers a chpwd hook"
        );
        assert!(
            zshrc.contains("file://"),
            "zshrc emits an OSC 7 file:// sequence"
        );
    }

    // ─── busy detection ──────────────────────────────────────────────────────

    /// A real shell reports idle at its prompt, busy while a foreground command
    /// runs, then idle again once it finishes — the signal `terminal_status`
    /// exposes for queued-cd logic.
    #[test]
    #[cfg(unix)]
    fn busy_detection_tracks_foreground_command() {
        let (exit_tx, _exit_rx) = mpsc::channel::<Option<u32>>();
        let (id, token) = reserve_started("busy-test");
        let id = spawn_shell(
            id,
            "busy-test".into(),
            token,
            None,
            80,
            24,
            |_| {},
            move |c| {
                let _ = exit_tx.send(c);
            },
            |_| {},
        )
        .expect("spawn failed")
        .id;

        let busy_now = || {
            let map = terminals().lock().unwrap_or_else(|e| e.into_inner());
            let slot = map.get(&id).expect("registered");
            let TerminalPhase::Running(handle) = &slot.phase else {
                panic!("not running")
            };
            let master = handle.master.lock().unwrap();
            is_busy(master.as_ref(), handle.pid)
        };

        // Let the shell reach its prompt.
        let idle_deadline = std::time::Instant::now() + Duration::from_secs(5);
        while busy_now() {
            assert!(
                std::time::Instant::now() < idle_deadline,
                "shell never became idle"
            );
            std::thread::sleep(Duration::from_millis(50));
        }

        // Start a foreground command.
        {
            let mut map = terminals().lock().unwrap_or_else(|e| e.into_inner());
            let slot = map.get_mut(&id).unwrap();
            let TerminalPhase::Running(handle) = &mut slot.phase else {
                panic!("not running")
            };
            handle
                .writer
                .lock()
                .unwrap()
                .write_all(b"sleep 2\n")
                .unwrap();
        }

        // Poll until busy is observed.
        let busy_deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if busy_now() {
                break;
            }
            assert!(
                std::time::Instant::now() < busy_deadline,
                "sleep never registered as busy"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        // …and idle again after it finishes.
        let done_deadline = std::time::Instant::now() + Duration::from_secs(6);
        while busy_now() {
            assert!(
                std::time::Instant::now() < done_deadline,
                "shell stayed busy after sleep"
            );
            std::thread::sleep(Duration::from_millis(50));
        }

        kill_test_terminal(id);
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
        let (id, token) = reserve_started("zsh-osc7");
        let info = spawn_shell(
            id,
            "zsh-osc7".into(),
            token,
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
        kill_test_terminal(info.id);

        assert!(
            got_cwd.is_ok(),
            "expected an OSC 7 cwd event from zsh startup; output: {output}"
        );
    }
}
