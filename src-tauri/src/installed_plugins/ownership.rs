//! The runtime owns its profile before recovery and until backend shutdown.
//! Every OS takes the same advisory lock: a second process (Windows launched
//! twice, macOS `open -n`, Linux without single-instance routing) must not
//! treat the first one's live claims as dead.
use crate::error::AppError;
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub(super) struct ProfileOwner {
    file: File,
    owner_pid: u32,
}

impl Drop for ProfileOwner {
    fn drop(&mut self) {
        // Close alone leaves flock held by descriptors inherited before exec.
        // A forked child's copy must not release the still-live parent's lease.
        if std::process::id() == self.owner_pid {
            let _ = self.file.unlock();
        }
    }
}

fn open(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        // Competing owners must be able to open it to try the lock. Without
        // FILE_SHARE_DELETE the held lease cannot be unlinked and recreated.
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(path)
}

fn regular(file: &File) -> Result<(), AppError> {
    let metadata = file.metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::Other(
                "Plugin runtime lease must be a regular file".into(),
            ));
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(AppError::Other(
            "Plugin runtime lease must be a regular file".into(),
        ));
    }
    Ok(())
}

pub(super) fn acquire(profile: &Path) -> Result<ProfileOwner, AppError> {
    let file = open(&profile.join(".plugin-runtime.lock"))?;
    regular(&file)?;
    file.try_lock().map_err(|cause| {
        AppError::Other(format!(
            "Another Tauri Explorer process owns this plugin profile: {cause}"
        ))
    })?;
    Ok(ProfileOwner {
        file,
        owner_pid: std::process::id(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// fork/exec descriptor inheritance is the Linux runtime contract.
    #[cfg(target_os = "linux")]
    mod inherited {
        use super::*;
        use std::io::Read;
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

        struct InheritedChild {
            pid: Option<libc::pid_t>,
            release: OwnedFd,
        }

        impl InheritedChild {
            fn assert_alive(&mut self) {
                let pid = self.pid.unwrap();
                let waited = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
                if waited == pid
                    || (waited < 0
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
                {
                    self.pid = None;
                }
                assert_eq!(waited, 0);
            }

            fn finish(&mut self) -> std::io::Result<()> {
                let Some(pid) = self.pid else {
                    return Ok(());
                };
                // Parallel forks can inherit writers, so EOF cannot release us.
                let release_error = if unsafe {
                    libc::write(self.release.as_raw_fd(), (&1u8 as *const u8).cast(), 1)
                } == 1
                {
                    None
                } else {
                    Some(std::io::Error::last_os_error())
                };
                if release_error.is_some() {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
                let mut status = 0;
                loop {
                    let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
                    if waited == pid {
                        self.pid = None;
                        break;
                    }
                    let cause = std::io::Error::last_os_error();
                    if cause.raw_os_error() == Some(libc::ECHILD) {
                        self.pid = None;
                    }
                    if cause.raw_os_error() != Some(libc::EINTR) {
                        return Err(cause);
                    }
                }
                if let Some(cause) = release_error {
                    return Err(cause);
                }
                if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
                    return Err(std::io::Error::other(
                        "Inherited child did not exit successfully",
                    ));
                }
                Ok(())
            }
        }

        impl Drop for InheritedChild {
            fn drop(&mut self) {
                // Still release and reap during assertion unwind; Drop never panics.
                let _ = self.finish();
            }
        }

        fn pipe() -> (OwnedFd, OwnedFd) {
            let mut fds = [0; 2];
            assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
        }

        fn inherit_owner<T>(owner: T, drop_in_child: bool) -> (T, InheritedChild) {
            let (ready_read, ready_write) = pipe();
            let (release_read, release_write) = pipe();
            let pid = unsafe { libc::fork() };
            if pid == 0 {
                // Only syscall-backed owner/FD drops and async-signal-safe I/O run
                // after a fork of the parallel test process; never unwind here.
                drop(ready_read);
                drop(release_write);
                if drop_in_child {
                    drop(owner);
                }
                let mut byte = 1u8;
                let acknowledged =
                    unsafe { libc::write(ready_write.as_raw_fd(), (&byte as *const u8).cast(), 1) };
                drop(ready_write);
                let released = unsafe {
                    libc::read(release_read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1)
                };
                unsafe {
                    libc::_exit(if acknowledged == 1 && released == 1 && byte == 1 {
                        0
                    } else {
                        1
                    })
                }
            }
            assert!(pid > 0, "{}", std::io::Error::last_os_error());
            drop(ready_write);
            drop(release_read);
            let child = InheritedChild {
                pid: Some(pid),
                release: release_write,
            };
            let mut ready = File::from(ready_read);
            ready.read_exact(&mut [0]).unwrap();
            (owner, child)
        }

        #[test]
        fn owner_drop_releases_while_an_inherited_descriptor_is_still_open() {
            let profile = tempfile::tempdir().unwrap();
            let (owner, mut child) = inherit_owner(acquire(profile.path()).unwrap(), false);
            child.assert_alive();
            assert!(acquire(profile.path()).is_err());
            drop(owner);
            child.assert_alive();
            let next = acquire(profile.path()).unwrap();
            assert!(acquire(profile.path()).is_err());
            drop(next);
            assert!(profile.path().join(".plugin-runtime.lock").exists());
            child.finish().unwrap();
        }

        #[test]
        fn inherited_owner_drop_cannot_unlock_the_live_parent() {
            let profile = tempfile::tempdir().unwrap();
            let (owner, mut child) = inherit_owner(acquire(profile.path()).unwrap(), true);
            child.assert_alive();
            assert!(acquire(profile.path()).is_err());
            drop(owner);
            acquire(profile.path()).unwrap();
            child.finish().unwrap();
        }

        #[test]
        fn inherited_child_is_released_and_reaped_when_an_assertion_unwinds() {
            let profile = tempfile::tempdir().unwrap();
            let mut pid = 0;
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let (_owner, mut child) = inherit_owner(acquire(profile.path()).unwrap(), false);
                pid = child.pid.unwrap();
                child.assert_alive();
                panic!("exercise fixture unwind");
            }));
            assert!(panicked.is_err());
            assert_eq!(
                unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            acquire(profile.path()).unwrap();
        }

        #[test]
        fn observing_an_exited_child_reaps_it_before_unwind_cleanup() {
            let profile = tempfile::tempdir().unwrap();
            let (owner, mut child) = inherit_owner(acquire(profile.path()).unwrap(), false);
            let pid = child.pid.unwrap();
            child.assert_alive();
            assert_eq!(
                unsafe { libc::write(child.release.as_raw_fd(), (&1u8 as *const u8).cast(), 1) },
                1
            );
            let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            assert_eq!(
                unsafe {
                    libc::waitid(
                        libc::P_PID,
                        pid as libc::id_t,
                        &mut info,
                        libc::WEXITED | libc::WNOWAIT,
                    )
                },
                0
            );
            assert!(std::panic::catch_unwind(
                std::panic::AssertUnwindSafe(|| child.assert_alive())
            )
            .is_err());
            child.finish().unwrap();
            assert_eq!(
                unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            assert!(acquire(profile.path()).is_err());
            drop(owner);
            acquire(profile.path()).unwrap();
        }

        /// The same fork hazard for the ledger's per-artifact IO leases: any
        /// spawn (fork, then exec) briefly duplicates every descriptor, and a
        /// lease released only by close stayed locked for that window, so a
        /// concurrent seal or read failed with "artifact IO is already owned".
        #[test]
        fn a_released_artifact_lease_is_free_while_a_forked_child_holds_its_descriptor() {
            let dir = tempfile::tempdir().unwrap();
            let store = crate::service_state::Store::open(
                dir.path().join("service-state"),
                crate::service_state::model::Limits::default(),
            )
            .unwrap();
            let handle = "ab".repeat(24);
            let (lease, mut child) = inherit_owner(store.hold_artifact_io(&handle).unwrap(), false);
            child.assert_alive();
            assert!(store.hold_artifact_io(&handle).is_err());
            drop(lease);
            store.hold_artifact_io(&handle).unwrap();
            child.finish().unwrap();
        }
    }

    #[test]
    fn excludes_another_owner_and_releases_without_unlinking_the_lock() {
        let profile = tempfile::tempdir().unwrap();
        let first = acquire(profile.path()).unwrap();
        assert!(acquire(profile.path()).is_err());
        drop(first);
        assert!(profile.path().join(".plugin-runtime.lock").exists());
        acquire(profile.path()).unwrap();
    }
    #[test]
    fn independent_profiles_can_have_independent_owners() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let _first = acquire(first.path()).unwrap();
        let _second = acquire(second.path()).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_a_planted_lease_symlink() {
        let profile = tempfile::tempdir().unwrap();
        let target = profile.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, profile.path().join(".plugin-runtime.lock")).unwrap();
        assert!(acquire(profile.path()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    }
    /// The planted name is refused rather than followed or locked through.
    #[cfg(windows)]
    #[test]
    fn rejects_a_planted_lease_reparse_point() {
        let profile = tempfile::tempdir().unwrap();
        let target = profile.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        // Creating symlinks needs Developer Mode or elevation on Windows.
        if std::os::windows::fs::symlink_file(&target, profile.path().join(".plugin-runtime.lock"))
            .is_err()
        {
            return;
        }
        assert!(acquire(profile.path()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    }
    #[test]
    fn rejects_a_lease_path_that_is_not_a_regular_file() {
        let profile = tempfile::tempdir().unwrap();
        std::fs::create_dir(profile.path().join(".plugin-runtime.lock")).unwrap();
        assert!(acquire(profile.path()).is_err());
        assert!(profile.path().join(".plugin-runtime.lock").is_dir());
    }
    #[test]
    fn another_process_cannot_acquire_the_profile_until_its_owner_exits() {
        let profile = tempfile::tempdir().unwrap();
        let owner = acquire(profile.path()).unwrap();
        let run = |expected: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "installed_plugins::ownership::tests::child_checks_profile_lease",
                ])
                .env("TE_LEASE_TEST_PROFILE", profile.path())
                .env("TE_LEASE_EXPECT", expected)
                .output()
                .unwrap()
        };
        // A filter that matched nothing would also exit successfully.
        let ran = |output: &std::process::Output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed")
        };
        let blocked = run("busy");
        assert!(
            ran(&blocked),
            "{}",
            String::from_utf8_lossy(&blocked.stderr)
        );
        drop(owner);
        let acquired = run("free");
        assert!(
            ran(&acquired),
            "{}",
            String::from_utf8_lossy(&acquired.stderr)
        );
    }
    #[test]
    #[ignore]
    fn child_checks_profile_lease() {
        let profile = std::env::var_os("TE_LEASE_TEST_PROFILE").expect("Owned test child only");
        let expected = std::env::var("TE_LEASE_EXPECT").unwrap();
        assert_eq!(acquire(Path::new(&profile)).is_ok(), expected == "free");
    }
}
