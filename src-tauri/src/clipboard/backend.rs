//! The platform seam of the clipboard: what the ordered file-clipboard
//! coordinator and the stateless text/image commands need from an OS
//! clipboard. `clipboard/mod.rs` selects the platform implementation once.

use crate::error::AppError;
use serde::{Deserialize, Serialize};

/// The in-app meaning of a published file list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardOperation {
    Copy,
    Cut,
}

impl ClipboardOperation {
    pub(super) fn parse(operation: &str) -> Result<Self, AppError> {
        match operation {
            "copy" => Ok(Self::Copy),
            "cut" => Ok(Self::Cut),
            _ => Err(AppError::Other("Invalid clipboard operation".into())),
        }
    }
}

/// Who currently owns the OS selection, as far as the platform can tell.
/// Used only to decide whether an external program replaced the clipboard
/// with an identical file list while our own mirror write had failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SelectionOwner {
    /// The platform exposes no owner identity; paths are the only evidence
    /// (Wayland: another client's selection has no observable identity).
    Untracked,
    /// The platform tracks owners but this observation failed.
    // The macOS change count is always observable.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unknown,
    /// An opaque identity of the clipboard's current content: an X11 owner
    /// window, a Windows sequence number, the macOS change count.
    Known(u64),
}

impl SelectionOwner {
    /// Whether `now` proves the owner observed as `self` still owns the
    /// selection. An unknown observation never proves anything.
    pub(super) fn unchanged_at(self, now: SelectionOwner) -> bool {
        match (self, now) {
            (Self::Untracked, Self::Untracked) => true,
            (Self::Known(before), Self::Known(after)) => before == after,
            _ => false,
        }
    }
}

pub(super) const CUT_NEEDS_NATIVE_OWNERSHIP: &str =
    "Cut requires native clipboard ownership; Copy is available here";

/// The file-list half of an OS clipboard, owned by the single ordered worker
/// (so implementations may hold native state such as an owner process or a
/// recorded sequence number, and need not be `Send`).
///
/// Ownership contract: after `write_files(.., token)` succeeds, the backend
/// reports `owner_token() == Some(token)` for exactly as long as it can
/// prove that write still owns the OS clipboard. The coordinator admits a Cut
/// only on that proof, so every default here fails closed. Each platform
/// backend overrides `owner_token` and `cut_unavailable_reason` with its own
/// proof (#835, #877): an X11 token target, a held Wayland `wl-copy` owner,
/// and a private token type plus change counter on Windows and macOS.
pub(super) trait ClipboardBackend {
    /// File paths the OS clipboard currently offers. `Ok(vec![])` means no
    /// file list; `Err` means the clipboard tooling itself is unusable.
    fn read_files(&mut self) -> Result<Vec<String>, AppError>;

    /// Mirror `paths` to the OS clipboard as one write carrying `token`.
    fn write_files(
        &mut self,
        paths: &[String],
        operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError>;

    /// The token carried by the write that currently owns the OS clipboard,
    /// or `None` when no proof is available. Tokens are random per write, so
    /// equality with the token just written proves that write still owns it.
    fn owner_token(&mut self) -> Option<String> {
        None
    }

    /// Identity of the current selection owner, whoever it is.
    fn selection_owner(&mut self) -> SelectionOwner {
        SelectionOwner::Untracked
    }

    /// Why a Cut cannot be admitted before trying a write, or `None` when
    /// this backend can prove ownership of its writes.
    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        Some(CUT_NEEDS_NATIVE_OWNERSHIP)
    }
}

/// Stateless text and image reads, used outside the file-clipboard worker so
/// terminal paste and screenshots never queue behind a slow file-list write.
pub(super) trait ClipboardReader {
    fn read_text(&self) -> Result<String, AppError>;

    fn has_image(&self) -> bool;

    /// Bytes of the clipboard image in `media_type`, or `None` when the
    /// clipboard offers no image this backend can deliver in that type.
    fn read_image(&self, media_type: &str) -> Option<Vec<u8>>;

    /// Checked image operations distinguish an empty clipboard from failed
    /// tooling/encoding. Optional report attachment discovery may stay best-effort.
    fn has_image_result(&self) -> Result<bool, AppError> {
        Ok(self.has_image())
    }

    fn read_image_result(&self, media_type: &str) -> Result<Option<Vec<u8>>, AppError> {
        Ok(self.read_image(media_type))
    }
}
