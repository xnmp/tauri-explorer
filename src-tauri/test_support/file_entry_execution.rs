use super::*;
use crate::files::recovery::{Access, ResourceRequest, Runtime, Scope};
use std::{fs, path::Path, time::Duration};

fn write(path: &Path) -> Vec<ResourceRequest> {
    vec![ResourceRequest {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]
}

struct HoldCleanup {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
impl Drop for HoldCleanup {
    fn drop(&mut self) {
        self.entered.send(()).unwrap();
        self.release.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}

#[test]
fn entry_claim_survives_waiter_loss_until_real_worker_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let before = root.path().join("before");
    let after = root.path().join("after");
    fs::write(&before, b"complete rename").unwrap();
    let runtime = Runtime::default();
    let storage = root.path().join("recovery");
    let plan = EntryPlan::rename(before.to_str().unwrap().into(), "after".into()).unwrap();
    let (plan, admission) =
        tauri::async_runtime::block_on(admit(plan, runtime.clone(), storage.clone())).unwrap();
    let (entered, started) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let task = tauri::async_runtime::spawn(async move {
        // Destruction order: paused cleanup completes before the claim is dropped.
        let owner = (
            HoldCleanup {
                entered,
                release: wait,
            },
            admission.context(),
        );
        let outcome = execute_owned(plan, owner).await;
        finish(outcome, admission).await
    });
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(fs::read(&after).unwrap(), b"complete rename");
    assert!(!before.exists());
    task.abort();
    let _ = tauri::async_runtime::block_on(task);
    assert!(tauri::async_runtime::block_on(runtime.admit(storage.clone(), write(&after))).is_err());
    assert!(
        tauri::async_runtime::block_on(runtime.admit(storage.clone(), write(&before))).is_err()
    );
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(next) =
            tauri::async_runtime::block_on(runtime.admit(storage.clone(), write(&after)))
        {
            next.finish().unwrap();
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(fs::read(after).unwrap(), b"complete rename");
}

#[test]
fn confirmed_rename_survives_worker_cleanup_panic_and_retirement_failure() {
    struct Panics;
    impl Drop for Panics {
        fn drop(&mut self) {
            panic!("injected cleanup panic");
        }
    }
    tauri::async_runtime::block_on(async {
        let root = tempfile::tempdir().unwrap();
        let before = root.path().join("before");
        let after = root.path().join("after");
        fs::write(&before, b"confirmed bytes").unwrap();
        let storage = root.path().join("recovery");
        let plan = EntryPlan::rename(before.to_str().unwrap().into(), "after".into()).unwrap();
        let (plan, admission) = admit(plan, Runtime::default(), storage.clone())
            .await
            .unwrap();
        let outcome = execute_owned(plan, (Panics, admission.context())).await;
        assert_eq!(fs::read(&after).unwrap(), b"confirmed bytes");
        fs::rename(
            storage.join("admission.lock"),
            storage.join("displaced.lock"),
        )
        .unwrap();
        let outcome = finish(outcome, admission).await;
        assert!(outcome.completion.result.is_ok());
        let warning = outcome.completion.warning.unwrap();
        assert!(warning.contains("injected cleanup panic"));
        assert!(warning.contains("ownership record could not be retired"));
        assert_eq!(outcome.target, after);
        assert_eq!(outcome.affected, [root.path().to_str().unwrap()]);
    });
}

#[test]
fn rename_binding_rejects_incoherent_parent_capture_before_any_effect() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(b.join("before"), b"unrelated source").unwrap();
    let plan = EntryPlan::rename(
        root.path().join("alias/before").to_str().unwrap().into(),
        "after".into(),
    )
    .unwrap();
    // A parent alias can change between independent source/target observations.
    let bound = plan.resolve([a.join("after"), b.join("before")].into_iter());
    assert!(
        bound.is_err(),
        "one rename must not bind two physical parents"
    );
    assert_eq!(fs::read(b.join("before")).unwrap(), b"unrelated source");
    assert!(!a.join("after").exists());
}
