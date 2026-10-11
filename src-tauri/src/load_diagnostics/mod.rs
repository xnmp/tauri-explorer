//! Slow directory-load diagnostics (#1022).
//!
//! The frontend watchdog (`state/load-watchdog.ts`) owns the threshold and the
//! frontend phases. At the threshold it calls [`record_slow_load`] while the
//! load is still pending; this module merges the native phase snapshot for
//! the same trace ID, the load it is queued behind, and the directory's
//! filesystem, then hands the record to `persist.rs`, whose dedicated thread
//! writes one bounded file under `<app log dir>/slow-loads/` and a summary
//! line to the rotating application log. A finished load replaces its record
//! with the final outcome; a late pending capture never replaces it.
//!
//! If the renderer cannot deliver its record (its event loop is blocked),
//! `fallback.rs` writes a native-only record for any watched listing still
//! in flight after [`NATIVE_FALLBACK_AFTER`], and settles it when the
//! listing finishes. `reply.rs` keeps a listing's trace open while Tauri
//! encodes the reply, so a slow encoding is not blamed on the scan.
//!
//! Records leave the machine only through the Report Issue dialog, which shows
//! them and lets the reporter exclude them before submitting.
mod fallback;
mod filesystem;
mod persist;
mod reply;
mod store;
pub(crate) mod trace;

use crate::error::AppError;
use filesystem::FilesystemInfo;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use trace::{NativeSnapshot, Outcome, TraceScope};

pub(crate) use reply::TracedReply;
pub(crate) use trace::{Phase, TraceHandle};

