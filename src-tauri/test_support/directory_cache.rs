use super::{DirectoryCache, Lookup, Permit, PreparedSnapshot};
use crate::files::{FileEntry, FileKind};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CACHE_BYTES: usize = 8 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(5);

fn snapshot(name: &str) -> Arc<Vec<FileEntry>> {
    Arc::new(vec![FileEntry {
        name: name.into(),
        path: format!("/fixture/{name}"),
        kind: FileKind::File,
        size: name.len() as u64,
        modified: "2026-09-08T00:00:00".into(),
        is_symlink: false,
        symlink_target: None,
        is_empty: None,
        is_git_repo: false,
    }])
}

fn large_snapshot(name: &str, allocation: usize) -> Arc<Vec<FileEntry>> {
    Arc::new(vec![FileEntry {
        name: name.into(),
        path: format!("/fixture/{name}"),
        kind: FileKind::File,
        size: allocation as u64,
        modified: "2026-09-08T00:00:00".into(),
        is_symlink: true,
        symlink_target: Some("x".repeat(allocation)),
        is_empty: None,
        is_git_repo: false,
    }])
}

fn miss(cache: &mut DirectoryCache, path: &str, now: Instant) -> Permit {
    match cache.lookup(path, now) {
        Lookup::Miss(permit) => permit,
        Lookup::Hit(_) => panic!("expected cache miss for {path}"),
    }
}

fn hit(cache: &mut DirectoryCache, path: &str, now: Instant) -> Arc<Vec<FileEntry>> {
    match cache.lookup(path, now) {
        Lookup::Hit(entries) => entries,
        Lookup::Miss(_) => panic!("expected cache hit for {path}"),
    }
}

#[test]
fn cache_hits_share_the_published_snapshot_allocation() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, CACHE_BYTES, TTL);
    let permit = miss(&mut cache, "/shared", now);
    let published = snapshot("shared.txt");

    cache.publish(permit, PreparedSnapshot::new(Arc::clone(&published)), now);

    let first = hit(&mut cache, "/shared", now + Duration::from_millis(1));
    let second = hit(&mut cache, "/shared", now + Duration::from_millis(2));
    assert!(Arc::ptr_eq(&published, &first));
    assert!(Arc::ptr_eq(&first, &second));
}

#[test]
fn invalidation_revokes_old_publication_and_a_fresh_miss_can_publish() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, CACHE_BYTES, TTL);
    let old = miss(&mut cache, "/changed", now);

    cache.invalidate("/changed");
    cache.publish(
        old,
        PreparedSnapshot::new(snapshot("stale.txt")),
        now + Duration::from_millis(1),
    );
    let fresh = miss(&mut cache, "/changed", now + Duration::from_millis(2));
    cache.publish(
        fresh,
        PreparedSnapshot::new(snapshot("fresh.txt")),
        now + Duration::from_millis(3),
    );

    let entries = hit(&mut cache, "/changed", now + Duration::from_millis(4));
    assert_eq!(entries[0].name, "fresh.txt");
}

#[test]
fn newer_same_path_miss_prevents_completion_order_rollback() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, CACHE_BYTES, TTL);
    let older = miss(&mut cache, "/racing", now);
    let newer = miss(&mut cache, "/racing", now + Duration::from_millis(1));

    cache.publish(
        newer,
        PreparedSnapshot::new(snapshot("newer.txt")),
        now + Duration::from_millis(2),
    );
    cache.publish(
        older,
        PreparedSnapshot::new(snapshot("older.txt")),
        now + Duration::from_millis(3),
    );

    let entries = hit(&mut cache, "/racing", now + Duration::from_millis(4));
    assert_eq!(entries[0].name, "newer.txt");
}

#[test]
fn stale_discard_does_not_remove_a_newer_snapshot() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, CACHE_BYTES, TTL);
    let older = miss(&mut cache, "/racing", now);
    let newer = miss(&mut cache, "/racing", now + Duration::from_millis(1));
    let published = snapshot("winner.txt");
    cache.publish(
        newer,
        PreparedSnapshot::new(Arc::clone(&published)),
        now + Duration::from_millis(2),
    );

    cache.discard(older);

    let entries = hit(&mut cache, "/racing", now + Duration::from_millis(3));
    assert!(Arc::ptr_eq(&published, &entries));
}

#[test]
fn ttl_is_measured_from_publication_and_expires_at_the_boundary() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, CACHE_BYTES, TTL);
    let permit = miss(&mut cache, "/expiring", now);
    cache.publish(permit, PreparedSnapshot::new(snapshot("current.txt")), now);

    let entries = hit(&mut cache, "/expiring", now + TTL - Duration::from_nanos(1));
    assert_eq!(entries[0].name, "current.txt");
    let _replacement = miss(&mut cache, "/expiring", now + TTL);
}

