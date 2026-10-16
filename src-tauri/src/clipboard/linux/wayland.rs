//! Wayland file-list backend: a held owner process per write (#877, #927).
//!
//! Every write stops the previous owner, then starts one that serves the file
//! list until another client takes the selection, when it exits: the
//! selection is ours exactly while that process runs, and `owner_token`
//! returns the write's token until it has exited. Reads go through
//! `wl-paste`.
//!
//! The owner is the app's own data-control client (`data_control.rs`). It
//! offers the list and, as a private type, the write's random token. The
//! write is proven when the selection offers that token while the owner
//! still runs. Matching the list's bytes proved nothing: a file manager, a
//! clipboard manager or an earlier write can offer the identical list, and
//! one did get credited to an owner that never published (#927).
//!
//! Without data-control (GNOME's Mutter, cage) the owner reports so and a
//! `wl-copy --foreground` owner serves the list instead. It cannot carry a
//! token, so the backend refuses Cut there and Copy keeps working.
//!
//! Lifecycle of the owner:
//! - A write stops (kills and reaps) the previous owner before starting the
//!   next, so the old one cannot keep serving the selection.
//! - An owner that exited (replaced by another program, or crashed) is reaped
//!   by the next ownership check.
//! - At app exit the last owner is deliberately left running. The file-list
//!   mirror always carries Copy semantics, so it cannot move files, and
//!   other programs can still paste the last Copy after the app quits, as
//!   they could when `wl-copy` forked its own background server. The worker
//!   is a process-wide static that is never dropped, so no destructor runs;
//!   the owner is started in `/` so it cannot keep a removable volume busy.
//!
//! The file list is offered only as `x-special/gnome-copied-files` (pasted by
//! Thunar, Nautilus, Nemo and Caja), not the multi-target set of the X11
//! owner, with the same bytes `wl-copy` served before #927. `wl-copy` offers
//! one payload per process and `text/*` types would also be offered as
//! `text/plain`, which would put our URI list into terminals.

use super::data_control;
use super::{tool_error, CliTool};
use crate::clipboard::backend::{ClipboardBackend, ClipboardOperation};
use crate::clipboard::file_uri::{gnome_copied_files, paths_to_uris};
use crate::error::AppError;
use std::time::{Duration, Instant};

pub(super) const FILE_LIST_TYPE: &str = "x-special/gnome-copied-files";
/// The private type under which an identified owner offers its write's token.
pub(super) const OWNER_TYPE: &str =
    "application/x-io.github.xnmp.tauri-explorer.file-clipboard-token";

const CUT_NEEDS_DATA_CONTROL: &str =
    "Cut requires a Wayland compositor with clipboard data-control; Copy is available here";

/// How long a new owner may take to publish its selection. Owners usually
/// publish within a few milliseconds.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(2);
const FIRST_POLL: Duration = Duration::from_millis(2);
const MAX_POLL: Duration = Duration::from_millis(50);
/// How long one `wl-paste` read may take. A source that never sends its data
/// would otherwise block the clipboard worker indefinitely.
const READ_TIMEOUT: Duration = Duration::from_secs(1);
const READ_POLL: Duration = Duration::from_millis(2);

/// What one read of the selection found.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Offer {
    /// Nothing is copied, or nothing is offered as the requested type.
    Empty,
    /// The selection offers these bytes as the requested type.
    Bytes(Vec<u8>),
    /// The read failed, so what the selection offers is unknown. It must
    /// never be taken to mean "not our payload": an identical offer the read
    /// could not see would then be credited to a new owner.
    Unreadable(String),
}

/// How an owner process ended.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum OwnerExit {
    /// An identified owner found no data-control protocol to publish with.
    NoDataControl,
    Ended(String),
}

/// A running process that serves the selection.
pub(super) trait OwnerProcess {
    /// `None` while the process runs; once it has exited (and been reaped),
    /// how it ended.
    fn exit_status(&mut self) -> Option<OwnerExit>;

    /// Stop the process and reap it.
    fn stop(&mut self);
}

/// The Wayland clipboard tooling this backend drives. `WlClipboard` is the
/// real session; tests substitute a simulated compositor.
pub(super) trait WaylandSession {
    /// Start an identified owner: it offers `payload` as `FILE_LIST_TYPE` and
    /// `token` as `OWNER_TYPE`, and keeps running until another client takes
    /// the selection or it is stopped. Without data-control it exits with
    /// `OwnerExit::NoDataControl`.
    fn spawn_owner(
        &mut self,
        payload: &[u8],
        token: &str,
    ) -> Result<Box<dyn OwnerProcess>, AppError>;

    /// Start a `wl-copy` owner offering only `payload` as `FILE_LIST_TYPE`.
    /// Its offer is indistinguishable from another client's identical one,
    /// so it serves Copy but never proves a Cut.
    fn spawn_plain_owner(&mut self, payload: &[u8]) -> Result<Box<dyn OwnerProcess>, AppError>;

    /// What the selection currently offers as `media_type`.
    fn read_offer(&mut self, media_type: &str) -> Offer;

    /// File paths the selection currently offers.
    fn read_files(&mut self) -> Result<Vec<String>, AppError>;

    fn pause(&mut self, duration: Duration);
}

struct Owner {
    /// `None` when publication could not be proven: the process still serves
    /// the list (Copy works) but never vouches for a Cut.
    token: Option<String>,
    process: Box<dyn OwnerProcess>,
}

/// What waiting for an owner's offer found.
enum Published {
    /// The selection offered the expected bytes while the owner still ran.
    Seen,
    /// A read failed, so publication can be neither proven nor ruled out.
    Unknown,
    NoDataControl,
}

pub(super) struct WaylandBackend {
    session: Box<dyn WaylandSession>,
    owner: Option<Owner>,
    /// Whether the compositor offers data-control; `None` until an identified
    /// owner has found out. The compositor cannot change while the app runs.
    data_control: Option<bool>,
}

impl WaylandBackend {
    pub(super) fn new() -> Self {
        Self::with_session(Box::new(WlClipboard::new()))
    }

    fn with_session(session: Box<dyn WaylandSession>) -> Self {
        Self {
            session,
            owner: None,
            data_control: None,
        }
    }

    fn stop_owner(&mut self) {
        if let Some(mut owner) = self.owner.take() {
            owner.process.stop();
        }
    }