/// Later than the frontend's 5 s threshold so the richer frontend record wins.
const NATIVE_FALLBACK_AFTER: Duration = Duration::from_secs(7);
const MAX_RECENT: usize = 20;
const MAX_PATH_CHARS: usize = 4096;
const MAX_LABEL_CHARS: usize = 48;
const MAX_PHASES: usize = 32;
const MAX_OTHERS: usize = 8;
const SCHEMA: u32 = 1;
/// A settled native command this much shorter than the frontend's `native`
/// phase (and at least half of it) means the time went to the IPC round
/// trip: the reply's transfer and decode in the webview, or the request.
const IPC_GAP_MIN_MS: f64 = 1000.0;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendPhase {
    pub phase: String,
    pub start_ms: f64,
    pub duration_ms: f64,
    pub pending: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueuedBehind {
    pub path: String,
    pub reason: String,
    pub elapsed_ms: f64,
    #[serde(default)]
    pub trace_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtherLoad {
    pub path: String,
    #[serde(default)]
    pub pending_phase: Option<String>,
    pub elapsed_ms: f64,
}

/// The frontend's view of one load, as sent by the watchdog.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrontendRecord {
    pub id: String,
    /// The folder actually listed (after any auto-enter descent).
    pub path: String,
    /// The folder the user asked for, when auto-enter descended from it.
    #[serde(default)]
    pub requested_path: Option<String>,
    #[serde(default)]
    pub pane: Option<u32>,
    pub reason: String,
    pub spinner_visible: bool,
    /// Epoch milliseconds.
    pub started_at: f64,
    pub captured_at: f64,
    pub elapsed_ms: f64,
    pub threshold_ms: f64,
    /// `pending` while the load is stuck, then its final outcome.
    pub outcome: String,
    #[serde(default)]
    pub pending_phase: Option<String>,
    #[serde(default)]
    pub phases: Vec<FrontendPhase>,
    #[serde(default)]
    pub queued_behind: Option<QueuedBehind>,
    #[serde(default)]
    pub entries: Option<u64>,
    #[serde(default)]
    pub drive_kind: Option<String>,
    #[serde(default)]
    pub since_boot_ms: Option<f64>,
    #[serde(default)]
    pub others_in_flight: Vec<OtherLoad>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Source {
    Frontend,
    NativeWatchdog,
}

/// One persisted slow-load diagnostic.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredRecord {
    pub schema: u32,
    pub source: Source,
    #[serde(flatten)]
    pub record: FrontendRecord,
    pub native: Option<NativeSnapshot>,
    pub blocker: Option<NativeSnapshot>,
    pub filesystem: Option<FilesystemInfo>,
    pub app_version: String,
    pub os: String,
}

fn bounded(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

impl FrontendRecord {
    /// Bound every renderer-supplied field before it reaches disk.
    fn bounded(mut self) -> Self {
        self.path = bounded(&self.path, MAX_PATH_CHARS);
        self.requested_path = self
            .requested_path
            .map(|path| bounded(&path, MAX_PATH_CHARS));
        self.reason = bounded(&self.reason, MAX_LABEL_CHARS);
        self.outcome = bounded(&self.outcome, MAX_LABEL_CHARS);
        self.pending_phase = self
            .pending_phase
            .map(|phase| bounded(&phase, MAX_LABEL_CHARS));
        self.drive_kind = self.drive_kind.map(|kind| bounded(&kind, MAX_LABEL_CHARS));
        self.phases.truncate(MAX_PHASES);
        for phase in &mut self.phases {
            phase.phase = bounded(&phase.phase, MAX_LABEL_CHARS);
        }
        if let Some(queued) = &mut self.queued_behind {
            queued.path = bounded(&queued.path, MAX_PATH_CHARS);
            queued.reason = bounded(&queued.reason, MAX_LABEL_CHARS);
            queued.trace_id = queued
                .trace_id
                .take()
                .filter(|id| trace::valid_trace_id(id));
        }
        self.others_in_flight.truncate(MAX_OTHERS);
        for other in &mut self.others_in_flight {
            other.path = bounded(&other.path, MAX_PATH_CHARS);
            other.pending_phase = other
                .pending_phase
                .take()
                .map(|phase| bounded(&phase, MAX_LABEL_CHARS));
        }
        self
    }
}

/// Merge the frontend view with the in-memory native traces. The filesystem
/// is filled in later by the persistence thread: identifying it may read
/// the mount table and symlinks, which never belongs on the executor.
fn merge(record: FrontendRecord, source: Source) -> StoredRecord {
    let native = trace::snapshot(&record.id);
    let blocker = record
        .queued_behind
        .as_ref()
        .and_then(|queued| queued.trace_id.as_deref())
        .and_then(trace::snapshot);
    StoredRecord {
        schema: SCHEMA,
        source,
        record,
        native,
        blocker,
        filesystem: None,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
    }
}

fn phase_name(phase: Phase) -> String {
    serde_json::to_value(phase)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The time the frontend's `native` phase spent outside a settled native
/// command, when that is most of it.
fn ipc_gap_ms(record: &StoredRecord, frontend_native_ms: f64) -> Option<f64> {
    let native = record.native.as_ref()?;
    if native.outcome == Outcome::Pending {
        return None;
    }
    let command_ms = native.elapsed_ms as f64;
    let gap = frontend_native_ms - command_ms;
    (gap >= IPC_GAP_MIN_MS && gap >= command_ms).then_some(gap)
}

/// The phase that best explains the delay: the deepest pending phase, else
/// the slowest one.
fn culprit(record: &StoredRecord) -> String {
    let native = record.native.as_ref().and_then(|native| {
        native
            .pending_phase
            .or_else(|| {
                native
                    .phases
                    .iter()
                    .max_by_key(|phase| phase.duration_ms)
                    .map(|phase| phase.phase)
            })
            .map(|phase| format!("native {}", phase_name(phase)))
    });
    let frontend_phase = record
        .record
        .phases
        .iter()
        .find(|phase| phase.pending)
        .or_else(|| {
            record
                .record
                .phases
                .iter()
                .max_by(|a, b| a.duration_ms.total_cmp(&b.duration_ms))
        });
    if let Some(phase) = frontend_phase.filter(|phase| phase.phase == "native") {
        if let Some(gap) = ipc_gap_ms(record, phase.duration_ms) {
            let command_ms = record.native.as_ref().map_or(0, |native| native.elapsed_ms);
            return format!(
                "ipc reply (native command finished in {command_ms}ms; {}ms waiting on the IPC reply / webview)",
                gap.round()
            );
        }
    }
    let frontend = record
        .record
        .pending_phase
        .clone()
        .or_else(|| frontend_phase.map(|phase| phase.phase.clone()));
    match (frontend.as_deref(), native) {
        (Some("native") | None, Some(native)) => native,
        (Some(frontend), _) => frontend.to_owned(),
        (None, None) => "unknown".into(),
    }
}

fn log_summary(record: &StoredRecord) {
    let entries = record
        .native
        .as_ref()
        .map(|native| format!("{}/{}", native.entries_statted, native.entries_listed))
        .unwrap_or_else(|| "?".into());
    let filesystem = record
        .filesystem
        .as_ref()
        .and_then(|info| info.fs_type.clone())
        .unwrap_or_else(|| "?".into());
    log::warn!(
        "slow directory load {}: path={:?}, outcome={}, elapsed={}ms, culprit={}, entries={}, fs={}, source={:?}",
        record.record.id,
        record.record.path,
        record.record.outcome,
        record.record.elapsed_ms.round(),
        culprit(record),
        entries,
        filesystem,
        record.source,
    );
}

fn records_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    app.path()
        .app_log_dir()
        .map(|dir| dir.join("slow-loads"))
        .map_err(|error| AppError::Other(format!("Failed to resolve log directory: {error}")))
}

/// Accept a frontend slow-load record merged with native state. Merging reads
/// only in-memory traces and the kernel mount table; the write and log line
/// happen on the persistence thread, never on the executor or the shared
/// blocking pool whose saturation may be the very delay being diagnosed.
#[tauri::command]
pub async fn record_slow_load(
    app: tauri::AppHandle,
    record: FrontendRecord,
) -> Result<(), AppError> {
    if !trace::valid_trace_id(&record.id) {
        return Err(AppError::InvalidPath("Invalid slow-load trace ID".into()));
    }
    let dir = records_dir(&app)?;
    persist::submit(dir, merge(record.bounded(), Source::Frontend));
    Ok(())
}

/// Recent slow-load records, newest first, for the Report Issue dialog.
#[tauri::command]
pub async fn recent_slow_loads(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<Vec<StoredRecord>, AppError> {
    let dir = records_dir(&app)?;
    let limit = limit.unwrap_or(MAX_RECENT).min(MAX_RECENT);
    Ok(persist::recent(dir, limit).await)
}

fn now_epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn fallback_threshold_ms() -> f64 {
    NATIVE_FALLBACK_AFTER.as_millis() as f64
}

/// Begin a traced native listing. Only frontend-supplied, well-formed trace
/// IDs are traced; everything else runs untraced at no extra cost. A
/// `watched` listing (one a pane is waiting on, as opposed to a background
/// refresh) is also armed for the native fallback.
pub(crate) fn begin_listing(
    app: Option<&tauri::AppHandle>,
    trace_id: Option<String>,
    path: &str,
    watched: bool,
) -> TraceScope {
    let dir = app.and_then(|app| records_dir(app).ok());
    begin_listing_in(dir, trace_id, path, watched, |id, dir| {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(NATIVE_FALLBACK_AFTER).await;
            fallback::capture(&id, dir, now_epoch_ms(), fallback_threshold_ms());
        });
    })
}

/// [`begin_listing`] with the records directory and the delayed capture
/// injected, so arming is testable without a runtime or app handle.
fn begin_listing_in(
    dir: Option<PathBuf>,
    trace_id: Option<String>,
    path: &str,
    watched: bool,
    schedule: impl FnOnce(String, PathBuf),
) -> TraceScope {
    let scope = TraceScope::begin(trace_id, path);
    let (Some(id), Some(dir), true) = (scope.handle().id().map(str::to_owned), dir, watched) else {
        return scope;
    };
    fallback::arm(&id);
    let scope = scope.on_settle(fallback::settled);
    schedule(id, dir);
    scope
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frontend(id: &str) -> FrontendRecord {
        FrontendRecord {
            id: id.into(),
            path: "/mnt/remote".into(),
            requested_path: None,
            pane: Some(1),
            reason: "navigate".into(),
            spinner_visible: true,
            started_at: 1.0,
            captured_at: 5001.0,
            elapsed_ms: 5000.0,
            threshold_ms: 5000.0,
            outcome: "pending".into(),
            pending_phase: Some("native".into()),
            phases: vec![FrontendPhase {
                phase: "native".into(),
                start_ms: 3.0,
                duration_ms: 4997.0,
                pending: true,
            }],
            queued_behind: None,
            entries: None,
            drive_kind: None,
            since_boot_ms: None,
            others_in_flight: Vec::new(),
        }
    }

    #[test]
    fn renderer_fields_are_bounded_before_persisting() {
        let mut record = frontend("1700000000000-b1");
        record.path = "p".repeat(10_000);
        record.reason = "r".repeat(500);
        record.phases = (0..100)
            .map(|n| FrontendPhase {
                phase: "x".repeat(200),
                start_ms: n as f64,
                duration_ms: 1.0,
                pending: false,
            })
            .collect();
        record.queued_behind = Some(QueuedBehind {
            path: "q".repeat(10_000),
            reason: "refresh".into(),
            elapsed_ms: 1.0,
            trace_id: Some("../bad".into()),
        });
        let bounded = record.bounded();
        assert_eq!(bounded.path.chars().count(), MAX_PATH_CHARS);
        assert_eq!(bounded.reason.chars().count(), MAX_LABEL_CHARS);
        assert_eq!(bounded.phases.len(), MAX_PHASES);
        assert!(bounded
            .phases
            .iter()
            .all(|p| p.phase.len() == MAX_LABEL_CHARS));
        let queued = bounded.queued_behind.unwrap();
        assert_eq!(queued.path.chars().count(), MAX_PATH_CHARS);
        assert_eq!(queued.trace_id, None);
    }

    #[test]
    fn merged_record_names_the_pending_native_phase_and_fits_its_size_bound() {
        let id = "1700000000000-merge1";
        let scope = TraceScope::begin(Some(id.into()), "/mnt/remote");
        scope.handle().enter(Phase::WatchLock);
        scope.handle().enter(Phase::ReadDir);
        let stored = merge(frontend(id), Source::Frontend);
        assert_eq!(
            stored.native.as_ref().unwrap().pending_phase,
            Some(Phase::ReadDir)
        );
        assert_eq!(culprit(&stored), "native read-dir");
        let json = serde_json::to_value(&stored).unwrap();
        assert_eq!(json["pendingPhase"], "native");
        assert_eq!(json["native"]["pendingPhase"], "read-dir");
        assert_eq!(json["source"], "frontend");
        // A record with the maximum renderer-supplied content still fits.
        let mut huge = frontend(id);
        huge.path = "p".repeat(100_000);
        huge.phases = vec![huge.phases[0].clone(); 1_000];
        let bounded = merge(huge.bounded(), Source::Frontend);
        assert!(serde_json::to_vec_pretty(&bounded).unwrap().len() <= store::MAX_RECORD_BYTES);
        drop(scope);
    }

    #[test]
    fn a_frontend_phase_other_than_native_is_the_culprit() {
        let mut record = frontend("1700000000000-queue1");
        record.pending_phase = Some("queued".into());
        assert_eq!(culprit(&merge(record, Source::Frontend)), "queued");
        let mut finished = frontend("1700000000000-done1");
        finished.pending_phase = None;
        finished.phases = vec![
            FrontendPhase {
                phase: "watch-ready".into(),
                start_ms: 0.0,
                duration_ms: 6000.0,
                pending: false,
            },
            FrontendPhase {
                phase: "publish".into(),
                start_ms: 6000.0,
                duration_ms: 20.0,
                pending: false,
            },
        ];
        assert_eq!(culprit(&merge(finished, Source::Frontend)), "watch-ready");
    }

    #[test]
    fn stored_records_round_trip_through_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let id = "1700000000000-store1";
        let stored = merge(frontend(id), Source::Frontend);
        store::write(dir.path(), id, &stored).unwrap();
        let read: Vec<StoredRecord> = store::read_recent(dir.path(), 5);
        assert_eq!(read, vec![stored]);
    }

    #[test]
    fn native_fallback_record_describes_a_pending_native_load() {
        let id = "1700000000000-native1";
        let scope = TraceScope::begin(Some(id.into()), "/mnt/stuck");
        scope.handle().enter(Phase::RootMetadata);
        let snapshot = trace::snapshot(id).unwrap();
        let record = fallback::native_only_record(id, &snapshot, 10_000.0, 7_000.0);
        assert_eq!(record.path, "/mnt/stuck");
        assert_eq!(record.outcome, "pending");
        let stored = merge(record, Source::NativeWatchdog);
        assert_eq!(culprit(&stored), "native root-metadata");
        drop(scope);
    }

    fn stored(id: &str, outcome: &str, source: Source) -> StoredRecord {
        let mut record = frontend(id);
        record.outcome = outcome.into();
        merge(record, source)
    }

    #[test]
    fn precedence_keeps_settled_and_frontend_records() {
        use persist::should_replace;
        let id = "1700000000000-prec1";
        let pending = stored(id, "pending", Source::Frontend);
        let finished = stored(id, "ok", Source::Frontend);
        let native = stored(id, "pending", Source::NativeWatchdog);
        assert!(should_replace(None, &pending));
        assert!(should_replace(Some(&pending), &finished));
        assert!(
            !should_replace(Some(&finished), &pending),
            "late pending capture"
        );
        assert!(
            !should_replace(Some(&pending), &native),
            "fallback after frontend"
        );
        assert!(
            should_replace(Some(&native), &pending),
            "frontend after fallback"
        );
        // The native command finishing does not mean the pane received its
        // reply: a later frontend capture still replaces the fallback.
        let native_settled = stored(id, "ok", Source::NativeWatchdog);
        assert!(
            should_replace(Some(&native_settled), &pending),
            "frontend pending after settled fallback"
        );
        assert!(!should_replace(Some(&finished), &native_settled));
        assert!(!should_replace(Some(&native_settled), &native));
        assert!(should_replace(
            Some(&finished),
            &stored(id, "error", Source::Frontend)
        ));
    }

    #[test]
    fn out_of_order_captures_persist_the_settled_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let id = "1700000000000-order1";
        assert!(persist::submit(
            dir.path().to_path_buf(),
            stored(id, "ok", Source::Frontend)
        ));
        assert!(!persist::submit(
            dir.path().to_path_buf(),
            stored(id, "pending", Source::Frontend)
        ));
        assert!(!persist::submit(
            dir.path().to_path_buf(),
            stored(id, "pending", Source::NativeWatchdog)
        ));
        persist::flush();
        let on_disk: Vec<StoredRecord> = store::read_recent(dir.path(), 5);
        assert_eq!(on_disk.len(), 1);
        assert_eq!(on_disk[0].record.outcome, "ok");
        assert_eq!(on_disk[0].source, Source::Frontend);
    }

    #[test]
    fn recent_overlays_session_records_on_disk_history() {
        let older = stored("1700000000000-disk1", "ok", Source::Frontend);
        let stale = stored("1700000000005-same1", "pending", Source::Frontend);
        let fresh = stored("1700000000005-same1", "ok", Source::Frontend);
        let newest = stored("1700000000009-mem1", "pending", Source::Frontend);
        let merged = persist::merge_recent(
            vec![newest.clone(), fresh.clone()],
            vec![stale, older.clone()],
            10,
        );
        assert_eq!(merged, vec![newest, fresh, older]);
        assert_eq!(persist::merge_recent(Vec::new(), Vec::new(), 3), Vec::new());
    }

    /// The exact record `buildFrontendRecord` produces, shared with
    /// `tests/domain/load-diagnostics.test.ts`. `persist()` on the frontend
    /// swallows IPC rejections, so a renamed or retyped field would otherwise
    /// silently disable recording.
    const FRONTEND_FIXTURE: &str =
        include_str!("../../test_support/fixtures/slow-load-frontend-record.json");

    /// JSON numbers compared by value: the record keeps millisecond fields
    /// as `f64`, so `5000` round-trips as `5000.0`.
    fn numbers_as_f64(value: serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match value {
            Value::Number(number) => number
                .as_f64()
                .and_then(serde_json::Number::from_f64)
                .map_or(Value::Null, Value::Number),
            Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_f64).collect()),
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .map(|(key, value)| (key, numbers_as_f64(value)))
                    .collect(),
            ),
            other => other,
        }
    }

    #[test]
    fn the_frontend_record_shape_deserializes_losslessly() {
        let record: FrontendRecord = serde_json::from_str(FRONTEND_FIXTURE).unwrap();
        assert!(trace::valid_trace_id(&record.id));
        assert_eq!(record.requested_path.as_deref(), Some("/mnt/nas"));
        assert_eq!(
            record.queued_behind.as_ref().unwrap().trace_id.as_deref(),
            Some("1791000000000-blocker1")
        );
        assert_eq!(record.others_in_flight.len(), 1);
        let fixture = numbers_as_f64(serde_json::from_str(FRONTEND_FIXTURE).unwrap());
        assert_eq!(
            numbers_as_f64(serde_json::to_value(&record).unwrap()),
            fixture,
            "no field dropped or renamed"
        );
        // A stored record flattens the same fields at its top level.
        let stored = numbers_as_f64(serde_json::to_value(merge(record, Source::Frontend)).unwrap());
        for (key, value) in fixture.as_object().unwrap() {
            assert_eq!(&stored[key], value, "{key}");
        }
    }

    fn native_snapshot(outcome: Outcome, elapsed_ms: u64) -> NativeSnapshot {
        NativeSnapshot {
            path: "/huge".into(),
            elapsed_ms,
            outcome,
            pending_phase: None,
            phases: vec![trace::PhaseSnapshot {
                phase: Phase::EntryMetadata,
                start_ms: 0,
                duration_ms: 300,
                pending: false,
            }],
            entries_listed: 300_000,
            entries_statted: 300_000,
            stat_failures: 0,
            entries_done: 300_000,
            stat_ms: 0,
            resolve_ms: 0,
            symlinks: 0,
            git_repo_probe: true,
            stalled_entries: Vec::new(),
            slowest_entry: None,
        }
    }

    #[test]
    fn time_after_a_settled_native_command_is_blamed_on_the_ipc_reply() {
        let mut stuck = stored("1700000000000-ipc1", "pending", Source::Frontend);
        stuck.native = Some(native_snapshot(Outcome::Ok, 420));
        // The frontend's native phase has been pending 5 s; the command took 420 ms.
        assert_eq!(
            culprit(&stuck),
            "ipc reply (native command finished in 420ms; 4577ms waiting on the IPC reply / webview)"
        );
        // A native command still running is not an IPC delay.
        stuck.native = Some(native_snapshot(Outcome::Pending, 4997));
        assert_eq!(culprit(&stuck), "native entry-metadata");
        // Nor is a short gap after a command that took most of the time.
        stuck.native = Some(native_snapshot(Outcome::Ok, 4600));
        assert_eq!(culprit(&stuck), "native entry-metadata");
    }

    #[test]
    fn only_watched_listings_arm_the_native_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let mut scheduled = Vec::new();
        let refresh = begin_listing_in(
            Some(dir.path().to_path_buf()),
            Some("1700000000000-refresh1".into()),
            "/mnt/nfs",
            false,
            |id, _| scheduled.push(id),
        );
        assert!(scheduled.is_empty());
        assert!(!fallback::is_armed("1700000000000-refresh1"));
        assert!(!fallback::capture(
            "1700000000000-refresh1",
            dir.path().to_path_buf(),
            1.0,
            7_000.0
        ));
        drop(refresh);
        persist::flush();
        assert!(store::read_recent::<StoredRecord>(dir.path(), 5).is_empty());

        let untraced =
            begin_listing_in(Some(dir.path().to_path_buf()), None, "/a", true, |id, _| {
                scheduled.push(id)
            });
        assert!(scheduled.is_empty());
        drop(untraced);

        let watched = begin_listing_in(
            Some(dir.path().to_path_buf()),
            Some("1700000000000-watched1".into()),
            "/mnt/nfs",
            true,
            |id, _| scheduled.push(id),
        );
        assert_eq!(scheduled, vec!["1700000000000-watched1".to_string()]);
        assert!(fallback::is_armed("1700000000000-watched1"));
        // Settling before the delay disarms it; the delayed capture is a no-op.
        watched.finish(&Ok::<(), ()>(()));
        assert!(!fallback::is_armed("1700000000000-watched1"));
        assert!(!fallback::capture(
            "1700000000000-watched1",
            dir.path().to_path_buf(),
            1.0,
            7_000.0
        ));
        persist::flush();
        assert!(store::read_recent::<StoredRecord>(dir.path(), 5).is_empty());
    }

    #[test]
    fn a_fallback_record_is_settled_when_its_listing_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let id = "1700000000000-fallback1";
        let scope = begin_listing_in(
            Some(dir.path().to_path_buf()),
            Some(id.into()),
            "/mnt/stuck",
            true,
            |_, _| {},
        );
        scope.handle().enter(Phase::RootMetadata);
        assert!(fallback::capture(
            id,
            dir.path().to_path_buf(),
            10_000.0,
            7_000.0
        ));
        persist::flush();
        let pending: Vec<StoredRecord> = store::read_recent(dir.path(), 5);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].record.outcome, "pending");
        assert_eq!(pending[0].source, Source::NativeWatchdog);
        assert_eq!(culprit(&pending[0]), "native root-metadata");
        // Windows has no mount for a drive-less path.
        if cfg!(unix) {
            assert!(
                pending[0].filesystem.is_some(),
                "filled in by the writer thread"
            );
        }

        scope.finish(&Err::<(), ()>(()));
        persist::flush();
        let settled: Vec<StoredRecord> = store::read_recent(dir.path(), 5);
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].record.outcome, "error");
        assert_eq!(settled[0].record.pending_phase, None);
        assert_eq!(settled[0].native.as_ref().unwrap().outcome, Outcome::Error);

        // A cancelled (dropped) command settles as cancelled.
        let dropped = "1700000000000-fallback2";
        let scope = begin_listing_in(
            Some(dir.path().to_path_buf()),
            Some(dropped.into()),
            "/mnt/stuck",
            true,
            |_, _| {},
        );
        assert!(fallback::capture(
            dropped,
            dir.path().to_path_buf(),
            10_000.0,
            7_000.0
        ));
        drop(scope);
        persist::flush();
        let outcome = store::read_one::<StoredRecord>(dir.path(), dropped).unwrap();
        assert_eq!(outcome.record.outcome, "cancelled");
    }

    #[test]
    fn a_settled_record_on_disk_outranks_a_late_capture_after_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let id = "1600000000000-evict1";
        assert!(persist::submit(
            dir.path().to_path_buf(),
            stored(id, "ok", Source::Frontend)
        ));
        // Newer records (written elsewhere) push it out of the in-memory map.
        let elsewhere = tempfile::tempdir().unwrap();
        for n in 0..persist::MAX_MEMORY {
            persist::submit(
                elsewhere.path().to_path_buf(),
                stored(&format!("17000000{n:05}-evict"), "ok", Source::Frontend),
            );
        }
        // The late pending capture is accepted in memory, but not on disk.
        assert!(persist::submit(
            dir.path().to_path_buf(),
            stored(id, "pending", Source::Frontend)
        ));
        persist::flush();
        let on_disk = store::read_one::<StoredRecord>(dir.path(), id).unwrap();
        assert_eq!(on_disk.record.outcome, "ok");
    }
}
