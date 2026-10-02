//! X11 file-list backend.
//!
//! `clipboard-rs` owns the CLIPBOARD selection with `text/uri-list`,
//! `x-special/gnome-copied-files` and an app-private token in one write, so
//! the token proves our write still owns the selection (#835). Reads go
//! through `xclip` like every other Linux read. `x11rb` identifies the
//! selection owner for the failed-mirror check. If `clipboard-rs` cannot
//! connect, writes fall back to `xclip` and Cut fails closed.

use super::{CliTool, CUT_NEEDS_X11_OWNERSHIP};
use crate::clipboard::backend::{ClipboardBackend, ClipboardOperation, SelectionOwner};
use crate::clipboard::file_uri::{gnome_copied_files, paths_to_uris};
use crate::error::AppError;

const FILE_CLIPBOARD_TOKEN: &str = "application/x-tauri-explorer-file-token";

pub(super) struct X11Backend {
    tool: CliTool,
    owner: Option<clipboard_rs::ClipboardContext>,
}

impl X11Backend {
    pub(super) fn new() -> Self {
        Self {
            tool: CliTool::Xclip,
            owner: clipboard_rs::ClipboardContext::new().ok(),
        }
    }
}

impl ClipboardBackend for X11Backend {
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        self.tool.read_file_paths()
    }

    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError> {
        use clipboard_rs::{Clipboard, ClipboardContent};
        let Some(owner) = &self.owner else {
            return self.tool.write_file_paths(paths);
        };
        let uris = paths_to_uris(paths);
        let payload = gnome_copied_files(&uris);
        owner
            .set(vec![
                ClipboardContent::Files(uris),
                ClipboardContent::Other(
                    "x-special/gnome-copied-files".into(),
                    payload.into_bytes(),
                ),
                ClipboardContent::Other(FILE_CLIPBOARD_TOKEN.into(), token.as_bytes().to_vec()),
            ])
            .map_err(|error| AppError::Other(format!("X11 clipboard write failed: {error}")))
    }

    fn owner_token(&mut self) -> Option<String> {
        use clipboard_rs::Clipboard;
        self.owner
            .as_ref()?
            .get_buffer(FILE_CLIPBOARD_TOKEN)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    }

    fn selection_owner(&mut self) -> SelectionOwner {
        x11_selection_owner().map_or(SelectionOwner::Unknown, |owner| {
            SelectionOwner::Known(owner.into())
        })
    }

    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        self.owner.is_none().then_some(CUT_NEEDS_X11_OWNERSHIP)
    }
}

/// The window that owns CLIPBOARD, over a fresh connection so it reflects the
/// server's current state.
#[cfg(target_os = "linux")]
fn x11_selection_owner() -> Option<u32> {
    use x11rb::protocol::xproto::ConnectionExt;
    let (connection, _) = x11rb::connect(None).ok()?;
    let atom = connection
        .intern_atom(false, b"CLIPBOARD")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let owner = connection
        .get_selection_owner(atom)
        .ok()?
        .reply()
        .ok()?
        .owner;
    Some(owner)
}

/// `x11rb` is a Linux-only dependency (Cargo.toml). Elsewhere the owner is
/// unknown, so a failed Copy mirror yields to whatever the OS list shows.
#[cfg(not(target_os = "linux"))]
fn x11_selection_owner() -> Option<u32> {
    None
}

#[cfg(all(test, target_os = "linux"))]
mod clipboard_coordinator_x11_tests {
    use super::*;
    use crate::clipboard::coordinator::FileClipboardCoordinator;
    use clipboard_rs::{Clipboard, ClipboardContent, ClipboardContext};
    use std::process::Command;

    /// The real X11 backend whose writes fail: a write-only mirror failure
    /// while OS reads and owner identity stay real.
    struct FailingWrites(X11Backend);

    impl ClipboardBackend for FailingWrites {
        fn read_files(&mut self) -> Result<Vec<String>, AppError> {
            self.0.read_files()
        }

        fn write_files(
            &mut self,
            _paths: &[String],
            _operation: ClipboardOperation,
            _token: &str,
        ) -> Result<(), AppError> {
            Err(AppError::Other("simulated write-only failure".into()))
        }

        fn owner_token(&mut self) -> Option<String> {
            self.0.owner_token()
        }

        fn selection_owner(&mut self) -> SelectionOwner {
            self.0.selection_owner()
        }
    }

    fn entry(path: &str) -> serde_json::Value {
        serde_json::json!({ "name": path.rsplit('/').next(), "path": path })
    }

