use super::*;

#[test]
fn blocked_recursive_registration_does_not_delay_unrelated_folder_navigation() {
    use super::super::watch_observation::tests::NativeHarness;
    use std::sync::mpsc;
    let root = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    std::fs::write(destination.path().join("visible.txt"), "entry").unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let direct = NativeHarness::default();
    let recursive = NativeHarness::default();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let observer = NativeObserver::with_cache(GlobalSearchCache, |mode| match mode {
        Mode::Direct => direct.factory(),
        Mode::Recursive => {
            let factory = recursive.factory();
            let started_tx = started_tx.clone();
            let release = release.clone();
            Box::new(move |callback| {
                if let Some(release_rx) = release.lock().unwrap().take() {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                factory(callback)
            })
        }
    });
    let watches = Arc::new(Mutex::new(DirectoryWatches::new(observer)));
    let owner = Owner::default();
    watches
        .lock()
        .unwrap()
        .acquire(&owner, root.path().to_string_lossy().into_owned())
        .unwrap();
    let search_watches = watches.clone();
    let search_path = root.path().to_path_buf();
    let search = std::thread::spawn(move || ensure_search_watch(&search_watches, &search_path));
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (loaded_tx, loaded_rx) = mpsc::channel();
    let navigation_path = destination.path().to_path_buf();
    let navigation = std::thread::spawn(move || {
        watches
            .lock()
            .unwrap()
            .observe(&owner, navigation_path.to_string_lossy().into_owned())
            .unwrap();
        let names: Vec<_> = std::fs::read_dir(navigation_path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        loaded_tx.send(names).unwrap();
    });
    let before_release = loaded_rx.recv_timeout(Duration::from_secs(1));
    release_tx.send(()).unwrap();
    assert!(search.join().unwrap());
    navigation.join().unwrap();
    assert_eq!(
        before_release.expect(
            "folder navigation must complete while recursive watch registration is blocked"
        ),
        vec![std::ffi::OsString::from("visible.txt")]
    );
}

fn change(origin: ChangeOrigin, at: Instant, observed_at_ms: u64) -> PendingChange {
    PendingChange {
        origin,
        last_event: at,
        observed_at_ms,
    }
}

#[test]
fn watcher_batches_wait_for_quiet_after_the_latest_event() {
    let start = Instant::now();
    let mut batch = change(ChangeOrigin::Watcher, start, 100);
    batch.merge(change(
        ChangeOrigin::Watcher,
        start + Duration::from_millis(200),
        300,
    ));
    assert!(!batch.ready(start + Duration::from_millis(499)));
    assert!(batch.ready(start + Duration::from_millis(500)));
}

#[test]
fn mutation_is_ready_despite_newer_watcher_churn_and_keeps_latest_observation() {
    let start = Instant::now();
    let mut batch = change(ChangeOrigin::Watcher, start, 100);
    batch.merge(change(
        ChangeOrigin::Mutation,
        start + Duration::from_millis(10),
        110,
    ));
    batch.merge(change(
        ChangeOrigin::Watcher,
        start + Duration::from_millis(20),
        120,
    ));
    // Out-of-order delivery cannot move the observation clock backward.
    batch.merge(change(ChangeOrigin::Watcher, start, 100));
    assert!(batch.ready(start + Duration::from_millis(20)));
    let payload = DirectoryChangedPayload {
        path: "/observed".into(),
        origin: batch.origin,
        observed_at_ms: batch.observed_at_ms,
    };
    assert_eq!(
        serde_json::to_value(payload).unwrap(),
        serde_json::json!({
            "path": "/observed", "origin": "mutation", "observed_at_ms": 120,
        })
    );
    let next = change(
        ChangeOrigin::Watcher,
        start + Duration::from_millis(30),
        130,
    );
    assert!(!next.ready(start + Duration::from_millis(30)));
}

impl CacheInvalidation for Arc<crate::search_cache::SearchEntryCache<String>> {
    fn changed(&self, path: &Path) {
        self.invalidate_for_change(path);
    }
    fn root(&self, path: &Path) {
        self.invalidate_root(path);
    }
}

fn cache_observer(
    cache: Arc<crate::search_cache::SearchEntryCache<String>>,
) -> (
    NativeObserver<Arc<crate::search_cache::SearchEntryCache<String>>>,
    super::super::watch_observation::tests::NativeHarness,
) {
    use super::super::watch_observation::tests::NativeHarness;
    let direct = NativeHarness::default();
    let recursive = NativeHarness::default();
    let observer = NativeObserver::with_cache(cache, |mode| match mode {
        Mode::Direct => direct.factory(),
        Mode::Recursive => recursive.factory(),
    });
    (observer, recursive)
}

fn cached_names(
    cache: &crate::search_cache::SearchEntryCache<String>,
    root: &Path,
    walks: &std::cell::Cell<usize>,
) -> Arc<Vec<String>> {
    cache.get_or_load(root, || {
        walks.set(walks.get() + 1);
        std::fs::read_dir(root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    })
}

#[test]
fn issue_974_overlap_coverage_preserves_parent_cache_and_rebuilds_surviving_child() {
    let root = tempfile::tempdir().unwrap();
    let child = root.path().join("child");
    std::fs::create_dir(&child).unwrap();
    std::fs::write(root.path().join("parent.txt"), "parent").unwrap();
    std::fs::write(child.join("before.txt"), "before").unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, recursive) = cache_observer(cache.clone());
    let mut watches = DirectoryWatches::new(observer);
    let owner = Owner::default();
    let parent_path = root.path().to_string_lossy().into_owned();
    let child_path = child.to_string_lossy().into_owned();
    let parent = watches.acquire(&owner, parent_path.clone()).unwrap();
    watches.acquire(&owner, child_path.clone()).unwrap();
    watches.observer.search.add(root.path(), true).unwrap();
    let parent_walks = std::cell::Cell::new(0);
    let child_walks = std::cell::Cell::new(0);
    let parent_listing = cached_names(&cache, root.path(), &parent_walks);
    assert!(parent_listing.contains(&"parent.txt".to_string()));
    let parent_revision = cache.begin_load(root.path());
    let uncovered_child_revision = cache.begin_load(&child);
    watches.observer.search.add(&child, true).unwrap();
    assert_ne!(cache.begin_load(&child), uncovered_child_revision);
    assert_eq!(cache.begin_load(root.path()), parent_revision);
    assert!(Arc::ptr_eq(
        &cached_names(&cache, root.path(), &parent_walks),
        &parent_listing
    ));
    assert_eq!(
        parent_walks.get(),
        1,
        "child coverage must preserve the parent listing"
    );
    assert!(cached_names(&cache, &child, &child_walks).contains(&"before.txt".to_string()));
    let child_revision = cache.begin_load(&child);

    watches.release(&owner, &parent.id).unwrap();
    watches.observer.search.settle();
    assert!(watches.covered(&child_path));
    assert!(watches.observer.search.healthy(&child));
    assert_ne!(cache.begin_load(&child), child_revision);
    assert!(cache.completed(&child).is_none());
    assert!(cached_names(&cache, &child, &child_walks).contains(&"before.txt".to_string()));
    assert_eq!(
        child_walks.get(),
        2,
        "rebuilding surviving child coverage must force a fresh walk"
    );

    std::fs::remove_file(child.join("before.txt")).unwrap();
    let changed = child.join("after.txt");
    std::fs::write(&changed, "after").unwrap();
    recursive.emit(
        recursive.latest_generation(),
        Ok(
            notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                .add_path(changed),
        ),
    );
    let after = cached_names(&cache, &child, &child_walks);
    assert!(after.contains(&"after.txt".to_string()));
    assert!(!after.contains(&"before.txt".to_string()));
    assert_eq!(
        child_walks.get(),
        3,
        "the surviving native callback must invalidate descendant changes"
    );
}

#[test]
fn issue_974_shared_owner_retirement_preserves_cache_until_final_owner_retires() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("before.txt"), "before").unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, recursive) = cache_observer(cache.clone());
    let mut watches = DirectoryWatches::new(observer);
    let first = Owner::default();
    let last = Owner::default();
    let path = root.path().to_string_lossy().into_owned();
    watches.acquire(&first, path.clone()).unwrap();
    watches.acquire(&last, path.clone()).unwrap();
    watches.observer.search.add(root.path(), true).unwrap();
    let walks = std::cell::Cell::new(0);
    let listing = cached_names(&cache, root.path(), &walks);
    assert!(listing.contains(&"before.txt".to_string()));
    let revision = cache.begin_load(root.path());
    first.retire();
    watches.maintain(Instant::now());
    assert!(watches.covered(&path));
    assert_eq!(cache.begin_load(root.path()), revision);
    assert!(Arc::ptr_eq(
        &cached_names(&cache, root.path(), &walks),
        &listing
    ));
    assert_eq!(
        walks.get(),
        1,
        "one retired owner must preserve the shared cached listing"
    );

    // Start a cold load through a real delivered callback before final retirement.
    let changed = root.path().join("trigger.txt");
    std::fs::write(&changed, "trigger").unwrap();
    recursive.emit(
        recursive.latest_generation(),
        Ok(
            notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File))
                .add_path(changed),
        ),
    );
    let cold_revision = cache.begin_load(root.path());
    assert!(cache.completed(root.path()).is_none());
    last.retire();
    assert!(
        !watches.covered(&path),
        "retirement immediately ends eligibility"
    );
    watches.maintain(Instant::now());
    assert!(!watches.observer.search.healthy(root.path()));
    assert_ne!(cache.begin_load(root.path()), cold_revision);
    cache.publish_if_unchanged(root.path(), listing, cold_revision);
    assert!(
        cache.completed(root.path()).is_none(),
        "a pre-retirement load token cannot publish into a retired epoch"
    );

    std::fs::remove_file(root.path().join("before.txt")).unwrap();
    std::fs::write(root.path().join("after.txt"), "after").unwrap();
    let replacement = Owner::default();
    watches.acquire(&replacement, path.clone()).unwrap();
    watches.observer.search.add(root.path(), true).unwrap();
    assert!(watches.covered(&path));
    assert_ne!(cache.begin_load(root.path()), cold_revision);
    let after = cached_names(&cache, root.path(), &walks);
    assert!(after.contains(&"after.txt".to_string()));
    assert!(!after.contains(&"before.txt".to_string()));
    assert_eq!(walks.get(), 2);
}

