use super::*;
use crate::{files::recovery::model::RecoverySnapshot, renderer_owner::Owner};

#[test]
fn grouped_receipts_survive_inventory_error_and_panic_with_usable_independent_inverses() {
    use crate::files::{
        batch::receipts::ItemState,
        recovery::{history, ReplacementDirection},
    };
    for panics in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let sources: Vec<_> = (0..2)
            .map(|i| directory.path().join(format!("source-{i}")))
            .collect();
        let targets: Vec<_> = (0..2)
            .map(|i| directory.path().join(format!("target-{i}")))
            .collect();
        for (i, (source, target)) in sources.iter().zip(&targets).enumerate() {
            std::fs::write(source, format!("new {i}")).unwrap();
            std::fs::write(target, format!("old {i}")).unwrap();
        }
        let copies: Vec<_> = sources
            .iter()
            .zip(&targets)
            .map(|(s, t)| (s.as_path(), t.as_path()))
            .collect();
        let storage = directory.path().join("recovery");
        let runtime = Runtime::default();
        let mut progress = crate::progress::ProgressTracker::new(
            None,
            "copy-progress",
            "Copy cancelled",
            0,
            0,
            None,
        );
        let outcome = runtime
            .replace_copies_with(storage.clone(), &copies, &mut progress, |_| {
                if panics {
                    panic!("inventory publisher interrupted");
                }
                Err(AppError::Other("inventory unavailable".into()))
            })
            .unwrap();
        assert!(outcome.warnings.into_vec().join("\n").contains("inventory"));
        assert_eq!(outcome.items.len(), 2);
        let coordinator = runtime.coordinator(storage).unwrap();
        assert_eq!(
            super::super::service::list(&coordinator)
                .unwrap()
                .items
                .len(),
            2
        );
        for (i, item) in outcome.items.into_iter().enumerate() {
            let ItemState::Succeeded(receipt) = item.state else {
                panic!("publication failure lost a receipt")
            };
            assert_eq!(
                std::fs::read(&targets[i]).unwrap(),
                format!("new {i}").as_bytes()
            );
            history::execute(
                &coordinator,
                receipt.replacement.unwrap().history,
                ReplacementDirection::Restore,
            )
            .unwrap();
            assert_eq!(
                std::fs::read(&targets[i]).unwrap(),
                format!("old {i}").as_bytes()
            );
        }
    }
}

#[test]
fn an_oversized_inventory_diagnostic_does_not_overgrow_or_replace_the_committed_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    std::fs::write(&source, "new").unwrap();
    std::fs::write(&target, "old").unwrap();
    let mut progress =
        crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None);
    let runtime = Runtime::default();
    let receipt = runtime
        .replace_copy_with(
            directory.path().join("recovery"),
            &source,
            &target,
            &mut progress,
            |_| Err(AppError::Other("界".repeat(32_768))),
        )
        .unwrap();
    let replacement = receipt.replacement.unwrap();
    let warning = replacement.warning.unwrap();
    assert!(warning.len() <= 16 * 1024);
    assert!(warning.ends_with("Additional warnings were omitted"));
    assert_eq!(std::fs::read(&target).unwrap(), b"new");
    assert!(!replacement.history.id.is_empty());
}

#[test]
fn losing_the_ipc_waiter_does_not_cancel_publication_of_completed_owned_work() {
    tauri::async_runtime::block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery");
        let runtime = Runtime::default();
        let (published, mut received) = tokio::sync::mpsc::unbounded_channel();
        let receive = move |snapshot: &RecoverySnapshot| published.send(snapshot.clone()).is_ok();
        runtime
            .subscribe(path.clone(), Owner::default(), 1, receive)
            .await
            .unwrap();
        received.recv().await.unwrap(); // initial inventory
        let (started, entered) = tokio::sync::oneshot::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        let worker = runtime.clone();
        let request = tokio::spawn(async move {
            worker
                .operate(path, move |_| {
                    started.send(()).unwrap();
                    resumed
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok(RecoverySnapshot {
                        revision: 42,
                        items: vec![],
                        error: None,
                    })
                })
                .await
        });
        entered.await.unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        resume.send(()).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.revision, 42);
    });
}

#[test]
fn failed_operation_publishes_fresh_inventory_without_replacing_its_error() {
    tauri::async_runtime::block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery");
        let runtime = Runtime::default();
        let (published, mut received) = tokio::sync::mpsc::unbounded_channel();
        runtime
            .subscribe(path.clone(), Owner::default(), 1, move |snapshot| {
                published.send(snapshot.clone()).is_ok()
            })
            .await
            .unwrap();
        received.recv().await.unwrap();
        let error = runtime
            .operate(path, |_| Err(AppError::Other("operation failed".into())))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "operation failed");
        let result = received
            .try_recv()
            .expect("failure still publishes authoritative inventory");
        assert!(result.items.is_empty());
    });
}

#[test]
fn failed_delivery_does_not_fail_the_native_operation_or_acknowledge_a_dead_channel() {
    tauri::async_runtime::block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery");
        let runtime = Runtime::default();
        let result = runtime
            .subscribe(path.clone(), Owner::default(), 1, |_| false)
            .await;
        assert!(result.is_err());
        let result = runtime
            .operate(path, |_| {
                Ok(RecoverySnapshot {
                    revision: 17,
                    items: vec![],
                    error: None,
                })
            })
            .await
            .unwrap();
        assert_eq!(result.revision, 17);
    });
}

