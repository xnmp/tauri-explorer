use super::{SearchEntryCache, MAX_TRACKED_ROOTS};
use std::cell::Cell;
use std::fs;

fn matching_names(
    cache: &SearchEntryCache<String>,
    root: &std::path::Path,
    query: &str,
    walks: &Cell<usize>,
) -> Vec<String> {
    let entries = cache.get_or_load(root, || {
        walks.set(walks.get() + 1);
        fs::read_dir(root)
            .expect("temporary search root")
            .map(|entry| {
                entry
                    .expect("temporary directory entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    });

    entries
        .iter()
        .filter(|name| name.contains(query))
        .cloned()
        .collect()
}

#[test]
fn issue_651_repeated_queries_reuse_the_completed_listing() {
    let root = tempfile::tempdir().expect("temporary search root");
    fs::write(root.path().join("alpha-report.txt"), "alpha").expect("alpha fixture");
    fs::write(root.path().join("beta-report.txt"), "beta").expect("beta fixture");
    let cache = SearchEntryCache::new();
    let walks = Cell::new(0);

    let alpha = matching_names(&cache, root.path(), "alpha", &walks);
    let beta = matching_names(&cache, root.path(), "beta", &walks);

    assert_eq!(alpha, ["alpha-report.txt"]);
    assert_eq!(beta, ["beta-report.txt"]);
    assert_eq!(
        walks.get(),
        1,
        "a second query under an unchanged root must not walk the tree again"
    );
}

#[test]
fn issue_651_invalidated_listing_exposes_filesystem_changes() {
    let root = tempfile::tempdir().expect("temporary search root");
    fs::write(root.path().join("before.txt"), "before").expect("initial fixture");
    let cache = SearchEntryCache::new();
    let walks = Cell::new(0);

    assert_eq!(
        matching_names(&cache, root.path(), "before", &walks),
        ["before.txt"]
    );
    fs::remove_file(root.path().join("before.txt")).expect("remove initial fixture");
    fs::write(root.path().join("after.txt"), "after").expect("changed fixture");
    cache.invalidate_for_change(&root.path().join("after.txt"));

    assert_eq!(
        matching_names(&cache, root.path(), "after", &walks),
        ["after.txt"]
    );
    assert_eq!(walks.get(), 2, "invalidation must force a fresh walk");
}

#[test]
fn issue_651_invalidation_during_a_walk_prevents_stale_publication() {
    let root = tempfile::tempdir().expect("temporary search root");
    fs::write(root.path().join("before.txt"), "before").expect("initial fixture");
    let cache = SearchEntryCache::new();
    let walks = Cell::new(0);

    let first = cache.get_or_load(root.path(), || {
        walks.set(walks.get() + 1);
        let entries = vec!["before.txt".to_string()];
        cache.invalidate_for_change(root.path());
        entries
    });
    assert_eq!(first.as_slice(), ["before.txt"]);

    fs::remove_file(root.path().join("before.txt")).expect("remove initial fixture");
    fs::write(root.path().join("after.txt"), "after").expect("changed fixture");
    let after = matching_names(&cache, root.path(), "after", &walks);

    assert_eq!(after, ["after.txt"]);
    assert_eq!(
        walks.get(),
        2,
        "an invalidated in-flight walk must not become the completed listing"
    );
}

#[test]
fn issue_651_unrelated_change_does_not_discard_an_unchanged_root_walk() {
    let root = tempfile::tempdir().expect("temporary search root");
    let unrelated = tempfile::tempdir().expect("unrelated temporary root");
    let cache = SearchEntryCache::new();
    let walks = Cell::new(0);

    let entries = cache.get_or_load(root.path(), || {
        walks.set(walks.get() + 1);
        cache.invalidate_for_change(unrelated.path());
        vec!["kept.txt".to_string()]
    });

    assert_eq!(entries.as_slice(), ["kept.txt"]);
    assert_eq!(
        cache.completed(root.path()).as_deref(),
        Some(entries.as_ref())
    );
    assert_eq!(walks.get(), 1);
}

#[test]
fn issue_651_exact_root_epochs_keep_revision_tracking_bounded() {
    let cache = SearchEntryCache::<String>::new();
    let base = tempfile::tempdir().expect("temporary revision roots");

    for index in 0..(MAX_TRACKED_ROOTS * 2) {
        cache.invalidate_root(&base.path().join(format!("root-{index}")));
    }

    assert!(
        cache
            .state()
            .lock()
            .expect("cache state lock")
            .revisions
            .len()
            <= MAX_TRACKED_ROOTS,
        "coverage epoch allocation must preserve the revision tracking bound"
    );
}
