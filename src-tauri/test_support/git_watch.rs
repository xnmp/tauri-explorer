use super::{
    service::{Callback, Observer, Owner, Service, Timing},
    target::{install, Target},
};
use crate::error::AppError;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use tempfile::TempDir;

fn repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    dir
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(future)
}

struct Observed {
    callback: Arc<Mutex<Callback>>,
    dropped: mpsc::Receiver<()>,
}
struct DropSignal(mpsc::Sender<()>);
impl Drop for DropSignal {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

struct Fixture {
    service: Service,
    owner: Owner,
    observers: mpsc::Receiver<Observed>,
    emitted: mpsc::Receiver<String>,
    registration_failures: Arc<AtomicUsize>,
    delivery_failures: Arc<AtomicUsize>,
}

fn fixture() -> Fixture {
    let (observers_tx, observers) = mpsc::channel();
    let (events_tx, emitted) = mpsc::channel();
    let registration_failures = Arc::new(AtomicUsize::new(0));
    let delivery_failures = Arc::new(AtomicUsize::new(0));
    let failing_registration = Arc::clone(&registration_failures);
    let failing_delivery = Arc::clone(&delivery_failures);
    let service = Service::spawn(
        Box::new(move |_target, callback| {
            if failing_registration
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err(AppError::Other("registration denied".into()));
            }
            let (dropped_tx, dropped) = mpsc::channel();
            observers_tx
                .send(Observed {
                    callback: Arc::new(Mutex::new(callback)),
                    dropped,
                })
                .unwrap();
            Ok(Box::new(DropSignal(dropped_tx)) as Observer)
        }),
        Box::new(move |key| {
            if failing_delivery
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                .is_ok()
            {
                return Err("delivery denied".into());
            }
            events_tx.send(key.to_owned()).unwrap();
            Ok(())
        }),
        Timing {
            debounce: Duration::from_millis(5),
            retry: Duration::from_millis(5),
            retry_cap: Duration::from_millis(20),
        },
    )
    .unwrap();
    Fixture {
        service,
        owner: Owner::default(),
        observers,
        emitted,
        registration_failures,
        delivery_failures,
    }
}

fn receive<T>(receiver: &mpsc::Receiver<T>) -> T {
    receiver
        .recv_timeout(Duration::from_secs(3))
        .expect("service outcome timed out")
}
fn fault(observer: &Observed) {
    (observer.callback.lock().unwrap())(Err(notify::Error::generic("lost observation")));
}

#[test]
fn lease_release_is_idempotent_across_recreated_repository_observation() {
    let dir = repo();
    let path = dir.path().to_string_lossy().into_owned();
    let f = fixture();
    let first = run(f.service.acquire(&f.owner, path.clone())).unwrap();
    let old = receive(&f.observers);
    run(f.service.release(&f.owner, first.id.clone())).unwrap();
    receive(&old.dropped);
    let second = run(f.service.acquire(&f.owner, path)).unwrap();
    let current = receive(&f.observers);
    assert_ne!(first.id, second.id);
    run(f.service.release(&f.owner, first.id)).unwrap();
    assert!(current.dropped.try_recv().is_err());
    run(f.service.release(&f.owner, second.id)).unwrap();
    receive(&current.dropped);
}

#[test]
fn shared_references_recover_after_callback_error_without_remounting() {
    let dir = repo();
    let path = dir.path().to_string_lossy().into_owned();
    let f = fixture();
    let first = run(f.service.acquire(&f.owner, path.clone())).unwrap();
    let second = run(f.service.acquire(&f.owner, path.clone())).unwrap();
    let failed = receive(&f.observers);
    assert!(f.observers.try_recv().is_err());
    fault(&failed);
    assert_eq!(receive(&f.emitted), first.repo_root);
    receive(&failed.dropped);
    let replacement = receive(&f.observers);
    assert_eq!(receive(&f.emitted), first.repo_root);
    // A native backend can finish a callback after its observer was retired.
    fault(&failed);
    let third = run(f.service.acquire(&f.owner, path)).unwrap();
    assert!(f.observers.try_recv().is_err());
    run(f.service.release(&f.owner, first.id)).unwrap();
    run(f.service.release(&f.owner, second.id)).unwrap();
    assert!(replacement.dropped.try_recv().is_err());
    run(f.service.release(&f.owner, third.id)).unwrap();
    receive(&replacement.dropped);
}