    /// Wait until the selection offers `expected` as `media_type` while
    /// `process` still runs.
    ///
    /// An identified owner is waited for by its token, which no other client
    /// can offer before this owner published it: a client that copied it
    /// later took the selection, which ends this owner, so the check that the
    /// owner still runs after the read fails. Seeing the token therefore
    /// proves that this exact write owns the selection (#927).
    fn await_offer(
        &mut self,
        process: &mut dyn OwnerProcess,
        media_type: &str,
        expected: &[u8],
    ) -> Result<Published, AppError> {
        let mut waited = Duration::ZERO;
        let mut poll = FIRST_POLL;
        loop {
            match process.exit_status() {
                Some(OwnerExit::NoDataControl) => return Ok(Published::NoDataControl),
                Some(OwnerExit::Ended(status)) => {
                    return Err(AppError::Other(format!(
                        "The Wayland clipboard owner exited ({status}) before it owned the clipboard"
                    )));
                }
                None => {}
            }
            match self.session.read_offer(media_type) {
                Offer::Bytes(offered) if offered == expected && process.exit_status().is_none() => {
                    return Ok(Published::Seen);
                }
                // Stop waiting; the owner keeps serving the list, unproven.
                Offer::Unreadable(reason) => {
                    log::warn!(
                        "Wayland clipboard read-back failed; Cut stays unverified: {reason}"
                    );
                    return Ok(Published::Unknown);
                }
                Offer::Bytes(_) | Offer::Empty => {}
            }
            if waited >= PUBLISH_TIMEOUT {
                return Err(AppError::Other(format!(
                    "The Wayland clipboard owner did not take the clipboard within {}s",
                    PUBLISH_TIMEOUT.as_secs()
                )));
            }
            self.session.pause(poll);
            waited += poll;
            poll = (poll * 2).min(MAX_POLL);
        }
    }

    /// Publish through an identified owner. `Ok(None)` when none can run
    /// here; the caller then falls back to `wl-copy`.
    fn write_identified(&mut self, payload: &[u8], token: &str) -> Result<Option<Owner>, AppError> {
        let mut process = match self.session.spawn_owner(payload, token) {
            Ok(process) => process,
            Err(error) => {
                log::warn!("Wayland clipboard owner unavailable; Cut stays unverified: {error}");
                return Ok(None);
            }
        };
        match self.await_offer(process.as_mut(), OWNER_TYPE, token.as_bytes()) {
            Ok(Published::Seen) => Ok(Some(Owner {
                token: Some(token.to_owned()),
                process,
            })),
            Ok(Published::Unknown) => Ok(Some(Owner {
                token: None,
                process,
            })),
            Ok(Published::NoDataControl) => {
                log::info!("The Wayland compositor has no clipboard data-control; Cut is refused");
                self.data_control = Some(false);
                Ok(None)
            }
            Err(error) => {
                process.stop();
                Err(error)
            }
        }
    }

    /// Publish through `wl-copy`, which serves Copy but never proves a Cut.
    /// The write still waits until the selection offers the new list:
    /// otherwise the coordinator's next snapshot reads the previous list and
    /// adopts it as an external replacement. When the selection already
    /// offers these bytes, or a read fails, there is nothing to wait for.
    fn write_plain(&mut self, payload: &[u8]) -> Result<Owner, AppError> {
        let baseline = self.session.read_offer(FILE_LIST_TYPE);
        let mut process = self.session.spawn_plain_owner(payload)?;
        let changes = match &baseline {
            Offer::Empty => true,
            Offer::Bytes(offered) => offered != payload,
            Offer::Unreadable(reason) => {
                log::warn!("Wayland clipboard read failed: {reason}");
                false
            }
        };
        if changes {
            if let Err(error) = self.await_offer(process.as_mut(), FILE_LIST_TYPE, payload) {
                process.stop();
                return Err(error);
            }
        }
        Ok(Owner {
            token: None,
            process,
        })
    }
}

impl ClipboardBackend for WaylandBackend {
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        self.session.read_files()
    }

    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError> {
        if paths.is_empty() {
            return Err(AppError::InvalidPath("No paths to copy".into()));
        }
        let payload = gnome_copied_files(&paths_to_uris(paths)).into_bytes();
        // Stop the previous owner first, so it cannot keep serving (or be
        // mistaken for) the new write.
        self.stop_owner();
        if self.data_control != Some(false) {
            if let Some(owner) = self.write_identified(&payload, token)? {
                self.data_control = Some(true);
                self.owner = Some(owner);
                return Ok(());
            }
        }
        self.owner = Some(self.write_plain(&payload)?);
        Ok(())
    }

    fn owner_token(&mut self) -> Option<String> {
        let owner = self.owner.as_mut()?;
        if owner.process.exit_status().is_some() {
            // Replaced or crashed; `exit_status` has reaped it.
            self.owner = None;
            return None;
        }
        owner.token.clone()
    }

    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        (self.data_control == Some(false)).then_some(CUT_NEEDS_DATA_CONTROL)
    }
}

/// The real session: identified owners run this executable in its
/// data-control owner mode; `wl-copy` serves the fallback; `wl-paste` reads.
struct WlClipboard {
    /// The executable to start in owner mode; normally this one.
    owner_program: Option<std::path::PathBuf>,
}

impl WlClipboard {
    fn new() -> Self {
        Self {
            owner_program: std::env::current_exe().ok(),
        }
    }
}

/// Start `command` with piped stdin, write `input` and close it.
fn spawn_with_input(
    command: &mut std::process::Command,
    input: &[u8],
    name: &str,
    data_control: bool,
) -> Result<Box<dyn OwnerProcess>, AppError> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = command
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| tool_error(name, "wl-clipboard", error))?;
    // Dropping stdin after the write closes it: both owners read to EOF
    // before they offer the selection.
    let written = child
        .stdin
        .take()
        .map_or(Ok(()), |mut stdin| stdin.write_all(input));
    let mut process = HeldOwner {
        child,
        data_control,
    };
    if let Err(error) = written {
        process.stop();
        return Err(AppError::Other(format!(
            "Failed to write to {name}: {error}"
        )));
    }
    Ok(Box::new(process))
}

impl WaylandSession for WlClipboard {
    fn spawn_owner(
        &mut self,
        payload: &[u8],
        token: &str,
    ) -> Result<Box<dyn OwnerProcess>, AppError> {
        let program = self
            .owner_program
            .as_ref()
            .ok_or_else(|| AppError::Other("The app's executable path is unknown".into()))?;
        let mut command = std::process::Command::new(program);
        command.arg(data_control::MARKER);
        spawn_with_input(
            &mut command,
            &data_control::encode_request(token, payload),
            "the Wayland clipboard owner",
            true,
        )
    }

    fn spawn_plain_owner(&mut self, payload: &[u8]) -> Result<Box<dyn OwnerProcess>, AppError> {
        let mut command = std::process::Command::new("wl-copy");
        command.args(["--foreground", "--type", FILE_LIST_TYPE]);
        spawn_with_input(&mut command, payload, "wl-copy", false)
    }

