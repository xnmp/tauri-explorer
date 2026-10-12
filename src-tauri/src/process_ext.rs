//! Suppress the console window that a spawned CLI child process flashes on
//! Windows. The app is built with the `windows` subsystem (no attached
//! console), so every `std::process::Command` that launches a console program
//! (git, powershell, where.exe, …) briefly pops a black console window unless
//! it is created with the `CREATE_NO_WINDOW` flag. This is very visible when a
//! command runs often — e.g. `git status` on every directory change.
//!
//! Use: `Command::new("git").no_console().args(...)`. No-op on non-Windows.

use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::error::{AppError, ProcessRunError};
#[path = "process_ext/pipe_capture.rs"]
pub(crate) mod pipe_capture;
#[cfg(windows)]
#[path = "process_ext/windows_job.rs"]
mod windows_job;

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
    output_with_stdin(command, cancelled, limits, cancel_message, Stdio::null())
}

/// The owned text service supplies a bounded private prompt file as stdin.
/// File-backed input cannot block a writer thread or exceed argv limits.
pub(crate) fn output_with_stdin(
    command: &mut Command,
    cancelled: impl Fn() -> bool,
    limits: (usize, usize),
    cancel_message: &'static str,
    stdin: Stdio,
) -> Result<Output, AppError> {
    run(
        command,
        cancelled,
        limits,
        cancel_message,
        Input::Stdio(stdin),
        Completion::OutputClosed,
    )
    .map_err(ProcessRunError::into_error)
}

/// Owned run for plugin processes. With `input`, stdin is a pipe that receives
/// exactly those bytes and is then closed; without it, stdin is null. Failures
/// are classified by whether the program could have executed. A completed
/// child's original exit and output remain authoritative after cancellation.
pub(crate) fn output_with_input(
    command: &mut Command,
    cancelled: impl Fn() -> bool,
    limits: (usize, usize),
    cancel_message: &'static str,
    input: Option<Vec<u8>>,
) -> Result<Output, ProcessRunError> {
    let input = match input {
        Some(bytes) => Input::Bytes(bytes),
        None => Input::Stdio(Stdio::null()),
    };
    run(
        command,
        cancelled,
        limits,
        cancel_message,
        input,
        Completion::ChildExited,
    )
}

enum Input {
    Stdio(Stdio),
    Bytes(Vec<u8>),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Completion {
    // Generic scans remain cancellable while descendants hold their pipes.
    OutputClosed,
    // An owned plugin CLI's exit is authoritative. Retire descendants and
    // retain completed bytes even when its owner concurrently retires.
    ChildExited,
}

fn run(
    command: &mut Command,
    cancelled: impl Fn() -> bool,
    limits: (usize, usize),
    cancel_message: &'static str,
    input: Input,
    completion: Completion,
) -> Result<Output, ProcessRunError> {
    use ProcessRunError::{NotStarted, Started};
    if cancelled() {
        return Err(NotStarted(AppError::Other(cancel_message.into())));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Give the child its own process group so cancellation also terminates
        // descendants (for example a shell/helper launched by Git).
        command.process_group(0);
    }

    #[cfg(windows)]
    let owned_job = {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_0004); // NO_WINDOW | SUSPENDED
        windows_job::Job::new().map_err(|cause| NotStarted(cause.into()))?
    };
    let (stdin, bytes) = match input {
        Input::Stdio(stdin) => (stdin, None),
        Input::Bytes(bytes) => (Stdio::piped(), Some(bytes)),
    };
    // std reports exec failures through spawn: an error means nothing ran.
    let mut child = command
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|cause| NotStarted(cause.into()))?;
    #[cfg(windows)]
    if let Err(error) = owned_job.attach_and_resume(&mut child) {
        // The primary thread was created suspended and never resumed.
        let _ = child.kill();
        owned_job.terminate();
        let _ = child.wait();
        return Err(NotStarted(error.into()));
    }
    let pid = child.id();
    let terminate = |child: &mut std::process::Child| {
        #[cfg(windows)]
        {
            // TerminateProcess uses nonzero code 1. Kill the launcher before
            // the job-close fallback, whose exit code is unspecified.
            let _ = child.kill();
            owned_job.terminate();
        }
        terminate_process_tree(child, pid);
    };
    let writer = match (bytes, child.stdin.take()) {
        (None, _) => None,
        (Some(bytes), Some(pipe)) => match write_input(pipe, bytes) {
            Ok(writer) => Some(writer),
            Err(error) => {
                terminate(&mut child);
                let _ = child.wait();
                return Err(Started(error.into()));
            }
        },
        (Some(_), None) => {
            terminate(&mut child);
            let _ = child.wait();
            return Err(Started(AppError::Other(
                "child stdin pipe unavailable".into(),
            )));
        }
    };
    // On Windows the job's descendants are retired as soon as the launcher
    // exits; Unix keeps the group until its pipes reach EOF.
    let launcher_exited = || {
        #[cfg(windows)]
        owned_job.terminate();
    };
    let result = supervise(
        &mut child,
        &terminate,
        &launcher_exited,
        cancelled,
        limits,
        cancel_message,
        completion,
    );
    if let Some(writer) = writer {
        // Termination closed every reader of stdin, so a blocked write fails
        // promptly; never join a writer an escaped descendant still blocks.
        finish_workers([writer]);
    }
    result.map_err(Started)
}

