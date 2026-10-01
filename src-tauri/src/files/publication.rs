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

pub(super) fn private_directory(parent: &Path, prefix: &str) -> io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

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
        // Retain a physical namespace from creation onward. A user-facing
        // symlink alias must not redirect later payload writes or cleanup.
        let parent = std::fs::canonicalize(parent)?;
        let directory = private_directory(&parent, ".tauri-explorer-stage-")?;
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
        self.publish_with(target, rename_noreplace)
    }

    /// Retain the staged object's observation and publish relative to the opened
    /// destination. Reopening the public path afterward could adopt a substitute.
    #[cfg(target_os = "linux")]
    pub(super) fn publish_observed(
        self,
        target: &Path,
    ) -> Result<super::mutation::PublishedEntry, AppError> {
        self.publish_observed_in(target, None)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn publish_observed_in(
        self,
        target: &Path,
        expected_parent: Option<&super::object_id::ObjectId>,
    ) -> Result<super::mutation::PublishedEntry, AppError> {
        use super::{
            file_identity::{of_file, version_at},
            native_directory::Directory,
        };
        let stage = Directory::open(self.directory.path())?;
        let parent_path =
            std::fs::canonicalize(target.parent().ok_or_else(|| {
                AppError::InvalidPath("Copy publication requires a parent".into())
            })?)?;
        let parent = Directory::open(&parent_path)?;
        let identity = of_file(&parent.file)?;
        if expected_parent.is_some_and(|expected| *expected != identity) {
            return Err(AppError::Other(
                "Copy destination directory changed before publication".into(),
            ));
        }
        let physical_parent = parent.path()?;
        if stage.path()?.parent() != Some(physical_parent.as_path()) {
            return Err(AppError::Other(
                "Copy destination changed during staging".into(),
            ));
        }
        let name = target.file_name().ok_or_else(|| {
            AppError::InvalidPath("Copy publication requires an entry name".into())
        })?;
        // Observe before temporary permission changes needed for directory rename.
        let publication = super::mutation::PublishedEntry {
            path: physical_parent.join(name),
            parent: identity,
            version: version_at(&stage, std::ffi::OsStr::new("payload"))?,
        };
        self.publish_with(target, |_, _| {
            stage.rename_to(std::ffi::OsStr::new("payload"), &parent, name)?;
            Ok(publication)
        })
    }

    fn publish_with<T>(
        self,
        target: &Path,
        publish: impl FnOnce(&Path, &Path) -> io::Result<T>,
    ) -> Result<T, AppError> {
        // POSIX may require write permission on a directory when moving it
        // between parents (updating '..'). A copied read-only directory must
        // stay writable while unpublished, then regain its final permissions.
        #[cfg(unix)]
        let permissions = match movable_directory(&self.payload) {
            Ok(permissions) => permissions,
            Err(error) => return Err(self.abort(error.into())),
        };
        let result = match publish(&self.payload, target) {
            Ok(result) => result,
            Err(error) => return Err(self.abort(error.into())),
        };
        #[cfg(unix)]
        if let Some((directory, permissions)) = permissions {
            // Restore through the captured handle, so a post-publication path
            // replacement cannot redirect this metadata change to another entry.
            if let Err(error) = directory.set_permissions(permissions) {
                log::warn!(
                    "Published {} but could not restore its directory permissions: {error}",
                    target.display()
                );
            }
        }
        let staging_path = self.directory.path().to_owned();
        if let Err(error) = self.directory.close() {
            log::warn!(
                "Published {} but could not remove empty staging directory {}: {error}",
                target.display(),
                staging_path.display()
            );
        }
        Ok(result)
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

#[cfg(unix)]
fn movable_directory(path: &Path) -> io::Result<Option<(std::fs::File, std::fs::Permissions)>> {
    use std::{fs, os::unix::fs::PermissionsExt};
    let metadata = fs::symlink_metadata(path)?;
    let permissions = metadata.permissions();
    if !metadata.is_dir() || permissions.mode() & 0o200 != 0 {
        return Ok(None);
    }
    // This is newly built data in our private staging namespace, never the
    // user's source or a displaced original. Read permission lets us retain
    // an fd for finalization even when copied mode bits deny the new owner read.
    fs::set_permissions(path, fs::Permissions::from_mode(permissions.mode() | 0o600))?;
    Ok(Some((fs::File::open(path)?, permissions)))
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
