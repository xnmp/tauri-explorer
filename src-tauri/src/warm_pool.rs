//! Global registry for pre-warmed hidden windows (settings.warmWindow).
//!
//! The pool must be global to the app, not per-webview: any window may claim
//! the warm window on Ctrl+N, and any window may spawn the replacement. Keeping
//! this state in JS module scope (the first iteration) meant each webview had
//! its own private "pool", so only the window that spawned a warm window could
//! ever use it. Rust owns the single source of truth; claims are atomic under
//! one mutex, so two windows racing Ctrl+N can never both activate the same
//! warm window.
//!
//! Spawn accounting: `begin_spawn` reserves a slot before the webview is
//! created so concurrent windows don't all spawn replacements at once. A
//! reservation expires after `SPAWN_TIMEOUT` in case the spawning window died
//! before `register`/`cancel` — otherwise a leaked reservation would pin the
//! pool empty forever.
//!
//! LIFECYCLE: a warm window keeps its `explorer-warm-` label for its whole
//! life, including after activation — Tauri labels are immutable. So "is this
//! window a real, user-facing window?" cannot be answered by label alone: the
//! registry tracks temporary claims separately from committed `activated` labels.
//! A bounded claim counts as real while activation finishes (destroying it on last-real-window-closed
//! was the bug that killed the user's freshly Ctrl+N'd window and exited the
//! app).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub const WARM_LABEL_PREFIX: &str = "explorer-warm-";
const TARGET_POOL_SIZE: usize = 1;
const SPAWN_TIMEOUT: Duration = Duration::from_secs(30);
const CLAIM_TIMEOUT: Duration = Duration::from_secs(30);

/// The live phase of a tracked warm window. Phases are mutually exclusive:
/// every transition into one requires leaving the previous one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Reserved; the webview is booting. Labels are unique reservation
    /// identities, retained through native boot.
    Spawning {
        since: Instant,
    },
    /// Registered and claimable. `seq` preserves LIFO claim order.
    Ready {
        seq: u64,
    },
    /// A claim temporarily keeps the app alive, but must commit after reveal.
    Claimed {
        since: Instant,
    },
    Activated,
}

/// Per-label record. `retiring` is deliberately a flag, not a `Stage`: it is
/// set by `retire_window` when native destruction fails, on a label in ANY
/// phase (or none), and the phase keeps evolving independently of it.
#[derive(Clone, Copy, Debug)]
struct Entry {
    stage: Option<Stage>,
    retiring: bool,
}

/// Invariant: no entry has `stage == None && !retiring` (it is removed).
#[derive(Default)]
struct PoolState {
    entries: HashMap<String, Entry>,
    next_seq: u64,
}

impl PoolState {
    fn stage(&self, label: &str) -> Option<Stage> {
        self.entries.get(label).and_then(|entry| entry.stage)
    }

    fn set_stage(&mut self, label: &str, stage: Option<Stage>) {
        match self.entries.get_mut(label) {
            Some(entry) if entry.retiring || stage.is_some() => entry.stage = stage,
            Some(_) => {
                self.entries.remove(label);
            }
            None => {
                if stage.is_some() {
                    self.entries.insert(
                        label.to_owned(),
                        Entry {
                            stage,
                            retiring: false,
                        },
                    );
                }
            }
        }
    }

    /// Spawning + Ready entries: the pool slots counted against the target.
    fn slots_in_use(&self) -> usize {
        self.entries
            .values()
            .filter(|entry| {
                matches!(
                    entry.stage,
                    Some(Stage::Spawning { .. } | Stage::Ready { .. })
                )
            })
            .count()
    }

    fn try_reserve_spawn(&mut self, label: String, now: Instant) -> bool {
        if self.slots_in_use() >= TARGET_POOL_SIZE || self.owns(&label) {
            return false;
        }
        self.set_stage(&label, Some(Stage::Spawning { since: now }));
        true
    }

    fn expire_spawn(&mut self, label: &str, started: Instant) -> bool {
        if self.stage(label) != Some(Stage::Spawning { since: started }) {
            return false;
        }
        self.set_stage(label, None);
        self.mark_retiring(label);
        true
    }

    fn release_spawn(&mut self, label: &str) {
        if self.is_spawning(label) {
            self.set_stage(label, None);
        }
    }

    fn is_spawning(&self, label: &str) -> bool {
        matches!(self.stage(label), Some(Stage::Spawning { .. }))
    }

