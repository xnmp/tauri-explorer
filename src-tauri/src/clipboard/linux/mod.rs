//! Linux (and other freedesktop) clipboards. Text, images and file-list reads
//! shell out to the session's clipboard CLI: `wl-paste`/`wl-copy` on Wayland,
//! `xclip` on X11. Those tools are runtime dependencies (the wl-clipboard and
//! xclip packages); when one is missing the operation reports how to install
//! it (#279) and file Copy keeps working in-app.
//!
//! The file-list backends differ by session: see `wayland.rs` (a held
//! `wl-copy --foreground` owner) and `x11.rs` (a `clipboard-rs` owner). Both
//! prove Cut ownership (#835, #877).

mod wayland;
mod x11;

use super::backend::{ClipboardBackend, ClipboardReader};
use super::file_uri::{
    gnome_copied_files, parse_file_uris, parse_gnome_copied_files, paths_to_uris,
};
use crate::error::AppError;
use std::process::{Command, Output, Stdio};

/// X11 proves Cut through its multi-target owner; without one (clipboard-rs
/// could not connect) it refuses Cut.
const CUT_NEEDS_X11_OWNERSHIP: &str =
    "Cut requires X11 clipboard ownership; Copy is available here";

/// Chosen once per process: the session type of our own environment does not
/// change while the app runs.
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
}

pub(in crate::clipboard) fn backend() -> Box<dyn ClipboardBackend> {
    if is_wayland() {
        Box::new(wayland::WaylandBackend::new())
    } else {
        Box::new(x11::X11Backend::new())
    }
}

pub(in crate::clipboard) fn reader() -> Box<dyn ClipboardReader> {
    Box::new(CliTool::for_session())
}

/// The clipboard command-line tool for the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CliTool {
    /// `wl-paste` / `wl-copy` from wl-clipboard.
    WlClipboard,
    /// `xclip`.
    Xclip,
}

impl CliTool {
    fn for_session() -> Self {
        if is_wayland() {
            Self::WlClipboard
        } else {
            Self::Xclip
        }
    }

    fn reader_name(self) -> &'static str {
        match self {
            Self::WlClipboard => "wl-paste",
            Self::Xclip => "xclip",
        }
    }

    fn writer_name(self) -> &'static str {
        match self {
            Self::WlClipboard => "wl-copy",
            Self::Xclip => "xclip",
        }
    }

    fn package(self) -> &'static str {
        match self {
            Self::WlClipboard => "wl-clipboard",
            Self::Xclip => "xclip",
        }
    }

    /// The command that prints the clipboard as `media_type` (or as plain
    /// text when `None`).
    fn read_command(self, media_type: Option<&str>) -> Command {
        let mut command = Command::new(self.reader_name());
        match (self, media_type) {
            (Self::WlClipboard, Some(media_type)) => {
                command.args(["--no-newline", "--type", media_type]);
            }
            (Self::WlClipboard, None) => {
                command.args(["--no-newline", "--type", "text"]);
            }
            (Self::Xclip, Some(media_type)) => {
                command.args(["-o", "-selection", "clipboard", "-t", media_type]);
            }
            (Self::Xclip, None) => {
                command.args(["-o", "-selection", "clipboard"]);
            }
        }
        command
    }

    fn list_types_command(self) -> Command {
        match self {
            Self::WlClipboard => {
                let mut command = Command::new("wl-paste");
                command.arg("--list-types");
                command
            }
            Self::Xclip => self.read_command(Some("TARGETS")),
        }
    }

    fn write_command(self, media_type: &str) -> Command {
        let mut command = Command::new(self.writer_name());
        match self {
            Self::WlClipboard => command.args(["--type", media_type]),
            Self::Xclip => command.args(["-i", "-selection", "clipboard", "-t", media_type]),
        };
        command
    }

    fn run_read(self, media_type: Option<&str>) -> Result<Output, AppError> {
        self.read_command(media_type)
            .output()
            .map_err(|error| tool_error(self.reader_name(), self.package(), error))
    }

    /// Read one MIME type. `Ok(None)` means the type isn't present (an empty
    /// clipboard is not an error); `Err` means the tool is unusable (#279).
    fn read_mime(self, media_type: &str) -> Result<Option<String>, AppError> {
        let output = self.run_read(Some(media_type))?;
        if !output.status.success() || output.stdout.is_empty() {
            return Ok(None);
        }
        Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
    }

    /// Own the clipboard with one MIME type. Failures carry the reason (#279).
    fn write_mime(self, media_type: &str, data: &[u8]) -> Result<(), AppError> {
        use std::io::Write;
        let tool = self.writer_name();
        let mut child = self
            .write_command(media_type)
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| tool_error(tool, self.package(), error))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(data)
                .map_err(|error| AppError::Other(format!("Failed to write to {tool}: {error}")))?;
        }
        // Close stdin to signal EOF.
        child.stdin.take();
        let status = child
            .wait()
            .map_err(|error| AppError::Other(format!("Failed to wait for {tool}: {error}")))?;
        if !status.success() {
            return Err(AppError::Other(format!("{tool} exited with {status}")));
        }
        Ok(())
    }

    /// File paths on the clipboard: `x-special/gnome-copied-files`
    /// (GNOME/XFCE/MATE) first, then `text/uri-list` (KDE and generic).
    /// `Ok(vec![])` = no file paths; `Err` = broken tooling (#279).
    fn read_file_paths(self) -> Result<Vec<String>, AppError> {
        if let Some(text) = self.read_mime("x-special/gnome-copied-files")? {
            let paths = parse_gnome_copied_files(&text);
            if !paths.is_empty() {
                return Ok(paths);
            }
        }
        if let Some(text) = self.read_mime("text/uri-list")? {
            let paths = parse_file_uris(&text);
            if !paths.is_empty() {
                return Ok(paths);
            }
        }
        Ok(Vec::new())
    }

    /// Write file paths in the format GTK file managers (Thunar, Nautilus,
    /// Nemo, Caja) paste.
    ///
    /// `wl-copy` and `xclip` own the clipboard with a single MIME type per
    /// invocation, and each invocation replaces the previous owner, so this
    /// cannot also offer `text/uri-list`. It writes the GNOME format; KDE
    /// paste of these copies needs a multi-target owner (the X11 backend has
    /// one).
    fn write_file_paths(self, paths: &[String]) -> Result<(), AppError> {
        if paths.is_empty() {
            return Err(AppError::InvalidPath("No paths to copy".into()));
        }
        let payload = gnome_copied_files(&paths_to_uris(paths));
        self.write_mime("x-special/gnome-copied-files", payload.as_bytes())
    }
}

