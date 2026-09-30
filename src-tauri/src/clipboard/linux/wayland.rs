//! Wayland file-list backend: a held `wl-copy --foreground` owner (#877).
//!
//! Every write starts one `wl-copy --foreground` child that serves the file
//! list and keeps it as plain worker-owned state. `wl-copy` exits as soon as
//! another client takes the selection, so the selection is ours exactly while
//! that child runs: `owner_token` returns the write's token until the child
//! has exited. Reads, and the check that a new owner has published, go
//! through `wl-paste`.
//!
//! Lifecycle of the child:
//! - A write stops (kills and reaps) the previous owner before starting the
//!   next. While the old owner served an identical list, a read-back could
//!   not show whether the new owner had published yet.
//! - An owner that exited (replaced by another program, or crashed) is reaped
//!   by the next ownership check.
//! - At app exit the last owner is deliberately left running. The file-list
//!   mirror always carries Copy semantics, so it cannot move files, and
//!   other programs can still paste the last Copy after the app quits, as
//!   they could when `wl-copy` forked its own background server. The worker
//!   is a process-wide static that is never dropped, so no destructor runs;
//!   the child is started in `/` so it cannot keep a removable volume busy.
//!
//! `wl-copy` offers one payload per process, so this backend offers only
//! `x-special/gnome-copied-files` (pasted by Thunar, Nautilus, Nemo and
//! Caja), not the multi-target set of the X11 owner. The plan in #877 named
//! `text/uri-list`; one payload cannot carry both, and switching would stop
//! GTK file managers from pasting what they paste today. `wl-copy` also
//! offers `text/plain` aliases for `text/*` types, which would put our
//! URI list into terminals.

use super::{tool_error, CliTool};
use crate::clipboard::backend::{ClipboardBackend, ClipboardOperation};
use crate::clipboard::file_uri::{gnome_copied_files, paths_to_uris};
use crate::error::AppError;
use std::time::Duration;

const FILE_LIST_TYPE: &str = "x-special/gnome-copied-files";

/// How long a new owner may take to publish its selection. `wl-copy`
/// usually publishes within a few milliseconds.
const PUBLISH_TIMEOUT: Duration = Duration::from_secs(2);
const FIRST_POLL: Duration = Duration::from_millis(2);
const MAX_POLL: Duration = Duration::from_millis(50);

/// A running process that serves the selection.
pub(super) trait OwnerProcess {
    /// `None` while the process runs; once it has exited (and been reaped),
    /// how it ended.
    fn exit_status(&mut self) -> Option<String>;

    /// Stop the process and reap it.
    fn stop(&mut self);
}

/// The Wayland clipboard tooling this backend drives. `WlClipboard` is the
/// real session; tests substitute a simulated compositor.
pub(super) trait WaylandSession {
    /// Start an owner serving `payload` as `media_type`. It keeps running
    /// until another client takes the selection or it is stopped.
    fn spawn_owner(
        &mut self,
        media_type: &str,
        payload: &[u8],
    ) -> Result<Box<dyn OwnerProcess>, AppError>;

    /// The bytes the selection currently offers as `media_type`, if any.
    fn read_offer(&mut self, media_type: &str) -> Option<Vec<u8>>;

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

pub(super) struct WaylandBackend {
    session: Box<dyn WaylandSession>,
    owner: Option<Owner>,
}

impl WaylandBackend {
    pub(super) fn new() -> Self {
        Self::with_session(Box::new(WlClipboard))
    }

    fn with_session(session: Box<dyn WaylandSession>) -> Self {
        Self {
            session,
            owner: None,
        }
    }

    fn stop_owner(&mut self) {
        if let Some(mut owner) = self.owner.take() {
            owner.process.stop();
        }
    }

