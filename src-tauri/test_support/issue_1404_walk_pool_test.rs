//! A busy rayon pool must not turn a Quick Open walk into a complete, empty
//! result (#1404, `docs/lessons/1404-quick-open-threadpool-busy.md`).

use super::{
    fuzzy_search_sync, lock_test_cache_commands, override_walk_parallelism_for_test,
    start_streaming_search_with_sink, stream_walk_count_for_test, walk_count_for_test,
    SearchResultsEvent, SearchResultsSink, SEARCH_ENTRY_CACHE,
};
use jwalk::Parallelism;
use std::fs;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Barrier};
use std::time::Duration;

/// Hang guard only: fixture walks finish in milliseconds.
const COMPLETION_WAIT: Duration = Duration::from_secs(10);

struct ChannelSink(Sender<SearchResultsEvent>);

impl SearchResultsSink for ChannelSink {
    fn publish(&self, event: SearchResultsEvent) {
        let _ = self.0.send(event);
    }
}

struct Searches {
    sink: Sender<SearchResultsEvent>,
    events: Receiver<SearchResultsEvent>,
}

impl Searches {
    fn new() -> Self {
        let (sink, events) = mpsc::channel();
        Self { sink, events }
    }

    fn start(&self, root: &Path, query: &str) -> u64 {
        tauri::async_runtime::block_on(start_streaming_search_with_sink(
            ChannelSink(self.sink.clone()),
            query.to_string(),
            root.to_string_lossy().into_owned(),
            20,
            None,
        ))
        .expect("start streaming Quick Open search")
    }

    /// Names in the search's `done` event.
    fn wait_for_done(&self, search_id: u64) -> Vec<String> {
        loop {
            let event = self
                .events
                .recv_timeout(COMPLETION_WAIT)
                .expect("streaming search completion");
            if event.search_id == search_id && event.done {
                return event.results.into_iter().map(|r| r.name).collect();
            }
        }
    }
}

/// A watched root whose walk needs the pool: the needle sits beside enough
/// subdirectories that jwalk schedules parallel `read_dir` work.
fn needle_fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().expect("search root");
    fs::write(root.path().join("needle.txt"), "needle").expect("needle fixture");
    for index in 0..32 {
        let dir = root.path().join(format!("dir-{index}"));
        fs::create_dir(&dir).expect("fixture directory");
        fs::write(dir.join("leaf.txt"), "leaf").expect("fixture leaf");
    }
    crate::files::fs_watcher::mark_directory_watched_for_test(root.path());
    root
}

fn cached_names(root: &Path) -> Option<Vec<String>> {
    SEARCH_ENTRY_CACHE
        .completed(root)
        .map(|entries| entries.iter().map(|entry| entry.name.clone()).collect())
}

/// Occupy every thread of rayon's global pool until the returned barrier is
/// released. Process-wide, so it only ever runs in its own test process.
fn saturate_global_pool() -> Arc<Barrier> {
    let threads = rayon::current_num_threads();
    let release = Arc::new(Barrier::new(threads + 1));
    let (started, all_started) = mpsc::channel();
    for _ in 0..threads {
        let release = Arc::clone(&release);
        let started = started.clone();
        rayon::spawn(move || {
            let _ = started.send(());
            release.wait();
        });
    }
    for _ in 0..threads {
        all_started
            .recv_timeout(COMPLETION_WAIT)
            .expect("every global pool thread is blocked");
    }
    release
}

const SATURATED_CHILD_ENV: &str = "TE_ISSUE_1404_SATURATED_POOL_CHILD";
const SATURATED_CHILD_TEST: &str =
    "search::issue_1404_walk_pool_tests::saturated_global_pool_search_child";

/// Body of the test below. It blocks rayon's global pool for longer than
/// jwalk's default 1 s busy timeout, which would fail unrelated tests sharing
/// the process, so it is ignored and does nothing unless that test runs it.
#[test]
#[ignore = "run in its own process by busy_global_rayon_pool_does_not_empty_quick_open"]
fn saturated_global_pool_search_child() {
    if std::env::var_os(SATURATED_CHILD_ENV).is_none() {
        return;
    }
    let _cache_guard = lock_test_cache_commands();
    let root = needle_fixture();
    let searches = Searches::new();

    let release = saturate_global_pool();
    let search_id = searches.start(root.path(), "needle");
    let names = searches.wait_for_done(search_id);
    let cached = cached_names(root.path());
    release.wait();

    assert!(
        names.contains(&"needle.txt".to_string()),
        "a busy global pool emptied the completed search: {names:?}"
    );
    if let Some(cached) = cached {
        assert!(
            cached.contains(&"needle.txt".to_string()),
            "an incomplete walk was published to the search cache: {cached:?}"
        );
    }
}

