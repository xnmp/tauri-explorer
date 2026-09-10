use super::super::{
    coordinator::Coordinator,
    resources::{Access, Request, Scope},
};
use super::*;
use std::{
    fs,
    future::Future,
    pin::Pin,
    sync::mpsc,
    task::{Context, Poll, Waker},
    thread,
    time::Duration,
};

const DEADLINE: Duration = Duration::from_secs(3);

fn fixture() -> (tempfile::TempDir, Arc<Coordinator>, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("managed-file");
    fs::write(&path, b"original bytes").unwrap();
    let coordinator = Coordinator::open(&directory.path().join("recovery")).unwrap();
    (directory, coordinator, path)
}

fn writing(path: &std::path::Path) -> Vec<Request> {
    vec![Request {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]
}

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

#[test]
fn finish_refuses_to_retire_ownership_while_a_worker_context_exists() {
    let (directory, coordinator, path) = fixture();
    let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
    let worker = admission.context();

    let error = admission
        .finish()
        .expect_err("a live worker must prevent final settlement");
    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert!(
        competitor.reserve(writing(&path)).is_err(),
        "the failed settlement must leave overlapping work fenced"
    );

    drop(worker);
    competitor
        .reserve(writing(&path))
        .expect("the abandoned row is reclaimable only after the worker exits")
        .finish()
        .unwrap();
    assert_eq!(fs::read(path).unwrap(), b"original bytes");
}

struct DetachedResult(Option<mpsc::SyncSender<()>>);

impl Drop for DetachedResult {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[test]
fn dropping_the_supervisor_and_waiter_keeps_a_detached_blocking_worker_owned() {
    let (directory, coordinator, path) = fixture();
    let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
    let context = admission.context();
    let worker_path = path.clone();
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (returned_tx, returned_rx) = mpsc::sync_channel(1);
    let (polled_tx, polled_rx) = mpsc::sync_channel(1);
    let (drop_tx, drop_rx) = mpsc::sync_channel(1);

    let poller = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build polling runtime");
        let _runtime = runtime.enter();
        let mut future = Box::pin(run_blocking(context, move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            fs::write(worker_path, b"written by detached worker")?;
            Ok(DetachedResult(Some(returned_tx)))
        }));
        polled_tx.send(poll_once(future.as_mut())).unwrap();
        drop_rx.recv().unwrap();
        drop(future);
    });

    assert!(matches!(
        polled_rx.recv_timeout(DEADLINE).expect("future was polled"),
        Poll::Pending
    ));
    started_rx
        .recv_timeout(DEADLINE)
        .expect("blocking worker started");
    drop(admission);
    drop_tx.send(()).unwrap();
    poller.join().unwrap();

    assert!(
        competitor.reserve(writing(&path)).is_err(),
        "dropping both async owners must not release a mutating worker"
    );
    release_tx.send(()).unwrap();
    returned_rx
        .recv_timeout(DEADLINE)
        .expect("detached worker returned and its unobserved result was released");
    assert_eq!(fs::read(&path).unwrap(), b"written by detached worker");
    competitor
        .reserve(writing(&path))
        .expect("the completed detached worker releases reclaimable ownership")
        .finish()
        .unwrap();
}

#[test]
fn a_panicking_worker_retains_ownership_until_unwind_and_join_complete() {
    let (directory, coordinator, path) = fixture();
    let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
    let context = admission.context();
    let worker_path = path.clone();
    let (written_tx, written_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);

    let supervisor = thread::spawn(move || {
        tauri::async_runtime::block_on(run_blocking(context, move || -> Result<(), AppError> {
            fs::write(worker_path, b"written before panic")?;
            written_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            panic!("injected worker panic after filesystem effect");
        }))
    });

    written_rx
        .recv_timeout(DEADLINE)
        .expect("worker performed its filesystem effect");
    assert_eq!(fs::read(&path).unwrap(), b"written before panic");
    assert!(
        competitor.reserve(writing(&path)).is_err(),
        "ownership must remain while the panicking worker is still active"
    );

    release_tx.send(()).unwrap();
    let error = supervisor
        .join()
        .expect("async supervisor handles the blocking worker panic")
        .expect_err("the blocking worker panic must be reported");
    assert!(matches!(error, AppError::WorkerFailed(_)));
    admission
        .finish()
        .expect("joining the unwound worker proves that its context was released");
    competitor
        .reserve(writing(&path))
        .expect("finished ownership permits later overlapping work")
        .finish()
        .unwrap();
}

