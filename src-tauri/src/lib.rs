//! Tauri Explorer app entry point.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-im3m, tauri-explorer-bo8l

mod archive;
mod clipboard;
mod config;
mod content_search;
pub mod error;
mod files;
mod search;
pub mod task_registry;
mod thumbnails;

use std::path::PathBuf;

use error::AppError;

/// Move a file or directory to the system trash/recycle bin.
/// Cross-platform: Windows Recycle Bin, macOS Trash, Linux Freedesktop Trash.
#[tauri::command]
fn move_to_trash(path: String) -> Result<(), AppError> {
    let pathbuf = PathBuf::from(&path);

    if !pathbuf.exists() {
        return Err(AppError::NotFound(path));
    }

    trash::delete(&pathbuf).map_err(|e| AppError::Other(format!("Failed to move to trash: {}", e)))
}

/// Move multiple files/directories to trash.
#[tauri::command]
fn move_multiple_to_trash(paths: Vec<String>) -> Result<(), AppError> {
    let pathbufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    for (i, path) in pathbufs.iter().enumerate() {
        if !path.exists() {
            return Err(AppError::NotFound(paths[i].clone()));
        }
    }

    trash::delete_all(&pathbufs).map_err(|e| AppError::Other(format!("Failed to move items to trash: {}", e)))
}

/// Set window opacity via the compositor (Hyprland only).
/// Falls back silently on non-Hyprland systems.
#[tauri::command]
fn set_compositor_opacity(opacity: f64) -> Result<bool, AppError> {
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_err() {
        return Ok(false);
    }
    let pid = std::process::id();
    let clamped = opacity.clamp(0.1, 1.0);
    let output = std::process::Command::new("hyprctl")
        .args(["dispatch", "setprop", &format!("pid:{pid}"), "opacity", &format!("{clamped:.2}"), "lock"])
        .output()
        .map_err(|e| AppError::Other(format!("Failed to run hyprctl: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("hyprctl failed: {stderr}")));
    }
    Ok(true)
}

/// Restore files from the system trash by their original paths.
/// Finds the most recently deleted item matching each path and restores it.
#[tauri::command]
fn restore_from_trash(paths: Vec<String>) -> Result<(), AppError> {
    let trash_items = trash::os_limited::list()
        .map_err(|e| AppError::Other(format!("Failed to list trash: {}", e)))?;

    let mut to_restore = Vec::new();

    for path_str in &paths {
        let target = PathBuf::from(path_str);
        // Find the most recently deleted item matching this original path
        let mut matching: Vec<_> = trash_items
            .iter()
            .filter(|item| item.original_path() == target)
            .collect();
        matching.sort_by_key(|item| std::cmp::Reverse(item.time_deleted));

        if let Some(item) = matching.into_iter().next() {
            to_restore.push(item.clone());
        }
    }

    if to_restore.is_empty() {
        return Err(AppError::Other("No matching items found in trash".to_string()));
    }

    trash::os_limited::restore_all(to_restore)
        .map_err(|e| AppError::Other(format!("Failed to restore from trash: {}", e)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix webkit2gtk rendering issues on Linux compositors (Hyprland, Sway, etc.)
    // WEBKIT_DISABLE_COMPOSITING_MODE: prevents ghosting artifacts with transparent windows.
    // WEBKIT_DISABLE_DMABUF_RENDERER: fixes Wayland protocol errors on some GPU/driver combos.
    // Real window transparency is handled compositor-side (e.g. hyprctl setprop opacity).
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_clipboard_x::init())
        .invoke_handler(tauri::generate_handler![
            // Trash operations
            move_to_trash,
            move_multiple_to_trash,
            restore_from_trash,
            // Window
            set_compositor_opacity,
            // File operations
            files::list_directory,
            files::invalidate_dir_cache,
            files::get_home_directory,
            files::create_directory,
            files::rename_entry,
            files::copy_entry,
            files::move_entry,
            files::open_file,
            files::open_file_with,
            files::open_in_terminal,
            files::read_text_file,
            files::write_text_file,
            files::delete_entry_permanent,
            files::create_symlink,
            files::estimate_size,
            // Streaming directory listing
            files::start_streaming_directory,
            files::cancel_directory_listing,
            // Search
            search::fuzzy_search,
            search::start_streaming_search,
            search::cancel_search,
            // Content search (ripgrep)
            content_search::start_content_search,
            content_search::cancel_content_search,
            // Clipboard (Linux native)
            clipboard::clipboard_has_files,
            clipboard::clipboard_read_files,
            clipboard::clipboard_write_files,
            clipboard::clipboard_has_image,
            clipboard::clipboard_paste_image,
            // Thumbnails
            thumbnails::get_thumbnail,
            thumbnails::get_thumbnail_data,
            thumbnails::clear_thumbnail_cache,
            thumbnails::get_thumbnail_cache_stats,
            // Archive operations
            archive::compress_to_zip,
            archive::extract_archive,
            // Config file persistence
            config::read_config_file,
            config::write_config_file,
            config::get_config_dir,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                println!("[Explorer] Rust backend ready");
            }
            // Note: Window rounded corners and borders are handled via CSS
            // with transparent: true and shadow: false in tauri.conf.json
            // DWM APIs don't work with decorations: false windows
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
