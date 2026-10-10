//! Directory-entry durability barrier for create/link/rename/delete.
//!
//! Unix fsyncs the directory. Windows has no directory fsync, but NTFS commits
//! a directory's metadata (and the journal records behind it) when a writable
//! directory handle is flushed. Native windows-2022 qualification measured this
//! flush succeeding (docs/shared-ai-windows-namespace-evidence.md). A refused
//! flush, e.g. on a filesystem without that support, stays an error: callers
//! fail closed instead of claiming durability.
use std::{io, path::Path};

pub(crate) fn sync(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let handle = std::fs::File::open(directory)?;
        if !handle.metadata()?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "durable directory must be a real directory",
            ));
        }
        handle.sync_all()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(FILE_SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(directory)?;
        let metadata = handle.metadata()?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "durable directory must be a real directory",
            ));
        }
        handle.sync_all()
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "directory durability is unavailable on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::sync;
    #[test]
    fn commits_a_directory_after_entries_change() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("entry"), b"bytes").unwrap();
        sync(root.path()).unwrap();
        std::fs::remove_file(root.path().join("entry")).unwrap();
        sync(root.path()).unwrap();
    }
    #[test]
    fn refuses_a_regular_file_or_missing_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file");
        std::fs::write(&file, b"bytes").unwrap();
        assert!(sync(&file).is_err());
        assert!(sync(&root.path().join("absent")).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn refuses_a_junction_instead_of_flushing_its_target() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let junction = root.path().join("junction");
        std::fs::create_dir(&target).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(sync(&junction).is_err());
        sync(&target).unwrap();
    }
}
