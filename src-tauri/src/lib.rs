//! Tauri Explorer app entry point.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-im3m, tauri-explorer-bo8l, tauri-explorer-yclf

mod archive;
mod clipboard;
mod config;
mod content_search;
pub mod error;
mod files;
mod search;
pub mod task_registry;
mod thumbnails;
mod wallpaper;

use std::path::PathBuf;

use error::AppError;

/// Stores the working directory from which the app was launched.
struct LaunchCwd(String);

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

/// Get the directory the app was launched from.
#[tauri::command]
fn get_launch_cwd(state: tauri::State<'_, LaunchCwd>) -> String {
    state.0.clone()
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
pub fn run(launch_dir: Option<String>) {
    let t_start = std::time::Instant::now();

    // Fix webkit2gtk Wayland protocol errors on Linux compositors (Hyprland, Sway, etc.)
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let home_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .to_string_lossy()
        .to_string();
    let launch_cwd = launch_dir.unwrap_or_else(|| home_dir.clone());

    // Inject launch data into the webview as a synchronous JS global,
    // so the frontend can read it immediately without IPC roundtrips.
    let init_script = format!(
        "window.__LAUNCH_DATA__ = {{ cwd: {}, home: {} }};",
        serde_json::to_string(&launch_cwd).unwrap(),
        serde_json::to_string(&home_dir).unwrap(),
    );
    let launch_cwd_for_state = launch_cwd.clone();

    let t_plugins = std::time::Instant::now();

    tauri::Builder::default()
        .manage(LaunchCwd(launch_cwd_for_state))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_clipboard_x::init())
        .invoke_handler(tauri::generate_handler![
            // Launch info
            get_launch_cwd,
            // Trash operations
            move_to_trash,
            move_multiple_to_trash,
            restore_from_trash,
            // File operations — directory listing
            files::dir_listing::list_directory,
            files::dir_listing::invalidate_dir_cache,
            files::dir_listing::start_streaming_directory,
            files::dir_listing::cancel_directory_listing,
            // File operations — CRUD
            files::file_ops::get_home_directory,
            files::file_ops::create_directory,
            files::file_ops::rename_entry,
            files::file_ops::copy_entry,
            files::file_ops::move_entry,
            files::file_ops::read_text_file,
            files::file_ops::write_text_file,
            files::file_ops::delete_entry_permanent,
            files::file_ops::create_symlink,
            files::file_ops::estimate_size,
            files::file_ops::check_paths_exist,
            // File operations — external apps
            files::external_apps::open_file,
            files::external_apps::open_file_with,
            files::external_apps::open_image_with_siblings,
            files::external_apps::open_in_terminal,
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
            thumbnails::get_micro_thumbnail,
            thumbnails::clear_thumbnail_cache,
            thumbnails::get_thumbnail_cache_stats,
            // Archive operations
            archive::compress_to_zip,
            archive::extract_archive,
            // Config file persistence
            config::read_config_file,
            config::write_config_file,
            config::get_config_dir,
            config::list_user_themes,
            // Wallpaper
            wallpaper::set_as_wallpaper,
        ])
        .setup(move |app| {
            let t_setup = std::time::Instant::now();

            // Create window programmatically so we can inject initialization_script.
            // This replaces the static window definition in tauri.conf.json.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("tauri-explorer")
            .inner_size(1200.0, 800.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .disable_drag_drop_handler()
            .initialization_script(&init_script)
            .build()?;

            #[cfg(debug_assertions)]
            eprintln!(
                "[Perf] Rust startup:\n  \
                 pre-builder:  {:?}\n  \
                 builder→setup: {:?}\n  \
                 total:        {:?}",
                t_plugins - t_start,
                t_setup - t_plugins,
                t_setup - t_start,
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
