//! Ordered effect receipts retained independently of a worker's stack.
//! The admitted plan bounds slot count; operation families own outcome policy.
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(in crate::files) enum ItemState<T, E = String> {
    Unstarted,
    Active,
    Succeeded(T),
    Failed(E),
    Uncertain(E),
}

pub(in crate::files) struct Receipts<T, E = String>(Arc<Mutex<Vec<ItemState<T, E>>>>);

impl<T, E> Clone for Receipts<T, E> {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl<T, E> Receipts<T, E> {
    pub(in crate::files) fn new(count: usize) -> Self {
        Self(Arc::new(Mutex::new(
            std::iter::repeat_with(|| ItemState::Unstarted)
                .take(count)
                .collect(),
        )))
    }

    pub(in crate::files) fn begin(&self, index: usize) {
        let mut states = self.0.lock().unwrap_or_else(|error| error.into_inner());
        assert!(
            matches!(states[index], ItemState::Unstarted),
            "an item can only start once"
        );
        states[index] = ItemState::Active;
    }

    pub(in crate::files) fn complete(&self, index: usize, outcome: ItemState<T, E>) {
        assert!(
            !matches!(outcome, ItemState::Unstarted | ItemState::Active),
            "completion requires a terminal receipt"
        );
        let mut states = self.0.lock().unwrap_or_else(|error| error.into_inner());
        assert!(
            matches!(states[index], ItemState::Active),
            "only an active item can complete"
        );
        states[index] = outcome;
    }

    /// The supervisor calls this only after execution and capture destruction
    /// have finished. Active slots then represent interrupted, uncertain work.
    pub(in crate::files) fn take(self) -> Vec<ItemState<T, E>> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|error| error.into_inner()))
    }
}
