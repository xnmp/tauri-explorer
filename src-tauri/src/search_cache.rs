use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_TTL: Duration = Duration::from_secs(5);
const MAX_CACHED_ROOTS: usize = 4;
pub(crate) const MAX_CACHED_LISTING_ENTRIES: usize = 100_000;
const MAX_TRACKED_ROOTS: usize = 64;

struct CompletedListing<T> {
    entries: Arc<Vec<T>>,
    cached_at: Instant,
}

struct CacheState<T> {
    listings: HashMap<PathBuf, CompletedListing<T>>,
    revisions: HashMap<PathBuf, u64>,
    next_revision: u64,
}

impl<T> Default for CacheState<T> {
    fn default() -> Self {
        Self {
            listings: HashMap::new(),
            revisions: HashMap::new(),
            next_revision: 1,
        }
    }
}

/// Process-local store for completed recursive Quick Open listings.
///
/// A listing is published only after its walk completes, so a later query can
/// reuse it without confusing a cancelled partial walk for a complete tree.
pub(crate) struct SearchEntryCache<T> {
    state: OnceLock<Mutex<CacheState<T>>>,
}

impl<T> SearchEntryCache<T> {
    pub(crate) const fn new() -> Self {
        Self {
            state: OnceLock::new(),
        }
    }

    fn state(&self) -> &Mutex<CacheState<T>> {
        self.state.get_or_init(|| Mutex::new(CacheState::default()))
    }

    fn advance_revision(state: &mut CacheState<T>, root: &Path) -> u64 {
        if !state.revisions.contains_key(root) && state.revisions.len() >= MAX_TRACKED_ROOTS {
            let evicted = state
                .revisions
                .keys()
                .find(|path| !state.listings.contains_key(*path))
                .cloned();
            if let Some(evicted) = evicted {
                state.revisions.remove(&evicted);
            }
        }
        let revision = state.next_revision;
        state.next_revision = state.next_revision.wrapping_add(1).max(1);
        state.revisions.insert(root.to_path_buf(), revision);
        revision
    }

    pub(crate) fn completed(&self, root: &Path) -> Option<Arc<Vec<T>>> {
        let mut state = self.state().lock().ok()?;
        state
            .listings
            .retain(|_, listing| listing.cached_at.elapsed() < CACHE_TTL);
        state
            .listings
            .get(root)
            .map(|listing| Arc::clone(&listing.entries))
    }

    pub(crate) fn begin_load(&self, root: &Path) -> u64 {
        let Ok(mut state) = self.state().lock() else {
            return 0;
        };
        if let Some(revision) = state.revisions.get(root) {
            return *revision;
        }

        Self::advance_revision(&mut state, root)
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

        let Ok(mut state) = self.state().lock() else {
            return;
        };
        if state.revisions.get(root).copied() != Some(load_revision) {
            return;
        }
        state
            .listings
            .retain(|_, listing| listing.cached_at.elapsed() < CACHE_TTL);
        if !state.listings.contains_key(root) && state.listings.len() >= MAX_CACHED_ROOTS {
            let oldest = state
                .listings
                .iter()
                .min_by_key(|(_, listing)| listing.cached_at)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                state.listings.remove(&oldest);
            }
        }
        state.listings.insert(
            root.to_path_buf(),
            CompletedListing {
                entries,
                cached_at: Instant::now(),
            },
        );
    }

    /// Advance one root's publication epoch without invalidating overlapping
    /// ancestor or descendant listings. Coverage lifecycle transitions use
    /// this; filesystem changes use `invalidate_for_change` below.
    pub(crate) fn invalidate_root(&self, root: &Path) {
        let Ok(mut state) = self.state().lock() else {
            return;
        };
        Self::advance_revision(&mut state, root);
        state.listings.remove(root);
    }

    pub(crate) fn invalidate_for_change(&self, changed_path: &Path) {
        let Ok(mut state) = self.state().lock() else {
            return;
        };
        let affected: Vec<PathBuf> = state
            .revisions
            .keys()
            .filter(|root| changed_path.starts_with(root) || root.starts_with(changed_path))
            .cloned()
            .collect();
        for root in affected {
            Self::advance_revision(&mut state, &root);
            state.listings.remove(&root);
        }
        state
            .listings
            .retain(|root, _| !changed_path.starts_with(root) && !root.starts_with(changed_path));
    }

    pub(crate) fn get_or_load<F>(&self, root: &Path, load: F) -> Arc<Vec<T>>
    where
        F: FnOnce() -> Vec<T>,
    {
        if let Some(entries) = self.completed(root) {
            return entries;
        }
        let load_revision = self.begin_load(root);
        let entries = Arc::new(load());
        self.publish_if_unchanged(root, Arc::clone(&entries), load_revision);
        entries
    }
}

#[cfg(test)]
#[path = "../test_support/issue_651_search_cache.rs"]
mod issue_651_tests;