#[test]
fn failed_recovery_retries_and_final_release_cancels_future_attempts() {
    let dir = repo();
    let path = dir.path().to_string_lossy().into_owned();
    let f = fixture();
    let lease = run(f.service.acquire(&f.owner, path.clone())).unwrap();
    let old = receive(&f.observers);
    f.registration_failures.store(2, Ordering::SeqCst);
    fault(&old);
    receive(&old.dropped);
    receive(&f.emitted);
    let recovered = receive(&f.observers);
    receive(&f.emitted);
    assert_eq!(f.registration_failures.load(Ordering::SeqCst), 0);
    f.registration_failures.store(100, Ordering::SeqCst);
    fault(&recovered);
    receive(&recovered.dropped);
    run(f.service.release(&f.owner, lease.id)).unwrap();
    f.registration_failures.store(0, Ordering::SeqCst);
    // A round trip through the same service establishes that release ran.
    let other = repo();
    let other_lease = run(f
        .service
        .acquire(&f.owner, other.path().to_string_lossy().into_owned()))
    .unwrap();
    let other_observer = receive(&f.observers);
    run(f.service.release(&f.owner, other_lease.id)).unwrap();
    receive(&other_observer.dropped);
    assert!(f.observers.recv_timeout(Duration::from_millis(60)).is_err());
}

#[test]
fn failed_emission_is_retried_and_shutdown_drops_every_observer() {
    let dir = repo();
    let path = dir.path().to_string_lossy().into_owned();
    let f = fixture();
    let lease = run(f.service.acquire(&f.owner, path)).unwrap();
    let observer = receive(&f.observers);
    f.delivery_failures.store(2, Ordering::SeqCst);
    (observer.callback.lock().unwrap())(Ok(notify::Event::new(notify::EventKind::Any)));
    assert_eq!(receive(&f.emitted), lease.repo_root);
    assert_eq!(f.delivery_failures.load(Ordering::SeqCst), 0);
    f.service.stop();
    receive(&observer.dropped);
    assert!(run(f
        .service
        .acquire(&f.owner, dir.path().to_string_lossy().into_owned()))
    .is_err());
}

#[test]
fn metadata_locks_are_ignored_but_worktree_locks_and_rescan_are_changes() {
    let dir = repo();
    let target = Target::resolve(dir.path().to_str().unwrap()).unwrap();
    for name in ["Cargo.lock", "editor-backup~"] {
        assert!(target
            .relevant(&notify::Event::new(notify::EventKind::Any).add_path(dir.path().join(name))));
    }
    let lock =
        notify::Event::new(notify::EventKind::Any).add_path(dir.path().join(".git/index.lock"));
    assert!(!target.relevant(&lock));
    assert!(target.relevant(&lock.set_flag(notify::event::Flag::Rescan)));
    assert!(target.relevant(
        &notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan)
    ));
    let access = notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read))
        .add_path(dir.path().join(".git/HEAD"));
    assert!(!target.relevant(&access));
    let sibling = notify::Event::new(notify::EventKind::Any)
        .add_path(dir.path().parent().unwrap().join("unrelated-sibling"));
    assert!(!target.relevant(&sibling));
}

#[test]
fn acquisition_requires_repository_and_every_native_root() {
    let missing = TempDir::new().unwrap();
    assert!(Target::resolve(missing.path().to_str().unwrap()).is_err());
    let dir = repo();
    let mut target = Target::resolve(dir.path().to_str().unwrap()).unwrap();
    target.roots.push(PathBuf::from("/external/metadata"));
    assert!(install(&target, |path, _mode| {
        if path == std::path::Path::new("/external/metadata") {
            Err(notify::Error::generic("denied"))
        } else {
            Ok(())
        }
    })
    .is_err());
}

#[test]
fn linked_worktree_observation_includes_shared_refs_without_overlapping_roots() {
    let dir = repo();
    let repository = git2::Repository::open(dir.path()).unwrap();
    let tree = repository.treebuilder(None).unwrap().write().unwrap();
    let tree = repository.find_tree(tree).unwrap();
    let signature = git2::Signature::now("Test", "test@example.com").unwrap();
    repository
        .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .unwrap();
    let linked_parent = TempDir::new().unwrap();
    let linked = linked_parent.path().join("linked");
    repository.worktree("linked", &linked, None).unwrap();
    let linked_repo = git2::Repository::open(&linked).unwrap();
    let target = Target::resolve(linked.to_str().unwrap()).unwrap();
    for required in [
        linked_repo.workdir().unwrap(),
        linked_repo.path(),
        linked_repo.commondir(),
    ] {
        assert!(target.roots.iter().any(|root| required.starts_with(root)));
    }
    for (i, root) in target.roots.iter().enumerate() {
        assert!(!target
            .roots
            .iter()
            .enumerate()
            .any(|(j, other)| i != j && root.starts_with(other)));
    }
}

