//! Tauri Explorer app entry point.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-im3m

mod files;
mod search;
mod thumbnails;

use std::path::PathBuf;

#[cfg(target_os = "windows")]
use tauri::Manager;

/// Move a file or directory to the system trash/recycle bin.
/// Cross-platform: Windows Recycle Bin, macOS Trash, Linux Freedesktop Trash.
#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    let pathbuf = PathBuf::from(&path);

    if !pathbuf.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    trash::delete(&pathbuf).map_err(|e| format!("Failed to move to trash: {}", e))
}

/// Move multiple files/directories to trash.
#[tauri::command]
fn move_multiple_to_trash(paths: Vec<String>) -> Result<(), String> {
    let pathbufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    for (i, path) in pathbufs.iter().enumerate() {
        if !path.exists() {
            return Err(format!("Path does not exist: {}", paths[i]));
        }
    }

    trash::delete_all(&pathbufs).map_err(|e| format!("Failed to move items to trash: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // Trash operations
            move_to_trash,
            move_multiple_to_trash,
            // File operations
            files::list_directory,
            files::get_home_directory,
            files::create_directory,
            files::rename_entry,
            files::copy_entry,
            files::move_entry,
            files::open_file,
            files::delete_entry_permanent,
            // Streaming directory listing
            files::start_streaming_directory,
            files::cancel_directory_listing,
            // Search
            search::fuzzy_search,
            search::start_streaming_search,
            search::cancel_search,
            // Thumbnails
            thumbnails::get_thumbnail,
            thumbnails::get_thumbnail_data,
            thumbnails::clear_thumbnail_cache,
            thumbnails::get_thumbnail_cache_stats,
        ])
        .setup(|#[allow(unused)] app| {
            #[cfg(debug_assertions)]
            {
                println!("[Explorer] Rust backend ready");
            }

            // Apply rounded corners on Windows 11
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                    DWM_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
                };

                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(hwnd) = window.hwnd() {
                        let preference = DWMWCP_ROUND;
                        unsafe {
                            let _ = DwmSetWindowAttribute(
                                HWND(hwnd.0 as *mut std::ffi::c_void),
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &preference as *const DWM_WINDOW_CORNER_PREFERENCE as *const _,
                                std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
                            );
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
