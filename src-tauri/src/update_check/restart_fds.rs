//! Descriptor hygiene before an update relaunch (#1679).
//!
//! `request_restart` forks and execs the updated binary, and the new process
//! inherits every descriptor not marked close-on-exec. Rust's own files are
//! close-on-exec, but native code is not always: the AppImage runtime leaves
//! a handle on its FUSE mount directory, which kept the *old* image mounted
//! (and its runtime process alive) for the relaunched app's whole lifetime;
//! Mesa buffers and cgroup files leaked across too. Marking every descriptor
//! above stderr close-on-exec immediately before the relaunch gives the new
//! process a clean table without disturbing this process, which is exiting.

use std::os::fd::RawFd;

/// Mark every open descriptor above stderr close-on-exec. Best-effort: a
/// descriptor closed concurrently simply fails `fcntl` and is skipped.
pub fn mark_all_cloexec() {
    let Ok(entries) = std::fs::read_dir("/proc/self/fd") else {
        return;
    };
    // Collect first: the directory handle itself is one of the entries.
    let fds: Vec<RawFd> = entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .filter(|fd| *fd > 2)
        .collect();
    for fd in fds {
        // SAFETY: F_GETFD/F_SETFD only read and set the descriptor flags of
        // a process-owned descriptor; an invalid one returns -1 (EBADF).
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags >= 0 {
            unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inheritable_descriptors_become_close_on_exec() {
        // A descriptor opened without O_CLOEXEC, as native libraries do.
        let fd = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
        assert!(fd > 2, "open failed");
        let before = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_eq!(before & libc::FD_CLOEXEC, 0);

        mark_all_cloexec();

        let after = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        assert_ne!(after & libc::FD_CLOEXEC, 0);
        // Standard streams stay inheritable.
        let stderr = unsafe { libc::fcntl(2, libc::F_GETFD) };
        assert_eq!(stderr & libc::FD_CLOEXEC, 0);
        unsafe { libc::close(fd) };
    }
}
