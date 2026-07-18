//! Tauri Explorer app entry point.
//! Issue: tauri-explorer-nv2y, tauri-explorer-hgt6, tauri-explorer-im3m, tauri-explorer-bo8l, tauri-explorer-yclf

mod ai_organize;
mod ai_rename;
mod archive;
mod clipboard;
mod config;
mod content_search;
mod crash_report;
pub mod error;
mod fal;
// pub: criterion benches (src-tauri/benches/) call into
// files::dir_listing::{scan_directory_parallel, sort_entries} directly.
pub mod files;
mod gemini;
pub mod git;
pub mod git_actions;
mod git_common;
pub mod git_log;
mod github;
mod nano_banana;
mod palette;
mod plugin_job;
#[cfg(target_os = "linux")]
mod portal;
mod process_ext;
mod progress;
mod update_check;
mod upscale;
/// Non-Linux stub so the command registry stays platform-independent.
#[cfg(not(target_os = "linux"))]
mod portal {
    #[tauri::command]
    pub async fn picker_respond(_token: String, _paths: Vec<String>, _cancelled: bool) {}

    pub fn is_portal_mode() -> bool {
        false
    }
}
mod search;
pub mod system;
pub mod task_registry;
mod terminal;
mod thumbnails;
mod wallpaper;
mod warm_pool;
mod wsl;

