//! In-flight native directory-load traces (#1022).
//!
//! A frontend navigation hands its trace ID to the listing command, which
//! records each native phase as a span on one shared timeline. The frontend
//! watchdog (or the native fallback in `mod.rs`) reads a snapshot while the
//! load is still pending, so a listing that never returns can still say where
//! it is stuck. Untraced listings carry an empty [`TraceHandle`] whose
//! operations are no-ops; traced listings pay one registry insert/remove,
//! a handful of span pushes and two relaxed atomic stores per entry.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Bounds keep a pathological workload from growing diagnostics memory.
const MAX_SPANS: usize = 32;
const MAX_IN_FLIGHT: usize = 256;
const MAX_FINISHED: usize = 32;
const MAX_STALLED_ENTRIES: usize = 5;
const MAX_PATH_CHARS: usize = 4096;
const MAX_NAME_CHARS: usize = 255;
/// An entry still being statted after this long is reported by name.
const STALLED_ENTRY_AFTER: Duration = Duration::from_secs(1);
/// Completed entries slower than this are candidates for `slowestEntry`.
const SLOW_ENTRY_NAME_AFTER: Duration = Duration::from_millis(50);

/// Native phases on the directory-load path, in the order they normally run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Phase {
    /// Renderer-ownership check for the requesting window.
    OwnerAcquire,
    /// Resolving the requested spelling (Windows touches each component).
    ResolvePath,
    /// Waiting for a thread on the async runtime's blocking pool.
    BlockingQueue,
    /// Waiting for the process-wide file-watcher lock.
    WatchLock,
    /// Registering the OS watch (inotify/FSEvents/ReadDirectoryChanges).
    WatchRegister,
    /// `stat` of the directory itself.
    RootMetadata,
    /// Enumerating the directory (`readdir`).
    ReadDir,
    /// Per-entry `lstat`, symlink-target resolution and git-repository probe.
    EntryMetadata,
    /// Sorting the listing.
    Sort,
    /// The command has its reply and is waiting for Tauri to encode it.
    Respond,
    /// Encoding the reply for the webview (JSON serialization). Transfer to
    /// the webview and its decode happen after the native trace settles; the
    /// frontend's `native` phase spans them.
    Serialize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Outcome {
    Pending,
    Ok,
    Error,
    /// The command future was dropped before it completed.
    Cancelled,
}

#[derive(Clone, Copy, Debug)]
struct Span {
    phase: Phase,
    start: Duration,
    end: Option<Duration>,
}

