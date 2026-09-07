//! System-level commands: native launch context, window theme, log paths.
//! Extracted from lib.rs so the entry point is pure wiring.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::error::AppError;
use crate::files;

/// Stores the working directory from which the app was launched.
pub struct LaunchCwd(pub String);

/// Monotonic clock starting at app run(), before builder and window creation.
/// Excludes OS process loading and main() argument parsing.
pub struct StartupClock(pub std::time::Instant);

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
pub struct RecycleBinLauncher {
    pub program: &'static str,
    pub arguments: Vec<OsString>,
}

#[cfg(not(target_os = "linux"))]
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
fn linux_recycle_bin_launcher() -> Result<RecycleBinLauncher, AppError> {
    Ok(RecycleBinLauncher {
        program: "xdg-open",
        arguments: vec![linux_trash_files_directory()?.into_os_string()],
    })
}

/// Open the Freedesktop deleted-files directory directly. A successful URI
/// dispatcher exit cannot prove that its asynchronous desktop handler accepted
/// `trash:///`, so Linux never sends that URI to the handler.
#[cfg(target_os = "linux")]
fn open_linux_recycle_bin_with<F>(mut launch: F) -> Result<(), AppError>
where
    F: FnMut(&RecycleBinLauncher) -> std::io::Result<std::process::ExitStatus>,
{
    open_linux_recycle_bin_with_launcher(&mut launch, linux_recycle_bin_launcher)
}

#[cfg(target_os = "linux")]
pub fn open_linux_recycle_bin_with_launcher<F, R>(
    mut launch: F,
    launcher: R,
) -> Result<(), AppError>
where
    F: FnMut(&RecycleBinLauncher) -> std::io::Result<std::process::ExitStatus>,
    R: FnOnce() -> Result<RecycleBinLauncher, AppError>,
{
    let launcher = launcher()?;
    log::info!(
        "Recycle Bin: launching deleted-files directory via {} {:?}",
        launcher.program,
        launcher.arguments
    );

    match launch(&launcher) {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(AppError::Other(format!(
            "Failed to open Recycle Bin: {} {:?} exited with {status}",
            launcher.program, launcher.arguments
        ))),
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

/// Open the operating system's recycle-bin UI rather than treating the bin as
/// an ordinary directory. Windows exposes it as a shell namespace, while
/// Linux and macOS provide a desktop-visible trash location.
#[tauri::command]
pub async fn open_recycle_bin() -> Result<(), AppError> {
    files::run_blocking(|| {
        #[cfg(target_os = "linux")]
        {
            open_linux_recycle_bin_with(|launcher| {
                log::info!(
                    "Recycle Bin: launching native surface via {} {:?}",
                    launcher.program,
                    launcher.arguments
                );
                std::process::Command::new(launcher.program)
                    .args(&launcher.arguments)
                    .status()
            })
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
pub async fn log_startup_timing(
    window: tauri::Window,
    clock: tauri::State<'_, StartupClock>,
    summary: String,
) -> Result<(), AppError> {
    log::info!("{}", summary);
    // Child/warm windows share this process clock; only the initial main
    // window can interpret it as startup latency. IPC receipt adds a small
    // scheduling delay but avoids adding unrelated Rust and JS time origins.
    if window.label() == "main" {
        log::info!(
            "Startup(native-ready): app-run-to-ready={:.1}ms",
            clock.0.elapsed().as_secs_f64() * 1000.0
        );
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::is_launcher_artifact_cwd;
    #[cfg(target_os = "linux")]
    use super::linux_recycle_bin_launcher;
    #[cfg(not(target_os = "linux"))]
    use super::recycle_bin_launcher;
    #[cfg(target_os = "windows")]
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
    fn recycle_bin_launcher_uses_the_freedesktop_deleted_files_directory() {
        let launcher = linux_recycle_bin_launcher().unwrap();

        assert_eq!(launcher.program, "xdg-open");
        assert!(Path::new(&launcher.arguments[0]).is_absolute());
        assert!(Path::new(&launcher.arguments[0]).ends_with("Trash/files"));
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

#[cfg(all(test, target_os = "linux"))]
#[path = "../test_support/issue_660_primary_launcher.rs"]
mod issue_660_primary_launcher;