    fn read_offer(&mut self, media_type: &str) -> Offer {
        let mut command = std::process::Command::new("wl-paste");
        command.args(["--no-newline", "--type", media_type]);
        match run_bounded(&mut command, READ_TIMEOUT) {
            Ok(run) => classify_paste(run.code, run.stdout, &run.stderr, media_type),
            Err(RunFailure::Spawn(error)) => {
                Offer::Unreadable(tool_error("wl-paste", "wl-clipboard", error).to_string())
            }
            Err(RunFailure::Unfinished(reason)) => Offer::Unreadable(format!("wl-paste {reason}")),
        }
    }

    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        CliTool::WlClipboard.read_file_paths()
    }

    fn pause(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// A finished process: its exit code (`None` if a signal ended it) and output.
struct FinishedRun {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

enum RunFailure {
    Spawn(std::io::Error),
    /// It could not be observed, or did not finish (and was killed).
    Unfinished(String),
}

/// Run `command` to completion, killing it after `timeout`.
fn run_bounded(
    command: &mut std::process::Command,
    timeout: Duration,
) -> Result<FinishedRun, RunFailure> {
    use std::process::Stdio;
    let mut child = command
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunFailure::Spawn)?;
    // Drain both pipes while waiting, so a large offer cannot stall the
    // child on a full pipe.
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(READ_POLL),
            unfinished => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunFailure::Unfinished(match unfinished {
                    Err(error) => format!("could not be observed: {error}"),
                    _ => format!("did not finish within {timeout:?}"),
                }));
            }
        }
    };
    // A descendant that inherited a pipe could hold it open after the exit.
    let grace = deadline
        .saturating_duration_since(Instant::now())
        .max(READ_POLL);
    match (stdout.recv_timeout(grace), stderr.recv_timeout(grace)) {
        (Ok(stdout), Ok(stderr)) => Ok(FinishedRun {
            code: status.code(),
            stdout,
            stderr,
        }),
        _ => Err(RunFailure::Unfinished(
            "exited, but its output did not close".into(),
        )),
    }
}

/// Read `pipe` to its end on a helper thread.
fn drain(pipe: Option<impl std::io::Read + Send + 'static>) -> std::sync::mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    if let Some(mut pipe) = pipe {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if pipe.read_to_end(&mut bytes).is_ok() {
                let _ = sender.send(bytes);
            }
        });
    }
    receiver
}

/// Classify a finished `wl-paste --type <media_type>` run. Only wl-paste's
/// own "nothing to paste" reports count as an empty selection. Anything else
/// (a lost compositor, a signal, a message from an unknown version) leaves
/// the selection's contents unknown.
fn classify_paste(code: Option<i32>, stdout: Vec<u8>, stderr: &[u8], media_type: &str) -> Offer {
    let message = String::from_utf8_lossy(stderr);
    match code {
        Some(0) => Offer::Bytes(stdout),
        Some(1) if reports_no_offer(&message, media_type) => Offer::Empty,
        Some(code) => Offer::Unreadable(format!(
            "wl-paste exited with code {code}: {}",
            message.trim()
        )),
        None => Offer::Unreadable("wl-paste was killed by a signal".into()),
    }
}

/// Whether `stderr` is exactly one of wl-paste's reports that the selection
/// offers nothing as `media_type` (wl-clipboard `src/wl-paste.c`):
/// - 2.2 and later: `Nothing is copied`, or `Clipboard content is not
///   available as requested type "<type>"` followed by a `--list-types` hint.
/// - 1.0 to 2.1: `No selection`, or `No suitable type of content copied`.
fn reports_no_offer(stderr: &str, media_type: &str) -> bool {
    const NO_OFFER: [&str; 3] = [
        "Nothing is copied",
        "No selection",
        "No suitable type of content copied",
    ];
    const LIST_TYPES_HINT: &str = "Use \"wl-paste --list-types\" to view available types.";
    let wrong_type =
        format!("Clipboard content is not available as requested type \"{media_type}\"");
    match stderr.lines().collect::<Vec<_>>().as_slice() {
        [only] => NO_OFFER.contains(only),
        [first, hint] => *first == wrong_type && *hint == LIST_TYPES_HINT,
        _ => false,
    }
}

/// A running owner: the data-control owner or `wl-copy`.
struct HeldOwner {
    child: std::process::Child,
    /// Whether this is the data-control owner, whose exit code reports a
    /// compositor without data-control.
    data_control: bool,
}

impl OwnerProcess for HeldOwner {
    fn exit_status(&mut self) -> Option<OwnerExit> {
        match self.child.try_wait() {
            Ok(None) => None,
            Ok(Some(status))
                if self.data_control
                    && status.code() == Some(data_control::NO_DATA_CONTROL_EXIT) =>
            {
                Some(OwnerExit::NoDataControl)
            }
            Ok(Some(status)) => Some(OwnerExit::Ended(status.to_string())),
            // Unobservable counts as gone: ownership must be proven.
            Err(error) => Some(OwnerExit::Ended(format!("unobservable: {error}"))),
        }
    }

