/// Explorer app entry point.
/// Issue: tauri-explorer-rzs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                println!("[Explorer] Dev mode: expecting API at http://127.0.0.1:8008");
                println!("[Explorer] Run: cd src-python && uv run uvicorn api.main:app --port 8008");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
