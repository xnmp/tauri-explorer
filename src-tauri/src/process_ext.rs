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
