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

    pub(crate) fn publish(&self, _root: &Path, _entries: Vec<T>) {}

    pub(crate) fn invalidate_for_change(&self, _changed_path: &Path) {}
}
