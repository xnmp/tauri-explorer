//! Host capabilities that shape recorded file history.

/// Whether this host can restore a trashed entry to its original location.
/// macOS exposes no trash-restore API, so its deletions and copies record no
/// restorable inverse.
pub(crate) const TRASH_RESTORE_SUPPORTED: bool = !cfg!(target_os = "macos");

/// Whether recorded deletions and copies may be undone through the trash.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TrashRestore {
    Supported,
    Unsupported,
}

impl TrashRestore {
    pub(crate) const HOST: Self = if TRASH_RESTORE_SUPPORTED {
        Self::Supported
    } else {
        Self::Unsupported
    };
}
