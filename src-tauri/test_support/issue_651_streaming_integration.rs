use super::{
    cancel_search, install_stream_gate_for_test, lock_test_cache_commands,
    start_streaming_search_with_sink, stream_trace, stream_walk_count_for_test, SearchResultsEvent,
    SearchResultsSink, SEARCH_ENTRY_CACHE,
};
use crate::files::fs_watcher::{
    acquire_directory, arm_search_watch_for_test, init_watcher, native_search_change_for_test,
    release_directory, retire_owners,
};
use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

/// A published search event stamped when the sink received it.
struct Received {
    at: Instant,
    event: SearchResultsEvent,
}

/// Lossless observer for the streaming command. A Tauri Rust listener is not
/// one: an emit that finds the listener table locked by any concurrent emit
/// (here, the watcher's `directory-changed` flush) is parked until a later
/// emit with a matching listener flushes it, so a final `done` can never
/// arrive (#1215).
struct RecordingSink(Sender<Received>);

impl SearchResultsSink for RecordingSink {
    fn publish(&self, event: SearchResultsEvent) {
        let _ = self.0.send(Received {
            at: Instant::now(),
            event,
        });
    }
}

struct Searches {
    sink: Sender<Received>,
    events: Receiver<Received>,
}

impl Searches {
    fn new() -> Self {
        let (sink, events) = mpsc::channel();
        Self { sink, events }
    }

    fn start(&self, root: &Path, query: &str) -> u64 {
        tauri::async_runtime::block_on(start_streaming_search_with_sink(
            RecordingSink(self.sink.clone()),
            query.to_string(),
            root.to_string_lossy().into_owned(),
            20,
            None,
        ))
        .expect("start streaming Quick Open search")
    }
}

/// A hang guard, not a performance budget: fixture walks complete in
/// milliseconds even under heavy CPU contention (#1215).
const COMPLETION_WAIT: Duration = Duration::from_secs(5);
const MAX_REPORTED_EVENTS: usize = 32;

fn wait_for_done(searches: &Searches, search_id: u64) -> Vec<String> {
    let waiting_since = Instant::now();
    let deadline = waiting_since + COMPLETION_WAIT;
    let mut unrelated = VecDeque::new();
    let mut unrelated_total = 0usize;
    loop {
        let received = match searches
            .events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(received) => received,
            Err(error) => panic!(
                "{}",
                completion_timeout_report(
                    search_id,
                    waiting_since,
                    error,
                    &unrelated,
                    unrelated_total
                )
            ),
        };
        let event = received.event;
        if event.search_id != search_id || !event.done {
            unrelated_total += 1;
            if unrelated.len() == MAX_REPORTED_EVENTS {
                unrelated.pop_front();
            }
            unrelated.push_back(format!(
                "{} searchId={} done={} results={} scanned={}",
                offset(received.at, waiting_since),
                event.search_id,
                event.done,
                event.results.len(),
                event.total_scanned,
            ));
            continue;
        }
        return event
            .results
            .into_iter()
            .map(|result| result.name)
            .collect();
    }
}

fn offset(at: Instant, origin: Instant) -> String {
    match at.checked_duration_since(origin) {
        Some(after) => format!("+{after:?}"),
        None => format!("-{:?}", origin - at),
    }
}

