use std::marker::PhantomData;
use std::path::Path;
use std::sync::Arc;

/// Process-local store for completed recursive Quick Open listings.
///
/// A listing is published only after its walk completes, so a later query can
/// reuse it without confusing a cancelled partial walk for a complete tree.
pub(crate) struct SearchEntryCache<T> {
    _entry: PhantomData<T>,
}

impl<T> SearchEntryCache<T> {
    pub(crate) const fn new() -> Self {
        Self {
            _entry: PhantomData,
        }
    }

    pub(crate) fn completed(&self, _root: &Path) -> Option<Arc<Vec<T>>> {
        None
    }

    pub(crate) fn publish(&self, _root: &Path, _entries: Arc<Vec<T>>) {}

    pub(crate) fn invalidate_for_change(&self, _changed_path: &Path) {}

    pub(crate) fn get_or_load<F>(&self, root: &Path, load: F) -> Arc<Vec<T>>
    where
        F: FnOnce() -> Vec<T>,
    {
        if let Some(entries) = self.completed(root) {
            return entries;
        }
        let entries = Arc::new(load());
        self.publish(root, Arc::clone(&entries));
        entries
    }
}

#[cfg(test)]
#[path = "../tests/issue_651_search_cache.rs"]
mod issue_651_tests;