// These tests use the production batch runners with a real cross-connection
// reservation, rather than a fake counter standing in for recovery ownership.
struct Cleanup {
    path: std::path::PathBuf,
    started: mpsc::SyncSender<()>,
    release: mpsc::Receiver<()>,
}

impl Cleanup {
    fn write(&self, path: &str) -> Result<crate::files::trash_artifact::TrashSuccess, AppError> {
        fs::write(path, b"batch operation completed")?;
        Ok(Default::default())
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.started.send(()).unwrap();
        self.release.recv_timeout(DEADLINE).unwrap();
        fs::write(&self.path, b"batch cleanup completed").unwrap();
    }
}

struct ObservedOwner {
    context: Option<MutationContext>,
    released: mpsc::SyncSender<()>,
}

impl Drop for ObservedOwner {
    fn drop(&mut self) {
        drop(self.context.take());
        self.released.send(()).unwrap();
    }
}

#[test]
fn pooled_and_dedicated_batches_keep_cleanup_owned_after_the_waiter_disappears() {
    use crate::files::batch;
    for worker in ["pool", "dedicated", "pool-setup"] {
        let (directory, coordinator, path) = fixture();
        let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
        let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
        let (cleanup_tx, cleanup_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (released_tx, released_rx) = mpsc::sync_channel(1);
        let (polled_tx, polled_rx) = mpsc::sync_channel(1);
        let (drop_tx, drop_rx) = mpsc::sync_channel(1);
        let cleanup = Cleanup {
            path: path.clone(),
            started: cleanup_tx,
            release: release_rx,
        };
        let owner = ObservedOwner {
            context: Some(admission.context()),
            released: released_tx,
        };
        let plan = batch::BatchPlan::new(vec![path.to_str().unwrap().into()]).unwrap();
        let caller = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let _entered = runtime.enter();
            let mut future = Box::pin(async move {
                if worker == "dedicated" {
                    batch::run_dedicated_receipts_owned(
                        owner,
                        plan,
                        || Ok(()),
                        move |_, path| cleanup.write(path),
                    )
                    .await
                } else if worker == "pool-setup" {
                    batch::run_with_setup_owned(
                        owner,
                        plan,
                        move |_| Ok(cleanup),
                        |context, path, _| context.write(path),
                    )
                    .await
                } else {
                    Ok(batch::run_with_receipts_owned(owner, plan, move |path, _| {
                        cleanup.write(path)
                    })
                    .await)
                }
            });
            polled_tx.send(poll_once(future.as_mut())).unwrap();
            drop_rx.recv_timeout(DEADLINE).unwrap();
            drop(future);
        });
        assert!(matches!(
            polled_rx.recv_timeout(DEADLINE).unwrap(),
            Poll::Pending
        ));
        cleanup_rx
            .recv_timeout(DEADLINE)
            .expect("worker reached capture cleanup");
        drop(admission);
        drop_tx.send(()).unwrap();
        caller.join().unwrap();
        let conflict = competitor.reserve(writing(&path));
        assert_eq!(fs::read(&path).unwrap(), b"batch operation completed");
        release_tx.send(()).unwrap();
        released_rx
            .recv_timeout(DEADLINE)
            .expect("cleanup ended and worker released its owner");
        assert!(
            conflict.is_err(),
            "cleanup lost ownership after waiter cancellation ({worker})"
        );
        assert_eq!(fs::read(&path).unwrap(), b"batch cleanup completed");
        competitor
            .reserve(writing(&path))
            .expect("finished worker is reclaimable")
            .finish()
            .unwrap();
    }
}

