//! Recent-actions trail for user reports and crash files (#1688).
//!
//! The frontend reports an identifier per user action (command ID, view
//! mode, navigation kind) and nothing else: never a path, file name or
//! search text. `sanitize` enforces that shape at the native boundary, so a
//! caller bug cannot widen what a report may disclose. The trail lives in
//! this process, so a panic hook can include it in the crash file.

use std::collections::VecDeque;
use std::sync::Mutex;

pub(crate) const MAX_ACTIONS: usize = 30;
const MAX_ACTION_CHARS: usize = 64;
/// What an identifier outside the allowed shape is recorded as.
const UNRECOGNIZED: &str = "(unrecognized)";

#[derive(Default)]
pub(crate) struct Trail {
    actions: VecDeque<String>,
}

/// An action identifier: ASCII letters, digits and `. _ : -`, at most 64
/// characters. Anything else (spaces, slashes, non-ASCII) is not an
/// identifier and could be user text, so it is replaced by a marker.
pub(crate) fn sanitize(raw: &str) -> String {
    let raw = raw.trim();
    let valid = !raw.is_empty()
        && raw.chars().count() <= MAX_ACTION_CHARS
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if valid { raw } else { UNRECOGNIZED }.to_owned()
}

impl Trail {
    pub(crate) fn record(&mut self, raw: &str) {
        self.actions.push_back(sanitize(raw));
        while self.actions.len() > MAX_ACTIONS {
            self.actions.pop_front();
        }
    }

    /// Oldest first, numbered so the order is unambiguous in a report.
    pub(crate) fn render(&self) -> String {
        self.actions
            .iter()
            .enumerate()
            .map(|(index, action)| format!("{}. {action}", index + 1))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

static TRAIL: Mutex<Trail> = Mutex::new(Trail {
    actions: VecDeque::new(),
});

/// The trail as text for the crash file. Never blocks: a panic hook can run
/// while this thread already holds the lock.
pub(crate) fn render_for_crash() -> String {
    TRAIL
        .try_lock()
        .map(|trail| trail.render())
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn record_for_test(kind: &str) {
    TRAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .record(kind);
}

#[tauri::command]
pub async fn record_action(kind: String) {
    TRAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .record(&kind);
}

/// The trail the report dialog previews. Empty when nothing was recorded.
#[tauri::command]
pub async fn recent_actions() -> String {
    TRAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .render()
}

#[cfg(test)]
#[path = "../test_support/recent_actions_test.rs"]
mod tests;
