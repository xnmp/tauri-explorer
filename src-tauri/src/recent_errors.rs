//! Recent warnings and errors for user reports (#1685).
//!
//! The reporter can opt in to a short excerpt of WARN/ERROR records: this
//! session's, from a bounded in-memory ring fed by a `log` target (no file
//! parsing), and the previous session's, read once at startup (off the main
//! thread) from the end of the log as it stood when this session started.
//! Reading at startup, not on demand, matters: the log rotates at 10 MB, and
//! an offset into the old file means nothing once a new one replaces it. Forwarded frontend errors
//! already reach `log::error!` (`crash_report::log_frontend_error`), so the
//! ring sees them too.
//!
//! Every line is redacted (`$HOME` becomes `~`) and bounded before it is
//! stored or read, and the excerpt is size-capped so it fits the report body.
#![allow(clippy::disallowed_methods)] // Retire-when: #1638 closed (non-UTF-8 names, ADR 0031)

use crate::diagnostics_cli::{quote_line, warn_error_tail, LOG_FILE};
use crate::report_redaction::Redactor;
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const MAX_RING_ENTRIES: usize = 100;
const MAX_RING_BYTES: usize = 24 * 1024;
/// Newest lines quoted per source.
pub(crate) const MAX_CURRENT_LINES: usize = 30;
pub(crate) const MAX_PREVIOUS_LINES: usize = 20;
/// Whole-excerpt cap, below the dialog's per-section ceiling (6000).
pub(crate) const MAX_EXCERPT_UNITS: usize = 5000;
/// How much of the previous session's log is scanned.
const PREVIOUS_SCAN_BYTES: u64 = 256 * 1024;

/// The plugin's line format is `[date][time][target][LEVEL] message`: two
/// records differing only in their timestamp are the same message.
fn same_message(a: &str, b: &str) -> bool {
    fn without_timestamp(line: &str) -> &str {
        let mut rest = line;
        for _ in 0..2 {
            match rest.strip_prefix('[').and_then(|r| r.split_once(']')) {
                Some((group, after)) if group.starts_with(|c: char| c.is_ascii_digit()) => {
                    rest = after;
                }
                _ => return line,
            }
        }
        rest
    }
    without_timestamp(a) == without_timestamp(b)
}

/// Bounded, de-duplicating record of recent log lines. Consecutive repeats
/// collapse into one entry so a tight error loop cannot evict everything else.
#[derive(Default)]
pub(crate) struct Ring {
    entries: VecDeque<(String, u32)>,
    bytes: usize,
}

impl Ring {
    pub(crate) fn push(&mut self, line: String) {
        if let Some(last) = self.entries.back_mut() {
            if same_message(&last.0, &line) {
                last.1 = last.1.saturating_add(1);
                return;
            }
        }
        self.bytes += line.len();
        self.entries.push_back((line, 1));
        while self.entries.len() > MAX_RING_ENTRIES || self.bytes > MAX_RING_BYTES {
            let Some((old, _)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.len();
        }
    }

    /// Oldest first, repeats annotated.
    pub(crate) fn lines(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|(line, count)| match count {
                1 => line.clone(),
                n => format!("{line} (x{n})"),
            })
            .collect()
    }
}

static RING: Mutex<Ring> = Mutex::new(Ring {
    entries: VecDeque::new(),
    bytes: 0,
});
/// The previous session's WARN/ERROR lines, read once at startup.
static PREVIOUS: OnceLock<Vec<String>> = OnceLock::new();
static REDACTOR: OnceLock<Redactor> = OnceLock::new();

fn redactor() -> &'static Redactor {
    REDACTOR.get_or_init(Redactor::for_current_user)
}

/// A `log` sink for `tauri_plugin_log::TargetKind::Dispatch` that records
/// WARN and ERROR records into the ring.
pub(crate) struct RingLog;

impl log::Log for RingLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // The plugin's formatter has already put the timestamp, target and
        // level in the message every target receives: store it as delivered.
        let line = quote_line(&redactor().redact(&record.args().to_string()), None);
        // A poisoned lock only means another logger panicked mid-push.
        let mut ring = RING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ring.push(line);
    }

    fn flush(&self) {}
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// The file holding the previous session's output and its length now: the
/// current log when it has content, otherwise the newest rotated file (the
/// plugin rotates at startup when the log was over its size cap, moving the
/// previous session to a dated file before this session writes anything).
pub(crate) fn previous_log_source(log_dir: &Path) -> Option<(PathBuf, u64)> {
    let current = log_dir.join(LOG_FILE);
    let length = |path: &Path| {
        std::fs::metadata(path)
            .ok()
            .map(|m| m.len())
            .filter(|len| *len > 0)
    };
    if let Some(len) = length(&current) {
        return Some((current, len));
    }
    std::fs::read_dir(log_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            *path != current && path.extension().is_some_and(|ext| ext == "log") && path.is_file()
        })
        .max_by_key(|path| modified(path))
        .and_then(|path| length(&path).map(|len| (path, len)))
}

