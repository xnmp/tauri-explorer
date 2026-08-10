use super::{
    cancel_search, install_stream_gate_for_test, start_streaming_search_with_runtime,
    stream_walk_count_for_test, SEARCH_ENTRY_CACHE,
};
use crate::files::fs_watcher::{init_watcher, unwatch_directory, watch_directory};
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
    let app = tauri::test::mock_app();
    let app_handle = app.handle().clone();
    init_watcher(&app_handle);
    let (sender, receiver) = mpsc::channel();
    app_handle.listen("search-results", move |event| {
        sender
            .send(event.payload().to_string())
            .expect("record search event");
    });

    let watched = tempfile::tempdir().expect("watched search root");
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
    assert_eq!(stream_walk_count_for_test(watched.path()), 1);

    let revision = SEARCH_ENTRY_CACHE.begin_load(watched.path());
    fs::write(watched.path().join("after.txt"), "after").expect("watcher fixture");
    wait_for_revision_change(watched.path(), revision);
    let after_id = start_search(&app_handle, watched.path(), "after");
    assert!(wait_for_done(&receiver, after_id).contains(&"after.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(watched.path()), 2);

    let revision = SEARCH_ENTRY_CACHE.begin_load(watched.path());
    fs::remove_file(nested.join("before-nested.txt")).expect("remove nested fixture");
    fs::write(nested.join("after-nested.txt"), "after").expect("changed nested fixture");
    wait_for_revision_change(watched.path(), revision);
    let nested_id = start_search(&app_handle, watched.path(), "after-nested");
    assert!(
        wait_for_done(&receiver, nested_id).contains(&"after-nested.txt".to_string()),
        "a nested descendant change must invalidate the recursive listing"
    );
    assert_eq!(
        stream_walk_count_for_test(watched.path()),
        3,
        "a nested descendant change must force a fresh recursive walk"
    );

    let rewatched = tempfile::tempdir().expect("rewatched search root");
    fs::write(rewatched.path().join("before-gap.txt"), "before").expect("pre-unwatch fixture");
    let rewatched_path = rewatched.path().to_string_lossy().into_owned();
    tauri::async_runtime::block_on(watch_directory(rewatched_path.clone()))
        .expect("watch cache epoch root");
    let before_gap_id = start_search(&app_handle, rewatched.path(), "before-gap");
    assert!(wait_for_done(&receiver, before_gap_id).contains(&"before-gap.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(rewatched.path()), 1);

    tauri::async_runtime::block_on(unwatch_directory(rewatched_path.clone()))
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
    assert_eq!(
        stream_walk_count_for_test(rewatched.path()),
        2,
        "a fresh watch epoch must force a fresh recursive walk"
    );

    let cancelled_root = tempfile::tempdir().expect("cancelled search root");
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

    let racing_root = tempfile::tempdir().expect("racing search root");
    fs::write(racing_root.path().join("seed.txt"), "seed").expect("race seed fixture");
    tauri::async_runtime::block_on(watch_directory(
        racing_root.path().to_string_lossy().into_owned(),
    ))
    .expect("watch racing root");
    let gate = install_stream_gate_for_test(racing_root.path());
    let revision = SEARCH_ENTRY_CACHE.begin_load(racing_root.path());
    let racing_id = start_search(&app_handle, racing_root.path(), "seed");
    gate.started.wait();
    fs::write(racing_root.path().join("raced.txt"), "raced").expect("raced fixture");
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

    let unwatched = tempfile::tempdir().expect("unwatched search root");
    fs::write(unwatched.path().join("before.txt"), "before").expect("unwatched fixture");
    let before_id = start_search(&app_handle, unwatched.path(), "before");
    assert!(wait_for_done(&receiver, before_id).contains(&"before.txt".to_string()));
    fs::remove_file(unwatched.path().join("before.txt")).expect("remove unwatched fixture");
    fs::write(unwatched.path().join("new.txt"), "new").expect("new unwatched fixture");
    let new_id = start_search(&app_handle, unwatched.path(), "new");
    assert!(wait_for_done(&receiver, new_id).contains(&"new.txt".to_string()));
    assert_eq!(stream_walk_count_for_test(unwatched.path()), 2);
}
