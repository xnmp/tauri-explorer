//! Suppress the console window that a spawned CLI child process flashes on
//! Windows. The app is built with the `windows` subsystem (no attached
//! console), so every `std::process::Command` that launches a console program
//! (git, powershell, where.exe, …) briefly pops a black console window unless
//! it is created with the `CREATE_NO_WINDOW` flag. This is very visible when a
//! command runs often — e.g. `git status` on every directory change.
//!
//! Use: `Command::new("git").no_console().args(...)`. No-op on non-Windows.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::error::AppError;

/// Mark a `Command` so it does not pop a console window on Windows.
pub trait NoConsole {
    fn no_console(&mut self) -> &mut Self;
}

impl NoConsole for std::process::Command {
    #[cfg(windows)]
    fn no_console(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — run the child without allocating a console.
        self.creation_flags(0x0800_0000)
    }

    #[cfg(not(windows))]
    fn no_console(&mut self) -> &mut Self {
        self
    }
}

/// Run a child while draining both output pipes and observing `cancelled`.
///
/// `Command::output()` cannot be interrupted and can therefore leave an
/// abandoned Git scan running for many seconds on a network/WSL filesystem.
/// The pipe readers run concurrently so a large porcelain response cannot
/// deadlock on a full OS pipe while this thread polls the child.
pub fn output_cancellable(
    command: &mut Command,
    cancelled: &AtomicBool,
    cancel_message: &'static str,
) -> Result<Output, AppError> {
    output_controlled(
        command,
        || cancelled.load(Ordering::Relaxed),
        (usize::MAX, usize::MAX),
        cancel_message,
    )
}

/// Bounded subprocess output with the same cancellation/process-tree ownership.
pub(crate) fn output_controlled(
    command: &mut Command,
    cancelled: impl Fn() -> bool,
    limits: (usize, usize),
    cancel_message: &'static str,
) -> Result<Output, AppError> {
    if cancelled() {
        return Err(AppError::Other(cancel_message.into()));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Give the child its own process group so cancellation also terminates
        // descendants (for example a shell/helper launched by Git).
        command.process_group(0);
    }

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(AppError::from)?;
    let pid = child.id();
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("child stdout pipe unavailable".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("child stderr pipe unavailable".into()))?;
    let overflow = std::sync::Arc::new(AtomicBool::new(false));
    let stdout_overflow = overflow.clone();
    let stderr_overflow = overflow.clone();
    let stdout_reader =
        std::thread::spawn(move || read_bounded(&mut stdout, limits.0, &stdout_overflow));
    let stderr_reader =
        std::thread::spawn(move || read_bounded(&mut stderr, limits.1, &stderr_overflow));

    let mut exited = None;
    loop {
        if cancelled() || overflow.load(Ordering::Relaxed) {
            terminate_process_tree(&mut child, pid);
            let _ = child.wait();
            drain_readers(stdout_reader, stderr_reader);
            return Err(AppError::Other(
                if overflow.load(Ordering::Relaxed) {
                    "Child output exceeded its limit"
                } else {
                    cancel_message
                }
                .into(),
            ));
        }

        if exited.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => exited = Some((status, Instant::now())),
                Ok(None) => {}
                Err(error) => {
                    terminate_process_tree(&mut child, pid);
                    let _ = child.wait();
                    drain_readers(stdout_reader, stderr_reader);
                    return Err(AppError::from(error));
                }
            }
        }
        if let Some((status, since)) = exited {
            if stdout_reader.is_finished() && stderr_reader.is_finished() {
                let stdout = stdout_reader
                    .join()
                    .map_err(|_| AppError::Other("child stdout reader panicked".into()))?
                    .map_err(AppError::from)?;
                let stderr = stderr_reader
                    .join()
                    .map_err(|_| AppError::Other("child stderr reader panicked".into()))?
                    .map_err(AppError::from)?;
                if overflow.load(Ordering::Relaxed) {
                    return Err(AppError::Other("Child output exceeded its limit".into()));
                }
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            // The launcher may exit while a descendant retains its pipes.
            // Continue observing cancellation until EOF, then bound that drain.
            if since.elapsed() >= Duration::from_secs(5) {
                terminate_process_tree(&mut child, pid);
                drain_readers(stdout_reader, stderr_reader);
                return Err(AppError::Other(
                    "Child output pipes remained open after exit".into(),
                ));
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Never join a blocked pipe reader after termination: an independently
/// detached descendant can hold a pipe even after the owned group is killed.
fn drain_readers<T>(stdout: std::thread::JoinHandle<T>, stderr: std::thread::JoinHandle<T>) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while !(stdout.is_finished() && stderr.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if stdout.is_finished() {
        let _ = stdout.join();
    }
    if stderr.is_finished() {
        let _ = stderr.join();
    }
}

fn read_bounded(
    reader: &mut impl Read,
    limit: usize,
    overflow: &AtomicBool,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            return Ok(bytes);
        }
        let remaining = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..count.min(remaining)]);
        if count > remaining {
            overflow.store(true, Ordering::Relaxed);
        }
    }
}

#[cfg(unix)]
fn terminate_process_tree(child: &mut std::process::Child, pid: u32) {
    // SAFETY: `pid` is the live child we just spawned as process-group leader.
    // A negative id targets exactly that group. Fall back to Child::kill if
    // group signalling fails (for example if the child exited concurrently).
    let killed = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } == 0;
    if !killed {
        let _ = child.kill();
    }
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut std::process::Child, pid: u32) {
    // `/T` includes descendants; this matters for `wsl.exe`, which proxies the
    // actual Linux Git process. Child::kill remains a fallback if taskkill is
    // unavailable or races with normal completion.
    let _ = Command::new("taskkill")
        .no_console()
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::output_cancellable;
    #[cfg(unix)]
    use super::output_controlled;
    use std::process::Command;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[test]
    fn cancellation_terminates_a_running_child_promptly() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let trigger = cancelled.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            trigger.store(true, std::sync::atomic::Ordering::Relaxed);
        });

        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            command
        };

        let start = Instant::now();
        let error = output_cancellable(&mut command, &cancelled, "git status cancelled")
            .expect_err("the cancelled child must not return a status result");

        assert!(error.to_string().contains("git status cancelled"));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "cancellation did not terminate the child promptly"
        );
    }

    #[test]
    fn successful_output_is_preserved_when_not_cancelled() {
        let cancelled = AtomicBool::new(false);
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "printf observable-output"]);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            // `set /p` with no input always sets errorlevel 1; exit explicitly.
            command.args(["/C", "<nul set /p =observable-output& exit 0"]);
            command
        };

        let output = output_cancellable(&mut command, &cancelled, "git status cancelled")
            .expect("successful child output");

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "observable-output");
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_remains_active_after_launcher_exits() {
        let start = Instant::now();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30 &"]);
        let error = output_controlled(
            &mut command,
            || start.elapsed() >= Duration::from_millis(100),
            (1024, 1024),
            "cancelled inherited pipes",
        )
        .unwrap_err();
        assert!(error.to_string().contains("cancelled inherited pipes"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn excessive_output_terminates_the_owned_process_tree() {
        let mut command = Command::new("sh");
        command.args(["-c", "while :; do printf 'xxxxxxxxxxxxxxxx'; done & wait"]);
        let start = Instant::now();
        let error = output_controlled(&mut command, || false, (64, 64), "cancelled").unwrap_err();
        assert!(error.to_string().contains("exceeded its limit"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
