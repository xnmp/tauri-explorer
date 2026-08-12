//! System-level commands: trash, launch context, window theme, log paths.
//! Extracted from lib.rs so the entry point is pure wiring.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::AppError;
use crate::files;

/// Stores the working directory from which the app was launched.
pub struct LaunchCwd(pub String);

/// Reap a launcher child asynchronously so opening a native surface does not
/// accumulate zombies on Unix.
#[cfg(not(target_os = "linux"))]
fn reap_in_background(child: std::process::Child) {
    std::thread::spawn(move || {
        let mut child = child;
        let child_id = child.id();
        match child.wait() {
            Ok(status) if status.success() => {
                log::debug!("Recycle Bin launcher process {child_id} exited successfully");
            }
            Ok(status) => {
                log::warn!("Recycle Bin launcher process {child_id} exited with {status}");
            }
            Err(error) => {
                log::warn!("Failed to reap Recycle Bin launcher process {child_id}: {error}");
            }
        }
    });
}

/// Immutable, platform-specific command specification for the native recycle
/// bin surface. Keeping this separate from spawning makes the platform
/// contract testable without launching the host desktop during tests.
#[derive(Debug, PartialEq, Eq)]
struct RecycleBinLauncher {
    program: &'static str,
    arguments: Vec<OsString>,
}