#[test]
fn setup_failures_and_worker_panics_release_the_lease_before_the_result() {
    use crate::files::{batch, trash_artifact::TrashSuccess};
    for pooled in [false, true] {
        for failure in ["setup-error", "setup-panic", "operation-panic", "success"] {
            let (directory, coordinator, path) = fixture();
            let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
            let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
            let setup = move || match failure {
                "setup-error" => Err(AppError::Other("rejected before effects".into())),
                "setup-panic" => panic!("injected setup panic"),
                _ => Ok(()),
            };
            let operation = move |_: &mut (), path: &str| {
                fs::write(path, b"actual worker effect")?;
                if failure == "operation-panic" {
                    panic!("injected panic after write");
                }
                Ok(TrashSuccess::default())
            };
            let owner = admission.context();
            let plan = batch::BatchPlan::new(vec![path.to_str().unwrap().into()]).unwrap();
            let result = tauri::async_runtime::block_on(async move {
                if pooled {
                    batch::run_with_setup_owned(
                        owner,
                        plan,
                        move |_| setup(),
                        move |context, path, _| operation(context, path),
                    )
                    .await
                } else {
                    batch::run_dedicated_receipts_owned(owner, plan, setup, operation).await
                }
            });
            admission
                .finish()
                .expect("terminal result must follow release of every worker context");
            competitor
                .reserve(writing(&path))
                .unwrap()
                .finish()
                .unwrap();
            if failure.starts_with("setup-") {
                assert!(matches!(result, Err(AppError::Other(_))));
                assert_eq!(fs::read(&path).unwrap(), b"original bytes");
            } else {
                let result = result.unwrap();
                assert_eq!(fs::read(&path).unwrap(), b"actual worker effect");
                if failure == "operation-panic" {
                    assert_eq!(result.uncertain[0].path, path.to_str().unwrap());
                    assert!(result.succeeded.is_empty());
                } else {
                    assert_eq!(result.succeeded, [path.to_str().unwrap()]);
                    assert!(result.uncertain.is_empty());
                }
            }
        }
    }
}

#[test]
fn pooled_setup_retains_admission_after_its_waiter_is_dropped() {
    use crate::files::batch;
    let (directory, coordinator, path) = fixture();
    let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (released_tx, released_rx) = mpsc::sync_channel(1);
    let owner = ObservedOwner {
        context: Some(admission.context()),
        released: released_tx,
    };
    let plan = batch::BatchPlan::new(vec![path.to_str().unwrap().into()]).unwrap();
    let mut future = Box::pin(batch::run_with_setup_owned(
        owner,
        plan,
        move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(DEADLINE).unwrap();
            Ok(())
        },
        |_, path, _| {
            fs::write(path, b"completed after setup")?;
            Ok(Default::default())
        },
    ));
    assert!(poll_once(future.as_mut()).is_pending());
    started_rx.recv_timeout(DEADLINE).unwrap();
    drop(future);
    drop(admission);
    let conflict = competitor.reserve(writing(&path));
    let before = fs::read(&path).unwrap();
    release_tx.send(()).unwrap();
    released_rx.recv_timeout(DEADLINE).unwrap();
    assert!(
        conflict.is_err(),
        "setup must retain the whole operation's reservation"
    );
    assert_eq!(before, b"original bytes");
    assert_eq!(fs::read(&path).unwrap(), b"completed after setup");
    competitor
        .reserve(writing(&path))
        .unwrap()
        .finish()
        .unwrap();
}

struct PanicDuringCleanup;

impl PanicDuringCleanup {
    fn write(&self, path: &str) -> Result<crate::files::trash_artifact::TrashSuccess, AppError> {
        fs::write(path, b"effect before cleanup panic")?;
        Ok(Default::default())
    }
}

impl Drop for PanicDuringCleanup {
    fn drop(&mut self) {
        panic!("injected cleanup panic after all item outcomes");
    }
}

