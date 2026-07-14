// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let t_main = std::time::Instant::now();

    // Capture cwd immediately — before Tauri or any library changes it.
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    // Support `tauri-explorer /some/path` CLI argument (flags like
    // --file-chooser-portal are not paths).
    let cli_path = std::env::args().nth(1).filter(|a| !a.starts_with("--"));
    let portal_mode = std::env::args().any(|a| a == "--file-chooser-portal");

    // Launcher-artifact cwds are not useful launch locations: Finder/DMG on
    // macOS sets "/", and Start menu / Explorer on Windows set the app's own
    // install directory (#408). Fall back to the home directory (frontend
    // default) in those cases.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
    let cwd = cwd.filter(|p| {
        !tauri_explorer_lib::system::is_launcher_artifact_cwd(
            std::path::Path::new(p),
            exe_dir.as_deref(),
        )
    });

    let launch_dir = cli_path.or(cwd);

    // Fork to background so the launching terminal is freed.
    // On Windows, the windows_subsystem attribute already handles this.
    // Skip in debug/dev builds so `tauri dev` stays in the foreground with logs.
    // macOS: fork() is not safe after Cocoa/AppKit initialization — it breaks
    // WKWebView's XPC connections, causing blank windows. Use `open -a` to launch
    // the .app bundle detached from the terminal instead.
    // Portal mode must not fork: D-Bus activation tracks the spawned
    // process, which has to be the one acquiring the bus name.
    #[cfg(all(target_os = "linux", not(debug_assertions)))]
    if !portal_mode {
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
    }
    #[cfg(not(all(target_os = "linux", not(debug_assertions))))]
    let _ = portal_mode;

    #[cfg(debug_assertions)]
    eprintln!("[Perf] main() pre-run: {:?}", t_main.elapsed());
    tauri_explorer_lib::run(launch_dir)
}
