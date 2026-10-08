//! Native-only records for watched listings the frontend cannot report (#1022).
//!
//! A navigation's frontend watchdog records it at 5 s. If the renderer's event
//! loop is blocked it never does, so each *watched* listing is also armed
//! here: still in flight after the fallback delay, it gets a native-only
//! `pending` record, and when it later settles that record is replaced with
//! the outcome. Background refreshes are not armed: nobody is waiting on them,
//! and a slow folder refreshed by watcher events would otherwise fill the
//! bounded record store with stale entries.
//!
//! One lock orders the delayed capture against settlement, so a settled load
//! never leaves a `pending` fallback record behind.
use super::trace::{self, NativeSnapshot, Outcome};
use super::{persist, FrontendRecord, Source};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

enum State {
    /// Armed; the delayed capture has not run yet.
    Armed,
    /// A pending record was written to this records directory.
    Recorded(PathBuf),
}

/// Bounded by the trace registry: only in-flight traces are armed, and
/// settling removes the entry.
static STATES: LazyLock<Mutex<HashMap<String, State>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock() -> std::sync::MutexGuard<'static, HashMap<String, State>> {
    STATES.lock().unwrap_or_else(|error| error.into_inner())
}

fn outcome_label(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Pending => "pending",
        Outcome::Ok => "ok",
        Outcome::Error => "error",
        Outcome::Cancelled => "cancelled",
    }
}

/// The record a native-only capture contributes, from the trace alone.
pub(super) fn native_only_record(
    id: &str,
    snapshot: &NativeSnapshot,
    now_epoch_ms: f64,
    threshold_ms: f64,
) -> FrontendRecord {
    let elapsed = snapshot.elapsed_ms as f64;
    let pending = snapshot.outcome == Outcome::Pending;
    FrontendRecord {
        id: id.to_owned(),
        path: snapshot.path.clone(),
        requested_path: None,
        pane: None,
        reason: "unknown".into(),
        spinner_visible: false,
        started_at: now_epoch_ms - elapsed,
        captured_at: now_epoch_ms,
        elapsed_ms: elapsed,
        threshold_ms,
        outcome: outcome_label(snapshot.outcome).into(),
        pending_phase: pending.then(|| "native".into()),
        phases: Vec::new(),
        queued_behind: None,
        entries: None,
        drive_kind: None,
        since_boot_ms: None,
        others_in_flight: Vec::new(),
    }
}

/// Arm the fallback for a watched, traced listing.
pub(super) fn arm(id: &str) {
    lock().insert(id.to_owned(), State::Armed);
}

/// The fallback delay elapsed. Writes a `pending` record if the listing is
/// still in flight; returns whether it did.
pub(super) fn capture(id: &str, dir: PathBuf, now_epoch_ms: f64, threshold_ms: f64) -> bool {
    let mut states = lock();
    if !matches!(states.get(id), Some(State::Armed)) {
        return false;
    }
    let pending = trace::snapshot(id).filter(|snapshot| snapshot.outcome == Outcome::Pending);
    let Some(snapshot) = pending else {
        states.remove(id);
        return false;
    };
    // Precedence in `persist` drops this if the frontend already recorded.
    persist::submit(
        dir.clone(),
        super::merge(
            native_only_record(id, &snapshot, now_epoch_ms, threshold_ms),
            Source::NativeWatchdog,
        ),
    );
    states.insert(id.to_owned(), State::Recorded(dir));
    true
}

/// [`trace::TraceScope`] settle hook: disarm, and settle a record the delayed
/// capture already wrote.
pub(super) fn settled(id: &str, snapshot: &NativeSnapshot) {
    let mut states = lock();
    if let Some(State::Recorded(dir)) = states.remove(id) {
        persist::submit(
            dir,
            super::merge(
                native_only_record(
                    id,
                    snapshot,
                    super::now_epoch_ms(),
                    super::fallback_threshold_ms(),
                ),
                Source::NativeWatchdog,
            ),
        );
    }
}

#[cfg(test)]
pub(super) fn is_armed(id: &str) -> bool {
    lock().contains_key(id)
}