#[test]
fn acquisition_rejects_a_callback_failure_during_registration() {
    let dir = repo();
    let (dropped_tx, dropped) = mpsc::channel();
    let owner = Owner::default();
    let service = Service::spawn(
        Box::new(move |_target, callback| {
            callback(Err(notify::Error::generic("lost during installation")));
            Ok(Box::new(DropSignal(dropped_tx.clone())) as Observer)
        }),
        Box::new(|_| Ok(())),
        Timing::default(),
    )
    .unwrap();
    assert!(run(service.acquire(&owner, dir.path().to_string_lossy().into_owned())).is_err());
    receive(&dropped);
}

#[test]
fn canceled_acquisition_drains_the_late_native_observer() {
    let dir = repo();
    let (entered_tx, entered) = mpsc::channel();
    let (continue_tx, resume) = mpsc::channel();
    let (dropped_tx, dropped) = mpsc::channel();
    let window = Owner::default();
    let service = Arc::new(
        Service::spawn(
            Box::new(move |_target, _callback| {
                entered_tx.send(()).unwrap();
                resume.recv().unwrap();
                Ok(Box::new(DropSignal(dropped_tx.clone())) as Observer)
            }),
            Box::new(|_| Ok(())),
            Timing::default(),
        )
        .unwrap(),
    );
    run(async {
        let owner = Arc::clone(&service);
        let path = dir.path().to_string_lossy().into_owned();
        let pending = tokio::spawn(async move { owner.acquire(&window, path).await });
        tokio::task::yield_now().await;
        receive(&entered);
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        continue_tx.send(()).unwrap();
        receive(&dropped);
    });
}

#[test]
fn native_observer_recovers_after_root_moves_and_observes_worktree_lock_files() {
    let dir = repo();
    let destination = TempDir::new().unwrap();
    let moved = destination.path().join("moved");
    let (installed_tx, installed) = mpsc::channel();
    let (changed_tx, changed) = mpsc::channel();
    let owner = Owner::default();
    let service = Service::spawn(
        Box::new(move |target, callback| {
            let observer = super::native_observer(target, callback)?;
            installed_tx.send(()).unwrap();
            Ok(observer)
        }),
        Box::new(move |key| {
            changed_tx.send(key.to_owned()).unwrap();
            Ok(())
        }),
        Timing {
            debounce: Duration::from_millis(5),
            retry: Duration::from_millis(5),
            retry_cap: Duration::from_millis(20),
        },
    )
    .unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    let lease = run(service.acquire(&owner, path.clone())).unwrap();
    receive(&installed);
    std::fs::rename(dir.path(), &moved).unwrap();
    assert_eq!(receive(&changed), lease.repo_root);
    std::fs::rename(&moved, dir.path()).unwrap();
    receive(&installed);
    assert_eq!(receive(&changed), lease.repo_root);
    // A round trip verifies recovery was acknowledged before the write.
    let second = run(service.acquire(&owner, path)).unwrap();
    while changed.try_recv().is_ok() {}
    std::fs::write(dir.path().join("Cargo.lock"), "changed after recovery").unwrap();
    assert_eq!(receive(&changed), lease.repo_root);
    run(service.release(&owner, lease.id)).unwrap();
    run(service.release(&owner, second.id)).unwrap();
}

