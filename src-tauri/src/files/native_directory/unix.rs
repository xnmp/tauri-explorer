//! Opened Unix directories provide one-component, handle-relative filesystem access.
//! Callers own policy (permissions, journals, retention); this module owns syscalls.
use std::{
    ffi::{CStr, CString, OsStr, OsString},
    fs::{File, Metadata},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
        },
    },
    path::{Component, Path, PathBuf},
};

use super::Directory;

impl Directory {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Directory path must be absolute",
            ));
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(Path::new("/"))?;
        let mut directory = Self { file };
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => directory = directory.open_existing(name)?,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Directory path is not normalized",
                    ));
                }
            }
        }
        Ok(directory)
    }

    pub(crate) fn open_existing(&self, name: &OsStr) -> io::Result<Self> {
        let name = native_name(name)?;
        // SAFETY: name is terminated and the returned descriptor is uniquely owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self {
                file: unsafe { File::from_raw_fd(descriptor) },
            })
        }
    }

    pub(crate) fn create_file(&self, name: &OsStr) -> io::Result<File> {
        let name = native_name(name)?;
        // SAFETY: name is terminated and the returned descriptor is uniquely owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
    }

    pub(crate) fn open_file(&self, name: &OsStr) -> io::Result<File> {
        let name = native_name(name)?;
        // SAFETY: name is terminated and the returned descriptor is uniquely owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if descriptor < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
    }

    pub(crate) fn metadata(&self) -> io::Result<Metadata> {
        self.file.metadata()
    }

    /// Distinguish bind mounts that expose the same device/inode. None is
    /// reserved for kernels without STATX_MNT_ID support.
    #[cfg(target_os = "linux")]
    pub(crate) fn mount_id(&self) -> io::Result<Option<u64>> {
        let mut stat = std::mem::MaybeUninit::<libc::statx>::zeroed();
        // SAFETY: the owned descriptor and empty terminated path are valid;
        // AT_EMPTY_PATH addresses the descriptor and stat is writable storage.
        let result = unsafe {
            libc::statx(
                self.file.as_raw_fd(),
                c"".as_ptr(),
                libc::AT_EMPTY_PATH,
                libc::STATX_MNT_ID,
                stat.as_mut_ptr(),
            )
        };
        if result == 0 {
            // SAFETY: successful statx initialized stat.
            let stat = unsafe { stat.assume_init() };
            return Ok((stat.stx_mask & libc::STATX_MNT_ID != 0).then_some(stat.stx_mnt_id));
        }
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL)) {
            Ok(None)
        } else {
            Err(error)
        }
    }

    pub(crate) fn entry_exists(&self, name: &OsStr) -> io::Result<bool> {
        match self.stat(name) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn stat(&self, name: &OsStr) -> io::Result<libc::stat> {
        let name = native_name(name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
        // SAFETY: the descriptor is owned, name is terminated, and stat is writable.
        let result = unsafe {
            libc::fstatat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful fstatat initialized stat.
        Ok(unsafe { stat.assume_init() })
    }

    /// Exclusive creation only. Existing directories require separate admission.
    pub(crate) fn create_directory(&self, name: &OsStr) -> io::Result<Self> {
        let native = native_name(name)?;
        // SAFETY: the descriptor and terminated name remain valid during mkdirat.
        if unsafe { libc::mkdirat(self.file.as_raw_fd(), native.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.open_existing(name)
    }

    pub(crate) fn rename_to(
        &self,
        source: &OsStr,
        target_directory: &Self,
        target: &OsStr,
    ) -> io::Result<()> {
        let source = native_name(source)?;
        let target = native_name(target)?;
        // SAFETY: owned descriptors and terminated names remain valid for the syscall.
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                self.file.as_raw_fd(),
                source.as_ptr(),
                target_directory.file.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                self.file.as_raw_fd(),
                source.as_ptr(),
                target_directory.file.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Does not follow a symlink. Directory removal must be requested explicitly.
    pub(crate) fn unlink(&self, name: &OsStr, directory: bool) -> io::Result<()> {
        let name = native_name(name)?;
        let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
        // SAFETY: owned descriptor and terminated name remain valid during unlinkat.
        if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), flags) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Enumerate through a fresh open description without buffering the directory.
    pub(crate) fn entries(&self) -> io::Result<Entries> {
        // SAFETY: the constant name is terminated and the descriptor is owned.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                c".".as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fdopendir takes ownership only on success.
        let stream = unsafe { libc::fdopendir(descriptor) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: fdopendir failed; this function still owns the descriptor.
            unsafe { libc::close(descriptor) };
            return Err(error);
        }
        Ok(Entries {
            stream,
            finished: false,
        })
    }

    /// Bounded collection for callers whose whole namespace must be validated.
    pub(crate) fn names(&self, maximum: usize) -> io::Result<Vec<OsString>> {
        let mut names = Vec::new();
        for name in self.entries()? {
            let name = name?;
            if names.len() == maximum {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Directory exceeds its entry limit",
                ));
            }
            names.push(name);
        }
        Ok(names)
    }

    /// Read literal link text, including non-Unicode and dangling targets.
    pub(crate) fn read_link(&self, name: &OsStr, maximum: usize) -> io::Result<OsString> {
        let name = native_name(name)?;
        let limit = maximum.checked_add(1).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Link target budget overflows")
        })?;
        let mut bytes = vec![0; limit.min(128)];
        loop {
            // SAFETY: owned descriptor, terminated name and writable buffer remain valid.
            let length = unsafe {
                libc::readlinkat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if length < 0 {
                return Err(io::Error::last_os_error());
            }
            let length = length as usize;
            if length > maximum {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Link target exceeds its byte limit",
                ));
            }
            if length < bytes.len() {
                bytes.truncate(length);
                return Ok(OsString::from_vec(bytes));
            }
            bytes.resize(bytes.len().saturating_mul(2).min(limit), 0);
        }
    }

    /// Exclusive creation; the target text is data and is never resolved here.
    pub(crate) fn create_symlink(&self, name: &OsStr, target: &OsStr) -> io::Result<()> {
        let name = native_name(name)?;
        let target = CString::new(target.as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Link target contains a NUL byte",
            )
        })?;
        // SAFETY: the descriptor and both terminated strings remain valid for symlinkat.
        if unsafe { libc::symlinkat(target.as_ptr(), self.file.as_raw_fd(), name.as_ptr()) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    pub(crate) fn sync(&self) -> io::Result<()> {
        self.file.sync_all()
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn path(&self) -> io::Result<PathBuf> {
        std::fs::read_link(format!("/proc/self/fd/{}", self.file.as_raw_fd()))
    }

    pub(crate) fn name_max(&self) -> io::Result<usize> {
        // SAFETY: fpathconf only reads the valid descriptor.
        let value = unsafe { libc::fpathconf(self.file.as_raw_fd(), libc::_PC_NAME_MAX) };
        if value < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(value as usize)
        }
    }
}