    /// Wait until the selection offers `payload` while `process` still runs.
    /// The caller has checked that the selection did not already offer
    /// `payload`, so seeing it proves that some client published it since;
    /// a process still alive after that read is the publisher, or will
    /// publish: a client that took the selection later would have ended it.
    fn await_published(
        &mut self,
        process: &mut dyn OwnerProcess,
        payload: &[u8],
    ) -> Result<(), AppError> {
        let mut waited = Duration::ZERO;
        let mut poll = FIRST_POLL;
        loop {
            if let Some(status) = process.exit_status() {
                return Err(AppError::Other(format!(
                    "wl-copy exited ({status}) before it owned the clipboard"
                )));
            }
            let offered = self.session.read_offer(FILE_LIST_TYPE);
            if offered.as_deref() == Some(payload) && process.exit_status().is_none() {
                return Ok(());
            }
            if waited >= PUBLISH_TIMEOUT {
                return Err(AppError::Other(format!(
                    "wl-copy did not take the clipboard within {}s",
                    PUBLISH_TIMEOUT.as_secs()
                )));
            }
            self.session.pause(poll);
            waited += poll;
            poll = (poll * 2).min(MAX_POLL);
        }
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
        self.stop_owner();
        // Another client (a file manager, a previous app instance) may already
        // offer these exact bytes; then their visibility cannot show that our
        // process published, and paths alone must never keep a Cut (#835).
        // Serve the list anyway so Copy works, but vouch for nothing.
        let baseline = self.session.read_offer(FILE_LIST_TYPE);
        let mut process = self.session.spawn_owner(FILE_LIST_TYPE, &payload)?;
        let provable = baseline.as_deref() != Some(payload.as_slice());
        if provable {
            if let Err(error) = self.await_published(process.as_mut(), &payload) {
                process.stop();
                return Err(error);
            }
        }
        self.owner = Some(Owner {
            token: provable.then(|| token.to_owned()),
            process,
        });
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
        None
    }
}

/// The real session: `wl-copy` owners and `wl-paste` reads.
struct WlClipboard;

impl WaylandSession for WlClipboard {
    fn spawn_owner(
        &mut self,
        media_type: &str,
        payload: &[u8],
    ) -> Result<Box<dyn OwnerProcess>, AppError> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("wl-copy")
            .args(["--foreground", "--type", media_type])
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| tool_error("wl-copy", "wl-clipboard", error))?;
        // Dropping stdin after the write closes it: wl-copy reads to EOF
        // before it offers the selection.
        let written = child
            .stdin
            .take()
            .map_or(Ok(()), |mut stdin| stdin.write_all(payload));
        let mut process = HeldWlCopy(child);
        if let Err(error) = written {
            process.stop();
            return Err(AppError::Other(format!(
                "Failed to write to wl-copy: {error}"
            )));
        }
        Ok(Box::new(process))
    }

    fn read_offer(&mut self, media_type: &str) -> Option<Vec<u8>> {
        CliTool::WlClipboard
            .read_mime(media_type)
            .ok()
            .flatten()
            .map(String::into_bytes)
    }

    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        CliTool::WlClipboard.read_file_paths()
    }

    fn pause(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

struct HeldWlCopy(std::process::Child);

impl OwnerProcess for HeldWlCopy {
    fn exit_status(&mut self) -> Option<String> {
        match self.0.try_wait() {
            Ok(None) => None,
            Ok(Some(status)) => Some(status.to_string()),
            // Unobservable counts as gone: ownership must be proven.
            Err(error) => Some(format!("unobservable: {error}")),
        }
    }

    fn stop(&mut self) {
        // Either may fail only because the child already exited and was
        // reaped, which is the goal.
        let _ = self.0.kill();
        let _ = self.0.wait();
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

    /// How a simulated `wl-copy` behaves after it starts.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Behaviour {
        /// Publishes on the compositor's next turn (the first pause).
        Publishes,
        /// Exits before publishing (e.g. no seat or no data-control).
        ExitsAtOnce,
        /// Runs but never publishes (a wedged compositor).
        NeverPublishes,
        /// Publishes, then exits after serving its first paste (as
        /// `wl-copy --paste-once` would, or a crash right after publishing).
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
        behaviour: Behaviour,
        life: Life,
        published: bool,
    }

    /// A compositor with one selection, `wl-copy` processes and other
    /// clients. Tests keep a handle and act as the rest of the desktop.
    #[derive(Default)]
    struct Compositor {
        processes: Vec<SimulatedProcess>,
        /// The selection: the index of the owning process, or another
        /// client's payload.
        selection: Option<Selection>,
        next_behaviour: Option<Behaviour>,
        fail_spawn: bool,
        pauses: usize,
    }

    #[derive(Clone)]
    enum Selection {
        Process(usize),
        External(Vec<u8>),
    }

    impl Compositor {
        /// Whoever held the selection loses it: `wl-copy` exits on cancel.
        fn cancel_owner(&mut self) {
            if let Some(Selection::Process(index)) = self.selection.take() {
                let process = &mut self.processes[index];
                if process.life == Life::Running {
                    process.life = Life::Exited;
                }
            }
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

        fn offer(&self) -> Option<Vec<u8>> {
            match self.selection.as_ref()? {
                Selection::Process(index) => Some(self.processes[*index].payload.clone()),
                Selection::External(payload) => Some(payload.clone()),
            }
        }
    }

    #[derive(Clone, Default)]
    struct Desktop(Rc<RefCell<Compositor>>);

    impl Desktop {
        fn backend(&self) -> WaylandBackend {
            WaylandBackend::with_session(Box::new(SimulatedSession(self.clone())))
        }

        fn with<T>(&self, apply: impl FnOnce(&mut Compositor) -> T) -> T {
            apply(&mut self.0.borrow_mut())
        }

        /// Another program (a file manager, a terminal) copies.
        fn external_copy(&self, payload: &str) {
            self.with(|compositor| {
                compositor.cancel_owner();
                compositor.selection = Some(Selection::External(payload.as_bytes().to_vec()));
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

        fn offered_paths(&self) -> Vec<String> {
            self.with(|compositor| compositor.offer())
                .map(|bytes| parse_gnome_copied_files(&String::from_utf8(bytes).unwrap()))
                .unwrap_or_default()
        }
    }

    struct SimulatedSession(Desktop);

    impl WaylandSession for SimulatedSession {
        fn spawn_owner(
            &mut self,
            media_type: &str,
            payload: &[u8],
        ) -> Result<Box<dyn OwnerProcess>, AppError> {
            assert_eq!(media_type, FILE_LIST_TYPE);
            self.0.with(|compositor| {
                if compositor.fail_spawn {
                    return Err(AppError::Other("wl-copy is not installed".into()));
                }
                let behaviour = compositor
                    .next_behaviour
                    .take()
                    .unwrap_or(Behaviour::Publishes);
                compositor.processes.push(SimulatedProcess {
                    payload: payload.to_vec(),
                    behaviour,
                    life: if behaviour == Behaviour::ExitsAtOnce {
                        Life::Exited
                    } else {
                        Life::Running
                    },
                    published: false,
                });
                Ok(())
            })?;
            let index = self.0.with(|compositor| compositor.processes.len() - 1);
            Ok(Box::new(SimulatedHandle {
                desktop: self.0.clone(),
                index,
            }))
        }

        fn read_offer(&mut self, media_type: &str) -> Option<Vec<u8>> {
            assert_eq!(media_type, FILE_LIST_TYPE);
            self.0.with(|compositor| {
                let offer = compositor.offer();
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
                compositor.run_turn();
            });
        }
    }

    struct SimulatedHandle {
        desktop: Desktop,
        index: usize,
    }

    impl OwnerProcess for SimulatedHandle {
        fn exit_status(&mut self) -> Option<String> {
            self.desktop.with(|compositor| {
                let process = &mut compositor.processes[self.index];
                match process.life {
                    Life::Running => None,
                    Life::Exited | Life::Reaped => {
                        process.life = Life::Reaped;
                        Some("exit status: 0".into())
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
        assert!(desktop.with(|compositor| compositor.pauses) >= 1);
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
        // The same list again (Copy, then Cut of the same file): only the new
        // process may be credited with publishing it.
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
        let pauses = desktop.with(|compositor| compositor.pauses);
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

    fn payload_of(list: &[&str]) -> String {
        gnome_copied_files(&paths_to_uris(&paths(list)))
    }

    #[test]
    fn an_identical_preexisting_offer_never_proves_a_cut() {
        // Nautilus, Nemo or Caja (or a previous app instance's owner) already
        // offer the byte-identical list, so its visibility cannot show that
        // our owner published. Otherwise a Cut would outlive the user's later
        // external Copy of the same file, and Paste would move it (#835).
        for behaviour in [Behaviour::NeverPublishes, Behaviour::Publishes] {
            let desktop = Desktop::default();
            desktop.external_copy(&payload_of(&["/tmp/a.txt"]));
            desktop.next_spawn_behaves(behaviour);
            let mut coordinator = FileClipboardCoordinator::new(Box::new(desktop.backend()));
            let entry = serde_json::json!({ "name": "a.txt", "path": "/tmp/a.txt" });
            let error = coordinator.publish(vec![entry.clone()], "cut").unwrap_err();
            assert!(
                error.to_string().contains("Could not verify native Cut"),
                "{error}"
            );
            assert!(
                desktop.with(|compositor| compositor.pauses) == 0,
                "an unprovable write does not wait for the publish timeout"
            );

            desktop.external_copy(&payload_of(&["/tmp/a.txt"]));
            let observed = coordinator.snapshot().unwrap();
            assert_eq!(observed.operation, None, "no Cut survives");
            assert!(!coordinator.claim_cut(observed.revision).unwrap());

            // Copy needs no proof: it is admitted with the same list.
            desktop.external_copy(&payload_of(&["/tmp/a.txt"]));
            let copy = coordinator.publish(vec![entry], "copy").unwrap();
            assert_eq!(copy.operation, Some(ClipboardOperation::Copy));
            assert_eq!(copy.mirror_error, None);
        }
    }

    #[test]
    fn an_owner_that_exits_right_after_serving_its_offer_fails_the_write() {
        // Seeing our payload once is not enough: the owner must still be
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

/// Real `wl-copy` against a private compositor. Never run it in a desktop
/// session: it replaces that session's clipboard. From `src-tauri/`, with
/// `cage` and `wtype` installed (`wtype` holds a virtual keyboard, which
/// `wl-copy` needs where the compositor lacks data-control):
///
/// ```sh
/// mkdir -m 700 -p /tmp/wl-test && env -u WAYLAND_DISPLAY -u DISPLAY \
///   XDG_RUNTIME_DIR=/tmp/wl-test WLR_BACKENDS=headless \
///   WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
///   cage -- sh -c 'wtype -s 600000 x & PRIVATE_WAYLAND_CLIPBOARD=1 \
///   cargo test --lib -- --ignored wayland_owner_process'
/// ```
#[cfg(test)]
mod real_wl_copy_tests {
    use super::*;
    use std::process::Command;

    #[test]
    #[ignore = "replaces the Wayland clipboard; run inside a private compositor"]
    fn wayland_owner_process_proves_and_loses_ownership() {
        assert!(
            std::env::var_os("PRIVATE_WAYLAND_CLIPBOARD").is_some(),
            "refusing to replace a desktop clipboard: see the module comment"
        );
        let mut backend = WaylandBackend::new();
        let file = vec!["/tmp/wayland owner é.txt".to_string()];
        backend
            .write_files(&file, ClipboardOperation::Cut, "a".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.owner_token(), Some("a".repeat(32)));
        assert_eq!(backend.read_files().unwrap(), file);
        let types = Command::new("wl-paste")
            .arg("--list-types")
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&types.stdout).trim(),
            FILE_LIST_TYPE
        );

        // Republishing the same list hands ownership to a new process.
        backend
            .write_files(&file, ClipboardOperation::Cut, "b".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.owner_token(), Some("b".repeat(32)));

        // Another client takes the selection: wl-copy exits, ownership ends.
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

        // That client offers our exact bytes, so a new write cannot prove it
        // published: it serves the list but never vouches for a Cut.
        backend
            .write_files(&file, ClipboardOperation::Cut, "c".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.owner_token(), None);
        assert_eq!(backend.read_files().unwrap(), file);

        let other = vec!["/tmp/another owner.txt".to_string()];
        backend
            .write_files(&other, ClipboardOperation::Cut, "d".repeat(32).as_str())
            .unwrap();
        assert_eq!(backend.owner_token(), Some("d".repeat(32)));
        let _ = Command::new("wl-copy").arg("--clear").status();
    }
}
