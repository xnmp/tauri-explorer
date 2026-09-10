//! Pin a directory for permission changes without requiring content read access.
//! Callers verify identity/version and own the permission policy before mutation.
use super::{unix::native_name, Directory};
use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io,
    os::fd::{AsRawFd, FromRawFd},
};

pub(crate) struct PermissionDirectory {
    file: File,
}

impl Directory {
    pub(crate) fn open_for_permissions(&self, name: &OsStr) -> io::Result<PermissionDirectory> {
        let name = native_name(name)?;
        #[cfg(target_os = "linux")]
        let access = libc::O_PATH;
        #[cfg(target_os = "macos")]
        // macOS has no public O_PATH equivalent; unreadable directories
        // fail here. Never replace this with a pathname chmod.
        let access = libc::O_RDONLY;
        // SAFETY: the directory is retained, name is terminated, and a successful
        // descriptor is transferred to exactly one File. No symlink is followed.
        let descriptor = unsafe {
            libc::openat(
                self.file.as_raw_fd(),
                name.as_ptr(),
                access | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(PermissionDirectory {
            file: unsafe { File::from_raw_fd(descriptor) },
        })
    }
}

impl PermissionDirectory {
    pub(crate) fn metadata(&self) -> io::Result<Metadata> {
        self.file.metadata()
    }

    pub(crate) fn set_mode(&self, mode: u32) -> io::Result<()> {
        if mode & !0o7777 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid directory permission mode",
            ));
        }
        #[cfg(target_os = "linux")]
        {
            // SAFETY: O_PATH pins this inode and AT_EMPTY_PATH addresses that
            // descriptor directly. Linux 6.6 added this flag to fchmodat2.
            let result = unsafe {
                libc::syscall(
                    linux_raw_sys::general::__NR_fchmodat2 as libc::c_long,
                    self.file.as_raw_fd(),
                    c"".as_ptr(),
                    mode as libc::mode_t,
                    libc::AT_EMPTY_PATH,
                )
            };
            if result == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOSYS) {
                return Err(error);
            }
            self.set_mode_via_procfs(mode)
        }
        #[cfg(target_os = "macos")]
        {
            // SAFETY: fchmod operates on the retained vnode descriptor; read
            // access is not needed to change metadata owned by this process uid.
            if unsafe { libc::fchmod(self.file.as_raw_fd(), mode as libc::mode_t) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }
    }

    /// Open the pinned directory itself after permission preparation. Unlike a
    /// lookup of its former name, this cannot switch to a replacement occupant.
    pub(crate) fn open_readable(&self) -> io::Result<Directory> {
        // SAFETY: the retained descriptor and literal "." address this inode.
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
        Ok(Directory {
            file: unsafe { File::from_raw_fd(descriptor) },
        })
    }

    #[cfg(target_os = "linux")]
    fn set_mode_via_procfs(&self, mode: u32) -> io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        // Older kernels can follow procfs's magic descriptor link to this held
        // inode. This deliberately follows kernel fd links, never the user path.
        let descriptors = Directory {
            file: std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
                .open("/proc/self/fd")?,
        };
        self.set_mode_via_descriptors(&descriptors, mode)
    }

    #[cfg(target_os = "linux")]
    fn set_mode_via_descriptors(&self, descriptors: &Directory, mode: u32) -> io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::zeroed();
        // SAFETY: valid retained descriptor and writable statfs storage.
        if unsafe { libc::fstatfs(descriptors.file.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { filesystem.assume_init() }.f_type != libc::PROC_SUPER_MAGIC {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Descriptor permission fallback requires procfs",
            ));
        }
        let name = native_name(OsStr::new(&self.file.as_raw_fd().to_string()))?;
        let mut observed = std::mem::MaybeUninit::<libc::stat>::zeroed();
        // SAFETY: follow the procfs magic link for this still-owned fd, not a
        // user entry. Keeping self.file alive prevents descriptor-number reuse.
        if unsafe {
            libc::fstatat(
                descriptors.file.as_raw_fd(),
                name.as_ptr(),
                observed.as_mut_ptr(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let observed = unsafe { observed.assume_init() };
        let held = self.file.metadata()?;
        if observed.st_dev != held.dev() || observed.st_ino != held.ino() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Procfs descriptor differs from the retained directory",
            ));
        }
        // SAFETY: the validated procfs fd directory exposes a kernel-owned link
        // for a descriptor that remains alive for the entire operation.
        if unsafe {
            libc::fchmodat(
                descriptors.file.as_raw_fd(),
                name.as_ptr(),
                mode as libc::mode_t,
                0,
            )
        } == 0
        {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../../test_support/native_directory_permissions.rs"]
mod tests;