fn recycle_bin_launcher() -> RecycleBinLauncher {
    #[cfg(target_os = "windows")]
    {
        RecycleBinLauncher {
            program: "explorer.exe",
            arguments: vec![OsString::from("shell:RecycleBinFolder")],
        }
    }

    #[cfg(target_os = "macos")]
    {
        RecycleBinLauncher {
            program: "open",
            arguments: vec![dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/"))
                .join(".Trash")
                .into_os_string()],
        }
    }

    #[cfg(target_os = "linux")]
    {
        RecycleBinLauncher {
            program: "gio",
            arguments: vec![OsString::from("open"), OsString::from("trash:///")],
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_trash_files_directory_from(
    xdg_data_home: Option<OsString>,
    home_directory: Option<PathBuf>,
) -> Result<PathBuf, AppError> {
    if let Some(xdg_data_home) = xdg_data_home {
        let xdg_data_home = PathBuf::from(xdg_data_home);
        if xdg_data_home.is_absolute() && !xdg_data_home.as_os_str().is_empty() {
            return Ok(xdg_data_home.join("Trash/files"));
        }
    }

    home_directory
        .filter(|home| home.is_absolute())
        .map(|home| home.join(".local/share/Trash/files"))
        .ok_or_else(|| {
            AppError::Other("Cannot locate the user's Freedesktop Trash directory".to_string())
        })
}

#[cfg(target_os = "linux")]
fn linux_trash_files_directory() -> Result<PathBuf, AppError> {
    linux_trash_files_directory_from(std::env::var_os("XDG_DATA_HOME"), dirs::home_dir())
}

#[cfg(target_os = "linux")]
fn linux_recycle_bin_launchers() -> Result<[RecycleBinLauncher; 2], AppError> {
    Ok([
        recycle_bin_launcher(),
        RecycleBinLauncher {
            program: "xdg-open",
            arguments: vec![linux_trash_files_directory()?.into_os_string()],
        },
    ])
}

/// `gio open` reports whether the desktop accepted `trash:///` synchronously.
/// On minimalist Linux desktops, wait for that result so a rejected URI can
/// fall back to the Freedesktop Trash directory.
#[cfg(target_os = "linux")]
fn open_linux_recycle_bin_with<F>(mut launch: F) -> Result<(), AppError>
where
    F: FnMut(&RecycleBinLauncher) -> std::io::Result<std::process::ExitStatus>,
{
    let [primary, fallback] = linux_recycle_bin_launchers()?;

    match launch(&primary) {
        Ok(status) if status.success() => return Ok(()),
        Ok(status) => log::warn!(
            "Recycle Bin: {} {:?} exited with {status}; falling back to {:?}",
            primary.program,
            primary.arguments,
            fallback.arguments
        ),
        Err(error) => log::warn!(
            "Recycle Bin: failed to launch {} {:?}: {error}; falling back to {:?}",
            primary.program,
            primary.arguments,
            fallback.arguments
        ),
    }

    match launch(&fallback) {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(AppError::Other(format!(
            "Failed to open Recycle Bin: {} {:?} exited with {status}",
            fallback.program, fallback.arguments
        ))),
        Err(error) => Err(AppError::Io(error)),
    }
}

/// True for UNC paths (`\\server\share`, `\\wsl.localhost\Distro\...`). Windows
/// has no Recycle Bin for network/WSL locations: the `trash` crate's shell APIs
/// fail on them, so these must be removed directly instead of trashed.
fn is_unc_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

/// Trash a single path, falling back to a permanent delete on UNC locations
/// where the Recycle Bin is unavailable.
pub(crate) fn trash_or_remove(pathbuf: &std::path::Path) -> Result<(), AppError> {
    if is_unc_path(&pathbuf.to_string_lossy()) {
        return files::file_ops::remove_entry_at(pathbuf);
    }
    trash::delete(pathbuf).map_err(|e| {
        log::error!("Failed to move to trash: {}", e);
        AppError::Other(format!("Failed to move to trash: {}", e))
    })
}

/// Move a file or directory to the system trash/recycle bin.
/// Cross-platform: Windows Recycle Bin, macOS Trash, Linux Freedesktop Trash.
/// UNC/WSL paths have no Recycle Bin, so they are removed permanently instead.
#[tauri::command]
pub async fn move_to_trash(path: String) -> Result<(), AppError> {
    files::run_blocking(move || {
        let pathbuf = PathBuf::from(&path);

        // lstat-based check so broken symlinks can still be trashed.
        if std::fs::symlink_metadata(&pathbuf).is_err() {
            return Err(AppError::NotFound(path));
        }

        trash_or_remove(&pathbuf)
    })
    .await
}

/// Move multiple files/directories to trash. Trashes each item individually
/// and reports which paths failed instead of failing all-or-nothing.
#[tauri::command]
pub async fn move_multiple_to_trash(paths: Vec<String>) -> Result<(), AppError> {
    files::run_blocking(move || {
        log::info!("Moving {} items to trash", paths.len());

        let mut failures: Vec<String> = Vec::new();
        for path in &paths {
            let pathbuf = PathBuf::from(path);
            if std::fs::symlink_metadata(&pathbuf).is_err() {
                failures.push(format!("{} (not found)", path));
                continue;
            }
            if let Err(e) = trash_or_remove(&pathbuf) {
                log::error!("Failed to move {} to trash: {}", path, e);
                failures.push(format!("{} ({})", path, e));
            }
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Other(format!(
                "Failed to move {} of {} items to trash: {}",
                failures.len(),
                paths.len(),
                failures.join(", ")
            )))
        }
    })
    .await
}

/// Open the operating system's recycle-bin UI rather than treating the bin as
/// an ordinary directory. Windows exposes it as a shell namespace, while
/// Linux and macOS provide a desktop-visible trash location.
#[tauri::command]
pub async fn open_recycle_bin() -> Result<(), AppError> {
    files::run_blocking(|| {
        #[cfg(target_os = "linux")]
        {
            return open_linux_recycle_bin_with(|launcher| {
                log::info!(
                    "Recycle Bin: launching native surface via {} {:?}",
                    launcher.program,
                    launcher.arguments
                );
                std::process::Command::new(launcher.program)
                    .args(&launcher.arguments)
                    .status()
            });
        }

        #[cfg(not(target_os = "linux"))]
        {
            let launcher = recycle_bin_launcher();
            log::info!(
                "Recycle Bin: launching native surface via {} {:?}",
                launcher.program,
                launcher.arguments
            );
            let mut command = std::process::Command::new(launcher.program);
            command.args(&launcher.arguments);
            match command.spawn() {
                Ok(child) => {
                    let child_id = child.id();
                    log::info!("Recycle Bin: native surface launch started as process {child_id}");
                    reap_in_background(child);
                    Ok(())
                }
                Err(error) => {
                    log::error!(
                        "Recycle Bin: failed to launch {} {:?}: {error}",
                        launcher.program,
                        launcher.arguments
                    );
                    Err(AppError::Io(error))
                }
            }
        }
    })
    .await
}

/// Get the directory the app was launched from.
#[tauri::command]
pub async fn get_launch_cwd(state: tauri::State<'_, LaunchCwd>) -> Result<String, AppError> {
    Ok(state.0.clone())
}

/// True when the launch cwd is a launcher artifact rather than a place the
/// user meant: Start menu / Explorer on Windows launch the app with cwd set
/// to its own install directory (`C:\Program Files\tauri-explorer`, #408),
/// and Finder/DMG on macOS uses `/`. Both compare canonicalized so prefix
/// (`\\?\`) and case differences on Windows can't defeat the check.
pub fn is_launcher_artifact_cwd(cwd: &std::path::Path, exe_dir: Option<&std::path::Path>) -> bool {
    if cwd == std::path::Path::new("/") {
        return true;
    }
    let Some(exe_dir) = exe_dir else { return false };
    match (cwd.canonicalize(), exe_dir.canonicalize()) {
        (Ok(c), Ok(e)) => c == e,
        _ => cwd == exe_dir,
    }
}

/// Record the frontend cold-start timing summary in the app log. Written next
/// to the Rust `Startup:` line so the backend (setup→build) and webview
/// (boot→first directory visible) halves of cold start can be read together
/// from the log file — durable in release builds without devtools.
#[tauri::command]
pub async fn log_startup_timing(summary: String) {
    log::info!("{}", summary);
}

/// Set the window theme (light/dark) to sync NSAppearance with the app theme.
#[tauri::command]
pub async fn set_window_theme(window: tauri::Window, theme: String) {
    let t = match theme.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };
    let _ = window.set_theme(t);
}

#[derive(serde::Serialize)]
pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
}

