//! Data-only identities retained by native history, never accepted from IPC.
use super::entry_version::EntryVersion;
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
        payload_version: EntryVersion,
    },
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    WindowsShell {
        /// Exact desktop-absolute Shell parsing name, without trailing NUL.
        parsing_name_utf16: Vec<u16>,
    },
    /// An item Tauri Explorer trashed and recorded itself (macOS, #863).
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    Recorded {
        trashed: PathBuf,
        original: PathBuf,
        device: u64,
        inode: u64,
        changed_seconds: i64,
        changed_nanos: i64,
        deleted_at: String,
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
                Self::Recorded {
                    trashed,
                    original,
                    deleted_at,
                    ..
                } => trashed.capacity() + original.capacity() + deleted_at.capacity(),
            }
    }

    /// The deletion record behind a [`TrashArtifact::Recorded`] artifact.
    #[cfg(unix)]
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub(crate) fn as_recorded(&self) -> Option<super::trash_origins::Record> {
        match self {
            Self::Recorded {
                trashed,
                original,
                device,
                inode,
                changed_seconds,
                changed_nanos,
                deleted_at,
            } => Some(super::trash_origins::Record {
                trashed: trashed.clone(),
                original: original.clone(),
                device: *device,
                inode: *inode,
                changed_seconds: *changed_seconds,
                changed_nanos: *changed_nanos,
                deleted_at: deleted_at.clone(),
            }),
            _ => None,
        }
    }
}

/// A committed deletion can lack recovery (for example permanent UNC removal).
/// Warnings cannot turn that committed effect into retryable work.
#[derive(Clone, Debug, Default)]
pub(crate) struct TrashSuccess {
    pub artifact: Option<Arc<TrashArtifact>>,
    /// A restore observes its actual destination parent and published object,
    /// so its next inverse need not reuse a parent identity from before Undo.
    pub publication: Option<Arc<super::mutation::PublishedEntry>>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RestoreRequest {
    pub path: String,
    // Only the Linux and Windows restore adapters read the captured artifact;
    // other platforms reject restore before touching it (#772).
    #[cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]
    pub artifact: Arc<TrashArtifact>,
}