    // Run on a private display with WAYLAND_DISPLAY unset:
    // env -u WAYLAND_DISPLAY xvfb-run -a cargo test -- --ignored clipboard_coordinator_x11
    #[test]
    #[ignore = "requires a private X11 display and xclip"]
    fn x11_cut_identity_and_external_file_formats() {
        assert!(
            std::env::var("WAYLAND_DISPLAY").is_err(),
            "unset WAYLAND_DISPLAY so the X11 backend is exercised"
        );
        let backend = X11Backend::new();
        assert_eq!(
            backend.cut_unavailable_reason(),
            None,
            "clipboard-rs connects"
        );
        let mut coordinator = FileClipboardCoordinator::new(Box::new(backend));

        let cut = coordinator
            .publish(vec![entry("/tmp/same.txt")], "cut")
            .unwrap();
        assert_eq!(cut.operation, Some(ClipboardOperation::Cut));
        assert_eq!(coordinator.snapshot().unwrap(), cut);
        let targets = Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", "TARGETS"])
            .output()
            .unwrap();
        let formats = String::from_utf8_lossy(&targets.stdout);
        assert!(
            formats.contains("x-special/gnome-copied-files"),
            "{formats}"
        );
        assert!(formats.contains("text/uri-list"), "{formats}");
        assert!(formats.contains(FILE_CLIPBOARD_TOKEN), "{formats}");

        let renamed = coordinator
            .rekey(cut.revision, "/tmp/same.txt", entry("/tmp/renamed.txt"))
            .unwrap()
            .unwrap();
        assert_eq!(renamed.paths, vec!["/tmp/renamed.txt"]);
        assert_eq!(coordinator.snapshot().unwrap(), renamed);
        assert!(
            !coordinator.claim_cut(cut.revision).unwrap(),
            "rekey replaced the revision"
        );
        assert!(coordinator.claim_cut(renamed.revision).unwrap());
        assert!(!coordinator.claim_cut(renamed.revision).unwrap());
        assert!(coordinator.release_cut(renamed.revision));

        // A different owner advertises the identical renamed file list,
        // without our private token. Cut must become external Copy.
        let external = ClipboardContext::new().unwrap();
        external
            .set(vec![ClipboardContent::Files(vec![
                "file:///tmp/renamed.txt".into(),
            ])])
            .unwrap();
        let observed = coordinator.snapshot().unwrap();
        assert_eq!(observed.paths, vec!["/tmp/renamed.txt"]);
        assert!(observed.entries.is_none());
        assert!(observed.operation.is_none());
        assert!(!coordinator.clear(renamed.revision).unwrap());
        assert!(coordinator
            .rekey(renamed.revision, "/tmp/renamed.txt", entry("/tmp/same.txt"))
            .unwrap()
            .is_none());

        // A failed Copy mirror stays usable while the real owner and list are
        // unchanged, and yields to a new owner even with identical paths.
        external
            .set_files(vec!["file:///tmp/baseline.txt".into()])
            .unwrap();
        let mut failing = FileClipboardCoordinator::new(Box::new(FailingWrites(X11Backend::new())));
        let failed = failing
            .publish(vec![entry("/tmp/failed.txt")], "copy")
            .unwrap();
        assert!(failed.mirror_error.is_some());
        assert_eq!(failing.snapshot().unwrap(), failed);

        let same_paths_new_owner = ClipboardContext::new().unwrap();
        same_paths_new_owner
            .set_files(vec!["file:///tmp/baseline.txt".into()])
            .unwrap();
        let same = failing.snapshot().unwrap();
        assert_eq!(same.paths, vec!["/tmp/baseline.txt"]);
        assert!(same.entries.is_none());
        assert!(same.operation.is_none());

        failing
            .publish(vec![entry("/tmp/failed-again.txt")], "copy")
            .unwrap();
        let changed_owner = ClipboardContext::new().unwrap();
        changed_owner
            .set_files(vec!["file:///tmp/external.txt".into()])
            .unwrap();
        let changed = failing.snapshot().unwrap();
        assert_eq!(changed.paths, vec!["/tmp/external.txt"]);
        assert!(changed.entries.is_none());
        assert!(changed.operation.is_none());

        // The process-wide worker selects this backend and completes a job
        // whose IPC reply was dropped (renderer cancellation).
        let (reply, received) = tokio::sync::oneshot::channel();
        crate::clipboard::clipboard_queue()
            .send(crate::clipboard::FileClipboardJob::Publish {
                entries: vec![entry("/tmp/survives.txt")],
                operation: "copy".into(),
                reply,
            })
            .unwrap();
        drop(received);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let after_cancel = runtime
            .block_on(crate::clipboard::clipboard_snapshot())
            .unwrap();
        assert_eq!(after_cancel.paths, vec!["/tmp/survives.txt"]);
        assert_eq!(after_cancel.operation, Some(ClipboardOperation::Copy));
    }
}