impl ClipboardReader for CliTool {
    /// Read plain text without relying on WebKit's Clipboard API permission,
    /// which is unavailable in some packaged WebKitGTK sessions even when the
    /// terminal owns focus and the desktop clipboard has text (#732).
    fn read_text(&self) -> Result<String, AppError> {
        let output = self.run_read(None)?;
        if !output.status.success() {
            return Err(AppError::Other(format!(
                "{} exited with {}",
                self.reader_name(),
                output.status
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn has_image(&self) -> bool {
        self.has_image_result().unwrap_or(false)
    }

    fn read_image(&self, media_type: &str) -> Option<Vec<u8>> {
        self.read_image_result(media_type).ok().flatten()
    }

    fn has_image_result(&self) -> Result<bool, AppError> {
        let output = self
            .list_types_command()
            .output()
            .map_err(|error| tool_error(self.reader_name(), self.package(), error))?;
        if !output.status.success() {
            return Err(AppError::Other(format!(
                "Could not inspect clipboard: {} exited with {}",
                self.reader_name(),
                output.status
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|kind| matches!(kind.trim(), "image/png" | "image/jpeg")))
    }

    fn read_image_result(&self, media_type: &str) -> Result<Option<Vec<u8>>, AppError> {
        let types = self
            .list_types_command()
            .output()
            .map_err(|error| tool_error(self.reader_name(), self.package(), error))?;
        if !types.status.success() {
            return Err(AppError::Other(format!(
                "Could not inspect clipboard: {} exited with {}",
                self.reader_name(),
                types.status
            )));
        }
        if !String::from_utf8_lossy(&types.stdout)
            .lines()
            .any(|kind| kind.trim() == media_type)
        {
            return Ok(None);
        }
        let output = self.run_read(Some(media_type))?;
        if !output.status.success() || output.stdout.is_empty() {
            return Err(AppError::Other(format!(
                "Could not read clipboard image: {} exited with {}",
                self.reader_name(),
                output.status
            )));
        }
        if crate::user_report::report_image_media_type(&output.stdout) != Some(media_type) {
            return Err(AppError::Other(
                "Clipboard provider returned invalid image data".into(),
            ));
        }
        Ok(Some(output.stdout))
    }
}

/// A clipboard tool failed to start. Distinguish "not installed" — the
/// common, actionable case (#279) — from other spawn failures.
fn tool_error(tool: &str, package: &str, error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::NotFound {
        AppError::Other(format!(
            "{tool} is not installed — install {package} for clipboard file support"
        ))
    } else {
        AppError::Other(format!("Failed to start {tool}: {error}"))
    }
}
