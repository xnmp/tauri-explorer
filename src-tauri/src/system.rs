//! System-level commands: native launch context, window theme, log paths.
//! Extracted from lib.rs so the entry point is pure wiring.

use std::ffi::OsString;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::PathBuf;

use crate::error::AppError;
use crate::files;

/// Monotonic clock starting at app run(), before builder and window creation.
/// Excludes OS process loading and main() argument parsing. `epoch_ms` pins the
/// same instant on the wall clock so the native readiness endpoint can be
/// correlated with webview time origins without assuming a shared clock.
pub struct StartupClock {
    pub started: std::time::Instant,
    pub epoch_ms: f64,
}

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
#[cfg(not(target_os = "linux"))]
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
#[derive(Debug)]
enum FileManager1Failure {
    Unavailable(String),
    Uncertain(String),
}

#[cfg(target_os = "linux")]
fn file_manager1_service_unavailable(error: &zbus::Error) -> bool {
    let name = match error {
        zbus::Error::MethodError(name, _, _) => name.as_str(),
        zbus::Error::FDO(error) => {
            return matches!(
                error.as_ref(),
                zbus::fdo::Error::ServiceUnknown(_)
                    | zbus::fdo::Error::UnknownMethod(_)
                    | zbus::fdo::Error::UnknownObject(_)
                    | zbus::fdo::Error::UnknownInterface(_)
            );
        }
        _ => return false,
    };
    matches!(
        name,
        "org.freedesktop.DBus.Error.ServiceUnknown"
            | "org.freedesktop.DBus.Error.UnknownMethod"
            | "org.freedesktop.DBus.Error.UnknownObject"
            | "org.freedesktop.DBus.Error.UnknownInterface"
    )
}

/// FileManager1 addresses a file manager directly and can open its native
/// Trash view. Generic URI or directory MIME dispatch can select a terminal.
#[cfg(target_os = "linux")]
async fn show_linux_trash_with_file_manager1() -> Result<(), FileManager1Failure> {
    use std::time::Duration;

    let connection = tokio::time::timeout(Duration::from_secs(2), zbus::Connection::session())
        .await
        .map_err(|_| FileManager1Failure::Unavailable("Session bus connection timed out".into()))?
        .map_err(|error| FileManager1Failure::Unavailable(error.to_string()))?;

    let folders = vec!["trash:///"];
    let body = (folders, "");
    let call = connection.call_method(
        Some("org.freedesktop.FileManager1"),
        "/org/freedesktop/FileManager1",
        Some("org.freedesktop.FileManager1"),
        "ShowFolders",
        &body,
    );
    match tokio::time::timeout(Duration::from_secs(5), call).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) if file_manager1_service_unavailable(&error) => {
            Err(FileManager1Failure::Unavailable(error.to_string()))
        }
        Ok(Err(error)) => Err(FileManager1Failure::Uncertain(error.to_string())),
        Err(_) => Err(FileManager1Failure::Uncertain(
            "File manager activation timed out; the window may still open".into(),
        )),
    }
}

#[cfg(target_os = "linux")]
fn is_graphical_file_manager(categories: Option<&str>, terminal: bool) -> bool {
    !terminal
        && categories.is_some_and(|categories| {
            categories
                .split(';')
                .any(|category| category == "FileManager")
        })
}

/// Launch only a desktop entry explicitly categorized as a graphical file
/// manager. Never fall back to generic xdg-open: it can select Kitty or Yazi.
#[cfg(target_os = "linux")]
fn launch_linux_trash_with_graphical_handler(directory: &std::path::Path) -> Result<(), AppError> {
    use gio::prelude::*;
    use std::collections::HashSet;

    let uri = url::Url::from_file_path(directory)
        .map_err(|_| AppError::Other("Trash path is not an absolute file URL".into()))?;
    let applications = gio::AppInfo::default_for_type("inode/directory", false)
        .into_iter()
        .chain(gio::AppInfo::recommended_for_type("inode/directory"))
        .chain(gio::AppInfo::all_for_type("inode/directory"));
    let mut seen = HashSet::new();
    let mut failures = Vec::new();
    for application in applications {
        let Some(id) = application.id() else {
            continue;
        };
        if !seen.insert(id.to_string())
            || !(application.supports_uris() || application.supports_files())
        {
            continue;
        }
        let Ok(desktop) = application.clone().downcast::<gio::DesktopAppInfo>() else {
            continue;
        };
        if desktop.is_hidden()
            || !is_graphical_file_manager(
                desktop.categories().as_deref(),
                desktop.boolean("Terminal"),
            )
        {
            continue;
        }
        let result = if application.supports_uris() {
            application.launch_uris(&[uri.as_str()], None::<&gio::AppLaunchContext>)
        } else {
            application.launch(
                &[gio::File::for_path(directory)],
                None::<&gio::AppLaunchContext>,
            )
        };
        match result {
            Ok(()) => {
                log::info!("Recycle Bin: opened with graphical file manager {id}");
                return Ok(());
            }
            Err(error) => failures.push(format!("{id}: {error}")),
        }
    }
    Err(AppError::Other(format!(
        "No graphical file manager could open Recycle Bin{}",
        if failures.is_empty() {
            String::new()
        } else {
            format!(": {}", failures.join("; "))
        }
    )))
}

