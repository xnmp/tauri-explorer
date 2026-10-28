use super::{disposal, release, Disposal, DEFERRED_ENTRIES};
use crate::files::{DirectoryListing, FileEntry, FileKind};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn entries(count: usize) -> Arc<Vec<FileEntry>> {
    Arc::new(
        (0..count)
            .map(|i| FileEntry {
                name: format!("f{i}"),
                path: format!("/d/f{i}"),
                kind: FileKind::File,
                size: i as u64,
                modified: "2026-01-01T00:00:00".into(),
                is_symlink: false,
                symlink_target: None,
                is_empty: None,
                is_git_repo: false,
            })
            .collect(),
    )
}

fn wait_until_freed(weak: &std::sync::Weak<Vec<FileEntry>>) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if weak.upgrade().is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

#[test]
fn only_large_unshared_listings_are_deferred() {
    assert_eq!(disposal(&entries(0)), Disposal::Inline);
    assert_eq!(disposal(&entries(DEFERRED_ENTRIES - 1)), Disposal::Inline);
    let large = entries(DEFERRED_ENTRIES);
    assert_eq!(disposal(&large), Disposal::Deferred);
    let shared = Arc::clone(&large);
    assert_eq!(disposal(&large), Disposal::Inline, "another owner keeps it");
    drop(shared);
}

#[test]
fn a_small_listing_is_freed_by_its_dropper() {
    let small = entries(3);
    let weak = Arc::downgrade(&small);
    release(small);
    assert!(weak.upgrade().is_none());
}

#[test]
fn a_dropped_large_listing_is_freed_in_the_background() {
    let large = entries(DEFERRED_ENTRIES * 2);
    let weak = Arc::downgrade(&large);
    drop(DirectoryListing {
        path: "/d".into(),
        entries: large,
    });
    assert!(wait_until_freed(&weak), "the reaper frees deferred entries");
}

#[test]
fn dropping_a_listing_leaves_shared_entries_to_their_other_owner() {
    let large = entries(DEFERRED_ENTRIES);
    let cached = Arc::clone(&large);
    drop(DirectoryListing {
        path: "/d".into(),
        entries: large,
    });
    assert_eq!(cached.len(), DEFERRED_ENTRIES);
    assert_eq!(cached[7].name, "f7");
}

#[test]
fn many_large_listings_are_all_freed_even_beyond_the_queue_depth() {
    let weaks: Vec<_> = (0..12)
        .map(|_| {
            let large = entries(DEFERRED_ENTRIES);
            let weak = Arc::downgrade(&large);
            release(large);
            weak
        })
        .collect();
    assert!(weaks.iter().all(wait_until_freed));
}
