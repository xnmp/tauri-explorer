//! Suppress the console window that a spawned CLI child process flashes on
//! Windows. The app is built with the `windows` subsystem (no attached
//! console), so every `std::process::Command` that launches a console program
//! (git, powershell, where.exe, …) briefly pops a black console window unless
//! it is created with the `CREATE_NO_WINDOW` flag. This is very visible when a
//! command runs often — e.g. `git status` on every directory change.
//!
//! Use: `Command::new("git").no_console().args(...)`. No-op on non-Windows.

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

#[cfg(test)]
mod tests {
    use super::output_cancellable;
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
            command.args(["/C", "<nul set /p =observable-output"]);
            command
        };

        let output = output_cancellable(&mut command, &cancelled, "git status cancelled")
            .expect("successful child output");

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "observable-output");
    }
}