    fn stop(&mut self) {
        // Either may fail only because the child already exited and was
        // reaped, which is the goal.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::coordinator::FileClipboardCoordinator;
    use crate::clipboard::file_uri::parse_gnome_copied_files;
    use std::cell::RefCell;
    use std::rc::Rc;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    /// How a simulated owner behaves after it starts.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Behaviour {
        /// Publishes on the compositor's next turn (the first pause).
        Publishes,
        /// Exits before publishing (e.g. no seat).
        ExitsAtOnce,
        /// Runs but never publishes (a wedged compositor, or one that
        /// ignores the owner's request).
        NeverPublishes,
        /// Publishes, then exits after serving its first paste (a crash
        /// right after publishing).
        ExitsAfterServing,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Life {
        Running,
        /// Exited on its own; not reaped yet.
        Exited,
        Reaped,
    }

    struct SimulatedProcess {
        payload: Vec<u8>,
        /// The identified owner's token; `None` for `wl-copy`.
        token: Option<Vec<u8>>,
        behaviour: Behaviour,
        life: Life,
        published: bool,
        /// An identified owner that found no data-control.
        no_data_control: bool,
    }

    /// A compositor with one selection, owner processes and other clients.
    /// Tests keep a handle and act as the rest of the desktop.
    #[derive(Default)]
    struct Compositor {
        processes: Vec<SimulatedProcess>,
        /// The selection: the index of the owning process, or another
        /// client's offer.
        selection: Option<Selection>,
        /// The compositor lacks data-control (GNOME's Mutter, cage).
        no_data_control: bool,
        next_behaviour: Option<Behaviour>,
        fail_spawn: bool,
        identified_spawns: usize,
        plain_spawns: usize,
        pauses: usize,
        reads: usize,
        /// 1-based numbers of the `wl-paste` reads that fail.
        failing_reads: Vec<usize>,
        /// Offers another client makes at the given 1-based pause number.
        scheduled: Vec<(usize, Selection)>,
    }

    #[derive(Clone)]
    enum Selection {
        Process(usize),
        /// Another client's file list, and the owner token it re-offers
        /// (a clipboard manager restoring one of our earlier writes).
        External {
            payload: Vec<u8>,
            token: Option<Vec<u8>>,
        },
    }

    impl Compositor {
        /// Whoever held the selection loses it: owners exit on cancel.
        fn cancel_owner(&mut self) {
            if let Some(Selection::Process(index)) = self.selection.take() {
                let process = &mut self.processes[index];
                if process.life == Life::Running {
                    process.life = Life::Exited;
                }
            }
        }

        fn set_external(&mut self, selection: Selection) {
            self.cancel_owner();
            self.selection = Some(selection);
        }

        fn run_turn(&mut self) {
            for index in 0..self.processes.len() {
                let process = &self.processes[index];
                if process.life == Life::Running
                    && !process.published
                    && matches!(
                        process.behaviour,
                        Behaviour::Publishes | Behaviour::ExitsAfterServing
                    )
                {
                    self.cancel_owner();
                    self.processes[index].published = true;
                    self.selection = Some(Selection::Process(index));
                }
            }
        }

        fn offer(&self, media_type: &str) -> Option<Vec<u8>> {
            let (payload, token) = match self.selection.as_ref()? {
                Selection::Process(index) => {
                    let process = &self.processes[*index];
                    (&process.payload, &process.token)
                }
                Selection::External { payload, token } => (payload, token),
            };
            match media_type {
                FILE_LIST_TYPE => Some(payload.clone()),
                OWNER_TYPE => token.clone(),
                other => panic!("unexpected read of {other}"),
            }
        }

        fn spawn(&mut self, payload: &[u8], token: Option<&str>) -> Result<usize, AppError> {
            if self.fail_spawn {
                return Err(AppError::Other("the owner is not installed".into()));
            }
            let behaviour = self.next_behaviour.take().unwrap_or(Behaviour::Publishes);
            let no_data_control = token.is_some() && self.no_data_control;
            self.processes.push(SimulatedProcess {
                payload: payload.to_vec(),
                token: token.map(|token| token.as_bytes().to_vec()),
                behaviour,
                life: if behaviour == Behaviour::ExitsAtOnce || no_data_control {
                    Life::Exited
                } else {
                    Life::Running
                },
                published: false,
                no_data_control,
            });
            Ok(self.processes.len() - 1)
        }
    }

    #[derive(Clone, Default)]
    struct Desktop(Rc<RefCell<Compositor>>);

    impl Desktop {
        fn backend(&self) -> WaylandBackend {
            WaylandBackend::with_session(Box::new(SimulatedSession(self.clone())))
        }

        fn coordinator(&self) -> FileClipboardCoordinator {
            FileClipboardCoordinator::new(Box::new(self.backend()))
        }

        fn without_data_control() -> Self {
            let desktop = Self::default();
            desktop.with(|compositor| compositor.no_data_control = true);
            desktop
        }

        fn with<T>(&self, apply: impl FnOnce(&mut Compositor) -> T) -> T {
            apply(&mut self.0.borrow_mut())
        }

        /// Another program (a file manager, a terminal) copies.
        fn external_copy(&self, payload: &str) {
            self.with(|compositor| {
                compositor.set_external(Selection::External {
                    payload: payload.as_bytes().to_vec(),
                    token: None,
                })
            });
        }

        /// Another client offers `payload` (and `token`) at the `pause`th
        /// pause from now.
        fn external_copy_at_pause(&self, pause: usize, payload: &str, token: Option<&str>) {
            self.with(|compositor| {
                compositor.scheduled.push((
                    compositor.pauses + pause,
                    Selection::External {
                        payload: payload.as_bytes().to_vec(),
                        token: token.map(|token| token.as_bytes().to_vec()),
                    },
                ))
            });
        }

        /// The held owner dies without being replaced (crash, OOM kill).
        fn crash_process(&self, index: usize) {
            self.with(|compositor| {
                compositor.processes[index].life = Life::Exited;
                if matches!(compositor.selection, Some(Selection::Process(owner)) if owner == index)
                {
                    compositor.selection = None;
                }
            });
        }

        fn next_spawn_behaves(&self, behaviour: Behaviour) {
            self.with(|compositor| compositor.next_behaviour = Some(behaviour));
        }

        fn lives(&self) -> Vec<Life> {
            self.with(|compositor| compositor.processes.iter().map(|p| p.life).collect())
        }

        fn pauses(&self) -> usize {
            self.with(|compositor| compositor.pauses)
        }

        fn spawns(&self) -> (usize, usize) {
            self.with(|compositor| (compositor.identified_spawns, compositor.plain_spawns))
        }

        fn offered_paths(&self) -> Vec<String> {
            self.with(|compositor| compositor.offer(FILE_LIST_TYPE))
                .map(|bytes| parse_gnome_copied_files(&String::from_utf8(bytes).unwrap()))
                .unwrap_or_default()
        }
    }

    struct SimulatedSession(Desktop);

    impl SimulatedSession {
        fn handle(&self, index: usize) -> Box<dyn OwnerProcess> {
            Box::new(SimulatedHandle {
                desktop: self.0.clone(),
                index,
            })
        }
    }

    impl WaylandSession for SimulatedSession {
        fn spawn_owner(
            &mut self,
            payload: &[u8],
            token: &str,
        ) -> Result<Box<dyn OwnerProcess>, AppError> {
            let index = self.0.with(|compositor| {
                compositor.identified_spawns += 1;
                compositor.spawn(payload, Some(token))
            })?;
            Ok(self.handle(index))
        }

        fn spawn_plain_owner(&mut self, payload: &[u8]) -> Result<Box<dyn OwnerProcess>, AppError> {
            let index = self.0.with(|compositor| {
                compositor.plain_spawns += 1;
                compositor.spawn(payload, None)
            })?;
            Ok(self.handle(index))
        }

        fn read_offer(&mut self, media_type: &str) -> Offer {
            self.0.with(|compositor| {
                compositor.reads += 1;
                if compositor.failing_reads.contains(&compositor.reads) {
                    return Offer::Unreadable("wl-paste exited with code 1: Broken pipe".into());
                }
                let offer = compositor
                    .offer(media_type)
                    .map_or(Offer::Empty, Offer::Bytes);
                if let Some(Selection::Process(index)) = compositor.selection {
                    if compositor.processes[index].behaviour == Behaviour::ExitsAfterServing {
                        compositor.processes[index].life = Life::Exited;
                        compositor.selection = None;
                    }
                }
                offer
            })
        }

        fn read_files(&mut self) -> Result<Vec<String>, AppError> {
            Ok(self.0.offered_paths())
        }

        fn pause(&mut self, _duration: Duration) {
            self.0.with(|compositor| {
                compositor.pauses += 1;
                let pause = compositor.pauses;
                let due: Vec<Selection> = compositor
                    .scheduled
                    .iter()
                    .filter(|(at, _)| *at == pause)
                    .map(|(_, selection)| selection.clone())
                    .collect();
                for selection in due {
                    compositor.set_external(selection);
                }
                compositor.run_turn();
            });
        }
    }

    struct SimulatedHandle {
        desktop: Desktop,
        index: usize,
    }

    impl OwnerProcess for SimulatedHandle {
        fn exit_status(&mut self) -> Option<OwnerExit> {
            self.desktop.with(|compositor| {
                let process = &mut compositor.processes[self.index];
                match process.life {
                    Life::Running => None,
                    Life::Exited | Life::Reaped => {
                        process.life = Life::Reaped;
                        Some(if process.no_data_control {
                            OwnerExit::NoDataControl
                        } else {
                            OwnerExit::Ended("exit status: 0".into())
                        })
                    }
                }
            })
        }

        fn stop(&mut self) {
            self.desktop.with(|compositor| {
                compositor.processes[self.index].life = Life::Reaped;
                if matches!(compositor.selection, Some(Selection::Process(owner)) if owner == self.index)
                {
                    compositor.selection = None;
                }
            });
        }
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    fn payload_of(list: &[&str]) -> String {
        gnome_copied_files(&paths_to_uris(&paths(list)))
    }

    fn entry(path: &str) -> serde_json::Value {
        serde_json::json!({ "name": path.rsplit('/').next(), "path": path })
    }

    /// The Cut was refused: no Cut survives in the clipboard snapshot, and no
    /// paste can claim one, so a later Paste copies.
    fn assert_cut_refused(coordinator: &mut FileClipboardCoordinator, error: AppError) {
        let message = error.to_string();
        assert!(
            message.contains("did not take the clipboard")
                || message.contains("Could not verify native Cut")
                || message.contains(CUT_NEEDS_DATA_CONTROL),
            "{message}"
        );
        let observed = coordinator.snapshot().unwrap();
        assert_eq!(observed.operation, None, "no Cut survives");
        assert!(!coordinator.claim_cut(observed.revision).unwrap());
    }

    #[test]
    fn a_published_write_is_owned_while_its_process_runs() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        assert_eq!(backend.cut_unavailable_reason(), None);
        backend
            .write_files(&paths(&["/tmp/a b.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap();
        assert_eq!(backend.owner_token().as_deref(), Some(TOKEN));
        assert_eq!(backend.read_files().unwrap(), paths(&["/tmp/a b.txt"]));
        assert_eq!(desktop.lives(), vec![Life::Running]);
        assert_eq!(desktop.spawns(), (1, 0), "an identified owner, not wl-copy");
        assert_eq!(backend.cut_unavailable_reason(), None);
    }

    #[test]
    fn a_write_returns_only_after_the_selection_offers_it() {
        // Otherwise the coordinator's next snapshot would read the previous
        // list and adopt it as an external replacement.
        let desktop = Desktop::default();
        desktop.external_copy("copy\nfile:///tmp/old.txt");
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/new.txt"]), ClipboardOperation::Copy, TOKEN)
            .unwrap();
        assert_eq!(desktop.offered_paths(), paths(&["/tmp/new.txt"]));
        assert!(desktop.pauses() >= 1);
    }

    #[test]
    fn another_client_taking_the_selection_ends_ownership_and_reaps_the_owner() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap();
        // Identical paths from another program still end our ownership.
        desktop.external_copy("copy\nfile:///tmp/a.txt");
        assert_eq!(desktop.lives(), vec![Life::Exited]);
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives(), vec![Life::Reaped]);
        assert_eq!(backend.owner_token(), None, "ownership never returns");
        assert_eq!(backend.read_files().unwrap(), paths(&["/tmp/a.txt"]));
    }

    #[test]
    fn an_owner_that_dies_loses_ownership() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap();
        desktop.crash_process(0);
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives(), vec![Life::Reaped]);
    }