#[test]
fn cleanup_panics_remain_visible_after_successful_items_and_release_the_lease() {
    use crate::files::batch;
    for worker in [
        "pool",
        "dedicated-operation",
        "dedicated-context",
        "pool-operation",
        "pool-context",
    ] {
        let (directory, coordinator, path) = fixture();
        let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
        let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
        let owner = admission.context();
        let plan = batch::BatchPlan::new(vec![path.to_str().unwrap().into()]).unwrap();
        let outcome = tauri::async_runtime::block_on(async move {
            match worker {
                "pool" => {
                    let operation = PanicDuringCleanup;
                    batch::run_with_receipts_owned(owner, plan, move |path, _| {
                        operation.write(path)
                    })
                    .await
                }
                "dedicated-operation" => {
                    let operation = PanicDuringCleanup;
                    batch::run_dedicated_receipts_owned(
                        owner,
                        plan,
                        || Ok(()),
                        move |_, path| operation.write(path),
                    )
                    .await
                    .unwrap()
                }
                "pool-operation" => {
                    let operation = PanicDuringCleanup;
                    batch::run_with_setup_owned(
                        owner,
                        plan,
                        |_| Ok(()),
                        move |_, path, _| operation.write(path),
                    )
                    .await
                    .unwrap()
                }
                "pool-context" => batch::run_with_setup_owned(
                    owner,
                    plan,
                    |_| Ok(PanicDuringCleanup),
                    |context, path, _| context.write(path),
                )
                .await
                .unwrap(),
                _ => batch::run_dedicated_receipts_owned(
                    owner,
                    plan,
                    || Ok(PanicDuringCleanup),
                    |context, path| context.write(path),
                )
                .await
                .unwrap(),
            }
        });
        admission
            .finish()
            .expect("cleanup panic must unwind the worker's ownership before reporting");
        competitor
            .reserve(writing(&path))
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"effect before cleanup panic");
        assert_eq!(outcome.succeeded, [path.to_str().unwrap()]);
        assert!(outcome.failed.is_empty() && outcome.uncertain.is_empty());
        assert!(
            outcome
                .error()
                .is_some_and(|error| error.contains("injected cleanup panic")),
            "cleanup panic vanished from the batch result ({worker})"
        );
        let wire = serde_json::to_value(&outcome).unwrap();
        assert!(wire["workerError"]
            .as_str()
            .unwrap()
            .contains("injected cleanup panic"));
    }
}

#[test]
fn empty_dedicated_batch_reports_context_cleanup_panic() {
    use crate::files::batch;
    let outcome = tauri::async_runtime::block_on(batch::run_dedicated_receipts(
        batch::BatchPlan::new(Vec::new()).unwrap(),
        || Ok(PanicDuringCleanup),
        |_, _| panic!("an empty batch must not execute an item"),
    ))
    .unwrap();
    assert!(
        outcome.succeeded.is_empty() && outcome.failed.is_empty() && outcome.uncertain.is_empty()
    );
    assert!(outcome.error().unwrap().contains("injected cleanup panic"));
}

#[test]
fn unrun_and_unwinding_jobs_destroy_work_before_releasing_ownership() {
    use crate::files::worker::Job;
    for execute in [false, true] {
        let (directory, coordinator, path) = fixture();
        let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
        let admission = MutationAdmission::new(coordinator.reserve(writing(&path)).unwrap());
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (released_tx, released_rx) = mpsc::sync_channel(1);
        let cleanup = Cleanup {
            path: path.clone(),
            started: started_tx,
            release: release_rx,
        };
        let worker_path = path.clone();
        let job = Job::new(
            ObservedOwner {
                context: Some(admission.context()),
                released: released_tx,
            },
            move || {
                cleanup.write(worker_path.to_str().unwrap()).unwrap();
                panic!("injected job unwind");
            },
        );
        drop(admission);
        let worker = thread::spawn(move || {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if execute {
                    job.run();
                } else {
                    drop(job);
                }
            }))
        });
        started_rx
            .recv_timeout(DEADLINE)
            .expect("job destroys its work");
        let conflict = competitor.reserve(writing(&path));
        release_tx.send(()).unwrap();
        released_rx
            .recv_timeout(DEADLINE)
            .expect("job releases its owner after work destruction");
        assert_eq!(worker.join().unwrap().is_err(), execute);
        assert!(
            conflict.is_err(),
            "work destructor lost its reservation (execute={execute})"
        );
        assert_eq!(fs::read(&path).unwrap(), b"batch cleanup completed");
        competitor
            .reserve(writing(&path))
            .unwrap()
            .finish()
            .unwrap();
    }
}
