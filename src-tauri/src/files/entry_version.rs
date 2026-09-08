//! Pure, bounded observations of an entry; independent of recovery storage.
use super::object_id::ObjectId;
use serde::{Deserialize, Serialize};

/// Rename/link operations change ctime without changing the retained payload.
/// This version detects ordinary content and Unix mode/ownership changes while
/// surviving those namespace operations. It is not a content hash or a recursive
/// snapshot: restored timestamps, xattrs, nested writes and inode reuse require
/// stronger evidence than this observation provides.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EntryVersion {
    pub object: ObjectId,
    pub size: u64,
    pub modified_seconds: i64,
    pub modified_nanos: u32,
    pub directory: bool,
    pub symlink: bool,
    #[cfg(unix)]
    pub mode: u32,
    #[cfg(unix)]
    pub uid: u32,
    #[cfg(unix)]
    pub gid: u32,
}

impl EntryVersion {
    pub(super) fn validate(&self) -> std::io::Result<()> {
        let valid = self.modified_nanos < 1_000_000_000 && !(self.directory && self.symlink);
        #[cfg(unix)]
        let valid = valid
            && self.mode & !0o177777 == 0
            && matches!(
                self.mode & 0o170000,
                0o010000 | 0o020000 | 0o040000 | 0o060000 | 0o100000 | 0o120000 | 0o140000
            )
            && self.directory == (self.mode & 0o170000 == 0o040000)
            && self.symlink == (self.mode & 0o170000 == 0o120000);
        if !valid {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Entry version is malformed",
            ));
        }
        Ok(())
    }
}