/// Blocking write on its own thread, then close stdin. A child that exits or
/// closes stdin without reading yields a broken pipe: an ordinary outcome.
fn write_input(
    mut pipe: std::process::ChildStdin,
    bytes: Vec<u8>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("owned-process-input".into())
        .spawn(move || {
            let _ = pipe.write_all(&bytes);
        })
}

fn supervise(
    child: &mut std::process::Child,
    terminate: &impl Fn(&mut std::process::Child),
    launcher_exited: &impl Fn(),
    cancelled: impl Fn() -> bool,
    limits: (usize, usize),
    cancel_message: &'static str,
    completion: Completion,
) -> Result<Output, AppError> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("child stdout pipe unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("child stderr pipe unavailable".into()))?;
    let overflow = std::sync::Arc::new(AtomicBool::new(false));
    let mut readers = match pipe_capture::Readers::new(stdout, stderr, limits, overflow.clone()) {
        Ok(readers) => readers,
        Err(error) => {
            terminate(child);
            let _ = child.wait();
            return Err(error.into());
        }
    };

    let mut exited = None;
    loop {
        let cancellation = cancelled();
        if overflow.load(Ordering::Relaxed)
            || (cancellation && completion == Completion::OutputClosed)
        {
            terminate(child);
            let _ = child.wait();
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
            match exited_without_reaping(child) {
                Ok(true) => {
                    launcher_exited();
                    if completion == Completion::ChildExited {
                        terminate(child);
                        readers.retire();
                    }
                    exited = Some(Instant::now());
                }
                Ok(false) => {}
                Err(error) => {
                    terminate(child);
                    let _ = child.wait();
                    return Err(AppError::from(error));
                }
            }
        }
        if let Some(since) = exited {
            if completion == Completion::ChildExited || readers.is_finished() {
                // Kill redirected descendants before reaping the launcher.
                // WNOWAIT keeps its PID/group identity reserved through cleanup.
                terminate(child);
                let status = child.wait()?;
                let (stdout, stderr) = readers.finish()?;
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
                terminate(child);
                let _ = child.wait();
                return Err(AppError::Other(
                    "Child output pipes remained open after exit".into(),
                ));
            }
        }
        if cancellation && !(completion == Completion::ChildExited && exited.is_some()) {
            terminate(child);
            if completion == Completion::ChildExited {
                let status = reap_after_cancellation(|| child.wait(), cancel_message)?;
                readers.retire();
                let (stdout, stderr) = readers.finish()?;
                if overflow.load(Ordering::Relaxed) {
                    return Err(AppError::Other("Child output exceeded its limit".into()));
                }
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            let _ = child.wait();
            return Err(AppError::Other(cancel_message.into()));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn exited_without_reaping(child: &mut std::process::Child) -> std::io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: the owned child PID and correctly sized writable siginfo.
    // WNOWAIT leaves its identity reserved until process-group cleanup.
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::Interrupted {
            Ok(false)
        } else {
            Err(error)
        };
    }
    Ok(unsafe { info.assume_init().si_pid() } != 0)
}
#[cfg(windows)]
fn exited_without_reaping(child: &mut std::process::Child) -> std::io::Result<bool> {
    Ok(child.try_wait()?.is_some())
}

/// Reap after signalling; a stale running observation cannot erase natural success.
pub(crate) fn reap_after_cancellation(
    reap: impl FnOnce() -> std::io::Result<std::process::ExitStatus>,
    cancel_message: &str,
) -> Result<std::process::ExitStatus, AppError> {
    let status = reap()?;
    if status.success() {
        Ok(status)
    } else {
        Err(AppError::Other(cancel_message.into()))
    }
}

fn finish_workers<T, const N: usize>(workers: [std::thread::JoinHandle<T>; N]) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while !workers.iter().all(|worker| worker.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    for worker in workers {
        if worker.is_finished() {
            let _ = worker.join();
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
fn terminate_process_tree(child: &mut std::process::Child, _pid: u32) {
    // The scoped JobObject has already terminated every owned descendant.
    // Retain Child::kill only as a fallback for the launcher's own handle.
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    #[test]
    fn cancellation_reaps_success_after_a_stale_running_observation() {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        let reaped = std::cell::Cell::new(false);
        let status = super::reap_after_cancellation(
            || {
                reaped.set(true);
                Ok(std::process::ExitStatus::from_raw(0))
            },
            "cancelled",
        )
        .expect("OS reported natural success after the stale observation");
        assert!(reaped.get());
        assert!(status.success());
        assert!(super::reap_after_cancellation(
            || Ok(std::process::ExitStatus::from_raw(1)),
            "cancelled"
        )
        .is_err());
    }
    use super::output_cancellable;
    #[cfg(unix)]
    use super::output_controlled;
    #[cfg(target_os = "linux")]
    #[test]
    fn successful_launcher_retires_its_redirected_descendants() {
        let output = output_controlled(
            std::process::Command::new("sh")
                .args(["-c", "sleep 30 >/dev/null 2>&1 & printf '%s' \"$!\""]),
            || false,
            (1024, 1024),
            "cancelled",
        )
        .unwrap();
        assert!(output.status.success());
        let pid = String::from_utf8(output.stdout)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let retired = || {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .map(|stat| {
                    stat.rsplit_once(')')
                        .is_some_and(|(_, tail)| tail.trim_start().starts_with('Z'))
                })
                .unwrap_or(true)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while !retired() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let stopped = retired();
        if !stopped {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        assert!(stopped, "Redirected child survived its successful launcher");
    }

    #[cfg(windows)]
    #[test]
    fn successful_launcher_retires_its_redirected_descendants() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let directory = tempfile::tempdir().unwrap();
        let stdout = directory
            .path()
            .join("child.stdout")
            .to_string_lossy()
            .replace("'", "''");
        let stderr = directory
            .path()
            .join("child.stderr")
            .to_string_lossy()
            .replace("'", "''");
        let script=format!("$p=Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -RedirectStandardOutput '{stdout}' -RedirectStandardError '{stderr}' -PassThru; $p.Id");
        let output = super::output_controlled(
            Command::new("powershell.exe").args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ]),
            || false,
            (1024, 1024),
            "cancelled",
        )
        .unwrap();
        assert!(output.status.success());
        let pid = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let retired = || unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return true;
            }
            let mut code = 259;
            let read = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            read != 0 && code != 259
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while !retired() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            retired(),
            "Redirected child survived its successful launcher"
        );
    }
    use std::process::Command;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    #[test]
    fn completed_png_remains_captured_when_close_wins_reader_scheduling() {
        use std::io::Write;
        use std::os::unix::net::UnixStream;
        let png = include_bytes!("../../static/favicon.png");
        let (output, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(png).unwrap();
        drop(writer);
        let overflow = Arc::new(AtomicBool::new(false));
        // A successful child has exited but its output reader has not run.
        let bytes = super::pipe_capture::spawn(
            output,
            png.len(),
            overflow,
            Arc::new(AtomicBool::new(true)),
        )
        .unwrap()
        .join()
        .unwrap()
        .unwrap();
        assert_eq!(bytes, png);
    }

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

    #[cfg(target_os = "linux")]
    #[test]
    fn completed_plugin_output_survives_cancellation_before_exit_is_observed() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("pid");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "echo $$ > \"$1\"; printf completed-paid-output; exit 0",
            "fixture",
        ]);
        command.arg(&pid_file);
        let calls = std::cell::Cell::new(0);
        let output = super::output_with_input(
            &mut command,
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    return false;
                }
                // Hold the host's first poll until the child has finished; do
                // not reap it, so production still owns the exit observation.
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    if let Ok(pid) = std::fs::read_to_string(&pid_file)
                        .and_then(|pid| pid.trim().parse::<i32>().map_err(std::io::Error::other))
                    {
                        if std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                            stat.rsplit_once(')')
                                .unwrap()
                                .1
                                .trim_start()
                                .starts_with('Z')
                        }) {
                            let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
                            assert_eq!(
                                unsafe {
                                    libc::waitid(
                                        libc::P_PID,
                                        pid as libc::id_t,
                                        info.as_mut_ptr(),
                                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                                    )
                                },
                                0
                            );
                            let info = unsafe { info.assume_init() };
                            assert_eq!(info.si_code, libc::CLD_EXITED);
                            assert_eq!(unsafe { info.si_status() }, 0);
                            return true;
                        }
                    }
                    assert!(Instant::now() < deadline, "fixture child did not exit");
                    std::thread::sleep(Duration::from_millis(1));
                }
            },
            (1024, 1024),
            "plugin retired",
            None,
        )
        .expect("completed paid execution must retain its original output");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"completed-paid-output");
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
