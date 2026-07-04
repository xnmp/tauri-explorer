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
//! registry tracks claimed labels in `activated`. A claimed window counts as
//! real from the moment of the claim (destroying it on last-real-window-closed
//! was the bug that killed the user's freshly Ctrl+N'd window and exited the
//! app).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// Label prefix identifying warm-pool windows (see warm-window.ts).
pub const WARM_LABEL_PREFIX: &str = "explorer-warm-";

const TARGET_POOL_SIZE: usize = 1;
const SPAWN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct PoolState {
    /// Labels of parked warm windows that completed the ready handshake.
    ready: Vec<String>,
    /// Labels claimed via `claim` — real user-facing windows despite the
    /// warm label. Entries leave this set only when the window is destroyed.
    activated: Vec<String>,
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
    /// been destroyed since it registered); dead labels are discarded. The
    /// claimed label is marked activated: it is a real window from this
    /// moment, even though it is not visible for another few milliseconds.
    fn claim(&mut self, is_alive: impl Fn(&str) -> bool) -> Option<String> {
        while let Some(label) = self.ready.pop() {
            if is_alive(&label) {
                self.activated.push(label.clone());
                return Some(label);
            }
        }
        None
    }

    /// Whether `label` is a real, user-facing window: anything not warm, or a
    /// warm window that has been claimed.
    fn is_real(&self, label: &str) -> bool {
        !label.starts_with(WARM_LABEL_PREFIX) || self.activated.iter().any(|l| l == label)
    }

    /// Drop `label` from all pool sets. Returns whether it counted as a real
    /// window at the time it was destroyed.
    fn forget(&mut self, label: &str) -> bool {
        let was_real = self.is_real(label);
        self.ready.retain(|l| l != label);
        self.activated.retain(|l| l != label);
        was_real
    }

    /// Take every parked (ready) label out of the pool, e.g. to shut it down.
    fn drain_ready(&mut self) -> Vec<String> {
        std::mem::take(&mut self.ready)
    }
}

static POOL: Mutex<PoolState> = Mutex::new(PoolState {
    ready: Vec::new(),
    activated: Vec::new(),
    spawns_in_flight: Vec::new(),
});

/// Reserve a spawn slot. Returns false when the pool (ready + in-flight) is
/// already at target size — the caller must not create a warm window then.
#[tauri::command]
pub async fn warm_pool_begin_spawn() -> bool {
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .try_reserve_spawn(Instant::now())
}

/// Release a reservation after a failed spawn (webview creation error).
#[tauri::command]
pub async fn warm_pool_cancel_spawn() {
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .release_spawn();
}

/// Called by the warm window itself once its activate-listener is registered.
///
/// If no real window is left by the time the handshake completes (the spawner
/// closed while this window was booting), the warm window is destroyed instead
/// of registered: an unclaimable hidden window would keep the process alive
/// forever with nothing on screen.
#[tauri::command]
pub async fn warm_pool_register(app: AppHandle, label: String) {
    {
        let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
        let any_real_left = app.webview_windows().keys().any(|l| pool.is_real(l));
        if any_real_left {
            pool.register(label);
            return;
        }
        pool.release_spawn();
    }
    log::info!("Destroying warm window {label} (no real window left to serve)");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.destroy();
    }
}

/// Atomically claim a ready warm window, if any. The claimer owns the label
/// exclusively; no other window can receive it. The claimed window counts as
/// a real window from here on.
#[tauri::command]
pub async fn warm_pool_claim(app: AppHandle) -> Option<String> {
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .claim(|label| app.get_webview_window(label).is_some())
}

/// Destroy a claimed warm window whose activation failed (the caller opens a
/// fresh window instead). Without this the claimed-but-never-shown window
/// would linger hidden while counting as real — keeping the app alive forever.
#[tauri::command]
pub async fn warm_pool_discard(app: AppHandle, label: String) {
    POOL.lock()
        .unwrap_or_else(|e| e.into_inner())
        .forget(&label);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.destroy();
    }
}

/// Close all parked warm windows and empty the pool (settings.warmWindow was
/// turned off). Activated windows are untouched — they are the user's.
#[tauri::command]
pub async fn warm_pool_shutdown(app: AppHandle) {
    let parked = POOL.lock().unwrap_or_else(|e| e.into_inner()).drain_ready();
    for label in parked {
        log::info!("Closing parked warm window {label} (pool disabled)");
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

/// Run-loop hook for every window Destroyed event. Drops the label from the
/// pool, and — when the destroyed window was the last REAL one (non-warm or
/// activated) — closes the remaining parked warm windows so the normal
/// all-windows-closed exit fires instead of a hidden window pinning the app.
pub fn on_window_destroyed(app: &AppHandle, destroyed_label: &str) {
    let windows = app.webview_windows();
    {
        let mut pool = POOL.lock().unwrap_or_else(|e| e.into_inner());
        let was_real = pool.forget(destroyed_label);
        if !was_real {
            return;
        }
        let any_real_left = windows.keys().any(|label| pool.is_real(label));
        if any_real_left {
            return;
        }
    } // release the lock: destroy() below re-enters this hook synchronously

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
    fn forget_drops_only_matching_label() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        s.forget("explorer-warm-1");
        assert_eq!(s.claim(|_| true), None);
    }

    // — activated-window lifecycle (the "Ctrl+N window destroyed when the
    //   original closes" regression) —

    #[test]
    fn claimed_window_counts_as_real() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        assert!(!s.is_real("explorer-warm-1"), "parked warm is not real");
        s.claim(|_| true);
        assert!(s.is_real("explorer-warm-1"), "claimed warm IS real");
        assert!(s.is_real("explorer-123"), "non-warm labels are always real");
    }

    #[test]
    fn destroying_parked_warm_window_is_not_a_real_close() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        assert!(!s.forget("explorer-warm-1"));
    }

    #[test]
    fn destroying_activated_warm_window_is_a_real_close() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        s.claim(|_| true);
        assert!(s.forget("explorer-warm-1"));
        assert!(
            !s.is_real("explorer-warm-1"),
            "forgotten label must lose real status"
        );
    }

    #[test]
    fn discarded_claim_loses_real_status() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        s.claim(|_| true);
        s.forget("explorer-warm-1"); // discard path after failed activation
        assert!(!s.is_real("explorer-warm-1"));
    }

    #[test]
    fn drain_ready_leaves_activated_untouched() {
        let mut s = state();
        s.register("explorer-warm-1".into());
        s.claim(|_| true);
        s.register("explorer-warm-2".into());
        assert_eq!(s.drain_ready(), vec!["explorer-warm-2".to_string()]);
        assert!(s.is_real("explorer-warm-1"), "activated survives shutdown");
        assert_eq!(s.claim(|_| true), None);
    }
}
