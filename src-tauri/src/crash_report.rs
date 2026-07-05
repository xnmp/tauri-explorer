//! Local crash capture (#184).
//!
//! A panic hook writes a crash report file (message, location, backtrace,
//! version, OS) under `<app log dir>/crashes/`. On the next launch the
//! frontend calls `take_crash_report` and offers to open a pre-filled GitHub
//! issue. Nothing is ever sent over the network by the app itself.

use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

const CRASH_PREFIX: &str = "crash-";
const CRASH_SUFFIX: &str = ".txt";

/// Install a panic hook that persists a crash report before delegating to
/// the previous hook (which prints to stderr as usual).
pub fn install_panic_hook(crash_dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_crash_report(&crash_dir, info);
        previous(info);
    }));
}

fn write_crash_report(crash_dir: &Path, info: &std::panic::PanicHookInfo) -> std::io::Result<()> {
    let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    };
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "unknown".to_string());
    let backtrace = std::backtrace::Backtrace::force_capture();
    let epoch_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let report = format!(
        "tauri-explorer {} crash report\n\
         os: {} ({})\n\
         time: {} (unix)\n\
         panic: {}\n\
         location: {}\n\n\
         backtrace:\n{}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        epoch_secs,
        message,
        location,
        backtrace
    );

    std::fs::create_dir_all(crash_dir)?;
    let file = crash_dir.join(format!("{}{}{}", CRASH_PREFIX, epoch_secs, CRASH_SUFFIX));
    std::fs::write(&file, report)?;
    // Backtraces can carry absolute paths — keep reports owner-readable only,
    // matching config.rs.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct CrashReport {
    #[serde(rename = "fileName")]
    pub file_name: String,
    pub contents: String,
}

fn crash_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_log_dir()
        .map(|d| d.join("crashes"))
        .map_err(|e| AppError::Other(format!("Failed to resolve log directory: {}", e)))
}

/// Return the newest unseen crash report and mark it (and any older ones)
/// seen, so a crash is offered for reporting exactly once.
#[tauri::command]
pub async fn take_crash_report(app: tauri::AppHandle) -> Result<Option<CrashReport>, AppError> {
    let dir = crash_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => return Ok(None), // no crashes dir → never crashed
        };
        let mut unseen: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(CRASH_PREFIX) && n.ends_with(CRASH_SUFFIX))
            })
            .collect();
        // Timestamps are zero-padded-free unix seconds; same-width lexical
        // sort is fine for the decades this app will see, but sort by the
        // parsed number to be exact.
        unseen.sort_by_key(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| {
                    n.strip_prefix(CRASH_PREFIX)?
                        .strip_suffix(CRASH_SUFFIX)?
                        .parse::<u64>()
                        .ok()
                })
                .unwrap_or(0)
        });
        let newest = unseen.pop();
        // Everything older is stale — mark seen so it isn't offered later.
        for old in unseen {
            let _ = mark_seen(&old);
        }
        let Some(path) = newest else { return Ok(None) };
        let contents = std::fs::read_to_string(&path)
            .map_err(|e| AppError::Other(format!("Failed to read crash report: {}", e)))?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        mark_seen(&path)
            .map_err(|e| AppError::Other(format!("Failed to mark crash report seen: {}", e)))?;
        Ok(Some(CrashReport {
            file_name,
            contents,
        }))
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn mark_seen(path: &Path) -> std::io::Result<()> {
    let mut seen = path.as_os_str().to_owned();
    seen.push(".seen");
    std::fs::rename(path, PathBuf::from(seen))
}

/// Log an error reported by the webview (window.onerror / unhandledrejection)
/// so it lands in the rotating log files alongside backend errors.
#[tauri::command]
pub async fn log_frontend_error(message: String) {
    // Truncate defensively: a pathological error message shouldn't bloat logs.
    let truncated: String = message.chars().take(4000).collect();
    log::error!("[frontend] {}", truncated);
}

/// Open an https URL in the default browser (used for "Report on GitHub").
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), AppError> {
    if !url.starts_with("https://") {
        return Err(AppError::Other("Only https URLs may be opened".to_string()));
    }
    opener::open(&url).map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_and_mark_seen_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let crashes = dir.path().join("crashes");
        std::fs::create_dir_all(&crashes).unwrap();
        let file = crashes.join("crash-1000.txt");
        std::fs::write(&file, "boom").unwrap();
        mark_seen(&file).unwrap();
        assert!(!file.exists());
        assert!(crashes.join("crash-1000.txt.seen").exists());
    }

    #[test]
    fn panic_hook_writes_report_file() {
        let dir = tempfile::tempdir().unwrap();
        let crashes = dir.path().join("crashes");
        // The hook is process-global, so other tests that panic concurrently
        // (e.g. assertion failures elsewhere in the suite) may also write
        // files here. Assert only that OUR panic produced a report — never
        // an exact file count.
        install_panic_hook(crashes.clone());
        let _ = std::thread::spawn(|| panic!("test crash")).join();
        let ours = std::fs::read_dir(&crashes)
            .unwrap()
            .flatten()
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .find(|c| c.contains("panic: test crash"));
        let contents = ours.expect("no crash report written for the test panic");
        assert!(contents.contains("location:"));
    }
}
