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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Label prefix identifying parked warm windows (see warm-window.ts).
pub const WARM_LABEL_PREFIX: &str = "explorer-warm-";

const TARGET_POOL_SIZE: usize = 1;
const SPAWN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct PoolState {
    /// Labels of warm windows that completed the ready handshake.
    ready: Vec<String>,
    /// Reservation timestamps for spawns that haven't registered yet.
    spawns_in_flight: Vec<Instant>,
}

impl PoolState {
    fn prune_stale_spawns(&mut self, now: Instant) {
        self.spawns_in_flight
            .retain(|started| now.duration_since(*started) < SPAWN_TIMEOUT);
    }

    fn try_reserve_spawn(&mut self, now: Instant) -> bool {
        self.prune_stale_spawns(now);
        if self.ready.len() + self.spawns_in_flight.len() >= TARGET_POOL_SIZE {
            return false;
        }
        self.spawns_in_flight.push(now);
        true
    }

    fn release_spawn(&mut self) {
        self.spawns_in_flight.pop();
    }

    fn register(&mut self, label: String) {
        self.release_spawn();
        if !self.ready.contains(&label) {
            self.ready.push(label);
        }
    }

    /// Pop ready labels until one passes `is_alive` (a pooled window may have
    /// been destroyed since it registered); dead labels are discarded.
    fn claim(&mut self, is_alive: impl Fn(&str) -> bool) -> Option<String> {
        while let Some(label) = self.ready.pop() {
            if is_alive(&label) {
                return Some(label);
            }
        }
        None
    }

    fn remove(&mut self, label: &str) {
        self.ready.retain(|l| l != label);
    }
}

static POOL: Mutex<PoolState> = Mutex::new(PoolState {
    ready: Vec::new(),
    spawns_in_flight: Vec::new(),
});

/// Reserve a spawn slot. Returns false when the pool (ready + in-flight) is
/// already at target size — the caller must not create a warm window then.
#[tauri::command]
pub async fn warm_pool_begin_spawn() -> bool {
    POOL.lock().unwrap().try_reserve_spawn(Instant::now())
}

/// Release a reservation after a failed spawn (webview creation error).
#[tauri::command]
pub async fn warm_pool_cancel_spawn() {
    POOL.lock().unwrap().release_spawn();
}

/// Called by the warm window itself once its activate-listener is registered.
#[tauri::command]
pub async fn warm_pool_register(label: String) {
    POOL.lock().unwrap().register(label);
}

/// Atomically claim a ready warm window, if any. The claimer owns the label
/// exclusively; no other window can receive it.
#[tauri::command]
pub async fn warm_pool_claim(app: AppHandle) -> Option<String> {
    POOL.lock()
        .unwrap()
        .claim(|label| app.get_webview_window(label).is_some())
}

/// Drop a destroyed window's label from the pool (called from the run loop).
pub fn forget_window(label: &str) {
    POOL.lock().unwrap().remove(label);
}

/// A hidden warm window must never keep the app alive: once the last real
/// (non-warm) window is gone, close all parked warm windows so the normal
/// all-windows-closed exit fires. Called on every window Destroyed event.
pub fn close_warm_windows_if_last(app: &AppHandle, destroyed_label: &str) {
    if destroyed_label.starts_with(WARM_LABEL_PREFIX) {
        return;
    }
    let windows = app.webview_windows();
    let any_real_left = windows
        .keys()
        .any(|label| !label.starts_with(WARM_LABEL_PREFIX));
    if any_real_left {
        return;
    }
    for (label, window) in windows {
        log::info!("Closing parked warm window {label} (last real window closed)");
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> PoolState {
        PoolState::default()
    }

    #[test]
    fn reserve_caps_at_target_size() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn(now));
        assert!(!s.try_reserve_spawn(now), "second reservation must fail");
    }

    #[test]
    fn ready_window_blocks_new_reservations() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        assert!(!s.try_reserve_spawn(Instant::now()));
    }

    #[test]
    fn register_converts_reservation_to_ready() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn(now));
        s.register("explorer-warm-1".into());
        assert_eq!(s.spawns_in_flight.len(), 0);
        assert_eq!(s.claim(|_| true), Some("explorer-warm-1".into()));
    }

    #[test]
    fn cancel_frees_the_slot() {
        let mut s = state();
        let now = Instant::now();
        assert!(s.try_reserve_spawn(now));
        s.release_spawn();
        assert!(s.try_reserve_spawn(now));
    }

    #[test]
    fn claim_is_exclusive_and_empties_pool() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        assert_eq!(s.claim(|_| true), Some("explorer-warm-1".into()));
        assert_eq!(s.claim(|_| true), None, "second claim must miss");
    }

    #[test]
    fn claim_skips_dead_windows() {
        let mut s = state();
        s.register("explorer-warm-dead".into());
        assert_eq!(s.claim(|_| false), None);
        assert!(s.ready.is_empty(), "dead label must be discarded");
    }

    #[test]
    fn stale_reservation_expires() {
        let mut s = state();
        let past = Instant::now()
            .checked_sub(SPAWN_TIMEOUT + Duration::from_secs(1))
            .expect("clock underflow");
        s.spawns_in_flight.push(past);
        assert!(
            s.try_reserve_spawn(Instant::now()),
            "expired reservation must not block a new spawn"
        );
    }

    #[test]
    fn remove_drops_only_matching_label() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        s.remove("explorer-warm-1");
        assert_eq!(s.claim(|_| true), None);
    }
}