/// Pure span bookkeeping on offsets from the trace start. Entering a phase
/// closes the open one; at most one span is open at a time.
#[derive(Clone, Debug, Default)]
pub(crate) struct Timeline {
    spans: Vec<Span>,
    dropped: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhaseSnapshot {
    pub phase: Phase,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub pending: bool,
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

impl Timeline {
    pub fn enter(&mut self, phase: Phase, at: Duration) {
        self.close(at);
        if self.spans.len() >= MAX_SPANS {
            self.dropped += 1;
            return;
        }
        self.spans.push(Span {
            phase,
            start: at,
            end: None,
        });
    }

    pub fn close(&mut self, at: Duration) {
        if let Some(open) = self.spans.last_mut().filter(|span| span.end.is_none()) {
            open.end = Some(at.max(open.start));
        }
    }

    pub fn pending(&self) -> Option<Phase> {
        self.spans
            .last()
            .filter(|span| span.end.is_none())
            .map(|span| span.phase)
    }

    pub fn snapshot(&self, now: Duration) -> Vec<PhaseSnapshot> {
        self.spans
            .iter()
            .map(|span| PhaseSnapshot {
                phase: span.phase,
                start_ms: millis(span.start),
                duration_ms: millis(span.end.unwrap_or(now).saturating_sub(span.start)),
                pending: span.end.is_none(),
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntryTiming {
    pub name: String,
    pub elapsed_ms: u64,
}

/// Point-in-time view of one native load, safe to take while it is pending.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSnapshot {
    pub path: String,
    pub elapsed_ms: u64,
    pub outcome: Outcome,
    pub pending_phase: Option<Phase>,
    pub phases: Vec<PhaseSnapshot>,
    /// Entries returned by `readdir` (0 while enumeration is still pending).
    pub entries_listed: usize,
    /// Entries whose own `lstat` has returned (successfully or not).
    pub entries_statted: usize,
    /// Entries whose `lstat` failed.
    pub stat_failures: usize,
    /// Entries completely processed, including symlink and git-repo probes.
    pub entries_done: usize,
    /// Summed `lstat` time across worker threads.
    pub stat_ms: u64,
    /// Summed symlink-target and git-repository probe time across threads.
    pub resolve_ms: u64,
    pub symlinks: usize,
    pub git_repo_probe: bool,
    /// Entries still being statted after [`STALLED_ENTRY_AFTER`].
    pub stalled_entries: Vec<EntryTiming>,
    pub slowest_entry: Option<EntryTiming>,
}

/// Per-worker in-flight entry, so a hung `stat` can be named while pending.
#[derive(Default)]
struct Slot {
    /// Offset from trace start in nanoseconds, plus one; zero means idle.
    started: AtomicU64,
    index: AtomicUsize,
}

struct TraceState {
    path: String,
    started: Instant,
    timeline: Mutex<Timeline>,
    outcome: Mutex<Outcome>,
    names: OnceLock<Arc<[PathBuf]>>,
    listed: AtomicUsize,
    statted: AtomicUsize,
    stat_failures: AtomicUsize,
    done: AtomicUsize,
    stat_ns: AtomicU64,
    resolve_ns: AtomicU64,
    symlinks: AtomicUsize,
    git_repo_probe: AtomicBool,
    slowest: Mutex<Option<(Duration, usize)>>,
    slots: Box<[Slot]>,
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn bounded(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

impl TraceState {
    fn new(path: &str) -> Self {
        // One slot per rayon worker plus one for a caller outside the pool.
        let slots = (0..=rayon::current_num_threads())
            .map(|_| Slot::default())
            .collect();
        Self {
            path: bounded(path, MAX_PATH_CHARS),
            started: Instant::now(),
            timeline: Mutex::new(Timeline::default()),
            outcome: Mutex::new(Outcome::Pending),
            names: OnceLock::new(),
            listed: AtomicUsize::new(0),
            statted: AtomicUsize::new(0),
            stat_failures: AtomicUsize::new(0),
            done: AtomicUsize::new(0),
            stat_ns: AtomicU64::new(0),
            resolve_ns: AtomicU64::new(0),
            symlinks: AtomicUsize::new(0),
            git_repo_probe: AtomicBool::new(false),
            slowest: Mutex::new(None),
            slots,
        }
    }

    fn entry_name(&self, index: usize) -> String {
        self.names
            .get()
            .and_then(|names| names.get(index))
            .and_then(|path| path.file_name())
            .map(|name| bounded(&name.to_string_lossy(), MAX_NAME_CHARS))
            .unwrap_or_default()
    }

    fn snapshot(&self) -> NativeSnapshot {
        let now = self.started.elapsed();
        let timeline = lock(&self.timeline);
        let mut stalled: Vec<EntryTiming> = self
            .slots
            .iter()
            .filter_map(|slot| {
                let started = slot.started.load(Ordering::Acquire);
                if started == 0 {
                    return None;
                }
                let elapsed = now.saturating_sub(Duration::from_nanos(started - 1));
                (elapsed >= STALLED_ENTRY_AFTER).then(|| EntryTiming {
                    name: self.entry_name(slot.index.load(Ordering::Relaxed)),
                    elapsed_ms: millis(elapsed),
                })
            })
            .collect();
        stalled.sort_by_key(|entry| std::cmp::Reverse(entry.elapsed_ms));
        stalled.truncate(MAX_STALLED_ENTRIES);
        let slowest = (*lock(&self.slowest)).map(|(duration, index)| EntryTiming {
            name: self.entry_name(index),
            elapsed_ms: millis(duration),
        });
        NativeSnapshot {
            path: self.path.clone(),
            elapsed_ms: millis(now),
            outcome: *lock(&self.outcome),
            pending_phase: timeline.pending(),
            phases: timeline.snapshot(now),
            entries_listed: self.listed.load(Ordering::Relaxed),
            entries_statted: self.statted.load(Ordering::Relaxed),
            stat_failures: self.stat_failures.load(Ordering::Relaxed),
            entries_done: self.done.load(Ordering::Relaxed),
            stat_ms: self.stat_ns.load(Ordering::Relaxed) / 1_000_000,
            resolve_ms: self.resolve_ns.load(Ordering::Relaxed) / 1_000_000,
            symlinks: self.symlinks.load(Ordering::Relaxed),
            git_repo_probe: self.git_repo_probe.load(Ordering::Relaxed),
            stalled_entries: stalled,
            slowest_entry: slowest,
        }
    }
}

#[derive(Default)]
struct Registry {
    in_flight: HashMap<String, Arc<TraceState>>,
    finished: VecDeque<(String, NativeSnapshot)>,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

/// Trace IDs are generated by the frontend: a 13-digit epoch-millisecond
/// prefix (so names sort chronologically) and a short random suffix. The
/// strict shape also makes the ID safe as a record file name.
pub(crate) fn valid_trace_id(id: &str) -> bool {
    let Some((millis, suffix)) = id.split_once('-') else {
        return false;
    };
    millis.len() == 13
        && millis.bytes().all(|byte| byte.is_ascii_digit())
        && (1..=16).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())
}

/// A cheap, cloneable reference to one traced load. Empty for untraced loads.
#[derive(Clone, Default)]
pub(crate) struct TraceHandle(Option<(Arc<str>, Arc<TraceState>)>);

impl TraceHandle {
    pub fn none() -> Self {
        Self(None)
    }

    pub fn id(&self) -> Option<&str> {
        self.0.as_ref().map(|(id, _)| id.as_ref())
    }

    pub fn enter(&self, phase: Phase) {
        if let Some((_, state)) = &self.0 {
            let at = state.started.elapsed();
            lock(&state.timeline).enter(phase, at);
        }
    }

    pub fn git_repo_probe(&self, enabled: bool) {
        if let Some((_, state)) = &self.0 {
            state.git_repo_probe.store(enabled, Ordering::Relaxed);
        }
    }

    /// Publish the enumerated entries so stalled metadata reads can be named.
    pub fn listed(&self, names: &Arc<[PathBuf]>) {
        if let Some((_, state)) = &self.0 {
            state.listed.store(names.len(), Ordering::Relaxed);
            let _ = state.names.set(Arc::clone(names));
        }
    }

    /// Start timing one entry's metadata work on the current worker thread.
    pub fn entry(&self, index: usize) -> EntryProbe<'_> {
        let Some((_, state)) = &self.0 else {
            return EntryProbe {
                state: None,
                slot: None,
                index,
                started: None,
                statted_at: None,
            };
        };
        let started = Instant::now();
        let slot = rayon::current_thread_index()
            .unwrap_or(usize::MAX)
            .min(state.slots.len() - 1);
        let slot = &state.slots[slot];
        slot.index.store(index, Ordering::Relaxed);
        let offset = nanos(started.saturating_duration_since(state.started));
        // Release pairs with the snapshot's Acquire load: a reader that sees
        // this start also sees the index stored before it.
        slot.started
            .store(offset.saturating_add(1), Ordering::Release);
        EntryProbe {
            state: Some(state),
            slot: Some(slot),
            index,
            started: Some(started),
            statted_at: None,
        }
    }
}

/// Times one entry; dropping it records completion and frees its slot.
pub(crate) struct EntryProbe<'a> {
    state: Option<&'a TraceState>,
    slot: Option<&'a Slot>,
    index: usize,
    started: Option<Instant>,
    statted_at: Option<Instant>,
}

impl EntryProbe<'_> {
    /// The entry's own `lstat` succeeded; following work is resolution.
    pub fn statted(&mut self, is_symlink: bool) {
        if let Some(state) = self.stat_returned() {
            if is_symlink {
                state.symlinks.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// The entry's own `lstat` failed; the entry is skipped.
    pub fn stat_failed(&mut self) {
        if let Some(state) = self.stat_returned() {
            state.stat_failures.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn stat_returned(&mut self) -> Option<&TraceState> {
        let (Some(state), Some(started)) = (self.state, self.started) else {
            return None;
        };
        if self.statted_at.is_some() {
            return None;
        }
        let now = Instant::now();
        state
            .stat_ns
            .fetch_add(nanos(now - started), Ordering::Relaxed);
        state.statted.fetch_add(1, Ordering::Relaxed);
        self.statted_at = Some(now);
        Some(state)
    }
}

impl Drop for EntryProbe<'_> {
    fn drop(&mut self) {
        let (Some(state), Some(slot), Some(started)) = (self.state, self.slot, self.started) else {
            return;
        };
        slot.started.store(0, Ordering::Relaxed);
        state.done.fetch_add(1, Ordering::Relaxed);
        let now = Instant::now();
        if let Some(statted_at) = self.statted_at {
            state
                .resolve_ns
                .fetch_add(nanos(now - statted_at), Ordering::Relaxed);
        }
        let duration = now - started;
        if duration >= SLOW_ENTRY_NAME_AFTER {
            let mut slowest = lock(&state.slowest);
            if slowest.is_none_or(|(current, _)| duration > current) {
                *slowest = Some((duration, self.index));
            }
        }
    }
}

/// Called once with the final snapshot when a traced load settles.
pub(crate) type SettleHook = fn(&str, &NativeSnapshot);

/// Owns one traced load's registry entry and settles its outcome. Dropping an
/// unsettled scope (a dropped command future) records `Cancelled`.
pub(crate) struct TraceScope {
    handle: TraceHandle,
    settled: bool,
    on_settle: Option<SettleHook>,
}

impl TraceScope {
    /// Register a traced load. An absent or malformed ID, a duplicate ID, or a
    /// full registry yields an untraced scope rather than failing the listing.
    pub fn begin(id: Option<String>, path: &str) -> Self {
        let untraced = Self {
            handle: TraceHandle::none(),
            settled: true,
            on_settle: None,
        };
        let Some(id) = id.filter(|id| valid_trace_id(id)) else {
            return untraced;
        };
        let state = Arc::new(TraceState::new(path));
        let mut registry = lock(&REGISTRY);
        if registry.in_flight.len() >= MAX_IN_FLIGHT || registry.in_flight.contains_key(&id) {
            return untraced;
        }
        registry.in_flight.insert(id.clone(), Arc::clone(&state));
        Self {
            handle: TraceHandle(Some((Arc::from(id), state))),
            settled: false,
            on_settle: None,
        }
    }

    /// Run `hook` with the final snapshot once this load settles, after the
    /// trace has left the in-flight registry.
    pub fn on_settle(mut self, hook: SettleHook) -> Self {
        self.on_settle = Some(hook);
        self
    }

    pub fn handle(&self) -> TraceHandle {
        self.handle.clone()
    }

    pub fn finish<T, E>(mut self, result: &Result<T, E>) {
        self.settle(if result.is_ok() {
            Outcome::Ok
        } else {
            Outcome::Error
        });
    }

    fn settle(&mut self, outcome: Outcome) {
        if self.settled {
            return;
        }
        self.settled = true;
        let Some((id, state)) = &self.handle.0 else {
            return;
        };
        lock(&state.timeline).close(state.started.elapsed());
        *lock(&state.outcome) = outcome;
        let snapshot = state.snapshot();
        {
            let mut registry = lock(&REGISTRY);
            registry.in_flight.remove(id.as_ref());
            if registry.finished.len() >= MAX_FINISHED {
                registry.finished.pop_front();
            }
            registry
                .finished
                .push_back((id.to_string(), snapshot.clone()));
        }
        if let Some(hook) = self.on_settle {
            hook(id, &snapshot);
        }
    }
}

impl Drop for TraceScope {
    fn drop(&mut self) {
        self.settle(Outcome::Cancelled);
    }
}

/// Snapshot an in-flight or recently finished trace.
pub(crate) fn snapshot(id: &str) -> Option<NativeSnapshot> {
    let state = {
        let registry = lock(&REGISTRY);
        if let Some(state) = registry.in_flight.get(id) {
            Some(Arc::clone(state))
        } else {
            return registry
                .finished
                .iter()
                .rev()
                .find(|(finished, _)| finished == id)
                .map(|(_, snapshot)| snapshot.clone());
        }
    };
    state.map(|state| state.snapshot())
}

#[cfg(test)]
pub(crate) fn is_in_flight(id: &str) -> bool {
    lock(&REGISTRY).in_flight.contains_key(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    fn unique_id(suffix: &str) -> String {
        format!("1700000000000-{suffix}")
    }

    #[test]
    fn timeline_keeps_one_open_span_and_reports_it_pending() {
        let mut timeline = Timeline::default();
        timeline.enter(Phase::WatchLock, ms(0));
        timeline.enter(Phase::ReadDir, ms(40));
        let snapshot = timeline.snapshot(ms(7_040));
        assert_eq!(timeline.pending(), Some(Phase::ReadDir));
        assert_eq!(
            snapshot,
            vec![
                PhaseSnapshot {
                    phase: Phase::WatchLock,
                    start_ms: 0,
                    duration_ms: 40,
                    pending: false
                },
                PhaseSnapshot {
                    phase: Phase::ReadDir,
                    start_ms: 40,
                    duration_ms: 7_000,
                    pending: true
                },
            ]
        );
        timeline.close(ms(7_100));
        assert_eq!(timeline.pending(), None);
        assert_eq!(timeline.snapshot(ms(9_999))[1].duration_ms, 7_060);
    }

    #[test]
    fn timeline_is_bounded() {
        let mut timeline = Timeline::default();
        for step in 0..(MAX_SPANS as u64 + 10) {
            timeline.enter(Phase::Sort, ms(step));
        }
        assert_eq!(timeline.snapshot(ms(100)).len(), MAX_SPANS);
        assert_eq!(timeline.dropped, 10);
    }

    #[test]
    fn trace_ids_must_be_safe_chronological_names() {
        assert!(valid_trace_id("1700000000000-a1b2"));
        for invalid in [
            "",
            "1700000000000",
            "170000000000-a",
            "1700000000000-",
            "1700000000000-ABC",
            "1700000000000-../x",
            "../../etc/passwd",
            "1700000000000-aaaaaaaaaaaaaaaaa",
        ] {
            assert!(!valid_trace_id(invalid), "{invalid:?}");
        }
    }

    #[test]
    fn untraced_scope_records_nothing_and_costs_no_registry_entry() {
        let scope = TraceScope::begin(None, "/tmp");
        let handle = scope.handle();
        assert!(handle.id().is_none());
        handle.enter(Phase::ReadDir);
        let mut probe = handle.entry(0);
        probe.statted(true);
        drop(probe);
        let malformed = TraceScope::begin(Some("../x".into()), "/tmp");
        assert!(malformed.handle().id().is_none());
    }

    #[test]
    fn pending_snapshot_names_the_stuck_phase_and_entry_progress() {
        let id = unique_id("pending1");
        let scope = TraceScope::begin(Some(id.clone()), "/mnt/remote");
        let handle = scope.handle();
        handle.enter(Phase::RootMetadata);
        handle.enter(Phase::ReadDir);
        let names: Arc<[PathBuf]> = vec![
            PathBuf::from("/mnt/remote/a"),
            PathBuf::from("/mnt/remote/b"),
        ]
        .into();
        handle.listed(&names);
        handle.enter(Phase::EntryMetadata);
        drop(handle.entry(0));

        let snapshot = snapshot(&id).expect("in-flight snapshot");
        assert!(is_in_flight(&id));
        assert_eq!(snapshot.outcome, Outcome::Pending);
        assert_eq!(snapshot.pending_phase, Some(Phase::EntryMetadata));
        assert_eq!(snapshot.entries_listed, 2);
        assert_eq!(snapshot.entries_statted, 0, "no lstat has returned");
        assert_eq!(snapshot.entries_done, 1);
        assert_eq!(snapshot.path, "/mnt/remote");
        drop(scope);
    }

    #[test]
    fn a_stalled_entry_is_named_while_its_stat_is_pending() {
        let id = unique_id("stalled1");
        let scope = TraceScope::begin(Some(id.clone()), "/mnt/remote");
        let handle = scope.handle();
        let names: Arc<[PathBuf]> = vec![PathBuf::from("/mnt/remote/hung-link")].into();
        handle.listed(&names);
        handle.enter(Phase::EntryMetadata);
        let mut probe = handle.entry(0);
        probe.statted(true);
        std::thread::sleep(STALLED_ENTRY_AFTER + ms(20));
        let snapshot = snapshot(&id).unwrap();
        // Its lstat returned; the symlink-target resolution is what hangs.
        assert_eq!((snapshot.entries_statted, snapshot.entries_done), (1, 0));
        assert_eq!(snapshot.stalled_entries.len(), 1);
        assert_eq!(snapshot.stalled_entries[0].name, "hung-link");
        assert!(snapshot.stalled_entries[0].elapsed_ms >= 1_000);
        drop(probe);
        let settled = super::snapshot(&id).unwrap();
        assert!(settled.stalled_entries.is_empty());
        assert_eq!(settled.slowest_entry.unwrap().name, "hung-link");
        drop(scope);
    }

    #[test]
    fn finishing_moves_the_trace_to_the_finished_ring_with_its_outcome() {
        let id = unique_id("finish1");
        let scope = TraceScope::begin(Some(id.clone()), "/tmp");
        scope.handle().enter(Phase::Sort);
        scope.finish(&Ok::<(), ()>(()));
        assert!(!is_in_flight(&id));
        let snapshot = snapshot(&id).unwrap();
        assert_eq!(snapshot.outcome, Outcome::Ok);
        assert_eq!(snapshot.pending_phase, None);
        assert!(snapshot.phases.iter().all(|phase| !phase.pending));

        let cancelled = unique_id("cancel1");
        drop(TraceScope::begin(Some(cancelled.clone()), "/tmp"));
        assert_eq!(
            super::snapshot(&cancelled).unwrap().outcome,
            Outcome::Cancelled
        );
    }

    #[test]
    fn a_duplicate_in_flight_id_is_not_traced_twice() {
        let id = unique_id("dup1");
        let first = TraceScope::begin(Some(id.clone()), "/a");
        let second = TraceScope::begin(Some(id.clone()), "/b");
        assert!(first.handle().id().is_some());
        assert!(second.handle().id().is_none());
        drop(second);
        assert!(is_in_flight(&id));
        drop(first);
    }

    #[test]
    fn entry_progress_is_counted_across_rayon_workers() {
        use rayon::prelude::*;
        let id = unique_id("rayon1");
        let scope = TraceScope::begin(Some(id.clone()), "/big");
        let handle = scope.handle();
        let count = 20_000;
        let names: Arc<[PathBuf]> = (0..count)
            .map(|n| PathBuf::from(format!("/big/{n}")))
            .collect::<Vec<_>>()
            .into();
        handle.listed(&names);
        (0..count).into_par_iter().for_each(|index| {
            let mut probe = handle.entry(index);
            if index % 500 == 1 {
                probe.stat_failed();
            } else {
                probe.statted(index % 1000 == 0);
            }
        });
        let snapshot = snapshot(&id).unwrap();
        assert_eq!(snapshot.entries_listed, count);
        assert_eq!(snapshot.entries_statted, count);
        assert_eq!(snapshot.stat_failures, 40);
        assert_eq!(snapshot.entries_done, count);
        assert_eq!(snapshot.symlinks, 20);
        assert!(snapshot.stalled_entries.is_empty());
        drop(scope);
    }
}
