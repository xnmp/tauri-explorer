//! Recovery storage policy evaluated through retained native handles.
//! A successful check is an observation, not authority over future namespace or
//! content changes. Callers still serialize admission and revalidate evidence.
use crate::files::native_directory::Directory;
use std::{
    fs::{File, Metadata},
    io,
};

#[cfg(windows)]
#[path = "private_storage/windows.rs"]
mod windows;
#[cfg(windows)]
pub(super) fn validate_directory(directory: &Directory) -> io::Result<()> {
    windows::validate_directory(directory)
}

#[cfg(windows)]
pub(super) fn validate_file(file: &File) -> io::Result<Metadata> {
    windows::validate_file(file)
}

#[cfg(unix)]
pub(super) fn validate_directory(directory: &Directory) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = directory.file.metadata()?;
    if !metadata.is_dir() || metadata.nlink() == 0 || !private_owner(&metadata) {
        return Err(invalid("Recovery storage is not a private owned directory"));
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn validate_file(file: &File) -> io::Result<Metadata> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.nlink() != 1 || !private_owner(&metadata) {
        return Err(invalid(
            "Recovery evidence must be a private, singly linked regular file",
        ));
    }
    Ok(metadata)
}

#[cfg(unix)]
fn private_owner(metadata: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid takes no arguments and returns the process's effective UID.
    metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
}

#[cfg(unix)]
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "../../../test_support/recovery_private_storage.rs"]
mod tests;