    #[test]
    fn republishing_stops_and_reaps_the_previous_owner() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Copy, TOKEN)
            .unwrap();
        let next = "fedcba9876543210fedcba9876543210";
        // The same list again (Copy, then Cut of the same file): the new
        // owner proves itself by its own token.
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, next)
            .unwrap();
        assert_eq!(desktop.lives(), vec![Life::Reaped, Life::Running]);
        assert_eq!(backend.owner_token().as_deref(), Some(next));
        assert!(
            desktop.with(|compositor| matches!(compositor.selection, Some(Selection::Process(1)))),
            "the new process owns the selection"
        );
    }

    #[test]
    fn an_owner_that_exits_before_publishing_fails_the_write() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        desktop.next_spawn_behaves(Behaviour::ExitsAtOnce);
        let error = backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap_err();
        assert!(error.to_string().contains("before it owned"), "{error}");
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives(), vec![Life::Reaped]);
        assert_eq!(
            backend.cut_unavailable_reason(),
            None,
            "not a missing protocol"
        );
    }

    #[test]
    fn an_owner_that_never_publishes_times_out_and_is_stopped() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        desktop.next_spawn_behaves(Behaviour::NeverPublishes);
        let error = backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap_err();
        assert!(error.to_string().contains("did not take"), "{error}");
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives(), vec![Life::Reaped]);
        let pauses = desktop.pauses();
        assert!(
            (5..=100).contains(&pauses),
            "backs off rather than spinning: {pauses}"
        );
    }

    #[test]
    fn a_failed_write_leaves_no_owner_behind() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap();
        desktop.with(|compositor| compositor.fail_spawn = true);
        assert!(backend
            .write_files(
                &paths(&["/tmp/b.txt"]),
                ClipboardOperation::Cut,
                "f".repeat(32).as_str()
            )
            .is_err());
        assert_eq!(backend.owner_token(), None, "the earlier Cut was stopped");
        assert_eq!(desktop.lives(), vec![Life::Reaped]);
    }

    #[test]
    fn empty_writes_are_rejected_without_touching_the_owner() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap();
        let error = backend
            .write_files(&[], ClipboardOperation::Copy, TOKEN)
            .unwrap_err();
        assert!(matches!(error, AppError::InvalidPath(_)), "{error}");
        assert_eq!(backend.owner_token().as_deref(), Some(TOKEN));
    }

    #[test]
    fn an_identical_offer_during_the_publish_wait_never_proves_a_cut() {
        // #927: our owner runs but never takes the selection, and another
        // client offers the byte-identical list mid-wait (the user copies
        // the same file in a file manager). Matching bytes once credited that
        // offer to our owner; the Cut then survived, so Paste moved a file
        // the user had last copied elsewhere.
        for pause in [1, 3] {
            let desktop = Desktop::default();
            let mut coordinator = desktop.coordinator();
            desktop.next_spawn_behaves(Behaviour::NeverPublishes);
            desktop.external_copy_at_pause(pause, &payload_of(&["/tmp/a.txt"]), None);
            let error = coordinator
                .publish(vec![entry("/tmp/a.txt")], "cut")
                .unwrap_err();
            assert!(
                desktop.with(|compositor| matches!(
                    compositor.selection,
                    Some(Selection::External { .. })
                )),
                "the identical offer arrived during the wait"
            );
            assert_eq!(desktop.lives(), vec![Life::Reaped], "the owner is stopped");
            assert_cut_refused(&mut coordinator, error);
            assert_eq!(desktop.offered_paths(), paths(&["/tmp/a.txt"]));

            // Copy needs no proof and still works with the same list.
            let copy = coordinator
                .publish(vec![entry("/tmp/a.txt")], "copy")
                .unwrap();
            assert_eq!(copy.operation, Some(ClipboardOperation::Copy));
        }
    }

    #[test]
    fn a_restoring_clipboard_manager_never_turns_its_offer_into_our_cut() {
        // After `stop_owner` a clipboard manager restores the list we offered
        // before, even with that earlier write's token.
        let earlier = "fedcba9876543210fedcba9876543210";
        for operation in ["cut", "copy"] {
            let desktop = Desktop::default();
            let mut coordinator = desktop.coordinator();
            let first = coordinator
                .publish(vec![entry("/tmp/a.txt")], "cut")
                .unwrap();
            assert_eq!(first.operation, Some(ClipboardOperation::Cut));
            desktop.next_spawn_behaves(Behaviour::NeverPublishes);
            desktop.external_copy_at_pause(1, &payload_of(&["/tmp/a.txt"]), Some(earlier));
            let result = coordinator.publish(vec![entry("/tmp/a.txt")], operation);
            assert!(
                desktop.with(|compositor| matches!(
                    compositor.selection,
                    Some(Selection::External { .. })
                )),
                "the manager restored the list during the wait"
            );
            match result {
                Err(error) => {
                    assert_eq!(operation, "cut");
                    assert_cut_refused(&mut coordinator, error);
                }
                // A Copy whose owner never published keeps the app's Copy;
                // it never becomes a Cut.
                Ok(copy) => {
                    assert_eq!(operation, "copy");
                    assert_eq!(copy.operation, Some(ClipboardOperation::Copy));
                    assert!(copy.mirror_error.is_some());
                    let observed = coordinator.snapshot().unwrap();
                    assert_ne!(observed.operation, Some(ClipboardOperation::Cut));
                    assert!(!coordinator.claim_cut(observed.revision).unwrap());
                }
            }
        }
    }

    #[test]
    fn an_identified_owner_publishing_over_an_identical_offer_is_owned() {
        // The token, not the bytes, proves the write: an identical list
        // offered before or while our owner publishes no longer blocks Cut,
        // and the user's later identical Copy still demotes it.
        let desktop = Desktop::default();
        desktop.external_copy(&payload_of(&["/tmp/a.txt"]));
        desktop.external_copy_at_pause(1, &payload_of(&["/tmp/a.txt"]), None);
        let mut coordinator = desktop.coordinator();
        let cut = coordinator
            .publish(vec![entry("/tmp/a.txt")], "cut")
            .unwrap();
        assert_eq!(cut.operation, Some(ClipboardOperation::Cut));
        assert_eq!(coordinator.snapshot().unwrap(), cut);

        desktop.external_copy(&payload_of(&["/tmp/a.txt"]));
        let observed = coordinator.snapshot().unwrap();
        assert_eq!(observed.operation, None, "demoted to an external Copy");
        assert!(!coordinator.claim_cut(cut.revision).unwrap());
        assert!(!coordinator.claim_cut(observed.revision).unwrap());
    }

    #[test]
    fn an_owner_that_exits_right_after_serving_its_offer_fails_the_write() {
        // Seeing our token once is not enough: the owner must still be
        // running after that read, or nothing owns the selection.
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        desktop.next_spawn_behaves(Behaviour::ExitsAfterServing);
        let error = backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap_err();
        assert!(error.to_string().contains("before it owned"), "{error}");
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives(), vec![Life::Reaped]);
    }

    #[test]
    fn a_failed_read_back_serves_the_list_but_proves_nothing() {
        let desktop = Desktop::default();
        let mut backend = desktop.backend();
        desktop.with(|compositor| compositor.failing_reads = vec![1]);
        backend
            .write_files(&paths(&["/tmp/a.txt"]), ClipboardOperation::Cut, TOKEN)
            .unwrap();
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives(), vec![Life::Running]);
    }

    #[test]
    fn without_data_control_cut_fails_closed_and_copy_uses_wl_copy() {
        for preexisting in [None, Some(payload_of(&["/tmp/a.txt"]))] {
            let desktop = Desktop::without_data_control();
            if let Some(payload) = &preexisting {
                desktop.external_copy(payload);
            }
            let mut coordinator = desktop.coordinator();
            let error = coordinator
                .publish(vec![entry("/tmp/a.txt")], "cut")
                .unwrap_err();
            assert_cut_refused(&mut coordinator, error);
            // Even the wl-copy owner that served the list as a Copy did not
            // prove the Cut, whether or not the bytes were already offered.
            assert_eq!(desktop.spawns(), (1, 1));
            assert_eq!(desktop.offered_paths(), paths(&["/tmp/a.txt"]));

            // Known now: Cut is refused up front, without another owner.
            let error = coordinator
                .publish(vec![entry("/tmp/b.txt")], "cut")
                .unwrap_err();
            assert_eq!(error.to_string(), CUT_NEEDS_DATA_CONTROL);
            assert_eq!(desktop.spawns(), (1, 1));

            let copy = coordinator
                .publish(vec![entry("/tmp/b.txt")], "copy")
                .unwrap();
            assert_eq!(copy.operation, Some(ClipboardOperation::Copy));
            assert_eq!(copy.mirror_error, None);
            assert_eq!(desktop.offered_paths(), paths(&["/tmp/b.txt"]));
            assert_eq!(desktop.spawns(), (1, 2), "never retries data-control");
            assert_eq!(desktop.lives().last(), Some(&Life::Running));
        }
    }

    #[test]
    fn without_data_control_a_copy_waits_only_when_the_list_changes() {
        // The fallback still returns only once the new list is offered, so
        // the coordinator's next snapshot does not adopt the previous one.
        let desktop = Desktop::without_data_control();
        desktop.external_copy("copy\nfile:///tmp/old.txt");
        let mut backend = desktop.backend();
        backend
            .write_files(&paths(&["/tmp/new.txt"]), ClipboardOperation::Copy, TOKEN)
            .unwrap();
        assert_eq!(desktop.offered_paths(), paths(&["/tmp/new.txt"]));
        assert_eq!(backend.owner_token(), None);

        // A failed baseline read leaves nothing to wait for.
        let before = desktop.pauses();
        desktop.with(|compositor| compositor.failing_reads = vec![compositor.reads + 1]);
        desktop.next_spawn_behaves(Behaviour::NeverPublishes);
        backend
            .write_files(&paths(&["/tmp/other.txt"]), ClipboardOperation::Copy, TOKEN)
            .unwrap();
        assert_eq!(desktop.pauses(), before);
        assert_eq!(backend.owner_token(), None);
        assert_eq!(desktop.lives().last(), Some(&Life::Running));
    }

    #[test]
    fn an_owner_that_cannot_start_falls_back_to_wl_copy_without_cut() {
        struct NoOwnerProgram(SimulatedSession);
        impl WaylandSession for NoOwnerProgram {
            fn spawn_owner(
                &mut self,
                _: &[u8],
                _: &str,
            ) -> Result<Box<dyn OwnerProcess>, AppError> {
                Err(AppError::Other(
                    "The app's executable path is unknown".into(),
                ))
            }
            fn spawn_plain_owner(
                &mut self,
                payload: &[u8],
            ) -> Result<Box<dyn OwnerProcess>, AppError> {
                self.0.spawn_plain_owner(payload)
            }
            fn read_offer(&mut self, media_type: &str) -> Offer {
                self.0.read_offer(media_type)
            }
            fn read_files(&mut self) -> Result<Vec<String>, AppError> {
                self.0.read_files()
            }
            fn pause(&mut self, duration: Duration) {
                self.0.pause(duration)
            }
        }
        let desktop = Desktop::default();
        let mut coordinator =
            FileClipboardCoordinator::new(Box::new(WaylandBackend::with_session(Box::new(
                NoOwnerProgram(SimulatedSession(desktop.clone())),
            ))));
        let error = coordinator
            .publish(vec![entry("/tmp/a.txt")], "cut")
            .unwrap_err();
        assert_cut_refused(&mut coordinator, error);
        let copy = coordinator
            .publish(vec![entry("/tmp/a.txt")], "copy")
            .unwrap();
        assert_eq!(copy.operation, Some(ClipboardOperation::Copy));
        assert_eq!(desktop.offered_paths(), paths(&["/tmp/a.txt"]));
    }

    #[test]
    fn only_wl_paste_reports_of_an_empty_selection_read_as_empty() {
        let classify = |code: Option<i32>, stderr: &str| {
            classify_paste(code, b"out".to_vec(), stderr.as_bytes(), FILE_LIST_TYPE)
        };
        let wrong_type = |media_type: &str| {
            format!(
                "Clipboard content is not available as requested type \"{media_type}\"\n\
                 Use \"wl-paste --list-types\" to view available types.\n"
            )
        };
        assert_eq!(classify(Some(0), ""), Offer::Bytes(b"out".to_vec()));
        for empty in [
            "Nothing is copied\n".to_string(),
            "No selection\n".to_string(),
            "No suitable type of content copied\n".to_string(),
            wrong_type(FILE_LIST_TYPE),
        ] {
            assert_eq!(classify(Some(1), &empty), Offer::Empty, "{empty}");
        }
        for failure in [
            (
                Some(1),
                "Failed to connect to a Wayland server: No such file or directory\n\
                       Note: WAYLAND_DISPLAY is set to wayland-1\n"
                    .to_string(),
            ),
            (Some(1), "No such seat\n".to_string()),
            (Some(1), "pipe: Too many open files\n".to_string()),
            (Some(1), String::new()),
            (
                Some(1),
                "Nothing is copied\nNothing is copied\n".to_string(),
            ),
            (Some(1), wrong_type("text/plain")),
            (Some(2), "Nothing is copied\n".to_string()),
            (None, "Nothing is copied\n".to_string()),
        ] {
            assert!(
                matches!(classify(failure.0, &failure.1), Offer::Unreadable(_)),
                "{failure:?}"
            );
        }
    }

    #[test]
    fn a_read_that_cannot_start_or_finish_fails() {
        use std::process::Command;
        let missing = run_bounded(
            &mut Command::new("/nonexistent/wl-paste"),
            Duration::from_secs(1),
        );
        assert!(matches!(missing, Err(RunFailure::Spawn(_))));

        let started = Instant::now();
        let mut hung = Command::new("sleep");
        hung.arg("30");
        let hung = run_bounded(&mut hung, Duration::from_millis(100));
        assert!(matches!(hung, Err(RunFailure::Unfinished(_))));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "killed at the timeout"
        );

        let mut finished = Command::new("sh");
        finished.args([
            "-c",
            "printf out; printf 'Nothing is copied\\n' >&2; exit 1",
        ]);
        let Ok(run) = run_bounded(&mut finished, Duration::from_secs(5)) else {
            panic!("sh did not finish");
        };
        assert_eq!(
            classify_paste(run.code, run.stdout, &run.stderr, FILE_LIST_TYPE),
            Offer::Empty
        );
    }

    #[test]
    fn the_coordinator_admits_a_wayland_cut_and_demotes_it_on_replacement() {
        let desktop = Desktop::default();
        let mut coordinator = FileClipboardCoordinator::new(Box::new(desktop.backend()));
        let entry = serde_json::json!({ "name": "a.txt", "path": "/tmp/a.txt" });
        let cut = coordinator.publish(vec![entry], "cut").unwrap();
        assert_eq!(cut.operation, Some(ClipboardOperation::Cut));
        assert_eq!(coordinator.snapshot().unwrap(), cut);
        assert!(coordinator.claim_cut(cut.revision).unwrap());
        assert!(coordinator.release_cut(cut.revision));

        desktop.external_copy("copy\nfile:///tmp/a.txt");
        let observed = coordinator.snapshot().unwrap();
        assert_eq!(observed.paths, paths(&["/tmp/a.txt"]));
        assert_eq!(
            observed.operation, None,
            "identical paths are an external Copy"
        );
        assert!(!coordinator.claim_cut(cut.revision).unwrap());
        assert!(!coordinator.claim_cut(observed.revision).unwrap());
    }
}

