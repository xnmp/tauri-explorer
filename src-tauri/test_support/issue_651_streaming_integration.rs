use super::{
    cancel_search, install_stream_gate_for_test, start_streaming_search_with_runtime,
    stream_walk_count_for_test, SEARCH_ENTRY_CACHE,
};
use crate::files::fs_watcher::{
    acquire_directory, init_watcher, native_search_change_for_test, release_directory,
    retire_owners,
};
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};
use tauri::Listener;

fn start_search<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path, query: &str) -> u64 {
    tauri::async_runtime::block_on(start_streaming_search_with_runtime(
        app.clone(),
        query.to_string(),
        root.to_string_lossy().into_owned(),
        20,
        None,
    ))
    .expect("start streaming Quick Open search")
}

fn wait_for_done(receiver: &Receiver<String>, search_id: u64) -> Vec<String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let payload = receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("completed streaming search event");
        let event: Value = serde_json::from_str(&payload).expect("search event JSON");
        if event["searchId"].as_u64() != Some(search_id) || event["done"] != true {
            continue;
        }
        return event["results"]
            .as_array()
            .expect("search results array")
            .iter()
            .filter_map(|result| result["name"].as_str().map(str::to_string))
            .collect();
    }
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
    let _cache_guard = super::TEST_CACHE_COMMANDS.lock().unwrap();
    let app = tauri::test::mock_app();
    let app_handle = app.handle().clone();
    init_watcher(&app_handle);
    let owner = crate::renderer_owner::Owner::default();
    let watch_directory = |path| acquire_directory(owner.clone(), path);
    let unwatch_directory = |id| release_directory(owner.clone(), id);
    let (sender, receiver) = mpsc::channel();
    app_handle.listen("search-results", move |event| {
        sender
            .send(event.payload().to_string())
            .expect("record search event");
    });

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

    let alpha_id = start_search(&app_handle, watched.path(), "alpha");
    assert!(wait_for_done(&receiver, alpha_id).contains(&"alpha.txt".to_string()));
    let beta_id = start_search(&app_handle, watched.path(), "beta");
    assert!(wait_for_done(&receiver, beta_id).contains(&"beta.txt".to_string()));

    let revision = SEARCH_ENTRY_CACHE.begin_load(watched.path());
    let changed = watched.path().join("after.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::write(&changed, "after").expect("watcher fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(watched.path(), revision);
    let after_id = start_search(&app_handle, watched.path(), "after");
    assert!(wait_for_done(&receiver, after_id).contains(&"after.txt".to_string()));

    let revision = SEARCH_ENTRY_CACHE.begin_load(watched.path());
    let changed = nested.join("after-nested.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::remove_file(nested.join("before-nested.txt")).expect("remove nested fixture");
    fs::write(&changed, "after").expect("changed nested fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(watched.path(), revision);
    let nested_id = start_search(&app_handle, watched.path(), "after-nested");
    assert!(
        wait_for_done(&receiver, nested_id).contains(&"after-nested.txt".to_string()),
        "a nested descendant change must invalidate the recursive listing"
    );

    let overlap_parent_path = overlap_parent.path().to_string_lossy().into_owned();
    let overlap_child_path = overlap_child.to_string_lossy().into_owned();
    let parent_lease = tauri::async_runtime::block_on(watch_directory(overlap_parent_path.clone()))
        .expect("watch overlapping parent root");
    tauri::async_runtime::block_on(watch_directory(overlap_child_path.clone()))
        .expect("watch overlapping child root");

    let parent_overlap_id = start_search(&app_handle, overlap_parent.path(), "before-overlap");
    assert!(wait_for_done(&receiver, parent_overlap_id).contains(&"before-overlap.txt".to_string()));
    let child_uncovered_revision = SEARCH_ENTRY_CACHE.begin_load(&overlap_child);
    let child_overlap_id = start_search(&app_handle, &overlap_child, "before-overlap");
    assert!(wait_for_done(&receiver, child_overlap_id).contains(&"before-overlap.txt".to_string()));
    assert_ne!(
        SEARCH_ENTRY_CACHE.begin_load(&overlap_child),
        child_uncovered_revision,
        "establishing recursive coverage must start a fresh cache epoch"
    );
    let parent_reuse_id = start_search(&app_handle, overlap_parent.path(), "before-overlap");
    assert!(wait_for_done(&receiver, parent_reuse_id).contains(&"before-overlap.txt".to_string()));

    tauri::async_runtime::block_on(unwatch_directory(parent_lease.id))
        .expect("remove overlapping parent watch");
    let child_recache_id = start_search(&app_handle, &overlap_child, "before-overlap");
    assert!(wait_for_done(&receiver, child_recache_id).contains(&"before-overlap.txt".to_string()));

    let revision = SEARCH_ENTRY_CACHE.begin_load(&overlap_child);
    let changed = overlap_deep.join("after-overlap.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::remove_file(overlap_deep.join("before-overlap.txt"))
        .expect("remove overlapping nested fixture");
    fs::write(&changed, "after").expect("changed overlapping nested fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(&overlap_child, revision);
    let changed_overlap_id = start_search(&app_handle, &overlap_child, "after-overlap");
    assert!(
        wait_for_done(&receiver, changed_overlap_id).contains(&"after-overlap.txt".to_string()),
        "the child cache watch must survive removal of an overlapping parent"
    );

    fs::write(rewatched.path().join("before-gap.txt"), "before").expect("pre-unwatch fixture");
    let rewatched_path = rewatched.path().to_string_lossy().into_owned();
    let gap_lease = tauri::async_runtime::block_on(watch_directory(rewatched_path.clone()))
        .expect("watch cache epoch root");
    let before_gap_id = start_search(&app_handle, rewatched.path(), "before-gap");
    assert!(wait_for_done(&receiver, before_gap_id).contains(&"before-gap.txt".to_string()));

    tauri::async_runtime::block_on(unwatch_directory(gap_lease.id))
        .expect("remove final cache epoch watch");
    fs::remove_file(rewatched.path().join("before-gap.txt")).expect("remove pre-unwatch fixture");
    fs::write(rewatched.path().join("after-gap.txt"), "after").expect("post-unwatch fixture");
    tauri::async_runtime::block_on(watch_directory(rewatched_path))
        .expect("rewatch cache epoch root");

    let after_gap_id = start_search(&app_handle, rewatched.path(), "after-gap");
    assert!(
        wait_for_done(&receiver, after_gap_id).contains(&"after-gap.txt".to_string()),
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

    let before_retirement_id = start_search(&app_handle, retired.path(), "owner-retirement");
    assert!(wait_for_done(&receiver, before_retirement_id)
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
    let shared_reuse_id = start_search(&app_handle, retired.path(), "owner-retirement");
    assert!(wait_for_done(&receiver, shared_reuse_id)
        .contains(&"before-owner-retirement.txt".to_string()));

    let revision = SEARCH_ENTRY_CACHE.begin_load(retired.path());
    let changed = retired.path().join("cold-trigger.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::write(&changed, "trigger").expect("cold retirement fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(retired.path(), revision);
    let gate = install_stream_gate_for_test(retired.path());
    let cold_revision = SEARCH_ENTRY_CACHE.begin_load(retired.path());
    let retiring_walk_id = start_search(&app_handle, retired.path(), "owner-retirement");
    gate.started.wait();

    final_owner.retire();
    retire_owners();
    wait_for_revision_change(retired.path(), cold_revision);
    fs::remove_file(retired.path().join("before-owner-retirement.txt"))
        .expect("remove pre-retirement fixture");
    fs::write(retired.path().join("after-owner-retirement.txt"), "after")
        .expect("post-retirement fixture");
    gate.release.wait();
    let _ = wait_for_done(&receiver, retiring_walk_id);
    assert!(
        SEARCH_ENTRY_CACHE.completed(retired.path()).is_none(),
        "a cold walk that overlaps final-owner retirement must not publish into the retired epoch"
    );

    let replacement_owner = crate::renderer_owner::Owner::default();
    let replacement_lease =
        tauri::async_runtime::block_on(acquire_directory(replacement_owner.clone(), retired_path))
            .expect("rewatch after final-owner retirement");
    let after_retirement_id = start_search(&app_handle, retired.path(), "owner-retirement");
    let after_retirement = wait_for_done(&receiver, after_retirement_id);
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
    let cancelled_id = start_search(&app_handle, cancelled_root.path(), "entry");
    gate.started.wait();
    tauri::async_runtime::block_on(cancel_search(cancelled_id)).expect("cancel streaming search");
    gate.release.wait();
    assert!(SEARCH_ENTRY_CACHE
        .completed(cancelled_root.path())
        .is_none());
    let retry_id = start_search(&app_handle, cancelled_root.path(), "entry-99");
    assert!(wait_for_done(&receiver, retry_id).contains(&"entry-99.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(cancelled_root.path()), 2);

    fs::write(racing_root.path().join("seed.txt"), "seed").expect("race seed fixture");
    tauri::async_runtime::block_on(watch_directory(
        racing_root.path().to_string_lossy().into_owned(),
    ))
    .expect("watch racing root");
    let gate = install_stream_gate_for_test(racing_root.path());
    let racing_id = start_search(&app_handle, racing_root.path(), "seed");
    gate.started.wait();
    // The cold walk establishes recursive coverage before reaching this gate,
    // which itself advances the epoch. Observe only invalidation after that
    // transition so registration cannot stand in for receipt of our write.
    let revision = SEARCH_ENTRY_CACHE.begin_load(racing_root.path());
    let changed = racing_root.path().join("raced.txt");
    let receipt = native_search_change_for_test(&changed);
    let write_started = Instant::now();
    fs::write(&changed, "raced").expect("raced fixture");
    receipt.wait_after(write_started);
    wait_for_revision_change(racing_root.path(), revision);
    gate.release.wait();
    assert!(wait_for_done(&receiver, racing_id).contains(&"seed.txt".to_string()));
    assert!(
        SEARCH_ENTRY_CACHE.completed(racing_root.path()).is_none(),
        "a watcher event during a cold stream must prevent stale publication"
    );
    let raced_id = start_search(&app_handle, racing_root.path(), "raced");
    assert!(wait_for_done(&receiver, raced_id).contains(&"raced.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(racing_root.path()), 2);

    fs::write(unwatched.path().join("before.txt"), "before").expect("unwatched fixture");
    let before_id = start_search(&app_handle, unwatched.path(), "before");
    assert!(wait_for_done(&receiver, before_id).contains(&"before.txt".to_string()));
    fs::remove_file(unwatched.path().join("before.txt")).expect("remove unwatched fixture");
    fs::write(unwatched.path().join("new.txt"), "new").expect("new unwatched fixture");
    let new_id = start_search(&app_handle, unwatched.path(), "new");
    assert!(wait_for_done(&receiver, new_id).contains(&"new.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(unwatched.path()), 2);
}

#[test]
fn issue_974_controlled_streaming_queries_reuse_and_invalidate_completed_listings() {
    let _cache_guard = super::TEST_CACHE_COMMANDS.lock().unwrap();
    let app = tauri::test::mock_app();
    let app_handle = app.handle().clone();
    let (sender, receiver) = mpsc::channel();
    app_handle.listen("search-results", move |event| {
        sender.send(event.payload().to_string()).unwrap();
    });
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("alpha.txt"), "alpha").unwrap();
    fs::write(root.path().join("beta.txt"), "beta").unwrap();
    crate::files::fs_watcher::mark_directory_watched_for_test(root.path());
    let alpha = start_search(&app_handle, root.path(), "alpha");
    assert!(wait_for_done(&receiver, alpha).contains(&"alpha.txt".to_string()));
    let beta = start_search(&app_handle, root.path(), "beta");
    assert!(wait_for_done(&receiver, beta).contains(&"beta.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(root.path()), 1);

    fs::remove_file(root.path().join("alpha.txt")).unwrap();
    fs::write(root.path().join("after.txt"), "after").unwrap();
    crate::files::fs_watcher::invalidate_directory_caches_for_change(root.path());
    let after = start_search(&app_handle, root.path(), "after");
    assert!(wait_for_done(&receiver, after).contains(&"after.txt".to_string()));
    let removed = start_search(&app_handle, root.path(), "alpha");
    assert!(!wait_for_done(&receiver, removed).contains(&"alpha.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(root.path()), 2);

    let nested = root.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("descendant.txt"), "descendant").unwrap();
    crate::files::fs_watcher::invalidate_directory_caches_for_change(&nested);
    let descendant = start_search(&app_handle, root.path(), "descendant");
    assert!(wait_for_done(&receiver, descendant).contains(&"descendant.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(root.path()), 3);
}
