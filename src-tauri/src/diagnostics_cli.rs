//! `tauri-explorer --diagnostics` (#1687): a plain-text report for when the
//! app will not start, so its report dialog and "Open Logs Folder" are out of
//! reach.
//!
//! `main.rs` dispatches here before anything else runs: no window, no
//! webview, no single-instance lock, no log plugin and no Linux detach fork.
//! The report reuses the environment summary that user reports and crash
//! files carry (`environment.rs`, #1683), names the log folder, and quotes
//! the newest crash file and a bounded tail of WARN/ERROR log lines.
//!
//! Rendering (`render`) and argument detection (`requested`) are pure; the
//! file-system adapter only gathers their inputs. The log folder is the one
//! path printed in full; the home directory is shown as `~` everywhere else.

use crate::environment::{self, EnvironmentField};
use crate::wire_path;
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const DIAGNOSTICS_FLAG: &str = "--diagnostics";

/// Tauri's `identifier`, which names the app's log folder. Pinned to
/// `tauri.conf.json` by a test: resolving it through Tauri would need the
/// generated context this mode exists to avoid depending on.
const IDENTIFIER: &str = "io.github.xnmp.tauri-explorer";
/// `tauri-plugin-log`'s `LogDir { file_name: None }` file: the product name.
const LOG_FILE: &str = "tauri-explorer.log";
const CRASH_PREFIX: &str = "crash-";

/// WARN/ERROR lines quoted from the log.
pub(crate) const MAX_LOG_LINES: usize = 50;
/// Lines quoted from the newest crash file (header, panic and the top of the
/// backtrace; the rest is in the file).
pub(crate) const MAX_CRASH_LINES: usize = 40;
/// Per-line bound: a single log line can carry a whole serialized payload.
const MAX_LINE_CHARS: usize = 400;
/// Only the end of the log is read; it rotates at 10 MB.
const MAX_LOG_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_CRASH_BYTES: u64 = 256 * 1024;

/// `--diagnostics` appears before any `--` terminator, so a folder literally
/// named `--diagnostics` can still be opened with `tauri-explorer -- NAME`.
pub fn requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .map(|arg| arg.as_ref().to_owned())
        .take_while(|arg| arg != "--")
        .any(|arg| arg == DIAGNOSTICS_FLAG)
}

/// One crash file in the crash folder, seen (`.seen`) or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CrashFile {
    pub name: String,
    /// Modification time, seconds since the Unix epoch.
    pub modified: Option<u64>,
}

/// Everything the report shows, gathered by `collect` or a test.
#[derive(Debug, Default)]
pub(crate) struct Input<'a> {
    pub version: &'a str,
    pub environment: &'a [EnvironmentField],
    /// Display text of the log folder; `None` when it cannot be resolved.
    pub log_dir: Option<&'a str>,
    pub log_dir_exists: bool,
    /// Name of the log file whose tail `log_text` is.
    pub log_file: Option<&'a str>,
    pub log_text: Option<&'a str>,
    pub crash_files: &'a [CrashFile],
    pub newest_crash_text: Option<&'a str>,
    /// Display text of the home directory, replaced by `~` in quoted lines.
    pub home: Option<&'a str>,
}

/// The newest crash file by modification time; the name breaks ties (and
/// orders files whose time is unreadable) so the choice is deterministic.
pub(crate) fn newest_crash(files: &[CrashFile]) -> Option<&CrashFile> {
    files
        .iter()
        .max_by(|a, b| (a.modified, &a.name).cmp(&(b.modified, &b.name)))
}

/// Whether a `tauri-plugin-log` line (`[date][time][LEVEL][target] message`)
/// is a warning or an error. Only the leading bracket groups are inspected,
/// so a message that merely mentions `[ERROR]` does not count.
pub(crate) fn is_warn_or_error(line: &str) -> bool {
    let mut rest = line;
    for _ in 0..4 {
        let Some(group) = rest.strip_prefix('[') else {
            return false;
        };
        let Some((inner, after)) = group.split_once(']') else {
            return false;
        };
        if inner == "WARN" || inner == "ERROR" {
            return true;
        }
        rest = after;
    }
    false
}

