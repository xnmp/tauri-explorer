use super::*;

struct PanickingCleanup;
impl Drop for PanickingCleanup {
    fn drop(&mut self) {
        panic!("resource cleanup interrupted");
    }
}

#[test]
fn confirmed_result_survives_context_cleanup_panic_with_a_warning() {
    let completion = tauri::async_runtime::block_on(run_blocking_context(PanickingCleanup, |_| {
        Ok::<_, AppError>("committed receipt")
    }));
    assert_eq!(completion.result.unwrap(), "committed receipt");
    assert!(completion
        .warning
        .unwrap()
        .contains("resource cleanup interrupted"));
}

#[test]
fn ordinary_errors_preserve_their_kind_after_successful_context_cleanup() {
    struct Cleanup(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let retired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completion =
        tauri::async_runtime::block_on(run_blocking_context(Cleanup(Arc::clone(&retired)), |_| {
            Err::<(), _>(AppError::NotFound("original source".into()))
        }));
    assert!(
        matches!(completion.result, Err(AppError::NotFound(ref message)) if message == "original source")
    );
    assert!(completion.warning.is_none());
    assert!(retired.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn failed_work_and_failed_cleanup_preserve_both_diagnostics_as_uncertainty() {
    let completion = tauri::async_runtime::block_on(run_blocking_context(PanickingCleanup, |_| {
        Err::<(), _>(AppError::NotFound("original source".into()))
    }));
    let Err(AppError::WorkerFailed(message)) = completion.result else {
        panic!("cleanup failure must require reconciliation")
    };
    assert!(message.contains("original source"));
    assert!(message.contains("resource cleanup interrupted"));
}

#[test]
fn work_panic_does_not_skip_context_cleanup() {
    struct Cleanup(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let retired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completion = tauri::async_runtime::block_on(run_blocking_context(
        Cleanup(Arc::clone(&retired)),
        |_| -> Result<(), AppError> {
            panic!("work interrupted");
        },
    ));
    assert!(
        matches!(completion.result, Err(AppError::WorkerFailed(ref message)) if message == "work interrupted")
    );
    assert!(retired.load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn work_and_cleanup_panics_do_not_abort_the_process() {
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::worker::tests::double_panic_helper",
            "--ignored",
            "--nocapture",
        ])
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "double-panic process failed: {}",
        String::from_utf8_lossy(&child.stderr)
    );
}

#[test]
#[ignore = "subprocess helper"]
fn double_panic_helper() {
    let completion = tauri::async_runtime::block_on(run_blocking_context(
        PanickingCleanup,
        |_| -> Result<(), AppError> {
            panic!("work interrupted");
        },
    ));
    let Err(AppError::WorkerFailed(message)) = completion.result else {
        panic!("both failures must require reconciliation")
    };
    assert!(message.contains("work interrupted"));
    assert!(message.contains("resource cleanup interrupted"));
}

struct PausedCleanup {
    path: std::path::PathBuf,
    entered: Option<tokio::sync::oneshot::Sender<()>>,
    released: std::sync::mpsc::Receiver<()>,
    retired: Option<tokio::sync::oneshot::Sender<()>>,
}
impl PausedCleanup {
    fn execute(&mut self) -> Result<String, AppError> {
        std::fs::write(&self.path, "committed before context cleanup")?;
        Ok("confirmed".into())
    }
}
impl Drop for PausedCleanup {
    fn drop(&mut self) {
        let _ = self.entered.take().unwrap().send(());
        self.released
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let _ = self.retired.take().unwrap().send(());
    }
}

#[test]
fn result_waits_for_cleanup_and_losing_the_waiter_does_not_shorten_context_lifetime() {
    for abort in [false, true] {
        tauri::async_runtime::block_on(async {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("result");
            let (entered, cleanup_started) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel();
            let (retired, cleanup_finished) = tokio::sync::oneshot::channel();
            let mut request = tokio::spawn(run_blocking_context(
                PausedCleanup {
                    path: path.clone(),
                    entered: Some(entered),
                    released,
                    retired: Some(retired),
                },
                PausedCleanup::execute,
            ));
            tokio::time::timeout(std::time::Duration::from_secs(5), cleanup_started)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                std::fs::read(&path).unwrap(),
                b"committed before context cleanup"
            );
            assert!(
                !request.is_finished(),
                "a recorded receipt must not resolve before cleanup finishes"
            );
            if abort {
                request.abort();
                // Confirm waiter cancellation before allowing the independent
                // blocking cleanup to finish; otherwise completion may win.
                assert!((&mut request).await.unwrap_err().is_cancelled());
            }
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), cleanup_finished)
                .await
                .unwrap()
                .unwrap();
            if !abort {
                let completion = request.await.unwrap();
                assert_eq!(completion.result.unwrap(), "confirmed");
                assert!(completion.warning.is_none());
            }
        });
    }
}

#[test]
fn cleanup_diagnostics_are_bounded_without_losing_the_successful_result() {
    struct HugePanic;
    impl Drop for HugePanic {
        fn drop(&mut self) {
            std::panic::panic_any("界".repeat(100_000));
        }
    }
    let completion =
        tauri::async_runtime::block_on(run_blocking_context(HugePanic, |_| Ok::<_, AppError>(42)));
    assert_eq!(completion.result.unwrap(), 42);
    assert!(completion.warning.unwrap().len() <= 16 * 1024);
}