#[test]
#[ignore = "manual native observation cost measurement; creates 12,000 directories"]
fn measure_retained_observation_fanout() {
    struct CountedObserver {
        _observer: Observer,
        live: Arc<AtomicUsize>,
    }
    impl Drop for CountedObserver {
        fn drop(&mut self) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let repositories: Vec<_> = (0..12)
        .map(|_| {
            let dir = repo();
            for i in 0..1000 {
                let child = dir.path().join(format!("directory-{i}"));
                std::fs::create_dir(&child).unwrap();
                std::fs::write(child.join("file.txt"), "fixture").unwrap();
            }
            dir
        })
        .collect();
    let live = Arc::new(AtomicUsize::new(0));
    let factory_live = Arc::clone(&live);
    let started = std::time::Instant::now();
    let owner = Owner::default();
    let service = Service::spawn(
        Box::new(move |target, callback| {
            let observer = super::native_observer(target, callback)?;
            factory_live.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(CountedObserver {
                _observer: observer,
                live: Arc::clone(&factory_live),
            }) as Observer)
        }),
        Box::new(|_| Ok(())),
        Timing::default(),
    )
    .unwrap();
    let worker_start_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut cold = Vec::new();
    let mut shared = Vec::new();
    let mut leases = Vec::new();
    for samples in [&mut cold, &mut shared] {
        for dir in &repositories {
            let started = std::time::Instant::now();
            leases.push(
                run(service.acquire(&owner, dir.path().to_string_lossy().into_owned())).unwrap(),
            );
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        assert_eq!(
            live.load(Ordering::SeqCst),
            12,
            "query variants must share native observers"
        );
    }
    let started = std::time::Instant::now();
    for lease in leases {
        run(service.release(&owner, lease.id)).unwrap();
    }
    let release_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(
        live.load(Ordering::SeqCst),
        0,
        "all observers must be dropped after final release"
    );
    cold.sort_by(f64::total_cmp);
    shared.sort_by(f64::total_cmp);
    println!("git-watch-fanout: roots=12 directories_per_root=1000 worker_start_ms={worker_start_ms:.3} cold_p50_ms={:.3} cold_p95_ms={:.3} shared_p50_ms={:.3} shared_p95_ms={:.3} release_all_ms={release_ms:.3} retained_observers=0", cold[5], cold[11], shared[5], shared[11]);
}

#[test]
fn native_owner_retirement_reclaims_unreleased_leases() {
    let dir = repo();
    let f = fixture();
    run(f
        .service
        .acquire(&f.owner, dir.path().to_string_lossy().into_owned()))
    .unwrap();
    let observer = receive(&f.observers);
    f.service.retire(&f.owner);
    receive(&observer.dropped);
    assert!(run(f
        .service
        .acquire(&f.owner, dir.path().to_string_lossy().into_owned()))
    .is_err());
}

#[test]
fn another_native_owner_cannot_release_a_shared_observers_lease() {
    let dir = repo();
    let f = fixture();
    let lease = run(f
        .service
        .acquire(&f.owner, dir.path().to_string_lossy().into_owned()))
    .unwrap();
    let observer = receive(&f.observers);
    let unrelated = Owner::default();
    run(f.service.release(&unrelated, lease.id.clone())).unwrap();
    assert!(observer.dropped.try_recv().is_err());
    run(f.service.release(&f.owner, lease.id)).unwrap();
    receive(&observer.dropped);
}

#[test]
fn retirement_preserves_other_windows_coverage_and_new_owner_can_reacquire() {
    let dir = repo();
    let path = dir.path().to_string_lossy().into_owned();
    let f = fixture();
    let other = Owner::default();
    run(f.service.acquire(&f.owner, path.clone())).unwrap();
    let observer = receive(&f.observers);
    let surviving = run(f.service.acquire(&other, path.clone())).unwrap();
    f.service.retire(&f.owner);
    // A round trip also establishes that queued retirement was processed.
    run(f.service.release(&f.owner, surviving.id.clone())).unwrap();
    assert!(observer.dropped.try_recv().is_err());
    (observer.callback.lock().unwrap())(Ok(notify::Event::new(notify::EventKind::Any)));
    assert_eq!(receive(&f.emitted), surviving.repo_root);
    f.service.retire(&other);
    receive(&observer.dropped);
    let replacement = Owner::default();
    let lease = run(f.service.acquire(&replacement, path)).unwrap();
    let new_observer = receive(&f.observers);
    run(f.service.release(&other, surviving.id)).unwrap();
    assert!(new_observer.dropped.try_recv().is_err());
    run(f.service.release(&replacement, lease.id)).unwrap();
    receive(&new_observer.dropped);
}

#[test]
fn retirement_during_blocked_registration_rejects_ack_and_drains_observer() {
    let dir = repo();
    let owner = Owner::default();
    let (entered_tx, entered) = mpsc::channel();
    let (continue_tx, resume) = mpsc::channel();
    let (dropped_tx, dropped) = mpsc::channel();
    let service = Service::spawn(
        Box::new(move |_, _| {
            entered_tx.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(Box::new(DropSignal(dropped_tx.clone())) as Observer)
        }),
        Box::new(|_| Ok(())),
        Timing::default(),
    )
    .unwrap();
    std::thread::scope(|scope| {
        let pending =
            scope.spawn(|| run(service.acquire(&owner, dir.path().to_string_lossy().into_owned())));
        receive(&entered);
        service.retire(&owner);
        continue_tx.send(()).unwrap();
        assert!(pending.join().unwrap().is_err());
        receive(&dropped);
    });
}

#[test]
fn retirement_with_a_saturated_inbox_rejects_queued_and_waiting_acquisitions() {
    let dir = repo();
    let owner = Owner::default();
    let (entered_tx, entered) = mpsc::channel();
    let (continue_tx, resume) = mpsc::channel();
    let (dropped_tx, dropped) = mpsc::channel();
    let service = Service::spawn(
        Box::new(move |_, _| {
            entered_tx.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(3)).unwrap();
            Ok(Box::new(DropSignal(dropped_tx.clone())) as Observer)
        }),
        Box::new(|_| Ok(())),
        Timing::default(),
    )
    .unwrap();
    std::thread::scope(|scope| {
        let pending =
            scope.spawn(|| run(service.acquire(&owner, dir.path().to_string_lossy().into_owned())));
        receive(&entered);
        run(async {
            use std::future::Future;
            use std::task::{Context, Poll, Waker};
            // Poll every acquisition once while the worker is held. This fills
            // its bounded inbox and leaves senders waiting without sleep-based
            // guesses about whether the futures have actually started.
            let mut queued: Vec<_> = (0..128)
                .map(|_| {
                    Box::pin(service.acquire(&owner, dir.path().to_string_lossy().into_owned()))
                })
                .collect();
            let mut context = Context::from_waker(Waker::noop());
            for acquire in &mut queued {
                assert!(matches!(acquire.as_mut().poll(&mut context), Poll::Pending));
            }
            service.retire(&owner);
            continue_tx.send(()).unwrap();
            assert!(pending.join().unwrap().is_err());
            for acquire in queued {
                assert!(acquire.await.is_err());
            }
        });
        receive(&dropped);
        assert!(
            entered.try_recv().is_err(),
            "retired queued work installed another observer"
        );
    });
}