/// The last `max` WARN/ERROR lines of `text`, oldest first.
pub(crate) fn warn_error_tail(text: &str, max: usize) -> Vec<&str> {
    let mut lines: Vec<&str> = text
        .lines()
        .rev()
        .filter(|line| is_warn_or_error(line))
        .take(max)
        .collect();
    lines.reverse();
    lines
}

fn quote_line(line: &str, home: Option<&str>) -> String {
    let line = match home.filter(|home| home.len() > 1) {
        Some(home) => line.replace(home, "~"),
        None => line.to_owned(),
    };
    let mut bounded: String = line
        .chars()
        .filter(|character| *character == '\t' || !character.is_control())
        .take(MAX_LINE_CHARS)
        .collect();
    if line.chars().count() > MAX_LINE_CHARS {
        bounded.push_str(" [...]");
    }
    bounded
}

fn format_time(secs: Option<u64>) -> String {
    secs.and_then(|secs| i64::try_from(secs).ok())
        .and_then(|secs| chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0))
        .map(|time| time.format("%Y-%m-%d %H:%M:%S UTC").to_string())
        .unwrap_or_else(|| "time unknown".to_owned())
}

/// The full report as printed to stdout.
pub(crate) fn render(input: &Input) -> String {
    let mut out = String::from("Tauri Explorer diagnostics\n\n");
    out.push_str(&environment::render_report_lines(
        input.version,
        input.environment,
        usize::MAX,
    ));
    out.push_str("\n\n");

    match (input.log_dir, input.log_dir_exists) {
        (Some(dir), true) => out.push_str(&format!("Log folder: {dir}\n")),
        (Some(dir), false) => out.push_str(&format!(
            "Log folder: {dir} (does not exist: the app has not written a log yet)\n"
        )),
        (None, _) => {
            out.push_str("Log folder: unknown (the home directory could not be resolved)\n")
        }
    }

    out.push('\n');
    match newest_crash(input.crash_files) {
        None => out.push_str("Crash reports: none\n"),
        Some(newest) => {
            let others = input.crash_files.len() - 1;
            out.push_str(&format!(
                "Newest crash report: crashes/{} ({}){}\n",
                newest.name,
                format_time(newest.modified),
                if others > 0 {
                    format!(", {others} older")
                } else {
                    String::new()
                }
            ));
            match input.newest_crash_text {
                Some(text) => {
                    let lines: Vec<&str> = text.lines().collect();
                    for line in lines.iter().take(MAX_CRASH_LINES) {
                        out.push_str(&format!("  {}\n", quote_line(line, input.home)));
                    }
                    if lines.len() > MAX_CRASH_LINES {
                        out.push_str(&format!(
                            "  [... {} more lines in the file]\n",
                            lines.len() - MAX_CRASH_LINES
                        ));
                    }
                }
                None => out.push_str("  (could not be read)\n"),
            }
        }
    }

    out.push('\n');
    match (input.log_file, input.log_text) {
        (Some(file), Some(text)) => {
            let tail = warn_error_tail(text, MAX_LOG_LINES);
            if tail.is_empty() {
                out.push_str(&format!("Warnings and errors: none in the end of {file}\n"));
            } else {
                out.push_str(&format!(
                    "Last {} warning/error lines of {file}:\n",
                    tail.len()
                ));
                for line in tail {
                    out.push_str(&format!("  {}\n", quote_line(line, input.home)));
                }
            }
        }
        _ => out.push_str("Warnings and errors: no log file found\n"),
    }

    out.push_str(
        "\nPaste this into a bug report: https://github.com/xnmp/tauri-explorer/issues/new?template=bug_report.yml\n\
         Check it for paths or names you would rather not share first.\n",
    );
    out
}

fn display(path: &Path) -> String {
    wire_path::lossy(&wire_path::encode_path(path)).into_owned()
}

