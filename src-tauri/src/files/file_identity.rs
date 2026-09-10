//! Native object and version observations from retained handles or supplied
//! metadata, never a path reopen. Callers separately validate privacy and authority.
use super::object_id::ObjectId;
use std::{fs::File, io};

#[cfg(windows)]
#[path = "file_identity/windows.rs"]
mod windows;
#[cfg(windows)]
pub(super) fn of_file(file: &File) -> io::Result<ObjectId> {
    windows::of_file(file)
}

#[cfg(unix)]
pub(super) fn of_file(file: &File) -> io::Result<ObjectId> {
    Ok(from_metadata(&file.metadata()?))
}

/// Unix path observations also carry dev/ino without reopening a symlink leaf.
#[cfg(unix)]
pub(super) fn from_metadata(metadata: &std::fs::Metadata) -> ObjectId {
    use std::os::unix::fs::MetadataExt;
    ObjectId::unix(metadata.dev(), metadata.ino())
}

#[cfg(unix)]
pub(super) fn version_from_metadata(
    metadata: &std::fs::Metadata,
) -> io::Result<super::entry_version::EntryVersion> {
    use std::os::unix::fs::MetadataExt;
    let version = super::entry_version::EntryVersion {
        object: from_metadata(metadata),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanos: metadata.mtime_nsec().try_into().map_err(io::Error::other)?,
        directory: metadata.is_dir(),
        symlink: metadata.is_symlink(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
    };
    version.validate()?;
    Ok(version)
}

/// Observe a leaf relative to its retained parent, including dangling symlinks
/// and unreadable files. No path reopen or content read is required.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // Darwin dev_t/mode_t differ from Linux.
pub(super) fn version_at(
    directory: &super::native_directory::Directory,
    name: &std::ffi::OsStr,
) -> io::Result<super::entry_version::EntryVersion> {
    let stat = directory.stat(name)?;
    let version = super::entry_version::EntryVersion {
        object: ObjectId::unix(stat.st_dev as u64, stat.st_ino as u64),
        size: stat.st_size.try_into().map_err(io::Error::other)?,
        modified_seconds: stat.st_mtime,
        modified_nanos: stat.st_mtime_nsec.try_into().map_err(io::Error::other)?,
        directory: stat.st_mode & libc::S_IFMT == libc::S_IFDIR,
        symlink: stat.st_mode & libc::S_IFMT == libc::S_IFLNK,
        mode: stat.st_mode as u32,
        uid: stat.st_uid,
        gid: stat.st_gid,
    };
    version.validate()?;
    Ok(version)
}

#[cfg(test)]
#[path = "../../test_support/recovery_file_identity.rs"]
mod tests;
