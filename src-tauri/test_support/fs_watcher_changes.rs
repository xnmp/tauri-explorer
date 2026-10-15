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

#[test]
fn cancelled_recursive_demand_is_not_installed_or_recovered() {
    use super::super::watch_observation::tests::NativeHarness;
    let root = tempfile::tempdir().unwrap();
    let queued = root.path().join("queued");
    std::fs::create_dir(&queued).unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let recursive = NativeHarness::default();
    let direct = NativeHarness::default();
    // Block inside the native root watch, after admission. Cancellation cannot
    // interrupt this call, so cleanup must revoke its eventual cache coverage.
    let (entered_rx, release_tx) = recursive.block_successful_watch_once(root.path());
    let observer = NativeObserver::with_cache(cache.clone(), |mode| match mode {
        Mode::Direct => direct.factory(),
        Mode::Recursive => recursive.factory(),
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    let queued_cancelled = Arc::new(AtomicBool::new(false));
    let revision = cache.begin_load(root.path());
    let active = observer
        .search
        .prepare_cancellable(root.path(), cancelled.clone());
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let queued_request = observer
        .search
        .prepare_cancellable(&queued, queued_cancelled.clone());
    cancelled.store(true, Ordering::Release);
    queued_cancelled.store(true, Ordering::Release);
    release_tx.send(()).unwrap();
    let active_result = active.wait();
    let queued_result = queued_request.wait();
    observer.search.settle();
    assert!(
        !active_result,
        "cancelled in-flight registration cannot report coverage"
    );
    assert!(
        !queued_result,
        "cancelled queued registration cannot report coverage"
    );
    assert!(!observer.search.healthy(root.path()));
    assert!(!observer.search.healthy(&queued));
    assert!(
        recursive
            .registrations(recursive.latest_generation())
            .is_empty(),
        "cancelled demand must release physical watches and recovery demand"
    );
    // Queued work must not even enter native registration (unlike install then remove).
    assert_eq!(recursive.watch_count(&queued), 0);
    cache.publish_if_unchanged(root.path(), Arc::new(vec!["stale".into()]), revision);
    assert!(cache.completed(root.path()).is_none());
}

#[test]
fn cancelled_recursive_request_cannot_retire_a_live_same_root_request() {
    let root = tempfile::tempdir().unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, _) = cache_observer(cache);
    let cancelled = Arc::new(AtomicBool::new(true));
    let rejected = observer.search.prepare_cancellable(root.path(), cancelled);
    let live = observer.search.prepare(root.path());
    assert!(
        !rejected.wait(),
        "already cancelled requests must not gain coverage"
    );
    assert!(live.wait());
    assert!(observer.search.healthy(root.path()));
}

#[test]
fn pending_same_root_cancellation_preserves_the_other_search() {
    let root = tempfile::tempdir().unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, recursive) = cache_observer(cache);
    let (entered, release) = recursive.block_successful_watch_once(root.path());
    let cancelled = Arc::new(AtomicBool::new(false));
    let original = observer
        .search
        .prepare_cancellable(root.path(), cancelled.clone());
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let replacement = observer.search.prepare(root.path());
    cancelled.store(true, Ordering::Release);
    // A cancelled waiter must return even while the OS call remains blocked.
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || done_tx.send(original.wait()).unwrap());
    let before_release = done_rx.recv_timeout(Duration::from_secs(1));
    release.send(()).unwrap();
    waiter.join().unwrap();
    assert!(!before_release.expect("cancelled search must stop waiting for native registration"));
    assert!(replacement.wait());
    assert!(observer.search.healthy(root.path()));
    assert_eq!(recursive.watch_count(root.path()), 1);
}

#[test]
fn watch_limit_recovery_does_not_block_navigation_and_cancelled_failures_do_not_retry() {
    let root = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    std::fs::write(destination.path().join("visible.txt"), "entry").unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, recursive) = cache_observer(cache);
    let mut watches = DirectoryWatches::new(observer);
    let owner = Owner::default();
    watches
        .acquire(&owner, root.path().to_string_lossy().into_owned())
        .unwrap();
    recursive.exhaust_watch_limit_once(root.path());
    let (entered, release) = recursive.block_successful_watch_once(root.path());
    assert!(watches.observer.search.add(root.path(), true).is_err());
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    // Multiple new navigation leases and their listings complete during recovery.
    for _ in 0..3 {
        let lease = watches
            .observe(&owner, destination.path().to_string_lossy().into_owned())
            .unwrap();
        assert_eq!(std::fs::read_dir(&lease.path).unwrap().count(), 1);
        watches.release(&owner, &lease.id).unwrap();
    }
    release.send(()).unwrap();
    watches.observer.search.settle();
    assert!(watches.observer.search.healthy(root.path()));

    let cancelled_root = tempfile::tempdir().unwrap();
    recursive.exhaust_watch_limit_once(cancelled_root.path());
    let cancelled = Arc::new(AtomicBool::new(false));
    let failed = watches
        .observer
        .search
        .prepare_cancellable(cancelled_root.path(), cancelled.clone());
    assert!(!failed.wait());
    cancelled.store(true, Ordering::Release);
    watches.observer.search.settle();
    // Force the deadline due through the worker's production recovery seam.
    watches
        .observer
        .search
        .maintain_for_test(Instant::now() + Duration::from_secs(60));
    assert_eq!(recursive.watch_count(cancelled_root.path()), 1);
    assert!(!watches.observer.search.healthy(cancelled_root.path()));
    assert!(watches.observer.search.healthy(root.path()));
}

// Per-root gate on the real streaming-command path; no mock invocation or
// substitute search implementation. Other concurrently running tests are free.
type SearchGate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
static SEARCH_GATES: OnceLock<Mutex<HashMap<PathBuf, SearchGate>>> = OnceLock::new();