/// Version/platform info for the bug-report template and about surfaces.
#[tauri::command]
pub async fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// Get the log directory path so the frontend can display it in settings.
#[tauri::command]
pub async fn get_log_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Other(format!("Failed to resolve log directory: {}", e)))?;
    Ok(log_dir.to_string_lossy().to_string())
}

/// Restore files from the system trash by their original paths.
/// Finds the most recently deleted item matching each path and restores it.
/// Note: trash::os_limited is only available on Linux/Windows (not macOS).
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn restore_from_trash(paths: Vec<String>) -> Result<(), AppError> {
    files::run_blocking(move || {
        let trash_items = trash::os_limited::list()
            .map_err(|e| AppError::Other(format!("Failed to list trash: {}", e)))?;

        let mut to_restore = Vec::new();
        let mut unmatched: Vec<String> = Vec::new();

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
            } else {
                unmatched.push(path_str.clone());
            }
        }

        // Report paths that have no matching trash item instead of silently
        // skipping them and claiming success.
        if !unmatched.is_empty() {
            return Err(AppError::NotFound(format!(
                "No matching trash items found for: {}",
                unmatched.join(", ")
            )));
        }

        trash::os_limited::restore_all(to_restore)
            .map_err(|e| AppError::Other(format!("Failed to restore from trash: {}", e)))
    })
    .await
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn restore_from_trash(_paths: Vec<String>) -> Result<(), AppError> {
    Err(AppError::Other(
        "Cannot undo delete on macOS — use Finder to restore from Trash".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{is_launcher_artifact_cwd, recycle_bin_launcher};
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn launcher_artifact_cwds_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("Program Files").join("tauri-explorer");
        std::fs::create_dir_all(&exe_dir).unwrap();

        // cwd == install dir → artifact (#408).
        assert!(is_launcher_artifact_cwd(&exe_dir, Some(&exe_dir)));
        // macOS Finder root.
        assert!(is_launcher_artifact_cwd(Path::new("/"), Some(&exe_dir)));
        assert!(is_launcher_artifact_cwd(Path::new("/"), None));

        // A genuine launch directory passes through.
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(!is_launcher_artifact_cwd(&home, Some(&exe_dir)));
        // Unknown exe dir: only "/" is rejected.
        assert!(!is_launcher_artifact_cwd(&home, None));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn recycle_bin_launcher_uses_the_freedesktop_trash_uri() {
        let launcher = recycle_bin_launcher();

        assert_eq!(launcher.program, "gio");
        assert_eq!(
            launcher.arguments,
            vec![OsString::from("open"), OsString::from("trash:///")]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn recycle_bin_launcher_uses_the_windows_shell_namespace() {
        let launcher = recycle_bin_launcher();

        assert_eq!(launcher.program, "explorer.exe");
        assert_eq!(
            launcher.arguments,
            vec![OsString::from("shell:RecycleBinFolder")]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recycle_bin_launcher_uses_the_macos_trash_directory() {
        let launcher = recycle_bin_launcher();

        assert_eq!(launcher.program, "open");
        assert_eq!(
            launcher.arguments,
            vec![dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("/"))
                .join(".Trash")
                .into_os_string()]
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../test_support/issue_660_recycle_bin.rs"]
mod issue_660_recycle_bin;