/// Name what a timed-out completion wait was blocked on, from the worker's
/// last recorded phase (#1215).
fn completion_timeout_report(
    search_id: u64,
    waiting_since: Instant,
    error: mpsc::RecvTimeoutError,
    unrelated: &VecDeque<String>,
    unrelated_total: usize,
) -> String {
    let phases = stream_trace::phases(search_id);
    let awaited = match phases.last().map(|phase| phase.name) {
        None => "worker thread start",
        Some("worker-started") => "recursive watch registration",
        Some("registration-finished") => "walk start",
        Some("walk-started") => "walk completion",
        Some("walk-finished") => "completion emission",
        Some("completion-publishing") => "completion publication",
        Some("completion-published") => "test-thread receipt of the published completion",
        Some("completion-suppressed") => "nothing: the worker cancelled itself",
        Some(_) => "unknown phase",
    };
    let phase_lines: Vec<String> = phases
        .iter()
        .map(|phase| {
            format!(
                "  {} {} {}",
                offset(phase.at, waiting_since),
                phase.name,
                phase.detail
            )
        })
        .collect();
    format!(
        "completed streaming search event: {error:?} for search {search_id} after {:?} (deadline {COMPLETION_WAIT:?}); awaiting {awaited}\n\
         worker phases relative to wait start:\n{}\n\
         other events received while waiting (last {} of {unrelated_total}):\n  {}",
        waiting_since.elapsed(),
        if phase_lines.is_empty() { "  (none recorded)".to_string() } else { phase_lines.join("\n") },
        unrelated.len(),
        unrelated.iter().cloned().collect::<Vec<_>>().join("\n  "),
    )
}

/// Arm before taking the revision a write must advance: arming can itself
/// rebuild coverage (and advance the epoch) after an overlapping root's
/// release, and a write that lands before the rebuild is never acknowledged
/// by the generation being retired (#1152).
fn arm_recursive_watch(root: &Path) {
    assert!(
        arm_search_watch_for_test(root),
        "recursive watch must be armed before the write it acknowledges"
    );
}

fn wait_for_revision_change(root: &Path, revision: u64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while SEARCH_ENTRY_CACHE.begin_load(root) == revision {
        assert!(
            Instant::now() < deadline,
            "real filesystem watcher did not invalidate the Quick Open cache"
        );
        std::thread::yield_now();
    }
    assert!(SEARCH_ENTRY_CACHE.completed(root).is_none());
}