#[test]
fn recent_hit_protects_snapshot_from_path_capacity_eviction() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(2, CACHE_BYTES, TTL);
    let first = miss(&mut cache, "/first", now);
    cache.publish(first, PreparedSnapshot::new(snapshot("first.txt")), now);
    let second = miss(&mut cache, "/second", now + Duration::from_millis(1));
    cache.publish(
        second,
        PreparedSnapshot::new(snapshot("second.txt")),
        now + Duration::from_millis(1),
    );
    let _ = hit(&mut cache, "/first", now + Duration::from_millis(2));

    let third = miss(&mut cache, "/third", now + Duration::from_millis(3));
    cache.publish(
        third,
        PreparedSnapshot::new(snapshot("third.txt")),
        now + Duration::from_millis(3),
    );

    assert_eq!(
        hit(&mut cache, "/first", now + Duration::from_millis(4))[0].name,
        "first.txt"
    );
    assert_eq!(
        hit(&mut cache, "/third", now + Duration::from_millis(4))[0].name,
        "third.txt"
    );
    let _replacement = miss(&mut cache, "/second", now + Duration::from_millis(4));
}

#[test]
fn oversized_snapshot_is_not_cached_or_allowed_to_evict_an_unrelated_hit() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, 256 * 1024, TTL);
    let small = miss(&mut cache, "/small", now);
    let small_snapshot = snapshot("small.txt");
    cache.publish(
        small,
        PreparedSnapshot::new(Arc::clone(&small_snapshot)),
        now,
    );
    let oversized = miss(&mut cache, "/oversized", now + Duration::from_millis(1));

    cache.publish(
        oversized,
        PreparedSnapshot::new(large_snapshot("oversized.txt", 512 * 1024)),
        now + Duration::from_millis(2),
    );

    let _replacement = miss(&mut cache, "/oversized", now + Duration::from_millis(3));
    let retained = hit(&mut cache, "/small", now + Duration::from_millis(3));
    assert!(Arc::ptr_eq(&small_snapshot, &retained));
}

#[test]
fn aggregate_byte_budget_evicts_an_older_independent_allocation() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(10, 1024 * 1024, TTL);
    let first = miss(&mut cache, "/large-first", now);
    cache.publish(
        first,
        PreparedSnapshot::new(large_snapshot("first.txt", 600 * 1024)),
        now,
    );
    assert_eq!(hit(&mut cache, "/large-first", now)[0].name, "first.txt");

    let second = miss(&mut cache, "/large-second", now + Duration::from_millis(1));
    cache.publish(
        second,
        PreparedSnapshot::new(large_snapshot("second.txt", 600 * 1024)),
        now + Duration::from_millis(1),
    );

    assert_eq!(
        hit(&mut cache, "/large-second", now + Duration::from_millis(2))[0].name,
        "second.txt"
    );
    let _replacement = miss(&mut cache, "/large-first", now + Duration::from_millis(2));
}

#[test]
fn path_capacity_eviction_revokes_a_pending_permit() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(1, CACHE_BYTES, TTL);
    let evicted = miss(&mut cache, "/evicted", now);
    let survivor = miss(&mut cache, "/survivor", now + Duration::from_millis(1));

    cache.publish(
        evicted,
        PreparedSnapshot::new(snapshot("stale.txt")),
        now + Duration::from_millis(2),
    );
    cache.publish(
        survivor,
        PreparedSnapshot::new(snapshot("survivor.txt")),
        now + Duration::from_millis(2),
    );

    assert_eq!(
        hit(&mut cache, "/survivor", now + Duration::from_millis(3))[0].name,
        "survivor.txt"
    );
}

#[test]
fn dropped_pending_permit_is_reclaimed_before_capacity_eviction() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(2, CACHE_BYTES, TTL);
    let retained = miss(&mut cache, "/retained", now);
    let retained_snapshot = snapshot("retained.txt");
    cache.publish(
        retained,
        PreparedSnapshot::new(Arc::clone(&retained_snapshot)),
        now,
    );
    let abandoned = miss(&mut cache, "/abandoned", now + Duration::from_millis(1));
    drop(abandoned);

    let replacement = miss(&mut cache, "/replacement", now + Duration::from_millis(2));
    cache.publish(
        replacement,
        PreparedSnapshot::new(snapshot("replacement.txt")),
        now + Duration::from_millis(2),
    );

    let still_retained = hit(&mut cache, "/retained", now + Duration::from_millis(3));
    assert!(Arc::ptr_eq(&retained_snapshot, &still_retained));
    assert_eq!(
        hit(&mut cache, "/replacement", now + Duration::from_millis(3))[0].name,
        "replacement.txt"
    );
}

#[test]
fn invalidating_one_path_preserves_unrelated_snapshot_identity() {
    let now = Instant::now();
    let mut cache = DirectoryCache::new(4, CACHE_BYTES, TTL);
    let first = miss(&mut cache, "/first", now);
    cache.publish(first, PreparedSnapshot::new(snapshot("first.txt")), now);
    let second = miss(&mut cache, "/second", now);
    let second_snapshot = snapshot("second.txt");
    cache.publish(
        second,
        PreparedSnapshot::new(Arc::clone(&second_snapshot)),
        now,
    );

    cache.invalidate("/first");

    let _replacement = miss(&mut cache, "/first", now + Duration::from_millis(1));
    let unrelated = hit(&mut cache, "/second", now + Duration::from_millis(1));
    assert!(Arc::ptr_eq(&second_snapshot, &unrelated));
}
