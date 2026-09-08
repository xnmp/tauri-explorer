//! Data-only identities retained by native history, never accepted from IPC.
use std::{ffi::OsString, path::PathBuf, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntryIdentity {
    pub device: u64,
    pub inode: u64,
    pub ctime_seconds: i64,
    pub ctime_nanoseconds: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TrashArtifact {
    // Keep one data contract available to platform-independent history tests.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Freedesktop {
        root: PathBuf,
        name: OsString,
        original_path: PathBuf,
        metadata_digest: [u8; 32],
        metadata_identity: EntryIdentity,
        payload_identity: EntryIdentity,
    },
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    WindowsShell {
        /// Exact desktop-absolute Shell parsing name, without trailing NUL.
        parsing_name_utf16: Vec<u16>,
    },
}

impl TrashArtifact {
    pub(crate) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + 2 * std::mem::size_of::<usize>()
            + match self {
                Self::Freedesktop {
                    root,
                    name,
                    original_path,
                    ..
                } => root.capacity() + name.capacity() + original_path.capacity(),
                Self::WindowsShell { parsing_name_utf16 } => parsing_name_utf16.capacity() * 2,
            }
    }
}

/// A committed deletion can lack recovery (for example permanent UNC removal).
/// Warnings cannot turn that committed effect into retryable work.
#[derive(Clone, Debug, Default)]
pub(crate) struct TrashSuccess {
    pub artifact: Option<Arc<TrashArtifact>>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RestoreRequest {
    pub path: String,
    pub artifact: Arc<TrashArtifact>,
}