#[test]
fn issue_651_real_streaming_command_reuses_refreshes_and_cancels_listings() {
    let _cache_guard = lock_test_cache_commands();
    // The watcher's flush thread emits app events; searches publish to their
    // own sink, so watcher traffic cannot delay or strand a completion.
    let app = tauri::test::mock_app();
    init_watcher(app.handle());
    let owner = crate::renderer_owner::Owner::default();
    let watch_directory = |path| acquire_directory(owner.clone(), path);
    let unwatch_directory = |id| release_directory(owner.clone(), id);
    let searches = Searches::new();

    // Native delivery may invalidate a freshly scanned listing after setup.
    // Exact reuse counts belong in the controlled command/cache tests below;
    // this fixture verifies real observation, results and stale-publication safety.
    // Keep the native parent-role watch inside this fixture. Creating every
    // root before registration avoids intentional writes during cache reuse,
    // while still allowing delayed native notifications to invalidate it.
    let fixture_parent = tempfile::tempdir().expect("private watcher fixture parent");
    let watched = tempfile::tempdir_in(fixture_parent.path()).expect("watched search root");
    let overlap_parent =
        tempfile::tempdir_in(fixture_parent.path()).expect("overlapping parent search root");
    let rewatched = tempfile::tempdir_in(fixture_parent.path()).expect("rewatched search root");
    // Keep owner retirement independent of namespace changes from earlier roots.
    let retired = tempfile::tempdir().expect("independent retired-owner search root");
    let cancelled_root =
        tempfile::tempdir_in(fixture_parent.path()).expect("cancelled search root");
    let racing_root = tempfile::tempdir_in(fixture_parent.path()).expect("racing search root");
    let unwatched = tempfile::tempdir_in(fixture_parent.path()).expect("unwatched search root");
    let overlap_child = overlap_parent.path().join("child");
    let overlap_deep = overlap_child.join("deep");
    fs::create_dir_all(&overlap_deep).expect("overlapping child fixture directory");

    fs::write(overlap_deep.join("before-overlap.txt"), "before")
        .expect("overlapping nested fixture");

    fs::write(watched.path().join("alpha.txt"), "alpha").expect("alpha fixture");
    fs::write(watched.path().join("beta.txt"), "beta").expect("beta fixture");
    let nested = watched.path().join("nested");
    fs::create_dir(&nested).expect("nested fixture directory");
    fs::write(nested.join("before-nested.txt"), "before").expect("nested fixture");
    tauri::async_runtime::block_on(watch_directory(
        watched.path().to_string_lossy().into_owned(),
    ))
    .expect("watch search root");

    let alpha_id = searches.start(watched.path(), "alpha");
    assert!(wait_for_done(&searches, alpha_id).contains(&"alpha.txt".to_string()));
    let beta_id = searches.start(watched.path(), "beta");
    assert!(wait_for_done(&searches, beta_id).contains(&"beta.txt".to_string()));

    arm_recursive_watch(watched.path());
    let revision = SEARCH_ENTRY_CACHE.begin_load(watched.path());
    let changed = watched.path().join("after.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::write(&changed, "after").expect("watcher fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(watched.path(), revision);
    let after_id = searches.start(watched.path(), "after");
    assert!(wait_for_done(&searches, after_id).contains(&"after.txt".to_string()));

    arm_recursive_watch(watched.path());
    let revision = SEARCH_ENTRY_CACHE.begin_load(watched.path());
    let changed = nested.join("after-nested.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::remove_file(nested.join("before-nested.txt")).expect("remove nested fixture");
    fs::write(&changed, "after").expect("changed nested fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(watched.path(), revision);
    let nested_id = searches.start(watched.path(), "after-nested");
    assert!(
        wait_for_done(&searches, nested_id).contains(&"after-nested.txt".to_string()),
        "a nested descendant change must invalidate the recursive listing"
    );

    let overlap_parent_path = overlap_parent.path().to_string_lossy().into_owned();
    let overlap_child_path = overlap_child.to_string_lossy().into_owned();
    let parent_lease = tauri::async_runtime::block_on(watch_directory(overlap_parent_path.clone()))
        .expect("watch overlapping parent root");
    tauri::async_runtime::block_on(watch_directory(overlap_child_path.clone()))
        .expect("watch overlapping child root");

    let parent_overlap_id = searches.start(overlap_parent.path(), "before-overlap");
    assert!(wait_for_done(&searches, parent_overlap_id).contains(&"before-overlap.txt".to_string()));
    let child_uncovered_revision = SEARCH_ENTRY_CACHE.begin_load(&overlap_child);
    let child_overlap_id = searches.start(&overlap_child, "before-overlap");
    assert!(wait_for_done(&searches, child_overlap_id).contains(&"before-overlap.txt".to_string()));
    assert_ne!(
        SEARCH_ENTRY_CACHE.begin_load(&overlap_child),
        child_uncovered_revision,
        "establishing recursive coverage must start a fresh cache epoch"
    );
    let parent_reuse_id = searches.start(overlap_parent.path(), "before-overlap");
    assert!(wait_for_done(&searches, parent_reuse_id).contains(&"before-overlap.txt".to_string()));

    tauri::async_runtime::block_on(unwatch_directory(parent_lease.id))
        .expect("remove overlapping parent watch");
    let child_recache_id = searches.start(&overlap_child, "before-overlap");
    assert!(wait_for_done(&searches, child_recache_id).contains(&"before-overlap.txt".to_string()));

    arm_recursive_watch(&overlap_child);
    let revision = SEARCH_ENTRY_CACHE.begin_load(&overlap_child);
    let changed = overlap_deep.join("after-overlap.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::remove_file(overlap_deep.join("before-overlap.txt"))
        .expect("remove overlapping nested fixture");
    fs::write(&changed, "after").expect("changed overlapping nested fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(&overlap_child, revision);
    let changed_overlap_id = searches.start(&overlap_child, "after-overlap");
    assert!(
        wait_for_done(&searches, changed_overlap_id).contains(&"after-overlap.txt".to_string()),
        "the child cache watch must survive removal of an overlapping parent"
    );

    fs::write(rewatched.path().join("before-gap.txt"), "before").expect("pre-unwatch fixture");
    let rewatched_path = rewatched.path().to_string_lossy().into_owned();
    let gap_lease = tauri::async_runtime::block_on(watch_directory(rewatched_path.clone()))
        .expect("watch cache epoch root");
    let before_gap_id = searches.start(rewatched.path(), "before-gap");
    assert!(wait_for_done(&searches, before_gap_id).contains(&"before-gap.txt".to_string()));

    tauri::async_runtime::block_on(unwatch_directory(gap_lease.id))
        .expect("remove final cache epoch watch");
    fs::remove_file(rewatched.path().join("before-gap.txt")).expect("remove pre-unwatch fixture");
    fs::write(rewatched.path().join("after-gap.txt"), "after").expect("post-unwatch fixture");
    tauri::async_runtime::block_on(watch_directory(rewatched_path))
        .expect("rewatch cache epoch root");

    let after_gap_id = searches.start(rewatched.path(), "after-gap");
    assert!(
        wait_for_done(&searches, after_gap_id).contains(&"after-gap.txt".to_string()),
        "rewatching within the TTL must not reuse the pre-unwatch listing"
    );

    fs::write(retired.path().join("before-owner-retirement.txt"), "before")
        .expect("pre-retirement fixture");
    let retired_path = retired.path().to_string_lossy().into_owned();
    let first_owner = crate::renderer_owner::Owner::default();
    let final_owner = crate::renderer_owner::Owner::default();
    tauri::async_runtime::block_on(acquire_directory(first_owner.clone(), retired_path.clone()))
        .expect("watch retirement root for first owner");
    tauri::async_runtime::block_on(acquire_directory(final_owner.clone(), retired_path.clone()))
        .expect("share retirement root with final owner");

    let before_retirement_id = searches.start(retired.path(), "owner-retirement");
    assert!(wait_for_done(&searches, before_retirement_id)
        .contains(&"before-owner-retirement.txt".to_string()));

    first_owner.retire();
    retire_owners();
    // acquire() performs maintenance while holding the real watcher lock. The
    // additional shared lease makes the first retirement deterministic here
    // without introducing another init_watcher singleton or a timing sleep.
    let maintenance_lease = tauri::async_runtime::block_on(acquire_directory(
        final_owner.clone(),
        retired_path.clone(),
    ))
    .expect("maintain the shared watch after first-owner retirement");
    tauri::async_runtime::block_on(release_directory(final_owner.clone(), maintenance_lease.id))
        .expect("release maintenance lease");
    let shared_reuse_id = searches.start(retired.path(), "owner-retirement");
    assert!(wait_for_done(&searches, shared_reuse_id)
        .contains(&"before-owner-retirement.txt".to_string()));

    arm_recursive_watch(retired.path());
    let revision = SEARCH_ENTRY_CACHE.begin_load(retired.path());
    let changed = retired.path().join("cold-trigger.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::write(&changed, "trigger").expect("cold retirement fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(retired.path(), revision);
    let gate = install_stream_gate_for_test(retired.path());
    let cold_revision = SEARCH_ENTRY_CACHE.begin_load(retired.path());
    let retiring_walk_id = searches.start(retired.path(), "owner-retirement");
    gate.started.wait();

    final_owner.retire();
    retire_owners();
    wait_for_revision_change(retired.path(), cold_revision);
    fs::remove_file(retired.path().join("before-owner-retirement.txt"))
        .expect("remove pre-retirement fixture");
    fs::write(retired.path().join("after-owner-retirement.txt"), "after")
        .expect("post-retirement fixture");
    gate.release.wait();
    let _ = wait_for_done(&searches, retiring_walk_id);
    assert!(
        SEARCH_ENTRY_CACHE.completed(retired.path()).is_none(),
        "a cold walk that overlaps final-owner retirement must not publish into the retired epoch"
    );

    let replacement_owner = crate::renderer_owner::Owner::default();
    let replacement_lease =
        tauri::async_runtime::block_on(acquire_directory(replacement_owner.clone(), retired_path))
            .expect("rewatch after final-owner retirement");
    let after_retirement_id = searches.start(retired.path(), "owner-retirement");
    let after_retirement = wait_for_done(&searches, after_retirement_id);
    assert!(after_retirement.contains(&"after-owner-retirement.txt".to_string()));
    assert!(!after_retirement.contains(&"before-owner-retirement.txt".to_string()));
    tauri::async_runtime::block_on(release_directory(replacement_owner, replacement_lease.id))
        .expect("release replacement retirement-root watch");

    for index in 0..100 {
        fs::write(
            cancelled_root.path().join(format!("entry-{index}.txt")),
            index.to_string(),
        )
        .expect("cancelled fixture");
    }
    tauri::async_runtime::block_on(watch_directory(
        cancelled_root.path().to_string_lossy().into_owned(),
    ))
    .expect("watch cancelled root");
    let gate = install_stream_gate_for_test(cancelled_root.path());
    let cancelled_id = searches.start(cancelled_root.path(), "entry");
    gate.started.wait();
    tauri::async_runtime::block_on(cancel_search(cancelled_id)).expect("cancel streaming search");
    gate.release.wait();
    assert!(SEARCH_ENTRY_CACHE
        .completed(cancelled_root.path())
        .is_none());
    let retry_id = searches.start(cancelled_root.path(), "entry-99");
    assert!(wait_for_done(&searches, retry_id).contains(&"entry-99.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(cancelled_root.path()), 2);

    fs::write(racing_root.path().join("seed.txt"), "seed").expect("race seed fixture");
    tauri::async_runtime::block_on(watch_directory(
        racing_root.path().to_string_lossy().into_owned(),
    ))
    .expect("watch racing root");
    let gate = install_stream_gate_for_test(racing_root.path());
    let racing_id = searches.start(racing_root.path(), "seed");
    gate.started.wait();
    // The cold walk establishes recursive coverage before reaching this gate,
    // which itself advances the epoch. Observe only invalidation after that
    // transition so registration cannot stand in for receipt of our write.
    arm_recursive_watch(racing_root.path());
    let revision = SEARCH_ENTRY_CACHE.begin_load(racing_root.path());
    let changed = racing_root.path().join("raced.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::write(&changed, "raced").expect("raced fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(racing_root.path(), revision);
    gate.release.wait();
    assert!(wait_for_done(&searches, racing_id).contains(&"seed.txt".to_string()));
    assert!(
        SEARCH_ENTRY_CACHE.completed(racing_root.path()).is_none(),
        "a watcher event during a cold stream must prevent stale publication"
    );
    let raced_id = searches.start(racing_root.path(), "raced");
    assert!(wait_for_done(&searches, raced_id).contains(&"raced.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(racing_root.path()), 2);

    // Cancellation crosses the actual streaming command / watcher boundary.
    // Reverting the cancellation-token forwarding leaves this root covered.
    let registration_root = tempfile::tempdir().unwrap();
    fs::write(registration_root.path().join("needle.txt"), "entry").unwrap();
    let registration_lease = tauri::async_runtime::block_on(watch_directory(
        registration_root.path().to_string_lossy().into_owned(),
    ))
    .unwrap();
    let (entered, release) =
        crate::files::fs_watcher::change_tests::gate_registration(registration_root.path());
    let registration_id = searches.start(registration_root.path(), "needle");
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    tauri::async_runtime::block_on(cancel_search(registration_id)).unwrap();
    release.send(()).unwrap();
    crate::files::fs_watcher::settle_search_watch_for_test();
    assert!(
        !crate::files::fs_watcher::is_search_cache_watched(registration_root.path()),
        "cancelled streaming registration must leave no recursive demand"
    );
    assert!(SEARCH_ENTRY_CACHE
        .completed(registration_root.path())
        .is_none());
    assert_eq!(stream_walk_count_for_test(registration_root.path()), 0);
    tauri::async_runtime::block_on(unwatch_directory(registration_lease.id)).unwrap();

    fs::write(unwatched.path().join("before.txt"), "before").expect("unwatched fixture");
    let before_id = searches.start(unwatched.path(), "before");
    assert!(wait_for_done(&searches, before_id).contains(&"before.txt".to_string()));
    fs::remove_file(unwatched.path().join("before.txt")).expect("remove unwatched fixture");
    fs::write(unwatched.path().join("new.txt"), "new").expect("new unwatched fixture");
    let new_id = searches.start(unwatched.path(), "new");
    assert!(wait_for_done(&searches, new_id).contains(&"new.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(unwatched.path()), 2);
}

#[test]
fn issue_974_controlled_streaming_queries_reuse_and_invalidate_completed_listings() {
    let _cache_guard = lock_test_cache_commands();
    let searches = Searches::new();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("alpha.txt"), "alpha").unwrap();
    fs::write(root.path().join("beta.txt"), "beta").unwrap();
    crate::files::fs_watcher::mark_directory_watched_for_test(root.path());
    let alpha = searches.start(root.path(), "alpha");
    assert!(wait_for_done(&searches, alpha).contains(&"alpha.txt".to_string()));
    let beta = searches.start(root.path(), "beta");
    assert!(wait_for_done(&searches, beta).contains(&"beta.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(root.path()), 1);

    fs::remove_file(root.path().join("alpha.txt")).unwrap();
    fs::write(root.path().join("after.txt"), "after").unwrap();
    crate::files::fs_watcher::invalidate_directory_caches_for_change(root.path());
    let after = searches.start(root.path(), "after");
    assert!(wait_for_done(&searches, after).contains(&"after.txt".to_string()));
    let removed = searches.start(root.path(), "alpha");
    assert!(!wait_for_done(&searches, removed).contains(&"alpha.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(root.path()), 2);

    let nested = root.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("descendant.txt"), "descendant").unwrap();
    crate::files::fs_watcher::invalidate_directory_caches_for_change(&nested);
    let descendant = searches.start(root.path(), "descendant");
    assert!(wait_for_done(&searches, descendant).contains(&"descendant.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(root.path()), 3);
}

/// The command's production sink is the app event the Quick Open frontend
/// listens to. Only one emitter runs here, so a Rust listener observes it.
#[test]
fn app_sink_publishes_the_search_results_event_payload() {
    use tauri::Listener;
    let app = tauri::test::mock_app();
    let (sender, receiver) = mpsc::channel();
    app.listen("search-results", move |event| {
        let _ = sender.send(event.payload().to_string());
    });

    app.handle().publish(SearchResultsEvent {
        search_id: 7,
        results: vec![super::SearchResult {
            name: "needle.txt".into(),
            path: "/root/nested/needle.txt".into(),
            relative_path: "nested/needle.txt".into(),
            score: 42,
            kind: "file".into(),
        }],
        done: true,
        total_scanned: 3,
    });

    let payload: serde_json::Value = serde_json::from_str(
        &receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("search-results event"),
    )
    .expect("search event JSON");
    assert_eq!(
        payload,
        serde_json::json!({
            "searchId": 7,
            "results": [{
                "name": "needle.txt",
                "path": "/root/nested/needle.txt",
                "relativePath": "nested/needle.txt",
                "score": 42,
                "kind": "file",
            }],
            "done": true,
            "totalScanned": 3,
        })
    );
}