/// Where `tauri::PathResolver::app_log_dir` puts the log for this app.
fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| home.join("Library/Logs").join(IDENTIFIER))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|dir| dir.join(IDENTIFIER).join("logs"))
    }
}

fn modified_secs(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn crash_files(dir: &Path) -> Vec<(CrashFile, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            let is_crash = name.starts_with(CRASH_PREFIX)
                && (name.ends_with(".txt") || name.ends_with(".txt.seen"));
            let metadata = entry.metadata().ok().filter(|m| m.is_file())?;
            is_crash.then(|| {
                (
                    CrashFile {
                        name,
                        modified: modified_secs(&metadata),
                    },
                    entry.path(),
                )
            })
        })
        .collect()
}

/// The current log file, or the newest rotated one when it is missing.
fn log_file(dir: &Path) -> Option<(String, PathBuf)> {
    let current = dir.join(LOG_FILE);
    if current.is_file() {
        return Some((LOG_FILE.to_owned(), current));
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            let metadata = entry.metadata().ok().filter(|m| m.is_file())?;
            name.ends_with(".log")
                .then(|| (modified_secs(&metadata), name, entry.path()))
        })
        .max()
        .map(|(_, name, path)| (name, path))
}

/// The last `max` bytes of a file, starting at a line boundary when cut.
fn read_tail(path: &Path, max: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(max);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(max).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if start == 0 {
        return Some(text);
    }
    Some(
        text.split_once('\n')
            .map_or(String::new(), |(_, rest)| rest.to_owned()),
    )
}

fn read_head(path: &Path, max: u64) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(max)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn collect_and_render() -> String {
    let environment = environment::summary();
    let log_dir = log_dir();
    let log_dir_text = log_dir.as_deref().map(display);
    let log_dir_exists = log_dir.as_deref().is_some_and(Path::is_dir);
    let crashes = log_dir
        .as_deref()
        .map(|dir| crash_files(&dir.join("crashes")))
        .unwrap_or_default();
    let crash_list: Vec<CrashFile> = crashes.iter().map(|(file, _)| file.clone()).collect();
    let newest_crash_text = newest_crash(&crash_list).and_then(|newest| {
        crashes
            .iter()
            .find(|(file, _)| file == newest)
            .and_then(|(_, path)| read_head(path, MAX_CRASH_BYTES))
    });
    let log = log_dir.as_deref().and_then(log_file);
    let log_text = log
        .as_ref()
        .and_then(|(_, path)| read_tail(path, MAX_LOG_TAIL_BYTES));
    let home = dirs::home_dir().map(|home| display(&home));
    render(&Input {
        version: env!("CARGO_PKG_VERSION"),
        environment,
        log_dir: log_dir_text.as_deref(),
        log_dir_exists,
        log_file: log.as_ref().map(|(name, _)| name.as_str()),
        log_text: log_text.as_deref(),
        crash_files: &crash_list,
        newest_crash_text: newest_crash_text.as_deref(),
        home: home.as_deref(),
    })
}

/// Release Windows builds use the GUI subsystem and start without a console;
/// borrow the launching terminal's so the report is visible there. A
/// redirected stdout is already a valid handle and is left alone.
#[cfg(windows)]
fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: plain Win32 call without pointers; failure (no parent console,
    // or one already attached) leaves the process as it was.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

/// Print the report and return the exit status when `--diagnostics` was
/// passed; `None` lets the app start normally.
pub fn run_if_requested() -> Option<i32> {
    if !requested(std::env::args_os().skip(1)) {
        return None;
    }
    #[cfg(windows)]
    attach_parent_console();
    let report = collect_and_render();
    let mut stdout = std::io::stdout().lock();
    // A closed pipe (`| head`) must not panic the way `println!` would.
    let written = stdout
        .write_all(report.as_bytes())
        .and_then(|()| stdout.flush());
    Some(if written.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
#[path = "../test_support/diagnostics_cli_test.rs"]
mod tests;