/// One independent native directory stream. An error ends iteration permanently.
pub(crate) struct Entries {
    stream: *mut libc::DIR,
    finished: bool,
}

impl Iterator for Entries {
    type Item = io::Result<OsString>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            // SAFETY: errno is thread-local; this owner exclusively retains the stream.
            let entry = unsafe {
                #[cfg(target_os = "linux")]
                {
                    *libc::__errno_location() = 0;
                }
                #[cfg(target_os = "macos")]
                {
                    *libc::__error() = 0;
                }
                libc::readdir(self.stream)
            };
            if entry.is_null() {
                let error = io::Error::last_os_error();
                self.finished = true;
                return (error.raw_os_error() != Some(0)).then_some(Err(error));
            }
            // SAFETY: this readdir name remains terminated and valid until next().
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if !matches!(name, b"." | b"..") {
                return Some(Ok(OsString::from_vec(name.to_vec())));
            }
        }
    }
}

impl Drop for Entries {
    fn drop(&mut self) {
        // SAFETY: fdopendir transferred this uniquely owned stream to Entries.
        unsafe { libc::closedir(self.stream) };
    }
}

pub(crate) fn native_name(name: &OsStr) -> io::Result<CString> {
    if !is_name(name) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected one filesystem name",
        ));
    }
    CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Name contains a NUL byte"))
}

pub(crate) fn is_name(name: &OsStr) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes != b"."
        && bytes != b".."
        && !bytes.contains(&b'/')
        && !bytes.contains(&0)
}

#[cfg(test)]
#[path = "../../../test_support/native_directory.rs"]
mod tests;
