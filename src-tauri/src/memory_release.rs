//! Return freed heap memory to the OS after large directory listings (#1416).
//!
//! A large listing allocates hundreds of megabytes for a moment: the parallel
//! scan's per-entry paths and metadata on rayon workers, the sort keys, the
//! entry vector and the encoded reply. glibc retained most of it:
//!
//! - It serves each thread from its own arena (up to eight per core) and keeps
//!   freed memory in the arena that allocated it. `free` returns only an
//!   arena's top beyond the trim threshold; free pages between live chunks
//!   stay resident until `malloc_trim` walks the arena.
//! - Its mmap threshold is dynamic: freeing one large mmapped buffer raises the
//!   threshold to that size (up to 32 MiB) and the trim threshold to twice it,
//!   so every later multi-megabyte buffer (scan vectors, the reply) comes from
//!   an arena heap, and up to 64 MiB of free top per arena stays resident.
//!
//! Measured on the release build, each 100k-entry folder opened left 30-90 MB
//! more in the app process, still there after navigating away. Fixing both
//! thresholds at glibc's own defaults (which disables the dynamic raise) keeps
//! large buffers in mmap, returned when freed, and lets `free` trim arena tops;
//! `malloc_trim(0)` after a large listing returns the free pages inside every
//! arena. Neither changed folder-open time (see docs/performance.md).
//!
//! Other platforms are untouched: their allocators were not measured here.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// Listings at least this large release memory once they are encoded. A 10k
/// listing's transient allocations are a few megabytes; smaller ones are noise.
const LARGE_LISTING_ENTRIES: usize = 10_000;

/// When to release, as a pure function of completed listings.
///
/// A large listing releases right after its reply is encoded, which returns
/// the scan's transient memory; the reply and the entries themselves are freed
/// only once the webview has taken the reply. That memory is owed one more
/// release, paid when the next listing of any size is encoded, by which time
/// the previous reply has been delivered.
#[derive(Debug, Default)]
pub(crate) struct ReleasePolicy {
    owed: bool,
}

impl ReleasePolicy {
    /// Record an encoded listing of `entries` entries; true when freed memory
    /// should be returned now.
    pub(crate) fn listing_encoded(&mut self, entries: usize) -> bool {
        let large = entries >= LARGE_LISTING_ENTRIES;
        let release = large || self.owed;
        self.owed = large;
        release
    }
}

static POLICY: Mutex<ReleasePolicy> = Mutex::new(ReleasePolicy { owed: false });
/// Coalesces releases: one queued release covers every listing before it runs.
static QUEUED: AtomicBool = AtomicBool::new(false);

/// Called once a directory listing's reply has been encoded.
pub(crate) fn listing_encoded(entries: usize) {
    let release = POLICY
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .listing_encoded(entries);
    if !release || !RELEASES_MEMORY || QUEUED.swap(true, Ordering::AcqRel) {
        return;
    }
    // Off the IPC path: trimming walks every arena (a few milliseconds).
    tauri::async_runtime::spawn_blocking(|| {
        QUEUED.store(false, Ordering::Release);
        release_freed_memory();
    });
}

/// Called by `files::listing_reaper` once it has freed a deferred listing's
/// entries (#1417), on its own thread, so the release costs no reply time.
pub(crate) fn listing_freed(entries: usize) {
    if RELEASES_MEMORY && entries >= LARGE_LISTING_ENTRIES {
        release_freed_memory();
    }
}

/// glibc's default mmap and trim thresholds (128 KiB), set explicitly so they
/// stay fixed instead of rising after the first large free.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const FIXED_THRESHOLD: libc::c_int = 128 * 1024;

/// Call once at startup, before any large allocation.
pub(crate) fn configure_allocator() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: mallopt only adjusts allocator tuning parameters; a rejected
    // value leaves the previous setting in place.
    unsafe {
        libc::mallopt(libc::M_MMAP_THRESHOLD, FIXED_THRESHOLD);
        libc::mallopt(libc::M_TRIM_THRESHOLD, FIXED_THRESHOLD);
    }
}

const RELEASES_MEMORY: bool = cfg!(all(target_os = "linux", target_env = "gnu"));

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn release_freed_memory() {
    // SAFETY: malloc_trim only returns free pages to the kernel; it takes each
    // arena's lock and has no preconditions on the caller.
    unsafe {
        libc::malloc_trim(0);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn release_freed_memory() {}

#[cfg(test)]
#[path = "../test_support/memory_release.rs"]
mod tests;
