//! Bounded directory snapshots with request-owned publication authority.
//!
//! Invalidation and eviction remove the slot, so an old request cannot refill
//! it. A newer miss replaces its permit, preventing completion-order rollback.
//! Weak permits make abandoned requests reclaimable without tombstones/timers.
use super::FileEntry;
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

pub(super) enum Lookup {
    Hit(Arc<Vec<FileEntry>>),
    Miss(Permit),
}

pub(super) struct Permit {
    path: String,
    identity: Arc<()>,
}

/// Prepare outside the cache lock, alongside blocking directory scanning.
pub(super) struct PreparedSnapshot {
    entries: Arc<Vec<FileEntry>>,
    bytes: usize,
}

impl PreparedSnapshot {
    pub fn new(entries: Arc<Vec<FileEntry>>) -> Self {
        Self {
            bytes: retained_bytes(&entries),
            entries,
        }
    }

    pub fn entries(&self) -> Arc<Vec<FileEntry>> {
        Arc::clone(&self.entries)
    }
}

struct Snapshot {
    value: PreparedSnapshot,
    stored_at: Instant,
}

struct Slot {
    identity: Weak<()>,
    snapshot: Option<Snapshot>,
    last_used: Instant,
}

pub(super) struct DirectoryCache {
    slots: HashMap<String, Slot>,
    bytes: usize,
    max_paths: usize,
    max_bytes: usize,
    ttl: Duration,
}

impl Default for DirectoryCache {
    fn default() -> Self {
        Self::new(50, 32 * 1024 * 1024, Duration::from_secs(5))
    }
}

impl DirectoryCache {
    pub fn new(max_paths: usize, max_bytes: usize, ttl: Duration) -> Self {
        Self {
            slots: HashMap::new(),
            bytes: 0,
            max_paths,
            max_bytes,
            ttl,
        }
    }

    pub fn lookup(&mut self, path: &str, now: Instant) -> Lookup {
        if let Some(slot) = self.slots.get_mut(path) {
            if let Some(snapshot) = &slot.snapshot {
                if now.saturating_duration_since(snapshot.stored_at) < self.ttl {
                    slot.last_used = now;
                    return Lookup::Hit(snapshot.value.entries());
                }
            }
        }
        self.prune(now);
        self.invalidate(path);
        let permit = Permit {
            path: path.into(),
            identity: Arc::new(()),
        };
        if self.max_paths != 0 {
            while self.slots.len() >= self.max_paths {
                self.evict_oldest();
            }
            self.slots.insert(
                path.into(),
                Slot {
                    identity: Arc::downgrade(&permit.identity),
                    snapshot: None,
                    last_used: now,
                },
            );
        }
        Lookup::Miss(permit)
    }

    pub fn invalidate(&mut self, path: &str) {
        if let Some(slot) = self.slots.remove(path) {
            self.bytes -= slot.snapshot.map_or(0, |snapshot| snapshot.value.bytes);
        }
    }

    pub fn discard(&mut self, permit: Permit) {
        if self.current(&permit) {
            self.invalidate(&permit.path);
        }
    }

    pub fn publish(&mut self, permit: Permit, value: PreparedSnapshot, now: Instant) {
        if !self.current(&permit) {
            return;
        }
        let bytes = value.bytes;
        if bytes > self.max_bytes || self.ttl.is_zero() {
            self.invalidate(&permit.path);
            return;
        }
        self.prune(now);
        // Evict completed snapshots first; never discard another pending read
        // merely to satisfy the snapshot byte budget.
        while self.bytes > self.max_bytes - bytes {
            let oldest = self
                .slots
                .iter()
                .filter(|(_, slot)| slot.snapshot.is_some())
                .min_by_key(|(_, slot)| slot.last_used)
                .map(|(path, _)| path.clone());
            let Some(oldest) = oldest else { break };
            self.invalidate(&oldest);
        }
        if let Some(slot) = self.slots.get_mut(&permit.path) {
            slot.snapshot = Some(Snapshot {
                value,
                stored_at: now,
            });
            slot.last_used = now;
            self.bytes += bytes;
        }
    }

    fn current(&self, permit: &Permit) -> bool {
        self.slots
            .get(&permit.path)
            .is_some_and(|slot| slot.identity.ptr_eq(&Arc::downgrade(&permit.identity)))
    }

    fn prune(&mut self, now: Instant) {
        let expired: Vec<_> = self
            .slots
            .iter()
            .filter(|(_, slot)| match &slot.snapshot {
                Some(snapshot) => now.saturating_duration_since(snapshot.stored_at) >= self.ttl,
                None => slot.identity.strong_count() == 0,
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in expired {
            self.invalidate(&path);
        }
    }

    fn evict_oldest(&mut self) {
        if let Some(path) = self
            .slots
            .iter()
            .min_by_key(|(_, slot)| slot.last_used)
            .map(|(path, _)| path.clone())
        {
            self.invalidate(&path);
        }
    }
}

/// Account for retained Vec/String allocations, not filesystem file sizes.
/// This bounds snapshot storage; it is not a process RSS or allocator-overhead bound.
fn retained_bytes(entries: &Vec<FileEntry>) -> usize {
    let allocation = entries
        .capacity()
        .saturating_mul(std::mem::size_of::<FileEntry>());
    entries.iter().fold(allocation, |bytes, entry| {
        bytes
            .saturating_add(entry.name.capacity())
            .saturating_add(entry.path.capacity())
            .saturating_add(entry.modified.capacity())
            .saturating_add(entry.symlink_target.as_ref().map_or(0, String::capacity))
    })
}

#[cfg(test)]
#[path = "../../test_support/directory_cache.rs"]
mod tests;