/// The real owners against a private compositor. Never run it in a desktop
/// session: it replaces that session's clipboard. Build the app binary first
/// (`cargo build`), which runs the data-control owner. From `src-tauri/`, with
/// `cage` and `wtype` installed (`wtype` holds a virtual keyboard, which
/// `wl-copy` needs where the compositor lacks data-control):
///
/// ```sh
/// mkdir -m 700 -p /tmp/wl-test && env -u WAYLAND_DISPLAY -u DISPLAY \
///   XDG_RUNTIME_DIR=/tmp/wl-test WLR_BACKENDS=headless \
///   WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
///   TAURI_EXPLORER_BIN=$PWD/target/debug/tauri-explorer \
///   cage -- sh -c 'wtype -s 600000 x & PRIVATE_WAYLAND_CLIPBOARD=1 \
///   cargo test --lib -- --ignored wayland_owner_process'
/// ```
///
/// `cage` has no data-control, so this proves the fail-closed fallback. Under
/// a compositor with data-control (sway, Hyprland, KWin), also set
/// `PRIVATE_WAYLAND_DATA_CONTROL=1` to prove identified ownership instead.
/// Without one, `PRIVATE_WAYLAND_TEST_COMPOSITOR=1` makes the test serve the
/// in-process data-control test compositor at an absolute `WAYLAND_DISPLAY`
/// path, which every client then uses:
///
/// ```sh
/// mkdir -m 700 -p /tmp/wl-dc && env -u DISPLAY XDG_RUNTIME_DIR=/tmp/wl-dc \
///   WAYLAND_DISPLAY=/tmp/wl-dc/wayland-test PRIVATE_WAYLAND_CLIPBOARD=1 \
///   PRIVATE_WAYLAND_TEST_COMPOSITOR=1 \
///   TAURI_EXPLORER_BIN=$PWD/target/debug/tauri-explorer \
///   cargo test --lib -- --ignored wayland_owner_process
/// ```
#[cfg(test)]
mod real_wl_copy_tests {
    use super::*;
    use std::process::Command;

