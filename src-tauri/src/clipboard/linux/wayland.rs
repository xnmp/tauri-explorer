//! Wayland file-list backend: `wl-copy` / `wl-paste`.
//!
//! Each `wl-copy` invocation offers a single MIME type from a detached
//! background server the app does not observe, so this backend cannot yet
//! prove that a write still owns the selection and Cut fails closed. #877 plans a held
//! `wl-copy --foreground` owner process here: ownership lasts while that child
//! is alive, which only requires overriding `owner_token` and
//! `cut_unavailable_reason`.

use super::{CliTool, CUT_NEEDS_X11_OWNERSHIP};
use crate::clipboard::backend::{ClipboardBackend, ClipboardOperation};
use crate::error::AppError;

pub(super) struct WaylandBackend {
    tool: CliTool,
}

impl WaylandBackend {
    pub(super) fn new() -> Self {
        Self {
            tool: CliTool::WlClipboard,
        }
    }
}

impl ClipboardBackend for WaylandBackend {
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        self.tool.read_file_paths()
    }

    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        _token: &str,
    ) -> Result<(), AppError> {
        self.tool.write_file_paths(paths)
    }

    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        Some(CUT_NEEDS_X11_OWNERSHIP)
    }
}
