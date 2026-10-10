//! Unix owned CLI process groups with a parent-death-safe, unreaped group anchor.
//! The host spawns the original Command directly: no argv/environment serialization,
//! output spools, shell wrapping, or supervisor-owned output reader is involved.
#![cfg(unix)]
use crate::error::AppError;
use std::{
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Child, Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
const MARKER: &str = "--te-owned-process-supervisor-v1";
const HELLO: &[u8; 8] = b"TEPS1\0\0\0";
const HANDSHAKE: Duration = Duration::from_secs(2);
const MAX_OUTPUT: usize = 64 * 1024 * 1024;

/// Call before Tauri/logging initialization. Only an exact private mode is handled.
/// Invalid marker/descriptor/handshake exits without launching any CLI or logging.
pub(crate) fn early_mode() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(MARKER)) {
        return None;
    }
    let fd = args
        .next()
        .and_then(|s| s.to_str().and_then(|s| s.parse::<RawFd>().ok()));
    Some(match (fd, args.next()) {
        (Some(fd), None) if fd >= 3 => supervisor(fd),
        _ => 64,
    })
}
fn supervisor(fd: RawFd) -> i32 {
    // A forged invocation must never signal the caller's or another process group.
    let pid = unsafe { libc::getpid() };
    let parent = unsafe { libc::getppid() };
    if unsafe { libc::getpgrp() } != pid || !private_socket(fd) {
        return 64;
    }
    let mut socket = unsafe { UnixStream::from_raw_fd(fd) };
    // This endpoint may never be inherited by a future exec in this helper.
    if cloexec(fd).is_err()
        || socket.set_read_timeout(Some(HANDSHAKE)).is_err()
        || socket.set_write_timeout(Some(HANDSHAKE)).is_err()
    {
        return 64;
    }
    let mut hello = [0u8; 40];
    if socket.read_exact(&mut hello).is_err()
        || &hello[..8] != HELLO
        || hello[8..].iter().all(|b| *b == 0)
    {
        return 64;
    }
    if socket.write_all(&hello).is_err()
        || socket
            .set_read_timeout(Some(Duration::from_millis(50)))
            .is_err()
    {
        kill_own_group(pid);
    }
    // No descendant owns the host endpoint (CLOEXEC), so actual host death closes
    // the last peer descriptor. EOF/error/unexpected data all retire this group.
    let mut byte = [0];
    loop {
        // A pre-exec leaf temporarily inherits the CLOEXEC peer descriptor.
        // Reparenting also proves host death even while that descriptor is held.
        if unsafe { libc::getppid() } != parent {
            kill_own_group(pid);
        }
        match socket.read(&mut byte) {
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            _ => kill_own_group(pid),
        }
    }
}
fn kill_own_group(pid: libc::pid_t) -> ! {
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
        libc::_exit(70)
    }
}
fn private_socket(fd: RawFd) -> bool {
    let mut kind: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&kind) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut kind as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
        || kind != libc::SOCK_STREAM
    {
        return false;
    }
    for peer in [false, true] {
        let mut address = std::mem::MaybeUninit::<libc::sockaddr_storage>::zeroed();
        let mut length = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
        let result = unsafe {
            if peer {
                libc::getpeername(fd, address.as_mut_ptr().cast(), &mut length)
            } else {
                libc::getsockname(fd, address.as_mut_ptr().cast(), &mut length)
            }
        };
        if result != 0 || unsafe { address.assume_init().ss_family } as libc::c_int != libc::AF_UNIX
        {
            return false;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut credentials = std::mem::MaybeUninit::<libc::ucred>::zeroed();
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                credentials.as_mut_ptr().cast(),
                &mut length,
            )
        } != 0
        {
            return false;
        }
        let credentials = unsafe { credentials.assume_init() };
        if credentials.pid != unsafe { libc::getppid() }
            || credentials.uid != unsafe { libc::geteuid() }
        {
            return false;
        }
    }
    true
}
fn cloexec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
struct Owned {
    anchor: Child,
    _control: UnixStream,
    leaf: Option<Child>,
    stopped: bool,
}
impl Owned {
    fn stop(&mut self) {
        if !self.stopped {
            // Never reap the anchor before this syscall: its PID pins the PGID.
            unsafe {
                libc::kill(-(self.anchor.id() as libc::pid_t), libc::SIGKILL);
            }
            if let Some(leaf) = self.leaf.as_mut() {
                let _ = leaf.kill();
            }
            self.stopped = true;
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.stop();
        if let Some(leaf) = self.leaf.as_mut() {
            let _ = leaf.wait();
        }
        let _ = self.anchor.wait();
    }
}
fn anchor() -> Result<Owned, AppError> {
    let (host, peer) = UnixStream::pair()?;
    cloexec(host.as_raw_fd())?;
    cloexec(peer.as_raw_fd())?;
    let host_fd = host.as_raw_fd();
    let peer_fd = peer.as_raw_fd();
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(MARKER)
        .arg(peer_fd.to_string())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    unsafe {
        command.pre_exec(move || {
            // Only this inherited endpoint survives exec. The host endpoint must
            // remain exclusively held by the original host, never by this helper.
            libc::close(host_fd);
            if libc::fcntl(peer_fd, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    drop(peer);
    let mut owned = Owned {
        anchor: child,
        _control: host,
        leaf: None,
        stopped: false,
    };
    owned._control.set_read_timeout(Some(HANDSHAKE))?;
    owned._control.set_write_timeout(Some(HANDSHAKE))?;
    let mut hello = [0u8; 40];
    hello[..8].copy_from_slice(HELLO);
    getrandom::fill(&mut hello[8..])
        .map_err(|_| AppError::Other("Could not establish owned process supervision".into()))?;
    owned._control.write_all(&hello)?;
    let mut reply = [0u8; 40];
    owned._control.read_exact(&mut reply)?;
    if hello != reply || exited(&mut owned.anchor)? {
        return Err(AppError::Other(
            "Owned process supervisor handshake failed".into(),
        ));
    }
    Ok(owned)
}
fn exited(child: &mut Child) -> io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::Interrupted {
            Ok(false)
        } else {
            Err(error)
        };
    }
    Ok(unsafe { info.assume_init().si_pid() } != 0)
}
struct Readers {
    stop: Arc<AtomicBool>,
    stdout: Option<JoinHandle<io::Result<Vec<u8>>>>,
    stderr: Option<JoinHandle<io::Result<Vec<u8>>>>,
}
impl Drop for Readers {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for reader in [&mut self.stdout, &mut self.stderr] {
            if let Some(reader) = reader.take() {
                let _ = reader.join();
            }
        }
    }
}
fn reader(
    mut pipe: impl Read + Send + 'static,
    limit: usize,
    overflow: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> io::Result<JoinHandle<io::Result<Vec<u8>>>> {
    std::thread::Builder::new()
        .name("owned-process-output".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                if stop.load(Ordering::Acquire) {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Owned output drain stopped",
                    ));
                }
                match pipe.read(&mut buffer) {
                    Ok(0) => return Ok(bytes),
                    Ok(count) => {
                        let available = limit.saturating_sub(bytes.len());
                        bytes.extend_from_slice(&buffer[..count.min(available)]);
                        if count > available {
                            overflow.store(true, Ordering::Release);
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        if stop.load(Ordering::Acquire) {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "Owned output pipes did not close",
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => return Err(e),
                }
            }
        })
}
/// SDK3 owned process path. Caller configures stdin; original args/env/cwd stay
/// on the original Command. Success retains the leaf's exit status, not anchor's.
pub(crate) fn output_controlled(
    command: &mut Command,
    cancelled: impl Fn() -> bool,
    limits: (usize, usize),
    cancel_message: &'static str,
) -> Result<Output, AppError> {
    if limits.0 > MAX_OUTPUT || limits.1 > MAX_OUTPUT {
        return Err(AppError::Other(
            "Owned process output limit is invalid".into(),
        ));
    }
    if cancelled() {
        return Err(AppError::Other(cancel_message.into()));
    }
    let mut owned = anchor()?;
    if cancelled() {
        return Err(AppError::Other(cancel_message.into()));
    }
    command
        .process_group(owned.anchor.id() as libc::pid_t)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let parent = unsafe { libc::getpid() };
    unsafe {
        command.pre_exec(move || {
            // Command's process_group setup precedes pre_exec. Check liveness
            // after joining: a late child must not exec into a retired group.
            // Only parent identity is captured, preserving reuse of Command.
            if libc::getppid() != parent {
                return Err(io::Error::from_raw_os_error(libc::ECANCELED));
            }
            Ok(())
        });
    }
    owned.leaf = Some(command.spawn()?);
    let leaf = owned.leaf.as_mut().expect("owned leaf");
    let stdout = leaf
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("Owned stdout pipe unavailable".into()))?;
    let stderr = leaf
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("Owned stderr pipe unavailable".into()))?;
    nonblocking(stdout.as_raw_fd())?;
    nonblocking(stderr.as_raw_fd())?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let mut readers = Readers {
        stop: stop.clone(),
        stdout: None,
        stderr: None,
    };
    readers.stdout = Some(reader(stdout, limits.0, overflow.clone(), stop.clone())?);
    readers.stderr = Some(reader(stderr, limits.1, overflow.clone(), stop)?);
    loop {
        if cancelled() || overflow.load(Ordering::Acquire) {
            owned.stop();
            return Err(AppError::Other(
                if overflow.load(Ordering::Acquire) {
                    "Child output exceeded its limit"
                } else {
                    cancel_message
                }
                .into(),
            ));
        }
        if exited(&mut owned.anchor)? {
            owned.stop();
            return Err(AppError::Other(
                "Owned process supervision was interrupted".into(),
            ));
        }
        if exited(owned.leaf.as_mut().expect("owned leaf"))? {
            owned.stop();
            let status = owned.leaf.as_mut().expect("owned leaf").wait()?;
            // Kill inherited pipe holders immediately after leaf exit, then drain
            // original pipes to EOF. No reader thread is detached on any path.
            let deadline = Instant::now() + Duration::from_secs(1);
            while !(readers.stdout.as_ref().unwrap().is_finished()
                && readers.stderr.as_ref().unwrap().is_finished())
            {
                if Instant::now() >= deadline {
                    readers.stop.store(true, Ordering::Release);
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let stdout = readers
                .stdout
                .take()
                .unwrap()
                .join()
                .map_err(|_| AppError::Other("Owned stdout reader stopped".into()))??;
            let stderr = readers
                .stderr
                .take()
                .unwrap()
                .join()
                .map_err(|_| AppError::Other("Owned stderr reader stopped".into()))??;
            if overflow.load(Ordering::Acquire) {
                return Err(AppError::Other("Child output exceeded its limit".into()));
            }
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