#[test]
fn concrete_native_windows_keep_retirement_with_old_handles() {
    use tauri::Manager;
    let f = fixture();
    let dir = repo();
    let path = dir.path().to_string_lossy().into_owned();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "owner-test", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();
    let old_handle = window.clone();
    let owner = super::resource_owner(&mut window.resources_table());
    let lease = run(f.service.acquire(&owner, path.clone())).unwrap();
    let observer = receive(&f.observers);
    // Looking up through a clone must retain release authority.
    let clone_owner = super::resource_owner(&mut old_handle.resources_table());
    run(f.service.release(&clone_owner, lease.id)).unwrap();
    receive(&observer.dropped);
    super::on_window_destroyed(&window);
    let late = super::resource_owner(&mut old_handle.resources_table());
    assert!(run(f.service.acquire(&late, path.clone())).is_err());

    // The mock dispatcher cannot destroy/remove a window; a separate app can
    // create the same native label with a fresh resource table.
    let replacement_app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let replacement =
        tauri::WebviewWindowBuilder::new(&replacement_app, "owner-test", Default::default())
            .build()
            .unwrap()
            .as_ref()
            .window();
    let replacement_owner = super::resource_owner(&mut replacement.resources_table());
    let lease = run(f.service.acquire(&replacement_owner, path.clone())).unwrap();
    let replacement_observer = receive(&f.observers);
    // A delayed destruction notification for an old handle cannot retire it.
    super::on_window_destroyed(&old_handle);
    let subsequent = run(f.service.acquire(&replacement_owner, path)).unwrap();
    run(f.service.release(&replacement_owner, lease.id)).unwrap();
    assert!(replacement_observer.dropped.try_recv().is_err());
    run(f.service.release(&replacement_owner, subsequent.id)).unwrap();
    receive(&replacement_observer.dropped);
}

#[test]
fn native_destruction_before_first_command_keeps_admission_closed() {
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "never-acquired", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();
    super::on_window_destroyed(&window);
    let late_owner = super::resource_owner(&mut window.resources_table());
    let f = fixture();
    let dir = repo();
    assert!(run(f
        .service
        .acquire(&late_owner, dir.path().to_string_lossy().into_owned()))
    .is_err());
    assert!(f.observers.try_recv().is_err());
}
