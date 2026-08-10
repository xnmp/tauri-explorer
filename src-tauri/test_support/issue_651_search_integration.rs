use super::{fuzzy_search_sync, walk_count_for_test, walk_streaming_entries, Walked};
use crate::files::fs_watcher::{
    invalidate_directory_caches_for_change, mark_directory_watched_for_test,
};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};

fn result_names(query: &str, root: &std::path::Path) -> Vec<String> {
    fuzzy_search_sync(query.to_string(), root.to_string_lossy().into_owned(), 20)
        .expect("Quick Open query")
        .results
        .into_iter()
        .map(|result| result.name)
        .collect()
}

#[test]
fn issue_651_search_command_reuses_a_completed_watched_listing() {
    let root = tempfile::tempdir().expect("temporary search root");
    fs::write(root.path().join("alpha-report.txt"), "alpha").expect("alpha fixture");
    fs::write(root.path().join("beta-report.txt"), "beta").expect("beta fixture");
    mark_directory_watched_for_test(root.path());

    assert!(result_names("alpha", root.path()).contains(&"alpha-report.txt".to_string()));
    assert!(result_names("beta", root.path()).contains(&"beta-report.txt".to_string()));
    assert_eq!(walk_count_for_test(root.path()), 1);
}

#[test]
fn issue_651_search_command_does_not_reuse_an_unwatched_listing() {
    let root = tempfile::tempdir().expect("temporary search root");
    fs::write(root.path().join("before.txt"), "before").expect("initial fixture");

    assert!(result_names("before", root.path()).contains(&"before.txt".to_string()));
    fs::remove_file(root.path().join("before.txt")).expect("remove initial fixture");
    fs::write(root.path().join("after.txt"), "after").expect("changed fixture");

    assert!(result_names("after", root.path()).contains(&"after.txt".to_string()));
    assert_eq!(walk_count_for_test(root.path()), 2);
}

#[test]
fn issue_651_watcher_invalidation_refreshes_search_command_results() {
    let root = tempfile::tempdir().expect("temporary search root");
    fs::write(root.path().join("before.txt"), "before").expect("initial fixture");
    mark_directory_watched_for_test(root.path());

    assert!(result_names("before", root.path()).contains(&"before.txt".to_string()));
    fs::remove_file(root.path().join("before.txt")).expect("remove initial fixture");
    fs::write(root.path().join("after.txt"), "after").expect("changed fixture");
    invalidate_directory_caches_for_change(root.path());

    assert!(result_names("after", root.path()).contains(&"after.txt".to_string()));
    assert_eq!(walk_count_for_test(root.path()), 2);
}

#[test]
fn issue_651_cancelled_stream_walk_never_returns_a_partial_listing() {
    let root = tempfile::tempdir().expect("temporary search root");
    for index in 0..100 {
        fs::write(
            root.path().join(format!("entry-{index}.txt")),
            index.to_string(),
        )
        .expect("search fixture");
    }
    let cancelled = AtomicBool::new(false);
    let mut seen: Vec<Walked> = Vec::new();

    let completed = walk_streaming_entries(
        root.path(),
        &|| cancelled.load(Ordering::Relaxed),
        &mut |entry| {
            seen.push(entry);
            cancelled.store(true, Ordering::Relaxed);
        },
    );

    assert!(!seen.is_empty(), "the walk must start before cancellation");
    assert!(
        completed.is_none(),
        "a cancelled walk must not return a publishable listing"
    );
}