pub(crate) fn gate_registration(
    path: &Path,
) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    SEARCH_GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), (entered_tx, release_rx));
    (entered_rx, release_tx)
}

pub(crate) fn wait_for_registration(path: &Path) {
    let gate = SEARCH_GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(path);
    if let Some((entered, release)) = gate {
        entered.send(()).unwrap();
        release.recv_timeout(Duration::from_secs(10)).unwrap();
    }
}

#[test]
fn healthy_acquisition_retains_recovered_demand_after_original_search_cancels() {
    let root = tempfile::tempdir().unwrap();
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, recursive) = cache_observer(cache);
    recursive.exhaust_watch_limit_once(root.path());
    let original = Arc::new(AtomicBool::new(false));
    assert!(!observer
        .search
        .prepare_cancellable(root.path(), original.clone())
        .wait());
    observer
        .search
        .maintain_for_test(Instant::now() + Duration::from_secs(60));
    assert!(observer.search.healthy(root.path()));
    let second = Arc::new(AtomicBool::new(false));
    assert!(observer
        .search
        .prepare_cancellable(root.path(), second.clone())
        .wait());
    original.store(true, Ordering::Release);
    observer.search.settle();
    assert!(
        observer.search.healthy(root.path()),
        "accepted recovered coverage belongs to the second search too"
    );
    assert!(recursive
        .registrations(recursive.latest_generation())
        .contains_key(root.path()));
}

#[test]
fn retiring_cancelled_roots_together_never_rebuilds_another_cancelled_root() {
    let fixture = tempfile::tempdir().unwrap();
    let roots: Vec<_> = ["healthy", "cancel-a", "cancel-b", "blocker"]
        .iter()
        .map(|name| fixture.path().join(name))
        .collect();
    for root in &roots {
        std::fs::create_dir(root).unwrap();
    }
    let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
    let (observer, recursive) = cache_observer(cache);
    observer.search.add(&roots[0], true).unwrap();
    let cancelled: Vec<_> = (0..2).map(|_| Arc::new(AtomicBool::new(false))).collect();
    for (root, flag) in roots[1..3].iter().zip(&cancelled) {
        recursive.exhaust_watch_limit_once(root);
        assert!(!observer
            .search
            .prepare_cancellable(root, flag.clone())
            .wait());
    }
    observer
        .search
        .maintain_for_test(Instant::now() + Duration::from_secs(60));
    let counts: Vec<_> = roots[1..3]
        .iter()
        .map(|root| recursive.watch_count(root))
        .collect();
    let (entered, release) = recursive.block_successful_watch_once(&roots[3]);
    let blocker = observer.search.prepare(&roots[3]);
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    for flag in &cancelled {
        flag.store(true, Ordering::Release);
    }
    release.send(()).unwrap();
    assert!(blocker.wait());
    observer.search.settle();
    for (root, count) in roots[1..3].iter().zip(counts) {
        assert_eq!(
            recursive.watch_count(root),
            count,
            "batch retirement must not re-register {root:?}"
        );
        assert!(!observer.search.healthy(root));
    }
    assert!(observer.search.healthy(&roots[0]));
    assert!(observer.search.healthy(&roots[3]));
}

#[test]
fn recovery_does_not_start_a_cancelled_later_root() {
    for rebuild in [false, true] {
        let fixture = tempfile::tempdir().unwrap();
        let roots = [fixture.path().join("first"), fixture.path().join("second")];
        for root in &roots {
            std::fs::create_dir(root).unwrap();
        }
        let cache = Arc::new(crate::search_cache::SearchEntryCache::<String>::new());
        let (observer, recursive) = cache_observer(cache);
        let cancelled: Vec<_> = roots
            .iter()
            .map(|_| Arc::new(AtomicBool::new(false)))
            .collect();
        for (root, flag) in roots.iter().zip(&cancelled) {
            recursive.exhaust_watch_limit_once(root);
            assert!(!observer
                .search
                .prepare_cancellable(root, flag.clone())
                .wait());
        }
        // Whichever unordered due root goes first blocks; cancel the other before
        // the same production maintain call can start its native registration.
        let (first_entered, first_release) = recursive.block_successful_watch_once(&roots[0]);
        let (second_entered, second_release) = recursive.block_successful_watch_once(&roots[1]);
        std::thread::scope(|scope| {
            let native = recursive.clone();
            let maintenance = scope.spawn(|| {
                observer.search.maintain_after_for_test(
                    Instant::now() + Duration::from_secs(60),
                    move || {
                        // Fault and recover in one worker command. Otherwise its
                        // automatic tail maintenance can consume the fault first,
                        // making both test arms exercise incremental installation.
                        if rebuild {
                            native.emit(
                                native.latest_generation(),
                                Err(notify::Error::generic("force shared-source rebuild")),
                            );
                        }
                    },
                )
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            let first = loop {
                if first_entered.try_recv().is_ok() {
                    break 0;
                }
                if second_entered.try_recv().is_ok() {
                    break 1;
                }
                assert!(Instant::now() < deadline, "neither retry started");
                std::thread::yield_now();
            };
            cancelled[1 - first].store(true, Ordering::Release);
            // Release both gates so a regression fails its watch-count assertion,
            // not an incidental timeout in the injected native watcher.
            first_release.send(()).unwrap();
            second_release.send(()).unwrap();
            maintenance.join().unwrap();
            observer.search.settle();
            assert_eq!(
                recursive.watch_count(&roots[1 - first]),
                1,
                "cancellation must be checked between native root registrations"
            );
            assert!(!observer.search.healthy(&roots[1 - first]));
            assert!(observer.search.healthy(&roots[first]));
        });
    }
}