    /// Ready, claimed or activated: a live owner that a duplicate handshake
    /// must not re-pool or destroy.
    fn holds_live_window(&self, label: &str) -> bool {
        matches!(
            self.stage(label),
            Some(Stage::Ready { .. } | Stage::Claimed { .. } | Stage::Activated)
        )
    }

    /// Record a failed native retirement. Valid in any phase.
    fn mark_retiring(&mut self, label: &str) {
        self.entries
            .entry(label.to_owned())
            .and_modify(|entry| entry.retiring = true)
            .or_insert(Entry {
                stage: None,
                retiring: true,
            });
    }

    /// Withdraw from claim admission; no-op unless currently ready.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn withdraw_ready(&mut self, label: &str) {
        if matches!(self.stage(label), Some(Stage::Ready { .. })) {
            self.set_stage(label, None);
        }
    }

    fn owns(&self, label: &str) -> bool {
        self.entries.contains_key(label)
    }

    fn register(&mut self, label: String, now: Instant) -> bool {
        let Some(Stage::Spawning { since: started }) = self.stage(&label) else {
            return false;
        };
        // The reservation is consumed even when registration is rejected.
        self.set_stage(&label, None);
        if now.duration_since(started) >= SPAWN_TIMEOUT || self.owns(&label) {
            return false;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.set_stage(&label, Some(Stage::Ready { seq }));
        true
    }

    fn claim(&mut self, now: Instant, is_alive: impl Fn(&str) -> bool) -> Option<String> {
        // Newest ready window first, discarding dead ones as they are met.
        let mut ready: Vec<(u64, String)> = self
            .entries
            .iter()
            .filter_map(|(label, entry)| match entry.stage {
                Some(Stage::Ready { seq }) => Some((seq, label.clone())),
                _ => None,
            })
            .collect();
        ready.sort_by_key(|entry| std::cmp::Reverse(entry.0));
        for (_, label) in ready {
            if is_alive(&label) {
                self.set_stage(&label, Some(Stage::Claimed { since: now }));
                return Some(label);
            }
            self.set_stage(&label, None);
        }
        None
    }

    fn activate(&mut self, label: &str, now: Instant) -> bool {
        let Some(Stage::Claimed { since: started }) = self.stage(label) else {
            return false;
        };
        if now.duration_since(started) >= CLAIM_TIMEOUT {
            // Reject commitment without revoking the watchdog's authority to
            // retire the native window, even if this caller never resumes.
            return false;
        }
        self.set_stage(label, Some(Stage::Activated));
        true
    }

    fn expire_claim(&mut self, label: &str, started: Instant) -> bool {
        if self.stage(label) != Some(Stage::Claimed { since: started }) {
            return false;
        }
        self.set_stage(label, None);
        self.mark_retiring(label);
        true
    }

    fn is_real(&self, label: &str) -> bool {
        !label.starts_with(WARM_LABEL_PREFIX)
            || matches!(
                self.stage(label),
                Some(Stage::Activated | Stage::Claimed { .. })
            )
    }

    /// Not yet a committed user-facing window: ready, booting, retiring, or
    /// claimed with activation still unacknowledged (#942).
    #[cfg(any(target_os = "macos", target_os = "linux", test))]
    fn parked(&self, label: &str) -> bool {
        label.starts_with(WARM_LABEL_PREFIX) && self.stage(label) != Some(Stage::Activated)
    }

    fn forget(&mut self, label: &str) -> bool {
        let was_real = self.is_real(label);
        self.entries.remove(label);
        was_real
    }

    /// Ready (oldest first), then booting, then retiring labels. A label that
    /// is both ready/booting and retiring is listed in both groups.
    fn drain_parked(&mut self) -> Vec<String> {
        let mut ready: Vec<(u64, String)> = Vec::new();
        let mut labels: Vec<String> = Vec::new();
        let mut retiring: Vec<String> = Vec::new();
        for (label, entry) in &self.entries {
            match entry.stage {
                Some(Stage::Ready { seq }) => ready.push((seq, label.clone())),
                Some(Stage::Spawning { .. }) => labels.push(label.clone()),
                _ => {}
            }
            if entry.retiring {
                retiring.push(label.clone());
            }
        }
        ready.sort_by_key(|(seq, _)| *seq);
        let mut drained: Vec<String> = ready.into_iter().map(|(_, label)| label).collect();
        drained.extend(labels);
        drained.extend(retiring);
        self.entries.retain(|_, entry| {
            if matches!(
                entry.stage,
                Some(Stage::Ready { .. } | Stage::Spawning { .. })
            ) {
                entry.stage = None;
            }
            entry.retiring = false;
            entry.stage.is_some()
        });
        drained
    }
}

