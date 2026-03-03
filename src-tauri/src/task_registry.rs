//! Shared cancellable task registry.
//! Issue: tauri-5t7m
//!
//! Provides a thread-safe registry for managing background tasks that can be
//! cancelled. Used by directory listings, search, and content search to avoid
//! duplicating the same AtomicU64 + Mutex<HashMap> pattern.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// A registry that tracks active cancellable tasks by ID.
pub struct TaskRegistry {
    next_id: AtomicU64,
    active: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>>,
}

impl TaskRegistry {
    pub const fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            active: OnceLock::new(),
        }
    }

    fn active_map(&self) -> &Mutex<HashMap<u64, Arc<AtomicBool>>> {
        self.active.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Start a new task. Returns (task_id, cancellation_flag).
    /// The caller should check `cancelled.load(Ordering::Relaxed)` periodically.
    pub fn start(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cancelled = Arc::new(AtomicBool::new(false));
        self.active_map().lock().unwrap().insert(id, cancelled.clone());
        (id, cancelled)
    }

    /// Cancel a task by ID. No-op if the task doesn't exist or already completed.
    pub fn cancel(&self, id: u64) {
        if let Some(flag) = self.active_map().lock().unwrap().get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Remove a completed task from the registry.
    pub fn cleanup(&self, id: u64) {
        self.active_map().lock().unwrap().remove(&id);
    }
}