#[test]
fn cancelled_discovery_releases_its_channel_while_newer_discovery_can_finish() {
    tauri::async_runtime::block_on(async {
        use std::{
            future::Future,
            task::{Context, Waker},
        };
        struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery");
        let runtime = Runtime::default();
        let owner = Owner::default();
        let (released, retired) = tokio::sync::oneshot::channel();
        let retained = Dropped(Some(released));
        let mut old = Box::pin(runtime.subscribe(path.clone(), owner.clone(), 1, move |_| {
            let _ = &retained;
            panic!("cancelled discovery must not deliver");
        }));
        let (delivered, mut received) = tokio::sync::mpsc::unbounded_channel();
        let mut new = Box::pin(runtime.subscribe(path.clone(), owner, 2, move |_| {
            delivered.send(()).unwrap();
            true
        }));
        {
            // Hold only initialization so both real IPC futures can register and
            // dispatch discovery before either blocking worker reads storage.
            let _initialization = runtime.initialized.lock().unwrap();
            let mut context = Context::from_waker(Waker::noop());
            assert!(old.as_mut().poll(&mut context).is_pending());
            assert!(new.as_mut().poll(&mut context).is_pending());
            drop(old);
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), retired)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), new)
            .await
            .unwrap()
            .unwrap();
        received
            .try_recv()
            .expect("replacement receives discovery despite cancelled old request");
    });
}

#[test]
fn committed_replacement_survives_failed_inventory_refresh_with_a_warning_and_no_replay() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    std::fs::write(&source, "new bytes").unwrap();
    std::fs::write(&target, "original bytes").unwrap();
    let runtime = Runtime::default();
    let storage = directory.path().join("recovery");
    let mut progress =
        crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None);
    let receipt = runtime
        .replace_copy_with(storage.clone(), &source, &target, &mut progress, |_| {
            Err(AppError::Other("inventory connection interrupted".into()))
        })
        .unwrap();
    let replacement = receipt.replacement.unwrap();
    assert_eq!(
        replacement.warning.as_deref(),
        Some("File Recovery inventory could not refresh: inventory connection interrupted")
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"new bytes");
    let recovered = tauri::async_runtime::block_on(runtime.list(storage)).unwrap();
    assert_eq!(recovered.items.len(), 1);
    assert_eq!(recovered.items[0].id, replacement.id);
    let roots: Vec<_> = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".tauri-explorer-recovery-")
        })
        .collect();
    assert_eq!(
        roots.len(),
        1,
        "discovery failure must not repeat the replacement"
    );
    assert_eq!(
        std::fs::read(roots[0].join("original")).unwrap(),
        b"original bytes"
    );
}

#[test]
fn panicking_copy_worker_publishes_its_retained_operation_before_reporting_failure() {
    struct PanicProgress;
    impl crate::files::anchored_copy::CopyProgress for PanicProgress {
        fn check_cancelled(&mut self) -> Result<(), AppError> {
            Ok(())
        }
        fn advance(&mut self, _: u64, _: &std::path::Path) -> Result<(), AppError> {
            panic!("copy worker interrupted after writing private bytes");
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    std::fs::write(&source, "new bytes").unwrap();
    std::fs::write(&target, "original bytes").unwrap();
    let runtime = Runtime::default();
    let storage = directory.path().join("recovery");
    let (sender, receiver) = std::sync::mpsc::channel();
    tauri::async_runtime::block_on(runtime.subscribe(
        storage.clone(),
        Owner::default(),
        1,
        move |snapshot| sender.send(snapshot.clone()).is_ok(),
    ))
    .unwrap();
    receiver.recv().unwrap();
    let result = runtime.replace_copy(storage, &source, &target, &mut PanicProgress);
    assert!(matches!(result, Err(AppError::WorkerFailed(_))));
    let updated = receiver
        .try_recv()
        .expect("panic still publishes the actual durable record");
    assert_eq!(updated.items.len(), 1);
    assert_eq!(std::fs::read(&target).unwrap(), b"original bytes");
    assert_eq!(std::fs::read(&source).unwrap(), b"new bytes");
}

#[test]
fn dropping_a_copy_reply_waiter_keeps_the_real_replacement_and_inventory_publication_alive() {
    struct PausedCopy {
        entered: Option<tokio::sync::oneshot::Sender<()>>,
        resumed: std::sync::mpsc::Receiver<()>,
    }
    impl crate::files::anchored_copy::CopyProgress for PausedCopy {
        fn check_cancelled(&mut self) -> Result<(), AppError> {
            Ok(())
        }
        fn advance(&mut self, _: u64, _: &std::path::Path) -> Result<(), AppError> {
            if let Some(entered) = self.entered.take() {
                entered.send(()).unwrap();
                self.resumed
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
            Ok(())
        }
    }
    tauri::async_runtime::block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        std::fs::write(&source, "new bytes").unwrap();
        std::fs::write(&target, "original bytes").unwrap();
        let storage = directory.path().join("recovery");
        let runtime = Runtime::default();
        let (published, mut received) = tokio::sync::mpsc::unbounded_channel();
        runtime
            .subscribe(storage.clone(), Owner::default(), 1, move |snapshot| {
                published.send(snapshot.clone()).is_ok()
            })
            .await
            .unwrap();
        received.recv().await.unwrap();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        let destination = target.clone();
        let request = tokio::spawn(async move {
            crate::files::run_blocking(move || {
                runtime.replace_copy(
                    storage,
                    &source,
                    &destination,
                    &mut PausedCopy {
                        entered: Some(started),
                        resumed,
                    },
                )
            })
            .await
        });
        entered.await.unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(std::fs::read(&target).unwrap(), b"original bytes");
        resume.send(()).unwrap();
        let updated = tokio::time::timeout(std::time::Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.items.len(), 1);
        assert_eq!(std::fs::read(&target).unwrap(), b"new bytes");
        let root = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".tauri-explorer-recovery-")
            })
            .unwrap();
        assert_eq!(
            std::fs::read(root.join("original")).unwrap(),
            b"original bytes"
        );
    });
}
