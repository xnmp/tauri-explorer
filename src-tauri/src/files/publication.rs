//! Own unpublished payloads and publish them without replacing a racing entry.
//!
//! Staging contains only newly created data. Never put a displaced user entry
//! here: its lifetime must be governed by explicit recovery, not a destructor.
//! Operations are still path-based: replacing the staging namespace from
//! another process requires artifact-identity/handle anchoring beyond this
//! destination-collision boundary.

use std::io;
use std::path::{Path, PathBuf};

use crate::error::AppError;

pub(super) struct StagedEntry {
    directory: tempfile::TempDir,
    payload: PathBuf,
}

impl StagedEntry {
    /// Reserve a private namespace on the destination filesystem, then build
    /// an unpublished payload. Errors cannot leave a partial public target.
    pub(super) fn prepare(
        parent: &Path,
        build: impl FnOnce(&Path) -> Result<(), AppError>,
    ) -> Result<Self, AppError> {
        let mut builder = tempfile::Builder::new();
        builder.prefix(".tauri-explorer-stage-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = builder.tempdir_in(parent)?;
        let staged = Self {
            payload: directory.path().join("payload"),
            directory,
        };
        match build(&staged.payload) {
            Ok(()) => Ok(staged),
            Err(error) => Err(staged.abort(error)),
        }
    }

    /// Commit once. An occupied target is an error even if it appeared after
    /// name selection. Cleanup failure after commit cannot revoke success.
    pub(super) fn publish(self, target: &Path) -> Result<(), AppError> {
        if let Err(error) = rename_noreplace(&self.payload, target) {
            return Err(self.abort(error.into()));
        }
        let staging_path = self.directory.path().to_owned();
        if let Err(error) = self.directory.close() {
            log::warn!(
                "Published {} but could not remove empty staging directory {}: {error}",
                target.display(),
                staging_path.display()
            );
        }
        Ok(())
    }

    fn abort(self, cause: AppError) -> AppError {
        let staging_path = self.directory.path().to_owned();
        match self.directory.close() {
            Ok(()) => cause,
            Err(cleanup) => AppError::Other(format!(
                "{cause}; unfinished staging data remains at {}: {cleanup}",
                staging_path.display()
            )),
        }
    }
}

/// A same-filesystem rename that atomically refuses an occupied destination.
/// Fail closed on unsupported filesystems; a preflight check plus rename is
/// not an equivalent fallback. Keep EXDEV intact for cross-volume policy.
pub(super) fn rename_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    native_rename_noreplace(source, target)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn native_rename_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let native_path = |path: &Path| {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Path contains a NUL byte"))
    };
    let source = native_path(source)?;
    let target = native_path(target)?;
    // SAFETY: both C strings remain alive and NUL-terminated for the call.
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    // SAFETY: same C-string lifetime as above; RENAME_EXCL refuses replacement.
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn native_rename_noreplace(source: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let native_path = |path: &Path| {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Path contains a NUL byte",
            ));
        }
        value.push(0);
        Ok(value)
    };
    let source = native_path(source)?;
    let target = native_path(target)?;
    // SAFETY: the terminated UTF-16 buffers live for the call. No replace or
    // copy flags: cross-volume fallback belongs to the transaction owner.
    let result = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn native_rename_noreplace(_source: &Path, _target: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Atomic no-replace rename is unavailable",
    ))
}

#[cfg(test)]
#[path = "../../test_support/file_publication.rs"]
mod tests;
