//! Shared cancellable task registry.
//! Issue: tauri-5t7m
//!
//! Provides a thread-safe registry for managing background tasks that can be
//! cancelled. Used by directory listings, search, and content search to avoid
//! duplicating the same AtomicU64 + Mutex<HashMap> pattern.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// A registry that tracks active cancellable tasks by ID.
pub struct TaskRegistry {
    next_id: AtomicU64,
    state: OnceLock<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    active: HashMap<u64, Arc<AtomicBool>>,
    /// Cancellation can race ahead of an async command's registration. Keep
    /// a bounded tombstone so `start_with_id` observes that ordering.
    pre_cancelled: HashSet<u64>,
}

impl Default for TaskRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskRegistry {
    pub const fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            state: OnceLock::new(),
        }
    }

    fn state(&self) -> &Mutex<RegistryState> {
        self.state
            .get_or_init(|| Mutex::new(RegistryState::default()))
    }

    /// Start a new task. Returns (task_id, cancellation_flag).
    /// The caller should check `cancelled.load(Ordering::Relaxed)` periodically.
    pub fn start(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cancelled = Arc::new(AtomicBool::new(false));
        self.state()
            .lock()
            .unwrap_or_else(|poisoned| {
                log::error!("task registry lock poisoned on start, recovering");
                poisoned.into_inner()
            })
            .active
            .insert(id, cancelled.clone());
        (id, cancelled)
    }

    /// Register a task under a caller-chosen ID. Used when the client
    /// generates the job id itself so it can cancel before the command
    /// returns (e.g. zip compression progress).
    pub fn start_with_id(&self, id: u64) -> Arc<AtomicBool> {
        let mut state = self.state().lock().unwrap_or_else(|poisoned| {
            log::error!("task registry lock poisoned on start_with_id, recovering");
            poisoned.into_inner()
        });
        let was_pre_cancelled = state.pre_cancelled.remove(&id);
        let cancelled = Arc::new(AtomicBool::new(was_pre_cancelled));
        state.active.insert(id, cancelled.clone());
        cancelled
    }

    /// Cancel a task by ID. If registration has not happened yet, preserve a
    /// bounded tombstone so a racing `start_with_id` begins cancelled.
    pub fn cancel(&self, id: u64) {
        let mut state = self.state().lock().unwrap_or_else(|poisoned| {
            log::error!("task registry lock poisoned on cancel, recovering");
            poisoned.into_inner()
        });
        if let Some(flag) = state.active.get(&id) {
            flag.store(true, Ordering::Relaxed);
            return;
        }
        const MAX_PRE_CANCELLED: usize = 4096;
        if state.pre_cancelled.len() >= MAX_PRE_CANCELLED {
            if let Some(stale) = state.pre_cancelled.iter().next().copied() {
                state.pre_cancelled.remove(&stale);
            }
        }
        state.pre_cancelled.insert(id);
    }

    /// Remove a completed task from the registry.
    pub fn cleanup(&self, id: u64) {
        let mut state = self.state().lock().unwrap_or_else(|poisoned| {
            log::error!("task registry lock poisoned on cleanup, recovering");
            poisoned.into_inner()
        });
        state.active.remove(&id);
        state.pre_cancelled.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_registration_is_observed() {
        let registry = TaskRegistry::new();
        registry.cancel(42);

        let cancelled = registry.start_with_id(42);

        assert!(cancelled.load(Ordering::Relaxed));
        registry.cleanup(42);
    }
}
