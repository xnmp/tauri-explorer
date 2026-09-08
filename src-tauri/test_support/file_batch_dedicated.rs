use super::{run_dedicated, BatchPlan};
use crate::error::AppError;
use std::{
    fs,
    future::Future,
    path::Path,
    pin::Pin,
    rc::Rc,
    sync::mpsc::{self, SyncSender},
    task::{Context, Poll, Waker},
    thread::{self, ThreadId},
    time::Duration,
};

const DEADLINE: Duration = Duration::from_secs(3);

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn plan(paths: &[&Path]) -> BatchPlan {
    BatchPlan::new(paths.iter().map(|path| path_string(path)).collect()).unwrap()
}

fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build test runtime")
        .block_on(future)
}

#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    CoGetApartmentType, CoInitializeEx, CoUninitialize, APTTYPE, APTTYPEQUALIFIER_NONE,
    APTTYPE_CURRENT, APTTYPE_MAINSTA, APTTYPE_MTA, APTTYPE_STA, COINIT_MULTITHREADED,
};

#[cfg(target_os = "windows")]
struct MtaCaller;

#[cfg(target_os = "windows")]
impl MtaCaller {
    fn initialize() -> Self {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .expect("initialize fresh caller as MTA");
        Self
    }
}

#[cfg(target_os = "windows")]
impl Drop for MtaCaller {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[cfg(target_os = "windows")]
fn current_apartment() -> APTTYPE {
    let mut apartment = APTTYPE_CURRENT;
    let mut qualifier = APTTYPEQUALIFIER_NONE;
    unsafe { CoGetApartmentType(&mut apartment, &mut qualifier) }
        .expect("query current COM apartment");
    apartment
}

#[cfg(target_os = "windows")]
fn assert_sta() {
    assert!(
        matches!(current_apartment(), APTTYPE_STA | APTTYPE_MAINSTA),
        "dedicated worker must own a single-threaded apartment"
    );
}

#[test]
fn setup_failure_returns_an_ordinary_error_before_any_filesystem_effect() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("untouched.txt");
    fs::write(&file, b"exact original bytes").unwrap();

    let result = run(run_dedicated(
        plan(&[&file]),
        || -> Result<(), AppError> { Err(AppError::PermissionDenied("setup rejected".into())) },
        |_, path| {
            fs::remove_file(path)?;
            Ok(())
        },
    ));

    let error = result.expect_err("setup failure must be returned before execution");
    assert!(matches!(&error, AppError::Other(_)));
    assert!(error.to_string().contains("before execution"));
    assert!(error.to_string().contains("setup rejected"));
    assert_eq!(fs::read(&file).unwrap(), b"exact original bytes");
}

#[test]
fn setup_panic_is_an_ordinary_pre_effect_error() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("untouched.txt");
    fs::write(&file, b"exact original bytes").unwrap();

    let error = run(run_dedicated(
        plan(&[&file]),
        || -> Result<(), AppError> { panic!("injected setup panic") },
        |_, path| {
            fs::remove_file(path)?;
            Ok(())
        },
    ))
    .expect_err("setup panic must fail before an item becomes active");

    assert!(
        matches!(&error, AppError::Other(_)),
        "pre-effect setup panic must not be classified WorkerFailed: {error:?}"
    );
    assert!(error.to_string().contains("injected setup panic"));
    assert_eq!(fs::read(&file).unwrap(), b"exact original bytes");
}

#[derive(Debug)]
enum ContextEvent {
    Setup(ThreadId),
    Operation(String, ThreadId),
    Drop(ThreadId),
}

struct LocalContext {
    // The dedicated worker owns this context for its complete lifetime. Rc
    // makes a compile-time regression to a C: Send API impossible.
    _local: Rc<()>,
    worker: ThreadId,
    events: SyncSender<ContextEvent>,
}

impl Drop for LocalContext {
    fn drop(&mut self) {
        let _ = self.events.send(ContextEvent::Drop(thread::current().id()));
    }
}