static POOL: std::sync::LazyLock<Mutex<PoolState>> = std::sync::LazyLock::new(Mutex::default);

/// Reserve exactly this future native label. Late callbacks cannot release a successor.
#[tauri::command]
pub async fn warm_pool_begin_spawn(app: AppHandle, label: String) -> bool {
    if !label.starts_with(WARM_LABEL_PREFIX) || label.len() > 128 {
        return false;
    }
    let started = Instant::now();
    if !POOL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .try_reserve_spawn(label.clone(), started)
    {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SPAWN_TIMEOUT).await;
        let expired = POOL
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .expire_spawn(&label, started);
        if expired {
            retire_window(&app, &label);
        }
    });
    true
}

#[tauri::command]
pub async fn warm_pool_cancel_spawn(app: AppHandle, label: String) {
    if !label.starts_with(WARM_LABEL_PREFIX) {
        return;
    }
    let pending = {
        let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
        let pending = pool.is_spawning(&label);
        pool.release_spawn(&label);
        pending
    };
    if pending {
        retire_window(&app, &label);
    }
}

/// Only the window that owns an admitted reservation can become ready.
#[tauri::command]
pub async fn warm_pool_register(
    app: AppHandle,
    window: tauri::WebviewWindow,
    label: String,
) -> bool {
    if window.label() != label || !label.starts_with(WARM_LABEL_PREFIX) {
        return false;
    }
    {
        let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
        let any_real_left = app
            .webview_windows()
            .keys()
            .any(|entry| pool.is_real(entry));
        if any_real_left && pool.register(label.clone(), Instant::now()) {
            return true;
        }
        // A duplicate handshake is idempotent; never re-pool or destroy a live owner.
        if pool.holds_live_window(&label) {
            return true;
        }
        pool.release_spawn(&label);
    }
    retire_window(&app, &label);
    false
}

/// Claims expire if their requesting webview dies before dispatch/reveal.
#[tauri::command]
pub async fn warm_pool_claim(app: AppHandle) -> Option<String> {
    let started = Instant::now();
    let label = POOL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .claim(started, |label| app.get_webview_window(label).is_some())?;
    let expiring = label.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLAIM_TIMEOUT).await;
        let expired = POOL
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .expire_claim(&expiring, started);
        if expired {
            retire_window(&app, &expiring);
        }
    });
    Some(label)
}

/// The receiver commits only after successfully revealing and navigating.
#[tauri::command]
pub async fn warm_pool_activate(window: tauri::WebviewWindow, label: String) -> bool {
    if window.label() != label {
        return false;
    }
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .activate(&label, Instant::now())
}

#[tauri::command]
pub async fn warm_pool_discard(app: AppHandle, label: String) {
    if !label.starts_with(WARM_LABEL_PREFIX) {
        return;
    }
    retire_window(&app, &label);
}

#[tauri::command]
pub async fn warm_pool_shutdown(app: AppHandle) {
    let parked = POOL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain_parked();
    for label in parked {
        retire_window(&app, &label);
    }
}

pub fn on_window_destroyed(app: &AppHandle, destroyed_label: &str) {
    let parked = {
        let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
        pool.forget(destroyed_label);
        let windows = app.webview_windows();
        if windows
            .keys()
            .any(|label| label != destroyed_label && pool.is_real(label))
        {
            return;
        }
        // Revoke claim admission while locked, before destruction can yield.
        let mut parked: HashSet<_> = pool.drain_parked().into_iter().collect();
        // Native inventory also owns booting windows whose JS never registered,
        // including construction that completed after reservation retirement.
        parked.extend(
            windows
                .keys()
                .filter(|label| label.as_str() != destroyed_label)
                .cloned(),
        );
        parked
    };
    for label in parked {
        retire_window(app, &label);
    }
}

/// Whether a window that lost its renderer should be retired, not reloaded.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn is_parked(label: &str) -> bool {
    POOL.lock().unwrap_or_else(|e| e.into_inner()).parked(label)
}

/// Withdraw a parked window from claim admission before destroying it, so no
/// claim can pick a window whose page is gone. A claim already in flight
/// fails its acknowledgement and falls back to a fresh window.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn retire_parked(app: &AppHandle, label: &str) {
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .withdraw_ready(label);
    retire_window(app, label);
}

