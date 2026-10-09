//! The Linux runtime owns its profile before recovery and until backend shutdown.
use crate::error::AppError;
use std::os::unix::fs::OpenOptionsExt;
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

pub(super) fn acquire(profile: &Path) -> Result<ProfileOwner, AppError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(profile.join(".plugin-runtime.lock"))?;
    if !file.metadata()?.is_file() {
        return Err(AppError::Other(
            "Plugin runtime lease must be a regular file".into(),
        ));
    }
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
            let release_error =
                if unsafe { libc::write(self.release.as_raw_fd(), (&1u8 as *const u8).cast(), 1) }
                    == 1
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
            let released =
                unsafe { libc::read(release_read.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
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
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| child.assert_alive()))
                .is_err()
        );
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
    #[test]
    fn rejects_a_planted_lease_symlink() {
        let profile = tempfile::tempdir().unwrap();
        let target = profile.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, profile.path().join(".plugin-runtime.lock")).unwrap();
        assert!(acquire(profile.path()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
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
        let blocked = run("busy");
        assert!(
            blocked.status.success(),
            "{}",
            String::from_utf8_lossy(&blocked.stderr)
        );
        drop(owner);
        let acquired = run("free");
        assert!(
            acquired.status.success(),
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