#[test]
fn non_send_context_is_created_used_and_dropped_on_one_dedicated_thread() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    let first_path = path_string(&first);
    let second_path = path_string(&second);
    let caller = thread::current().id();
    let (events_tx, events_rx) = mpsc::sync_channel(8);
    let setup_events = events_tx.clone();

    let outcome = run(run_dedicated(
        plan(&[&first, &second]),
        move || {
            let worker = thread::current().id();
            setup_events.send(ContextEvent::Setup(worker)).unwrap();
            Ok(LocalContext {
                _local: Rc::new(()),
                worker,
                events: setup_events,
            })
        },
        |context, path| {
            assert_eq!(thread::current().id(), context.worker);
            context
                .events
                .send(ContextEvent::Operation(path.into(), thread::current().id()))
                .unwrap();
            Ok(())
        },
    ))
    .unwrap();

    assert_eq!(outcome.succeeded, [first_path.clone(), second_path.clone()]);
    let events: Vec<_> = events_rx.try_iter().collect();
    let worker = match &events[0] {
        ContextEvent::Setup(worker) => *worker,
        other => panic!("first context event was not setup: {other:?}"),
    };
    assert_ne!(worker, caller);
    assert!(matches!(
        &events[1],
        ContextEvent::Operation(path, id) if path == &first_path && *id == worker
    ));
    assert!(matches!(
        &events[2],
        ContextEvent::Operation(path, id) if path == &second_path && *id == worker
    ));
    assert!(matches!(&events[3], ContextEvent::Drop(id) if *id == worker));
    assert_eq!(events.len(), 4);
}

#[test]
fn operation_panic_preserves_prior_success_and_marks_only_active_effect_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let active = dir.path().join("active.txt");
    let unstarted = dir.path().join("unstarted.txt");
    fs::write(&first, b"first exact bytes").unwrap();
    fs::write(&active, b"active exact bytes").unwrap();
    fs::write(&unstarted, b"unstarted exact bytes").unwrap();
    let active_path = path_string(&active);

    let outcome = run(run_dedicated(
        plan(&[&first, &active, &unstarted]),
        || Ok(()),
        move |_, path| {
            fs::remove_file(path)?;
            if path == active_path {
                panic!("injected operation panic after effect");
            }
            Ok(())
        },
    ))
    .unwrap();

    assert_eq!(outcome.succeeded, [path_string(&first)]);
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.uncertain.len(), 1);
    assert_eq!(outcome.uncertain[0].path, path_string(&active));
    assert!(outcome.uncertain[0]
        .error
        .contains("injected operation panic after effect"));
    assert_eq!(outcome.unstarted, [path_string(&unstarted)]);
    assert!(!first.exists());
    assert!(!active.exists());
    assert_eq!(fs::read(&unstarted).unwrap(), b"unstarted exact bytes");
}

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

#[test]
fn dropping_a_polled_future_after_acceptance_does_not_cancel_the_worker() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("committed-after-caller-drop.txt");
    fs::write(&file, b"must be removed").unwrap();
    let file_for_worker = file.clone();
    let (accepted_tx, accepted_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (completed_tx, completed_rx) = mpsc::sync_channel(1);
    let (polled_tx, polled_rx) = mpsc::sync_channel(1);
    let (drop_tx, drop_rx) = mpsc::sync_channel(1);

    let poller = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build polling runtime");
        let _runtime = runtime.enter();
        let mut future = Box::pin(run_dedicated(
            plan(&[&file_for_worker]),
            || Ok(()),
            move |_, path| {
                accepted_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                fs::remove_file(path)?;
                completed_tx.send(()).unwrap();
                Ok(())
            },
        ));
        polled_tx.send(poll_once(future.as_mut())).unwrap();
        drop_rx.recv().unwrap();
        drop(future);
    });

    let poll = polled_rx
        .recv_timeout(DEADLINE)
        .expect("the async caller must not block while the worker is held");
    assert!(matches!(poll, Poll::Pending));
    accepted_rx
        .recv_timeout(DEADLINE)
        .expect("worker accepted its active item");
    drop_tx.send(()).unwrap();
    poller.join().unwrap();

    release_tx.send(()).unwrap();
    completed_rx
        .recv_timeout(DEADLINE)
        .expect("detached worker completes after its caller future is dropped");
    assert!(!file.exists());
}