use system::{
    get_launch_cwd, get_log_dir, log_startup_timing, move_multiple_to_trash, move_to_trash,
    read_log_tail, restore_from_trash, set_window_theme, LaunchCwd,
};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Minimal stdout logger for `#[ignore]`d diagnostic tests (git_status.rs,
/// git.rs) run manually against a live WSL distro: `cargo test` normally has
/// no `log` sink installed, so `gitstat:` lines would otherwise be silently
/// dropped. Shared here so both test modules can install it.
#[cfg(test)]
pub(crate) fn init_test_logger() {
    struct StdoutLog;
    impl log::Log for StdoutLog {
        fn enabled(&self, _metadata: &log::Metadata) -> bool {
            true
        }
        fn log(&self, record: &log::Record) {
            println!("[{}] {}", record.level(), record.args());
        }
        fn flush(&self) {}
    }
    // Multiple diagnostic tests may call this; a second install attempt is
    // expected to fail and is intentionally ignored.
    let _ = log::set_boxed_logger(Box::new(StdoutLog));
    log::set_max_level(log::LevelFilter::Debug);
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
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
        .to_string_lossy()
        .to_string();
    let launch_cwd = launch_dir.unwrap_or_else(|| home_dir.clone());

    // Inject launch data into the webview as a synchronous JS global,
    // so the frontend can read it immediately without IPC roundtrips.
    //
    // The saved theme is applied to <html data-theme> in app.html's head
    // script (runs in every window before the bundle parses), not here — that
    // covers child windows too, which don't receive this initialization_script.
    let init_script = format!(
        "window.__LAUNCH_DATA__ = {{ cwd: {}, home: {} }};",
        serde_json::to_string(&launch_cwd).unwrap(),
        serde_json::to_string(&home_dir).unwrap(),
    );
    let launch_cwd_for_state = launch_cwd.clone();

    let t_plugins = std::time::Instant::now();

    // Parse RUST_LOG env var for log level override (default: warn, app crate: info).
    let app_log_level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(log::LevelFilter::Info);

    tauri::Builder::default()
        .manage(LaunchCwd(launch_cwd_for_state))
        .plugin({
            let mut targets = vec![
                Target::new(TargetKind::LogDir { file_name: None }),
                Target::new(TargetKind::Webview),
            ];
            if cfg!(debug_assertions) {
                targets.push(Target::new(TargetKind::Stdout));
            }
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Warn) // third-party crates: warn only
                .level_for("tauri_explorer", app_log_level)
                .level_for("tauri_explorer_lib", app_log_level)
                .rotation_strategy(RotationStrategy::KeepSome(7))
                .max_file_size(10 * 1024 * 1024) // 10 MB
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets(targets)
                .build()
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_clipboard_x::init())
        .invoke_handler(tauri::generate_handler![
            // Launch info
            get_launch_cwd,
            get_log_dir,
            read_log_tail,
            system::get_app_info,
            crash_report::take_crash_report,
            crash_report::log_frontend_error,
            crash_report::record_frontend_crash,
            crash_report::open_external_url,
            palette::extract_palette,
            config::write_theme_file,
            update_check::check_for_update,
            log_startup_timing,
            // Trash operations
            move_to_trash,
            move_multiple_to_trash,
            restore_from_trash,
            // File operations — directory listing
            files::dir_listing::list_directory,
            files::dir_listing::invalidate_dir_cache,
            files::dir_listing::is_directory_empty,
            files::dir_listing::start_streaming_directory,
            files::dir_listing::cancel_directory_listing,
            // File operations — CRUD
            files::file_ops::get_home_directory,
            files::file_ops::create_directory,
            files::file_ops::create_empty_file,
            files::file_ops::rename_entry,
            files::file_ops::copy_entry,
            files::file_ops::cancel_copy,
            files::file_ops::move_entry,
            files::file_ops::read_text_file,
            files::file_ops::read_image_data_url,
            files::file_ops::write_text_file,
            files::file_ops::delete_entry_permanent,
            files::file_ops::create_symlink,
            files::file_ops::estimate_size,
            files::file_ops::check_paths_exist,
            // Filesystem watcher
            files::fs_watcher::watch_directory,
            files::fs_watcher::unwatch_directory,
            // File operations — external apps
            files::external_apps::open_file,
            files::external_apps::open_file_at_line,
            files::external_apps::open_file_with,
            files::external_apps::open_image_with_siblings,
            files::external_apps::open_in_terminal,
            files::external_apps::list_installed_terminals,
            files::shortcuts::resolve_shortcut,
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
            thumbnails::get_video_thumbnail_data,
            thumbnails::get_folder_preview,
            thumbnails::set_ffmpeg_path,
            thumbnails::clear_thumbnail_cache,
            thumbnails::get_thumbnail_cache_stats,
            // Archive operations
            archive::compress_to_zip,
            archive::cancel_compress,
            archive::cancel_extract,
            archive::extract_archive,
            archive::list_archive_contents,
            // Config file persistence
            config::read_config_file,
            config::write_config_file,
            config::get_config_dir,
            config::list_user_themes,
            // Git status (legacy: per-file indicators for file list)
            files::git_status::get_git_status,
            // Git source-control backend (#53, #54)
            git::git_init,
            git::git_repo_root,
            git::git_add_to_gitignore,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_diff,
            git::git_commit,
            git::git_watch_repo,
            git::git_unwatch_repo,
            git_log::git_log,
            git_log::git_refs,
            git_log::git_commit_files,
            git_log::git_commit_file_diff,
            git_actions::git_checkout,
            git_actions::git_create_branch,
            git_actions::git_create_tag,
            git_actions::git_cherry_pick,
            git_actions::git_revert,
            git_actions::git_merge,
            git_actions::git_rebase,
            git_actions::git_reset,
            git_actions::git_merge_abort,
            git_actions::git_rebase_abort,
            git_actions::git_rebase_continue,
            git_actions::git_cherry_pick_abort,
            git_actions::git_revert_abort,
            git_actions::git_fetch,
            git_actions::git_pull,
            git_actions::git_branch_behind_upstream,
            git_log::git_branch_authors,
            github::git_open_prs,
            git_actions::git_delete_branch,
            git_actions::git_delete_remote_branch,
            git_actions::git_checkout_tracking,
            git_actions::git_sync_local_branches,
            // Drives / volumes
            files::drives::list_drives,
            // Wallpaper
            wallpaper::set_as_wallpaper,
            // Nano Banana (AI image editing)
            nano_banana::start_nano_banana_job,
            upscale::start_upscale_job,
            // AI rename suggestions
            ai_rename::ai_suggest_filenames,
            ai_organize::ai_suggest_destination,
            // File-picker portal (xdg-desktop-portal FileChooser backend)
            portal::picker_respond,
            // Window appearance
            set_window_theme,
            // Pre-warmed window pool
            warm_pool::warm_pool_begin_spawn,
            warm_pool::warm_pool_cancel_spawn,
            warm_pool::warm_pool_register,
            warm_pool::warm_pool_claim,
            warm_pool::warm_pool_discard,
            warm_pool::warm_pool_shutdown,
            // Embedded terminal
            terminal::terminal_reserve_id,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_status,
        ])
        .setup(move |app| {
            let t_setup = std::time::Instant::now();

            // Persist panics locally so the next launch can offer a
            // pre-filled GitHub issue (#184). Local files only — no telemetry.
            if let Ok(log_dir) = tauri::Manager::path(app).app_log_dir() {
                crash_report::install_panic_hook(log_dir.join("crashes"));
            }

            // Initialize filesystem watcher for auto-refresh
            files::fs_watcher::init_watcher(app.handle());

            // Portal-backend mode: no main window — serve the FileChooser
            // D-Bus interface and open picker windows on demand.
            if portal::is_portal_mode() {
                #[cfg(target_os = "linux")]
                portal::start_portal_service(app.handle());
                return Ok(());
            }

            // Create window programmatically so we can inject initialization_script.
            // This replaces the static window definition in tauri.conf.json.
            // `mut` is used by the macOS (title bar / vibrancy) and Windows
            // (Mica/Acrylic backdrop) blocks below; allow the otherwise-unused
            // mut on Linux so clippy -D warnings stays green there.
            #[cfg_attr(target_os = "linux", allow(unused_mut))]
            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("tauri-explorer")
            .inner_size(1200.0, 800.0)
            .decorations(cfg!(target_os = "macos"))
            .accept_first_mouse(true)
            .initialization_script(&init_script);

            #[cfg(target_os = "macos")]
            {
                let settings_json = config::config_dir()
                    .ok()
                    .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());

                let integrated = settings_json
                    .as_ref()
                    .and_then(|v| v.get("integratedTitleBar")?.as_bool())
                    .unwrap_or(false);
                if integrated {
                    builder = builder
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true);
                }

                let vibrancy = settings_json
                    .as_ref()
                    .and_then(|v| v.get("macOsVibrancy")?.as_bool())
                    .unwrap_or(false);
                let vibrancy_blur = settings_json
                    .as_ref()
                    .and_then(|v| v.get("vibrancyBlur")?.as_bool())
                    .unwrap_or(true);
                if vibrancy {
                    builder = builder.transparent(true);
                    if vibrancy_blur {
                        use tauri::utils::config::WindowEffectsConfig;
                        use tauri::utils::{WindowEffect, WindowEffectState};
                        builder = builder.effects(WindowEffectsConfig {
                            effects: vec![WindowEffect::UnderWindowBackground],
                            state: Some(WindowEffectState::Active),
                            radius: None,
                            color: None,
                        });
                    }
                }
            }

            // Windows: apply a translucent Mica/Acrylic system backdrop when
            // enabled. Like macOS vibrancy this is a startup decision (the
            // transparent flag can't be toggled at runtime), so it requires a
            // restart. The DWM system backdrop keeps the window's rounded
            // corners; the frontend's [data-vibrancy] CSS makes the app
            // background transparent so the effect shows through.
            #[cfg(target_os = "windows")]
            {
                let backdrop = config::config_dir()
                    .ok()
                    .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v.get("windowsBackdrop")?.as_str().map(String::from));

                use tauri::utils::WindowEffect;
                let effect = match backdrop.as_deref() {
                    Some("mica") => Some(WindowEffect::Mica),
                    Some("acrylic") => Some(WindowEffect::Acrylic),
                    _ => None,
                };
                if let Some(effect) = effect {
                    use tauri::utils::config::WindowEffectsConfig;
                    builder = builder.transparent(true).effects(WindowEffectsConfig {
                        effects: vec![effect],
                        state: None,
                        radius: None,
                        color: None,
                    });
                }
            }

            builder.build()?;

            // WARM_MEASURE=1: also spawn a hidden measure-mode warm window
            // (see runWarmWindow in warm-window.ts). It boots, self-fires one
            // activation, and logs `Startup(warm-activate): show=Xms` — a
            // keypress-free latency probe for platforms with no WebDriver
            // (macOS CI): launch with the env var, wait, grep the app log.
            if std::env::var("WARM_MEASURE").is_ok() {
                tauri::WebviewWindowBuilder::new(
                    app,
                    "explorer-warm-measure",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .initialization_script("window.__WARM_MEASURE__ = true;")
                .visible(false)
                .skip_taskbar(true)
                .inner_size(1200.0, 800.0)
                .build()?;
            }

            log::info!(
                "Startup: pre-builder={:?} builder→setup={:?} total={:?}",
                t_plugins - t_start,
                t_setup - t_plugins,
                t_setup - t_start,
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Portal mode has no persistent window: closing a picker window
            // must not exit the service, or the D-Bus name would drop.
            if portal::is_portal_mode() {
                if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                warm_pool::on_window_destroyed(app, label);
                terminal::on_window_destroyed(label);
            }
            // WebView2 quirk (#415): activating the window (Alt+Tab, taskbar)
            // focuses the native window but NOT the webview's keyboard focus —
            // shortcuts are dead until the user clicks inside. Re-asserting
            // focus moves keyboard focus into the webview. Windows-only: the
            // other platforms hand focus over correctly, and re-entrant
            // set_focus is pointless there.
            #[cfg(windows)]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } = &event
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.set_focus();
                }
            }
        });
}
