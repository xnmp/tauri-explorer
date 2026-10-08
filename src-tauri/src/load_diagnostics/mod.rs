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
//! a native fallback writes a native-only record for any traced listing
//! still in flight after [`NATIVE_FALLBACK_AFTER`].
//!
//! Records leave the machine only through the Report Issue dialog, which shows
//! them and lets the reporter exclude them before submitting.
mod filesystem;
mod persist;
mod store;
pub(crate) mod trace;

use crate::error::AppError;
use filesystem::FilesystemInfo;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use trace::{NativeSnapshot, TraceScope};

pub(crate) use trace::{Phase, TraceHandle};

/// Later than the frontend's 5 s threshold so the richer frontend record wins.
const NATIVE_FALLBACK_AFTER: Duration = Duration::from_secs(7);
const MAX_RECENT: usize = 20;
const MAX_PATH_CHARS: usize = 4096;
const MAX_LABEL_CHARS: usize = 48;
const MAX_PHASES: usize = 32;
const MAX_OTHERS: usize = 8;
const SCHEMA: u32 = 1;

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

/// Merge the frontend view with everything only the native side can see.
fn merge(record: FrontendRecord, source: Source) -> StoredRecord {
    let native = trace::snapshot(&record.id);
    let blocker = record
        .queued_behind
        .as_ref()
        .and_then(|queued| queued.trace_id.as_deref())
        .and_then(trace::snapshot);
    let filesystem = filesystem::filesystem_info(&record.path);
    StoredRecord {
        schema: SCHEMA,
        source,
        record,
        native,
        blocker,
        filesystem,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
    }
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
            .and_then(|phase| serde_json::to_value(phase).ok())
            .and_then(|value| value.as_str().map(|phase| format!("native {phase}")))
    });
    let frontend = record.record.pending_phase.clone().or_else(|| {
        record
            .record
            .phases
            .iter()
            .max_by(|a, b| a.duration_ms.total_cmp(&b.duration_ms))
            .map(|phase| phase.phase.clone())
    });
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

fn native_only_record(id: &str, snapshot: &NativeSnapshot, now_epoch_ms: f64) -> FrontendRecord {
    let elapsed = snapshot.elapsed_ms as f64;
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
        threshold_ms: NATIVE_FALLBACK_AFTER.as_millis() as f64,
        outcome: "pending".into(),
        pending_phase: Some("native".into()),
        phases: Vec::new(),
        queued_behind: None,
        entries: None,
        drive_kind: None,
        since_boot_ms: None,
        others_in_flight: Vec::new(),
    }
}

fn now_epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

fn schedule_native_fallback(app: tauri::AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(NATIVE_FALLBACK_AFTER).await;
        if !trace::is_in_flight(&id) {
            return;
        }
        let Ok(dir) = records_dir(&app) else { return };
        let Some(snapshot) = trace::snapshot(&id) else {
            return;
        };
        // Precedence in `persist` drops this if the frontend already recorded.
        persist::submit(
            dir,
            merge(
                native_only_record(&id, &snapshot, now_epoch_ms()),
                Source::NativeWatchdog,
            ),
        );
    });
}

/// Begin a traced native listing. Only frontend-supplied, well-formed trace
/// IDs are traced; everything else runs untraced at no extra cost.
pub(crate) fn begin_listing(
    app: Option<&tauri::AppHandle>,
    trace_id: Option<String>,
    path: &str,
) -> TraceScope {
    let scope = TraceScope::begin(trace_id, path);
    if let (Some(app), Some(id)) = (app, scope.handle().id()) {
        schedule_native_fallback(app.clone(), id.to_owned());
    }
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
        let record = native_only_record(id, &snapshot, 10_000.0);
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
}
