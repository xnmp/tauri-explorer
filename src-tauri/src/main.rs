// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let t_main = std::time::Instant::now();

    // Capture cwd immediately — before Tauri or any library changes it.
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    // Support `tauri-explorer /some/path` CLI argument.
    let cli_path = std::env::args().nth(1);

    let launch_dir = cli_path.or(cwd);

    // Fork to background so the launching terminal is freed.
    // On Windows, the windows_subsystem attribute already handles this.
    // Skip in debug/dev builds so `tauri dev` stays in the foreground with logs.
    #[cfg(all(unix, not(debug_assertions)))]
    unsafe {
        let pid = libc::fork();
        if pid > 0 {
            // Parent — exit immediately to free the terminal.
            libc::_exit(0);
        }
        if pid == 0 {
            // Child — start a new session so we're fully detached.
            libc::setsid();
        }
        // pid < 0: fork failed, just continue in the original process.
    }

    eprintln!("[Perf] main() pre-run: {:?}", t_main.elapsed());
    tauri_explorer_lib::run(launch_dir)
}