    fn backend() -> WaylandBackend {
        let program = std::env::var_os("TAURI_EXPLORER_BIN")
            .expect("TAURI_EXPLORER_BIN names the built app binary");
        WaylandBackend::with_session(Box::new(WlClipboard {
            owner_program: Some(program.into()),
        }))
    }

    fn types() -> Vec<String> {
        let types = Command::new("wl-paste")
            .arg("--list-types")
            .output()
            .unwrap();
        String::from_utf8_lossy(&types.stdout)
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    #[ignore = "replaces the Wayland clipboard; run inside a private compositor"]
    fn wayland_owner_process_proves_or_refuses_cut() {
        assert!(
            std::env::var_os("PRIVATE_WAYLAND_CLIPBOARD").is_some(),
            "refusing to replace a desktop clipboard: see the module comment"
        );
        let test_compositor = std::env::var_os("PRIVATE_WAYLAND_TEST_COMPOSITOR").is_some();
        if test_compositor {
            let socket = std::path::PathBuf::from(std::env::var_os("WAYLAND_DISPLAY").unwrap());
            assert!(
                socket.is_absolute(),
                "WAYLAND_DISPLAY names the socket path"
            );
            super::super::data_control::tests::serve_on_socket(socket);
        }
        let data_control =
            test_compositor || std::env::var_os("PRIVATE_WAYLAND_DATA_CONTROL").is_some();
        let mut session = WlClipboard::new();
        // The installed wl-paste's "nothing to paste" reports read as empty,
        // not as failures (which would refuse every Cut).
        assert!(Command::new("wl-copy")
            .arg("--clear")
            .status()
            .unwrap()
            .success());
        assert_eq!(session.read_offer(FILE_LIST_TYPE), Offer::Empty);
        assert!(Command::new("wl-copy")
            .arg("plain text")
            .status()
            .unwrap()
            .success());
        assert_eq!(session.read_offer(FILE_LIST_TYPE), Offer::Empty);
        assert_eq!(session.read_offer(OWNER_TYPE), Offer::Empty);

        let mut backend = backend();
        let file = vec!["/tmp/wayland owner é.txt".to_string()];
        let payload = b"copy\nfile:///tmp/wayland%20owner%20%C3%A9.txt";
        backend
            .write_files(&file, ClipboardOperation::Cut, "a".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.read_files().unwrap(), file);
        assert_eq!(
            session.read_offer(FILE_LIST_TYPE),
            Offer::Bytes(payload.to_vec())
        );

        if !data_control {
            // Only wl-copy can publish here: Copy is served, Cut is refused.
            assert_eq!(backend.owner_token(), None);
            assert_eq!(
                backend.cut_unavailable_reason(),
                Some(CUT_NEEDS_DATA_CONTROL)
            );
            assert_eq!(types(), vec![FILE_LIST_TYPE.to_owned()]);
            let other = vec!["/tmp/another owner.txt".to_string()];
            backend
                .write_files(&other, ClipboardOperation::Copy, "b".repeat(32).as_str())
                .unwrap();
            assert_eq!(backend.read_files().unwrap(), other);
            let _ = Command::new("wl-copy").arg("--clear").status();
            return;
        }

        assert_eq!(backend.owner_token(), Some("a".repeat(32)));
        assert_eq!(
            types(),
            vec![FILE_LIST_TYPE.to_owned(), OWNER_TYPE.to_owned()]
        );
        assert_eq!(
            session.read_offer(OWNER_TYPE),
            Offer::Bytes("a".repeat(32).into_bytes())
        );

        // Republishing the same list hands ownership to a new owner.
        backend
            .write_files(&file, ClipboardOperation::Cut, "b".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.owner_token(), Some("b".repeat(32)));

        // Another client takes the selection with identical bytes: the owner
        // exits and ownership ends.
        let status = Command::new("wl-copy")
            .args([
                "--type",
                FILE_LIST_TYPE,
                "copy\nfile:///tmp/wayland%20owner%20%C3%A9.txt",
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while backend.owner_token().is_some() {
            assert!(std::time::Instant::now() < deadline, "owner never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(backend.read_files().unwrap(), file, "same paths, new owner");

        // The token, not the bytes, proves the next write.
        backend
            .write_files(&file, ClipboardOperation::Cut, "c".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.owner_token(), Some("c".repeat(32)));
        let _ = Command::new("wl-copy").arg("--clear").status();
    }
}
