//! Recent warnings and errors for user reports (#1685).
//!
//! The reporter can opt in to a short excerpt of WARN/ERROR records: this
//! session's, from a bounded in-memory ring fed by a `log` target (no file
//! parsing), and the previous session's, read on demand from the end of the
//! log file as it stood when this session started. Forwarded frontend errors
//! already reach `log::error!` (`crash_report::log_frontend_error`), so the
//! ring sees them too.
//!
//! Every line is redacted (`$HOME` becomes `~`) and bounded before it is
//! stored or read, and the excerpt is size-capped so it fits the report body.
#![allow(clippy::disallowed_methods)] // Retire-when: #1638 closed (non-UTF-8 names, ADR 0031)

use crate::diagnostics_cli::{display, log_file, quote_line, warn_error_tail};
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_RING_ENTRIES: usize = 100;
const MAX_RING_BYTES: usize = 24 * 1024;
/// Newest lines quoted per source.
pub(crate) const MAX_CURRENT_LINES: usize = 30;
pub(crate) const MAX_PREVIOUS_LINES: usize = 20;
/// Whole-excerpt cap, below the dialog's per-section ceiling (6000).
pub(crate) const MAX_EXCERPT_UNITS: usize = 5000;
/// How much of the previous session's log is scanned.
const PREVIOUS_SCAN_BYTES: u64 = 256 * 1024;

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
            if last.0 == line {
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
/// The log file and its length when this session started: everything before
/// that offset belongs to earlier sessions.
static SESSION_START: OnceLock<Option<(PathBuf, u64)>> = OnceLock::new();
static HOME: OnceLock<Option<String>> = OnceLock::new();

fn home() -> Option<&'static str> {
    HOME.get_or_init(|| dirs::home_dir().map(|home| display(&home)))
        .as_deref()
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
        let line = quote_line(
            &format!(
                "[{}][{}] {}",
                record.level(),
                record.target(),
                record.args()
            ),
            home(),
        );
        // A poisoned lock only means another logger panicked mid-push.
        let mut ring = RING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ring.push(line);
    }

    fn flush(&self) {}
}

/// Remember where this session's log output begins. Call once, first in setup.
pub(crate) fn mark_session_start(log_dir: &Path) {
    let _ = SESSION_START.set(log_file(log_dir).and_then(|(_, path)| {
        let length = std::fs::metadata(&path).ok()?.len();
        Some((path, length))
    }));
}

/// WARN/ERROR lines from the bytes of `path` before `end`: the newest
/// `MAX_PREVIOUS_LINES`, redacted and bounded.
pub(crate) fn previous_session_lines(path: &Path, end: u64, home: Option<&str>) -> Vec<String> {
    let read = || -> Option<String> {
        let mut file = std::fs::File::open(path).ok()?;
        // The file may have been rotated or truncated since `end` was taken.
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
                .map(|line| quote_line(line, home))
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
    let previous = match SESSION_START.get() {
        Some(Some((path, end))) => previous_session_lines(path, *end, home()),
        _ => Vec::new(),
    };
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