#[cfg(target_os = "windows")]
#[test]
fn dedicated_sta_does_not_change_a_fresh_mta_caller_apartment() {
    use crate::files::windows_restore::StaApartment;

    thread::Builder::new()
        .name("dedicated-batch-mta-caller-test".into())
        .spawn(|| {
            let _caller_com = MtaCaller::initialize();
            assert_eq!(current_apartment(), APTTYPE_MTA);

            let dir = tempfile::tempdir().unwrap();
            let item = dir.path().join("restore-item.txt");
            fs::write(&item, b"unchanged").unwrap();
            let outcome = run(run_dedicated(
                plan(&[&item]),
                || {
                    let apartment = StaApartment::new()?;
                    assert_sta();
                    Ok(apartment)
                },
                |_apartment, _| {
                    assert_sta();
                    Ok(())
                },
            ))
            .expect("dedicated STA batch completes");

            assert_eq!(outcome.succeeded, [path_string(&item)]);
            assert!(outcome.failed.is_empty());
            assert!(outcome.uncertain.is_empty());
            assert!(outcome.unstarted.is_empty());
            assert_eq!(current_apartment(), APTTYPE_MTA);
        })
        .expect("spawn fresh MTA caller")
        .join()
        .expect("MTA caller test thread completes");
}

#[cfg(target_os = "windows")]
#[test]
fn public_trash_and_restore_batches_preserve_an_mta_caller_and_exact_file_bytes() {
    use crate::files::{
        trash::{move_multiple_to_trash, restore_entries},
        trash_artifact::RestoreRequest,
    };

    thread::Builder::new()
        .name("public-trash-mta-caller-test".into())
        .spawn(|| {
            let _caller_com = MtaCaller::initialize();
            assert_eq!(current_apartment(), APTTYPE_MTA);

            let dir = tempfile::tempdir().unwrap();
            let first = dir.path().join("batch-first.txt");
            let second = dir.path().join("batch-second.txt");
            let single = dir.path().join("single.txt");
            fs::write(&first, b"first exact bytes").unwrap();
            fs::write(&second, b"second exact bytes").unwrap();
            fs::write(&single, b"single exact bytes").unwrap();
            let first_path = path_string(&first);
            let second_path = path_string(&second);
            let single_path = path_string(&single);

            // Retain the deletion outcomes: their exact artifacts are the only
            // authority the restore batch may use.
            let trashed = run(move_multiple_to_trash(vec![
                first_path.clone(),
                second_path.clone(),
            ]));
            let after_batch_apartment = current_apartment();
            let batch_sources_absent = !first.exists() && !second.exists();
            let single_trashed = run(move_multiple_to_trash(vec![single_path.clone()]));
            let after_single_apartment = current_apartment();
            let single_source_absent = !single.exists();
            let requests = [&first_path, &second_path]
                .into_iter()
                .map(|path| RestoreRequest {
                    path: path.clone(),
                    artifact: trashed
                        .as_ref()
                        .expect("public batch trash call completes")
                        .artifacts[path]
                        .clone(),
                })
                .chain(std::iter::once_with(|| RestoreRequest {
                    path: single_path.clone(),
                    artifact: single_trashed
                        .as_ref()
                        .expect("public single-item trash call completes")
                        .artifacts[&single_path]
                        .clone(),
                }))
                .collect();
            let restored = run(restore_entries(requests));
            let after_restore_apartment = current_apartment();

            let trashed = trashed.expect("public batch trash call completes");
            assert_eq!(trashed.succeeded, [first_path.clone(), second_path.clone()]);
            assert!(trashed.failed.is_empty());
            assert!(trashed.uncertain.is_empty());
            assert!(trashed.unstarted.is_empty());
            let single_trashed = single_trashed.expect("public single-item trash call completes");
            assert_eq!(single_trashed.succeeded, std::slice::from_ref(&single_path));
            assert!(single_trashed.failed.is_empty());
            assert!(single_trashed.uncertain.is_empty());
            assert!(single_trashed.unstarted.is_empty());
            assert!(batch_sources_absent);
            assert!(single_source_absent);
            assert_eq!(after_batch_apartment, APTTYPE_MTA);
            assert_eq!(after_single_apartment, APTTYPE_MTA);

            let restored = restored.expect("public restore batch completes");
            assert_eq!(
                restored.succeeded,
                [first_path.clone(), second_path.clone(), single_path.clone()]
            );
            assert!(restored.failed.is_empty());
            assert!(restored.uncertain.is_empty());
            assert!(restored.unstarted.is_empty());
            assert_eq!(fs::read(&first).unwrap(), b"first exact bytes");
            assert_eq!(fs::read(&second).unwrap(), b"second exact bytes");
            assert_eq!(fs::read(&single).unwrap(), b"single exact bytes");
            assert_eq!(after_restore_apartment, APTTYPE_MTA);
        })
        .expect("spawn fresh public-trash MTA caller")
        .join()
        .expect("public-trash MTA caller test thread completes");
}
