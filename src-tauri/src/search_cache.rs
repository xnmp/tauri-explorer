use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(5);
const MAX_CACHED_ROOTS: usize = 4;
pub(crate) const MAX_CACHED_LISTING_ENTRIES: usize = 100_000;

struct CompletedListing<T> {
    entries: Arc<Vec<T>>,
    cached_at: Instant,
}

/// Process-local store for completed recursive Quick Open listings.
///
/// A listing is published only after its walk completes, so a later query can
/// reuse it without confusing a cancelled partial walk for a complete tree.
pub(crate) struct SearchEntryCache<T> {
    listings: OnceLock<Mutex<HashMap<PathBuf, CompletedListing<T>>>>,
    revision: AtomicU64,
}

impl<T> SearchEntryCache<T> {
    pub(crate) const fn new() -> Self {
        Self {
            listings: OnceLock::new(),
            revision: AtomicU64::new(0),
        }
    }

    fn listings(&self) -> &Mutex<HashMap<PathBuf, CompletedListing<T>>> {
        self.listings.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(crate) fn completed(&self, root: &Path) -> Option<Arc<Vec<T>>> {
        let mut listings = self.listings().lock().ok()?;
        listings.retain(|_, listing| listing.cached_at.elapsed() < CACHE_TTL);
        listings
            .get(root)
            .map(|listing| Arc::clone(&listing.entries))
    }

    pub(crate) fn begin_load(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    pub(crate) fn publish_if_unchanged(
        &self,
        root: &Path,
        entries: Arc<Vec<T>>,
        load_revision: u64,
    ) {
        if entries.len() > MAX_CACHED_LISTING_ENTRIES {
            return;
        }

        let Ok(mut listings) = self.listings().lock() else {
            return;
        };
        if self.revision.load(Ordering::Acquire) != load_revision {
            return;
        }
        listings.retain(|_, listing| listing.cached_at.elapsed() < CACHE_TTL);
        if !listings.contains_key(root) && listings.len() >= MAX_CACHED_ROOTS {
            let oldest = listings
                .iter()
                .min_by_key(|(_, listing)| listing.cached_at)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                listings.remove(&oldest);
            }
        }
        listings.insert(
            root.to_path_buf(),
            CompletedListing {
                entries,
                cached_at: Instant::now(),
            },
        );
    }

    pub(crate) fn invalidate_for_change(&self, changed_path: &Path) {
        // Increment before locking. A publisher either observes this revision
        // and declines to insert, or publishes first and is removed below.
        self.revision.fetch_add(1, Ordering::AcqRel);
        let Ok(mut listings) = self.listings().lock() else {
            return;
        };
        listings
            .retain(|root, _| !changed_path.starts_with(root) && !root.starts_with(changed_path));
    }

    pub(crate) fn get_or_load<F>(&self, root: &Path, load: F) -> Arc<Vec<T>>
    where
        F: FnOnce() -> Vec<T>,
    {
        if let Some(entries) = self.completed(root) {
            return entries;
        }
        let load_revision = self.begin_load();
        let entries = Arc::new(load());
        self.publish_if_unchanged(root, Arc::clone(&entries), load_revision);
        entries
    }
}

#[cfg(test)]
#[path = "../tests/issue_651_search_cache.rs"]
mod issue_651_tests;
