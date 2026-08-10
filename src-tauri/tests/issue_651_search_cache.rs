use super::SearchEntryCache;
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
