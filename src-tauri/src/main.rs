// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Capture cwd immediately — before Tauri or any library changes it.
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    // Support `tauri-explorer /some/path` CLI argument.
    let cli_path = std::env::args().nth(1);

    let launch_dir = cli_path.or(cwd);

    eprintln!("[Explorer] launch_dir: {:?}", launch_dir);

    tauri_explorer_lib::run(launch_dir)
}
