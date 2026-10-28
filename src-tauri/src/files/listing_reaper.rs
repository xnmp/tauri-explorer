//! Free large directory listings off the IPC reply path (#1417).
//!
//! Tauri encodes a command's reply and then drops the returned value before
//! it hands the encoded body to the webview. For a listing that drop frees
//! three heap strings per entry, most of them allocated by other threads'
//! allocator arenas during the parallel scan: measured on the release build,
//! 12-21 ms at 100k entries and 134-146 ms at 500k, all of it spent before
//! the reply left the process. A large listing whose entries nobody else
//! holds is handed to one background thread instead, which frees it and then
//! asks `memory_release` to return the pages to the OS.
use super::FileEntry;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, LazyLock};

/// Smaller listings free in about a millisecond; deferring them is noise.
const DEFERRED_ENTRIES: usize = 10_000;
/// Listings waiting to be freed. A full queue frees inline, so a burst of
/// listings cannot accumulate unbounded garbage behind a slow thread.
const QUEUE_DEPTH: usize = 4;

type Entries = Arc<Vec<FileEntry>>;

/// Where a dropped listing's entries go: freed now, or queued for the reaper.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Disposal {
    Inline,
    Deferred,
}

/// Pure policy: only a large listing whose entries are not shared is
/// deferred. A shared `Arc` (a cache or another reply still holds it) frees
/// nothing when this owner drops, so it is released inline.
pub(crate) fn disposal(entries: &Entries) -> Disposal {
    if entries.len() >= DEFERRED_ENTRIES && Arc::strong_count(entries) == 1 {
        Disposal::Deferred
    } else {
        Disposal::Inline
    }
}

static REAPER: LazyLock<Option<SyncSender<Entries>>> = LazyLock::new(|| {
    let (send, receive) = sync_channel::<Entries>(QUEUE_DEPTH);
    std::thread::Builder::new()
        .name("listing-reaper".into())
        .spawn(move || {
            for entries in receive {
                let count = entries.len();
                drop(entries);
                crate::memory_release::listing_freed(count);
            }
        })
        .ok()
        .map(|_| send)
});

/// Release a listing's entries, deferring large unshared ones to the reaper.
pub(crate) fn release(entries: Entries) {
    if disposal(&entries) == Disposal::Inline {
        return;
    }
    let Some(sender) = REAPER.as_ref() else {
        return; // No thread could be started: free inline.
    };
    // A full or closed queue hands the entries back inside the error, and
    // they are freed inline here as it drops.
    let _ = sender.try_send(entries);
}

#[cfg(test)]
#[path = "../../test_support/listing_reaper_test.rs"]
mod tests;