#[test]
fn busy_global_rayon_pool_does_not_empty_quick_open() {
    let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--ignored", "--exact", SATURATED_CHILD_TEST, "--nocapture"])
        .env(SATURATED_CHILD_ENV, "1")
        .output()
        .expect("run the saturated-pool search in its own process");
    let stdout = String::from_utf8_lossy(&output.stdout);
    // A filter that matched nothing would also exit successfully.
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "saturated-pool child failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A pool whose only thread is held until the returned sender is dropped, and
/// a walk scheduling that gives up on it quickly: jwalk then reports
/// `ThreadpoolBusy`, the error a saturated global pool produced in #1404.
fn refusing_parallelism() -> (Parallelism, mpsc::Sender<()>) {
    let pool = Arc::new(
        rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .expect("single-thread pool"),
    );
    let (started, has_started) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    pool.spawn(move || {
        let _ = started.send(());
        let _ = released.recv();
    });
    has_started
        .recv_timeout(COMPLETION_WAIT)
        .expect("the pool's only thread is held");
    let parallelism = Parallelism::RayonExistingPool {
        pool,
        busy_timeout: Some(Duration::from_millis(50)),
    };
    (parallelism, release)
}

#[test]
fn a_failed_streaming_walk_completes_the_stream_but_is_never_cached() {
    let _cache_guard = lock_test_cache_commands();
    let root = needle_fixture();
    let searches = Searches::new();

    let (parallelism, release) = refusing_parallelism();
    override_walk_parallelism_for_test(root.path(), parallelism);
    let refused = searches.start(root.path(), "needle");
    // The stream still finishes, so Quick Open stops loading (UI contract).
    searches.wait_for_done(refused);
    drop(release);
    assert_eq!(
        cached_names(root.path()),
        None,
        "a refused walk was published to the search cache as the whole tree"
    );

    let retried = searches.start(root.path(), "needle");
    assert!(searches
        .wait_for_done(retried)
        .contains(&"needle.txt".to_string()));
    assert_eq!(
        stream_walk_count_for_test(root.path()),
        2,
        "the next search must walk the tree again"
    );
    assert!(cached_names(root.path()).is_some_and(|names| names.contains(&"needle.txt".into())));
}

#[test]
fn a_failed_listing_walk_is_never_cached() {
    let _cache_guard = lock_test_cache_commands();
    let root = needle_fixture();
    let search = |query: &str| {
        fuzzy_search_sync(
            query.into(),
            root.path().to_string_lossy().into_owned(),
            20,
            None,
        )
        .expect("non-streaming Quick Open search")
        .results
        .into_iter()
        .map(|result| result.name)
        .collect::<Vec<_>>()
    };

    let (parallelism, release) = refusing_parallelism();
    override_walk_parallelism_for_test(root.path(), parallelism);
    search("needle");
    drop(release);
    assert_eq!(cached_names(root.path()), None);

    assert!(search("needle").contains(&"needle.txt".to_string()));
    assert_eq!(walk_count_for_test(root.path()), 2);
}

/// An unreadable directory is a stable part of the tree, not a walk failure:
/// treating it as one would silently disable the cache for any root holding a
/// directory the user cannot open.
#[cfg(unix)]
#[test]
fn an_unreadable_directory_does_not_disable_the_cache() {
    use std::os::unix::fs::PermissionsExt;
    let _cache_guard = lock_test_cache_commands();
    let root = needle_fixture();
    let locked = root.path().join("locked");
    fs::create_dir(&locked).expect("locked fixture directory");
    fs::write(locked.join("secret.txt"), "secret").expect("locked fixture file");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("lock directory");
    if fs::read_dir(&locked).is_ok() {
        // Privileged runners ignore directory permissions.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("unlock");
        return;
    }
    let searches = Searches::new();
    let search_id = searches.start(root.path(), "needle");
    let names = searches.wait_for_done(search_id);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).expect("unlock directory");

    assert!(names.contains(&"needle.txt".to_string()));
    let cached = cached_names(root.path()).expect("the listing is cached");
    assert!(cached.contains(&"locked".to_string()));
    assert!(!cached.contains(&"secret.txt".to_string()));
}