/// Open the operating system's recycle-bin UI rather than treating the bin as
/// an ordinary directory. Windows exposes it as a shell namespace, while
/// Linux and macOS provide a desktop-visible trash location.
#[tauri::command]
pub async fn open_recycle_bin() -> Result<(), AppError> {
    #[cfg(target_os = "linux")]
    {
        let directory = linux_trash_files_directory()?;
        match show_linux_trash_with_file_manager1().await {
            Ok(()) => Ok(()),
            Err(FileManager1Failure::Unavailable(reason)) => {
                log::warn!(
                    "Recycle Bin: FileManager1 unavailable ({reason}); trying graphical handler"
                );
                files::run_blocking(move || launch_linux_trash_with_graphical_handler(&directory))
                    .await
            }
            Err(FileManager1Failure::Uncertain(reason)) => Err(AppError::Other(format!(
                "Could not confirm whether Recycle Bin opened: {reason}"
            ))),
        }
    }

    #[cfg(not(target_os = "linux"))]
    {
        files::run_blocking(|| {
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
        })
        .await
    }
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
    // scheduling delay, so the receipt epoch is logged alongside it and the
    // gap stays attributable instead of being folded into app work.
    if window.label() == "main" {
        let receipt_epoch_ms = epoch_ms_now();
        log::info!(
            "Startup(native-ready): window=main app-run-to-ready={:.1}ms receipt-epoch-ms={:.3}",
            clock.started.elapsed().as_secs_f64() * 1000.0,
            receipt_epoch_ms,
        );
    }
    Ok(())
}

/// Wall-clock milliseconds since the Unix epoch, the unit every correlated
/// startup marker uses. NaN (never a panic) if the clock predates the epoch.
pub(crate) fn epoch_ms_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(f64::NAN)
}

/// Longest accepted progress mark name; marks are short fixed identifiers.
const STARTUP_PROGRESS_MARK_MAX: usize = 32;
/// A webview offset beyond a day is not a startup measurement.
const STARTUP_PROGRESS_WEBVIEW_MS_MAX: f64 = 86_400_000.0;

/// Format one `Startup(webview-progress)` diagnostic line (#936).
///
/// The webview mirrors each startup milestone here as it is recorded, so a
/// startup that never reaches `ui-ready` still shows the last milestone it
/// reached and, via heartbeats, whether its JavaScript kept running. The
/// native receipt time is on the same monotonic clock as `native-ready`.
/// These lines are diagnostics only: the attributed startup parser must never
/// read them, which the distinct `webview-progress` tag guarantees. The mark
/// is validated because it becomes part of a parsed log line.
pub(crate) fn startup_progress_line(
    window: &str,
    mark: &str,
    webview_ms: f64,
    app_run_ms: f64,
) -> Result<String, AppError> {
    let valid_mark = !mark.is_empty()
        && mark.len() <= STARTUP_PROGRESS_MARK_MAX
        && mark.starts_with(|c: char| c.is_ascii_lowercase())
        && mark
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid_mark {
        return Err(AppError::Other(format!(
            "invalid startup progress mark: {mark:?}"
        )));
    }
    if !webview_ms.is_finite() || !(0.0..=STARTUP_PROGRESS_WEBVIEW_MS_MAX).contains(&webview_ms) {
        return Err(AppError::Other(format!(
            "invalid startup progress offset: {webview_ms}"
        )));
    }
    Ok(format!(
        "Startup(webview-progress): window={window} mark={mark} webview-ms={webview_ms:.1} app-run-ms={app_run_ms:.1}"
    ))
}

/// Record one webview startup milestone as it happens (see
/// [`startup_progress_line`]). Fire-and-forget from the page's point of view.
#[tauri::command]
pub async fn log_startup_progress(
    window: tauri::Window,
    clock: tauri::State<'_, StartupClock>,
    mark: String,
    webview_ms: f64,
) -> Result<(), AppError> {
    let line = startup_progress_line(
        window.label(),
        &mark,
        webview_ms,
        clock.started.elapsed().as_secs_f64() * 1000.0,
    )?;
    log::info!("{line}");
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
    use super::linux_trash_files_directory;
    #[cfg(not(target_os = "linux"))]
    use super::recycle_bin_launcher;
    use super::startup_progress_line;
    #[cfg(target_os = "windows")]
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn startup_progress_lines_carry_mark_and_both_clocks() {
        assert_eq!(
            startup_progress_line("main", "settings-ready", 1500.04, 3102.46).unwrap(),
            "Startup(webview-progress): window=main mark=settings-ready webview-ms=1500.0 app-run-ms=3102.5"
        );
        // The distinct tag keeps the attributed `Startup(webview):` parser blind to it.
        assert!(!startup_progress_line("main", "list-ready", 1.0, 2.0)
            .unwrap()
            .contains("Startup(webview):"));
    }

    #[test]
    fn startup_progress_rejects_marks_that_could_forge_log_fields() {
        for mark in [
            "",
            "List-ready",
            "1st",
            "list ready",
            "list-ready=1ms",
            "ready\nStartup(native-ready): window=main",
            &"a".repeat(33),
        ] {
            assert!(
                startup_progress_line("main", mark, 1.0, 1.0).is_err(),
                "{mark:?}"
            );
        }
        assert!(startup_progress_line("main", &"a".repeat(32), 1.0, 1.0).is_ok());
        for offset in [f64::NAN, f64::INFINITY, -1.0, 86_400_001.0] {
            assert!(startup_progress_line("main", "heartbeat", offset, 1.0).is_err());
        }
    }

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
        let directory = linux_trash_files_directory().unwrap();
        assert!(Path::new(&directory).is_absolute());
        assert!(Path::new(&directory).ends_with("Trash/files"));
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