#[test]
fn released_search_registration_cannot_cover_a_reacquired_directory() {
    use super::super::watch_observation::tests::NativeHarness;
    use std::sync::mpsc;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().to_string_lossy().into_owned();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let direct = NativeHarness::default();
    let recursive = NativeHarness::default();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let observer = NativeObserver::with_cache(cache.clone(), |mode| match mode {
        Mode::Direct => direct.factory(),
        Mode::Recursive => {
            let factory = recursive.factory();
            let started_tx = started_tx.clone();
            let release = release.clone();
            Box::new(move |callback| {
                if let Some(release) = release.lock().unwrap().take() {
                    started_tx.send(()).unwrap();
                    release.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                factory(callback)
            })
        }
    });
    let mut watches = DirectoryWatches::new(observer);
    let owner = Owner::default();
    let lease = watches.acquire(&owner, path.clone()).unwrap();
    let original = watches.observer.search.prepare(root.path());
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let old_revision = cache.begin_load(root.path());
    watches.release(&owner, &lease.id).unwrap();
    assert!(!watches.observer.search.healthy(root.path()));
    cache.publish_if_unchanged(
        root.path(),
        Arc::new(vec!["stale.txt".into()]),
        old_revision,
    );
    assert!(cache.completed(root.path()).is_none());
    watches.acquire(&Owner::default(), path).unwrap();
    let replacement = watches.observer.search.prepare(root.path());
    assert!(!watches.observer.search.healthy(root.path()));
    release_tx.send(()).unwrap();
    assert!(
        !original.wait(),
        "a late result belongs to the released demand"
    );
    assert!(
        replacement.wait(),
        "the replacement must establish its own coverage"
    );
    assert!(watches.observer.search.healthy(root.path()));
    cache.publish_if_unchanged(
        root.path(),
        Arc::new(vec!["stale.txt".into()]),
        old_revision,
    );
    assert!(cache.completed(root.path()).is_none());
}

#[test]
fn published_recursive_health_observes_native_callback_faults_immediately() {
    use super::super::watch_observation::tests::NativeHarness;
    let root = tempfile::tempdir().unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    use std::sync::{atomic::AtomicUsize, mpsc};
    let direct = NativeHarness::default();
    let recursive = NativeHarness::default();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let builds = Arc::new(AtomicUsize::new(0));
    let observer = NativeObserver::with_cache(cache.clone(), |mode| match mode {
        Mode::Direct => direct.factory(),
        Mode::Recursive => {
            let factory = recursive.factory();
            let started_tx = started_tx.clone();
            let release = release.clone();
            let builds = builds.clone();
            Box::new(move |callback| {
                if builds.fetch_add(1, Ordering::SeqCst) == 1 {
                    started_tx.send(()).unwrap();
                    release
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
                factory(callback)
            })
        }
    });
    let mut watches = DirectoryWatches::new(observer);
    watches
        .acquire(
            &Owner::default(),
            root.path().to_string_lossy().into_owned(),
        )
        .unwrap();
    watches.observer.search.add(root.path(), true).unwrap();
    let revision = cache.begin_load(root.path());
    cache.publish_if_unchanged(root.path(), Arc::new(vec!["before.txt".into()]), revision);
    assert!(cache.completed(root.path()).is_some());
    recursive.emit(
        recursive.latest_generation(),
        Err(notify::Error::generic("injected overflow")),
    );
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(
        !watches.observer.search.healthy(root.path()),
        "published health must retain the live generation fault"
    );
    assert!(cache.completed(root.path()).is_none());
    let recovering = watches.observer.search.prepare(root.path());
    release_tx.send(()).unwrap();
    assert!(recovering.wait());
    assert!(watches.observer.search.healthy(root.path()));
    cache.publish_if_unchanged(root.path(), Arc::new(vec!["stale.txt".into()]), revision);
    assert!(cache.completed(root.path()).is_none());
}