/// The previous session's WARN/ERROR lines, redacted and bounded.
#[cfg(test)]
pub(crate) fn load_previous_session(log_dir: &Path, redactor: &Redactor) -> Vec<String> {
    previous_log_source(log_dir)
        .map(|(path, end)| previous_session_lines(&path, end, redactor))
        .unwrap_or_default()
}

/// Capture the previous session's tail. Call first in setup, before this
/// session logs: the source is chosen synchronously, so nothing this session
/// writes can land in it; the read itself runs off the setup thread. The
/// result is a snapshot, immune to later rotation, and no file handle is kept
/// (an open handle would block Windows from renaming the log).
pub(crate) fn capture_previous_session(log_dir: PathBuf) {
    let Some((path, end)) = previous_log_source(&log_dir) else {
        let _ = PREVIOUS.set(Vec::new());
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("previous-session-log".into())
        .spawn(move || {
            let _ = PREVIOUS.set(previous_session_lines(&path, end, redactor()));
        });
    if spawned.is_err() {
        let _ = PREVIOUS.set(Vec::new());
    }
}

/// WARN/ERROR lines from the first `end` bytes of `path`: the newest
/// `MAX_PREVIOUS_LINES`, redacted and bounded.
pub(crate) fn previous_session_lines(path: &Path, end: u64, redactor: &Redactor) -> Vec<String> {
    let read = || -> Option<String> {
        let mut file = std::fs::File::open(path).ok()?;
        let end = end.min(file.metadata().ok()?.len());
        let start = end.saturating_sub(PREVIOUS_SCAN_BYTES);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(end - start).read_to_end(&mut bytes).ok()?;
        // Not necessarily UTF-8 (a byte-cut character, a foreign write).
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if start == 0 {
            return Some(text);
        }
        // The window starts mid-line: drop the fragment.
        Some(
            text.split_once('\n')
                .map_or(String::new(), |(_, rest)| rest.to_owned()),
        )
    };
    read()
        .map(|text| {
            warn_error_tail(&text, MAX_PREVIOUS_LINES)
                .into_iter()
                .map(|line| quote_line(&redactor.redact(line), None))
                .collect()
        })
        .unwrap_or_default()
}

fn units(value: &str) -> usize {
    value.encode_utf16().count()
}

/// The report section text: previous session, then this session. When over
/// `max_units`, the oldest lines go first (previous session before current).
/// Empty when there is nothing to report.
pub(crate) fn render_excerpt(previous: &[String], current: &[String], max_units: usize) -> String {
    let mut previous: &[String] = &previous[previous.len().saturating_sub(MAX_PREVIOUS_LINES)..];
    let mut current: &[String] = &current[current.len().saturating_sub(MAX_CURRENT_LINES)..];
    let render = |previous: &[String], current: &[String]| {
        let mut out = String::new();
        for (heading, lines) in [("Previous session", previous), ("This session", current)] {
            if lines.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&format!("{heading}:\n"));
            for line in lines {
                out.push_str(line);
                out.push('\n');
            }
        }
        out.trim_end().to_owned()
    };
    loop {
        let text = render(previous, current);
        if units(&text) <= max_units {
            return text;
        }
        if let Some((_, rest)) = previous.split_first() {
            previous = rest;
        } else if let Some((_, rest)) = current.split_first() {
            current = rest;
        } else {
            return String::new();
        }
    }
}

fn excerpt() -> String {
    let current = RING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .lines();
    let previous = PREVIOUS.get().cloned().unwrap_or_default();
    render_excerpt(&previous, &current, MAX_EXCERPT_UNITS)
}

/// The redacted, bounded excerpt the report dialog previews (#1685).
#[tauri::command]
pub async fn recent_errors() -> String {
    tauri::async_runtime::spawn_blocking(excerpt)
        .await
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "../test_support/recent_errors_test.rs"]
mod tests;
