//! Local crash capture (#184).
//!
//! A panic hook writes a crash report file (message, location, backtrace,
//! version, OS) under `<app log dir>/crashes/`. On the next launch the
//! frontend calls `take_crash_report` and offers to open a pre-filled GitHub
//! issue. Nothing is ever sent over the network by the app itself.

use crate::error::AppError;
use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};
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

    persist_crash_report(crash_dir, epoch_secs, report.as_bytes())?;
    Ok(())
}

fn persist_crash_report(
    crash_dir: &Path,
    epoch_secs: u64,
    report: &[u8],
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(crash_dir)?;
    let staged = stage_crash_report(crash_dir, report)?;
    publish_crash_report(crash_dir, epoch_secs, staged)
}

fn stage_crash_report(crash_dir: &Path, report: &[u8]) -> std::io::Result<tempfile::NamedTempFile> {
    let mut staged = tempfile::Builder::new()
        .prefix(".crash-writing-")
        .suffix(".tmp")
        .tempfile_in(crash_dir)?;
    staged.write_all(report)?;
    staged.flush()?;
    Ok(staged)
}

fn publish_crash_report(
    crash_dir: &Path,
    epoch_secs: u64,
    mut staged: tempfile::NamedTempFile,
) -> std::io::Result<PathBuf> {
    for collision in 0..=u32::MAX {
        let suffix = if collision == 0 {
            String::new()
        } else {
            format!("-{collision}")
        };
        let path = crash_dir.join(format!("{CRASH_PREFIX}{epoch_secs}{suffix}{CRASH_SUFFIX}"));
        let mut claim_path = path.as_os_str().to_owned();
        claim_path.push(".claim");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(PathBuf::from(claim_path)) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }

        // A retained claim makes this identity single-use across both its
        // unseen and consumed names. Existing legacy reports have no claim,
        // so account for either state before publishing under the identity.
        if path.try_exists()? || seen_path(&path).try_exists()? {
            continue;
        }
        match staged.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                staged = error.file;
            }
            Err(error) => return Err(error.error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "crash report name space exhausted",
    ))
}

fn is_unseen_report(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(CRASH_PREFIX) && name.ends_with(CRASH_SUFFIX))
}

fn report_order(path: &Path) -> (u64, u32) {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| {
            let stem = name
                .strip_prefix(CRASH_PREFIX)?
                .strip_suffix(CRASH_SUFFIX)?;
            let (timestamp, collision) = stem
                .split_once('-')
                .map_or((stem, "0"), |(timestamp, collision)| (timestamp, collision));
            Some((timestamp.parse().ok()?, collision.parse().ok()?))
        })
        .unwrap_or((0, 0))
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
            .filter(|path| is_unseen_report(path))
            .collect();
        // Sort legacy names by timestamp and collision-safe names by their
        // sequence within that second.
        unseen.sort_by_key(|path| report_order(path));
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
    std::fs::rename(path, seen_path(path))
}

fn seen_path(path: &Path) -> PathBuf {
    let mut seen = path.as_os_str().to_owned();
    seen.push(".seen");
    PathBuf::from(seen)
}

/// Log an error reported by the webview (window.onerror / unhandledrejection)
/// so it lands in the rotating log files alongside backend errors.
#[tauri::command]
pub async fn log_frontend_error(message: String) {
    // Truncate defensively: a pathological error message shouldn't bloat logs.
    let truncated: String = message.chars().take(4000).collect();
    log::error!("[frontend] {}", truncated);
}

/// Persist a crash report for an uncaught webview error (#302), in the same
/// file format the panic hook uses so `take_crash_report` and the next-launch
/// crash notice treat it identically. The frontend dedupes bursts, so this is
/// called at most once per distinct message per session. Local write only —
/// nothing is sent anywhere.
#[tauri::command]
pub async fn record_frontend_crash(
    app: tauri::AppHandle,
    message: String,
    stack: Option<String>,
) -> Result<(), AppError> {
    let dir = crash_dir(&app)?;
    // Defensive caps: a pathological message/stack shouldn't bloat the file.
    let message: String = message.chars().take(4000).collect();
    let stack: String = stack.unwrap_or_default().chars().take(8000).collect();
    tokio::task::spawn_blocking(move || {
        let epoch_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backtrace = if stack.is_empty() {
            "<no stack captured>".to_string()
        } else {
            stack
        };
        let report = format!(
            "tauri-explorer {} crash report\n\
             os: {} ({})\n\
             time: {} (unix)\n\
             source: frontend (webview)\n\
             panic: {}\n\
             location: webview\n\n\
             backtrace:\n{}\n",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            epoch_secs,
            message,
            backtrace
        );
        persist_crash_report(&dir, epoch_secs, report.as_bytes())
            .map_err(|e| AppError::Other(format!("Failed to write crash report: {}", e)))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Open a GitHub URL in the default browser (used for "Report on GitHub").
/// Host-pinned, not just scheme-checked: this command's only job is opening
/// the repo's issue page, so it must not be usable as a generic URL opener.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), AppError> {
    if !crate::update_check::is_github_url(&url) {
        return Err(AppError::Other(
            "Only https://github.com/ URLs may be opened".to_string(),
        ));
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

    #[test]
    fn reports_written_in_the_same_second_retain_distinct_contents() {
        let dir = tempfile::tempdir().unwrap();
        let crashes = dir.path().join("crashes");

        let first = persist_crash_report(&crashes, 1_000, b"first crash").unwrap();
        let second = persist_crash_report(&crashes, 1_000, b"second crash").unwrap();

        let mut reports = std::fs::read_dir(&crashes)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| is_unseen_report(path))
            .collect::<Vec<_>>();
        reports.sort_by_key(|path| report_order(path));
        let contents = reports
            .iter()
            .map(std::fs::read_to_string)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(contents, ["first crash", "second crash"]);

        #[cfg(unix)]
        for path in [first, second] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn report_is_discoverable_only_after_its_full_contents_are_published() {
        let dir = tempfile::tempdir().unwrap();
        let crashes = dir.path().join("crashes");
        std::fs::create_dir_all(&crashes).unwrap();

        let staged = stage_crash_report(&crashes, b"complete crash report").unwrap();
        assert_eq!(
            std::fs::read_dir(&crashes)
                .unwrap()
                .flatten()
                .filter(|entry| is_unseen_report(&entry.path()))
                .count(),
            0
        );

        let published = publish_crash_report(&crashes, 2_000, staged).unwrap();
        assert_eq!(
            std::fs::read_to_string(published).unwrap(),
            "complete crash report"
        );
    }

    #[test]
    fn consumed_report_identity_is_not_reused_in_the_same_second() {
        let dir = tempfile::tempdir().unwrap();
        let crashes = dir.path().join("crashes");

        let first = persist_crash_report(&crashes, 3_000, b"first consumed crash").unwrap();
        mark_seen(&first).unwrap();
        let second = persist_crash_report(&crashes, 3_000, b"second consumed crash").unwrap();
        assert_ne!(first, second);
        mark_seen(&second).unwrap();

        let mut consumed = std::fs::read_dir(crashes)
            .unwrap()
            .flatten()
            .filter_map(|entry| {
                entry
                    .path()
                    .to_string_lossy()
                    .ends_with(".txt.seen")
                    .then(|| std::fs::read_to_string(entry.path()).unwrap())
            })
            .collect::<Vec<_>>();
        consumed.sort();
        assert_eq!(consumed, ["first consumed crash", "second consumed crash"]);
    }
}