fn retire_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.destroy() {
            // Destruction is verified by its native event, never inferred from
            // an attempted IPC. Retain failed retirement for later cleanup.
            POOL.lock()
                .unwrap_or_else(|e| e.into_inner())
                .mark_retiring(label);
            log::error!("Could not retire warm window {label}: {error}");
        }
    } else {
        on_window_destroyed(app, label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> PoolState {
        PoolState::default()
    }

    fn ready(s: &mut PoolState, label: &str) {
        let now = Instant::now();
        assert!(s.try_reserve_spawn(label.into(), now));
        assert!(s.register(label.into(), now));
    }

    #[test]
    fn reserve_caps_at_target_size() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn("explorer-warm-1".into(), now));
        assert!(
            !s.try_reserve_spawn("explorer-warm-1".into(), now),
            "second reservation must fail"
        );
    }

    #[test]
    fn ready_window_blocks_new_reservations() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        assert!(!s.try_reserve_spawn("explorer-warm-1".into(), Instant::now()));
    }

    #[test]
    fn register_converts_reservation_to_ready() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn("explorer-warm-1".into(), now));
        assert!(s.register("explorer-warm-1".into(), now));
        assert!(!s.is_spawning("explorer-warm-1"));
        assert_eq!(
            s.claim(Instant::now(), |_| true),
            Some("explorer-warm-1".into())
        );
    }

    #[test]
    fn cancel_frees_the_slot() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn("explorer-warm-1".into(), now));
        s.release_spawn("explorer-warm-1");
        assert!(s.try_reserve_spawn("explorer-warm-1".into(), now));
    }

    #[test]
    fn claim_is_exclusive_and_empties_pool() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        assert_eq!(
            s.claim(Instant::now(), |_| true),
            Some("explorer-warm-1".into())
        );
        assert_eq!(
            s.claim(Instant::now(), |_| true),
            None,
            "second claim must miss"
        );
    }

    #[test]
    fn claim_skips_dead_windows() {
        let mut s = state();
        ready(&mut s, "explorer-warm-dead");
        assert_eq!(s.claim(Instant::now(), |_| false), None);
        assert!(
            !s.owns("explorer-warm-dead"),
            "dead label must be discarded"
        );
    }

    #[test]
    fn stale_reservation_expires() {
        let mut s = state();
        let past = Instant::now()
            .checked_sub(SPAWN_TIMEOUT + Duration::from_secs(1))
            .expect("clock underflow");
        s.set_stage("explorer-warm-old", Some(Stage::Spawning { since: past }));
        assert!(s.expire_spawn("explorer-warm-old", past));
        assert!(
            s.try_reserve_spawn("explorer-warm-1".into(), Instant::now()),
            "expired reservation must not block a new spawn"
        );
    }

    #[test]
    fn forget_drops_only_matching_label() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        s.forget("explorer-warm-1");
        assert_eq!(s.claim(Instant::now(), |_| true), None);
    }

    // — activated-window lifecycle (the "Ctrl+N window destroyed when the
    //   original closes" regression) —

    #[test]
    fn claimed_window_counts_as_real() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        assert!(!s.is_real("explorer-warm-1"), "parked warm is not real");
        s.claim(Instant::now(), |_| true);
        assert!(s.is_real("explorer-warm-1"), "claimed warm IS real");
        assert!(s.is_real("explorer-123"), "non-warm labels are always real");
    }

    #[test]
    fn destroying_parked_warm_window_is_not_a_real_close() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        assert!(!s.forget("explorer-warm-1"));
    }

    #[test]
    fn destroying_activated_warm_window_is_a_real_close() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        s.claim(Instant::now(), |_| true);
        assert!(s.forget("explorer-warm-1"));
        assert!(
            !s.is_real("explorer-warm-1"),
            "forgotten label must lose real status"
        );
    }

    #[test]
    fn discarded_claim_loses_real_status() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        s.claim(Instant::now(), |_| true);
        s.forget("explorer-warm-1"); // discard path after failed activation
        assert!(!s.is_real("explorer-warm-1"));
    }

    #[test]
    fn drain_ready_leaves_activated_untouched() {
        let mut s = state();
        ready(&mut s, "explorer-warm-1");
        s.claim(Instant::now(), |_| true);
        ready(&mut s, "explorer-warm-2");
        assert_eq!(s.drain_parked(), vec!["explorer-warm-2".to_string()]);
        assert!(s.is_real("explorer-warm-1"), "activated survives shutdown");
        assert_eq!(s.claim(Instant::now(), |_| true), None);
    }
    #[test]
    fn stale_cancel_and_registration_cannot_consume_new_reservation() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn("explorer-warm-old".into(), now));
        assert!(s.expire_spawn("explorer-warm-old", now));
        assert!(s.try_reserve_spawn("explorer-warm-new".into(), now + SPAWN_TIMEOUT));
        s.release_spawn("explorer-warm-old");
        assert!(!s.register("explorer-warm-old".into(), now + SPAWN_TIMEOUT));
        assert!(!s.try_reserve_spawn("explorer-warm-third".into(), now + SPAWN_TIMEOUT));
        assert!(s.register("explorer-warm-new".into(), now + SPAWN_TIMEOUT));
        assert_eq!(s.claim(now, |_| true).as_deref(), Some("explorer-warm-new"));
    }

    #[test]
    fn shutdown_rejects_late_boot_but_allows_future_reservations() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn("explorer-warm-old".into(), now));
        assert_eq!(s.drain_parked(), vec!["explorer-warm-old"]);
        assert!(!s.register("explorer-warm-old".into(), now));
        assert!(s.claim(now, |_| true).is_none());
        assert!(s.try_reserve_spawn("explorer-warm-new".into(), now));
    }

    #[test]
    fn registration_cannot_repool_a_claimed_or_activated_window() {
        let mut s = state();
        let now = Instant::now();
        ready(&mut s, "explorer-warm-one");
        s.claim(Instant::now(), |_| true);
        assert!(!s.register("explorer-warm-one".into(), Instant::now()));
        assert!(s.activate("explorer-warm-one", now));
        assert!(!s.register("explorer-warm-one".into(), Instant::now()));
        assert!(s.claim(Instant::now(), |_| true).is_none());
    }

    #[test]
    fn abandoned_claim_expires_but_committed_activation_survives() {
        let mut s = state();
        let now = Instant::now();
        ready(&mut s, "explorer-warm-one");
        s.claim(now, |_| true);
        assert!(!s.expire_claim("explorer-warm-one", now + CLAIM_TIMEOUT));
        assert!(s.expire_claim("explorer-warm-one", now));
        assert!(!s.is_real("explorer-warm-one"));
        assert!(!s.activate("explorer-warm-one", now));
        ready(&mut s, "explorer-warm-two");
        s.claim(now, |_| true);
        assert!(s.activate("explorer-warm-two", now));
        assert!(!s.expire_claim("explorer-warm-two", now));
        assert!(s.is_real("explorer-warm-two"));
    }
    #[test]
    fn expired_boot_retains_native_retirement_ownership() {
        let mut pool = PoolState::default();
        let now = Instant::now();
        assert!(pool.try_reserve_spawn("explorer-warm-a".into(), now));
        assert!(pool.expire_spawn("explorer-warm-a", now));
        assert!(pool.try_reserve_spawn("explorer-warm-b".into(), now + SPAWN_TIMEOUT));
        let retired = pool.drain_parked();
        assert!(retired.contains(&"explorer-warm-a".to_owned()));
    }
    #[test]
    fn late_activation_cannot_commit_before_a_delayed_expiry_callback() {
        let mut s = state();
        let now = Instant::now();
        ready(&mut s, "explorer-warm-delayed");
        s.claim(now, |_| true);
        assert!(!s.activate("explorer-warm-delayed", now + CLAIM_TIMEOUT));
        assert!(
            s.expire_claim("explorer-warm-delayed", now),
            "watchdog must still request native retirement"
        );
        assert!(!s.is_real("explorer-warm-delayed"));
        assert!(s
            .drain_parked()
            .contains(&"explorer-warm-delayed".to_owned()));
    }
    #[test]
    fn only_committed_activation_makes_a_warm_window_reloadable() {
        let mut s = state();
        let now = Instant::now();
        assert!(!s.parked("main"), "ordinary windows are always recovered");
        assert!(!s.parked("explorer-child-1"));
        let mut booting = state();
        assert!(booting.try_reserve_spawn("explorer-warm-boot".into(), now));
        assert!(booting.parked("explorer-warm-boot"), "booting");
        ready(&mut s, "explorer-warm-live");
        assert!(s.parked("explorer-warm-live"), "ready in the pool");
        assert_eq!(
            s.claim(now, |_| true).as_deref(),
            Some("explorer-warm-live")
        );
        assert!(
            s.parked("explorer-warm-live"),
            "a claim without acknowledged activation falls back to a fresh window"
        );
        assert!(s.activate("explorer-warm-live", now));
        assert!(
            !s.parked("explorer-warm-live"),
            "activated windows are user-facing"
        );
        assert!(s.parked("explorer-warm-measure"), "never-registered probe");
    }
}

#[cfg(test)]
#[path = "../test_support/warm_pool_state_test.rs"]
mod state_contracts;
