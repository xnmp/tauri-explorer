use super::*;
use std::sync::mpsc;
use std::time::Duration;
use tempfile::tempdir;

const GATE_TIMEOUT: Duration = Duration::from_secs(5);

struct ScanGate {
    entered: mpsc::Receiver<()>,
    release: Option<mpsc::Sender<()>>,
    finished: mpsc::Receiver<()>,
}

impl ScanGate {
    fn wait_for_snapshot(&self) {
        self.entered
            .recv_timeout(GATE_TIMEOUT)
            .expect("real directory scan did not reach the publication gate");
    }

    fn release(mut self) {
        self.release
            .take()
            .unwrap()
            .send(())
            .expect("gated directory scan ended before release");
        self.finished
            .recv_timeout(GATE_TIMEOUT)
            .expect("released directory scan did not finish");
    }
}

impl Drop for ScanGate {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}

fn gated_real_scan() -> (
    impl FnOnce(&PathBuf) -> ScanResult + Send + 'static,
    ScanGate,
) {
    let (entered_send, entered) = mpsc::channel();
    let (release, release_receive) = mpsc::channel();
    let (finished_send, finished) = mpsc::channel();
    let scan = move |path: &PathBuf| {
        let result = scan_directory_with_diagnostics(path);
        entered_send
            .send(())
            .expect("publication-gate owner disappeared");
        release_receive
            .recv_timeout(GATE_TIMEOUT)
            .expect("publication gate was not released");
        let _ = finished_send.send(());
        result
    };
    (
        scan,
        ScanGate {
            entered,
            release: Some(release),
            finished,
        },
    )
}

fn entry_names(listing: &DirectoryListing) -> Vec<String> {
    listing
        .entries
        .iter()
        .map(|entry| entry.name.clone())
        .collect()
}

#[test]
fn invalidation_rejects_an_inflight_snapshot_with_or_without_a_newer_read() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        for complete_newer_read in [false, true] {
            let directory = tempdir().unwrap();
            std::fs::write(directory.path().join("old.txt"), "old").unwrap();
            let path = directory.path().to_string_lossy().into_owned();
            invalidate_dir_cache_sync(&path);

            let (scan, gate) = gated_real_scan();
            let first_path = path.clone();
            let older = tokio::spawn(async move { list_directory_with(first_path, scan).await });
            gate.wait_for_snapshot();

            std::fs::write(directory.path().join("later.txt"), "later").unwrap();
            invalidate_dir_cache_sync(&path);
            if complete_newer_read {
                let newer = list_directory(path.clone()).await.unwrap();
                assert!(entry_names(&newer).contains(&"later.txt".to_string()));
            }

            gate.release();
            let older = older.await.unwrap().unwrap();
            assert_eq!(entry_names(&older), vec!["old.txt"]);

            let current = list_directory(path.clone()).await.unwrap();
            assert!(
                entry_names(&current).contains(&"later.txt".to_string()),
                "an invalidated in-flight scan must not repopulate stale cache; newer_read={complete_newer_read}"
            );
            invalidate_dir_cache_sync(&path);
        }
    });
}

#[test]
fn an_older_same_path_miss_cannot_overwrite_a_newer_completed_miss() {
    let directory = tempdir().unwrap();
    std::fs::write(directory.path().join("old.txt"), "old").unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    invalidate_dir_cache_sync(&path);
    let runtime = tokio::runtime::Runtime::new().unwrap();

    runtime.block_on(async {
        let (scan, gate) = gated_real_scan();
        let first_path = path.clone();
        let older = tokio::spawn(async move { list_directory_with(first_path, scan).await });
        gate.wait_for_snapshot();

        std::fs::write(directory.path().join("new.txt"), "new").unwrap();
        let newer = list_directory(path.clone()).await.unwrap();
        assert!(entry_names(&newer).contains(&"new.txt".to_string()));

        gate.release();
        let older = older.await.unwrap().unwrap();
        assert_eq!(entry_names(&older), vec!["old.txt"]);

        let current = list_directory(path.clone()).await.unwrap();
        assert!(
            entry_names(&current).contains(&"new.txt".to_string()),
            "the older completion must not replace the newer same-path snapshot"
        );
    });
    invalidate_dir_cache_sync(&path);
}

#[test]
fn cancelling_a_gated_real_scan_retires_its_publication_authority() {
    let directory = tempdir().unwrap();
    std::fs::write(directory.path().join("old.txt"), "old").unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    invalidate_dir_cache_sync(&path);
    let runtime = tokio::runtime::Runtime::new().unwrap();

    runtime.block_on(async {
        let (scan, gate) = gated_real_scan();
        let first_path = path.clone();
        let abandoned = tokio::spawn(async move { list_directory_with(first_path, scan).await });
        gate.wait_for_snapshot();

        abandoned.abort();
        assert!(abandoned.await.unwrap_err().is_cancelled());
        std::fs::write(directory.path().join("later.txt"), "later").unwrap();
        gate.release();

        let current = list_directory(path.clone()).await.unwrap();
        assert!(entry_names(&current).contains(&"later.txt".to_string()));
    });
    invalidate_dir_cache_sync(&path);
}

#[test]
fn a_partial_listing_is_returned_to_its_caller_but_not_cached() {
    let directory = tempdir().unwrap();
    std::fs::write(directory.path().join("visible.txt"), "visible").unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    invalidate_dir_cache_sync(&path);
    let runtime = tokio::runtime::Runtime::new().unwrap();

    runtime.block_on(async {
        let partial = list_directory_with(path.clone(), |root| {
            let (entries, mut diagnostics) = scan_directory_with_diagnostics(root)?;
            diagnostics.record("injected child metadata race");
            Ok((entries, diagnostics))
        })
        .await
        .unwrap();
        assert_eq!(entry_names(&partial), vec!["visible.txt"]);

        std::fs::write(directory.path().join("later.txt"), "later").unwrap();
        let current = list_directory(path.clone()).await.unwrap();
        assert!(entry_names(&current).contains(&"later.txt".to_string()));
    });
    invalidate_dir_cache_sync(&path);
}

#[test]
fn disappearing_root_is_an_error_instead_of_a_successful_empty_listing() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("vanishing");
    fs::create_dir(&path).unwrap();
    let path_string = path.to_string_lossy().into_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(list_directory_with(path_string.clone(), |root| {
        fs::remove_dir(root).unwrap();
        scan_directory_with_diagnostics(root)
    }));
    assert!(matches!(result, Err(AppError::NotFound(_))), "{result:?}");
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains(&path.display().to_string()),
        "a failed navigation must identify the requested root"
    );

    fs::create_dir(&path).unwrap();
    fs::write(path.join("restored.txt"), "restored").unwrap();
    let restored = runtime
        .block_on(list_directory(path_string.clone()))
        .unwrap();
    assert_eq!(entry_names(&restored), vec!["restored.txt"]);
    invalidate_dir_cache_sync(&path_string);
}

#[cfg(unix)]
#[test]
fn unreadable_root_returns_permission_error_and_does_not_cache_empty_success() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempdir().unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o000)).unwrap();
    // Privileged test runners bypass permission bits; this contract requires a
    // real denied read, not a fabricated scanner error.
    if fs::read_dir(directory.path()).is_ok() {
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        return;
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(list_directory(path.clone()));
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        matches!(result, Err(AppError::PermissionDenied(_))),
        "{result:?}"
    );
    fs::write(directory.path().join("restored.txt"), "readable again").unwrap();
    let restored = runtime.block_on(list_directory(path.clone())).unwrap();
    assert_eq!(entry_names(&restored), vec!["restored.txt"]);
    invalidate_dir_cache_sync(&path);
}

#[test]
fn fresh_listing_returns_the_complete_sorted_snapshot_and_bypasses_cache() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let directory = tempdir().unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    runtime.block_on(list_directory(path.clone())).unwrap();
    for index in (0..10_003).rev() {
        fs::write(directory.path().join(format!("file-{index:05}.txt")), "x").unwrap();
    }
    let listing = runtime
        .block_on(fresh_listing(path.clone(), TraceHandle::none()))
        .unwrap();
    assert_eq!(listing.path, path);
    assert_eq!(
        entry_names(&listing),
        (0..10_003)
            .map(|index| format!("file-{index:05}.txt"))
            .collect::<Vec<_>>()
    );
    fs::remove_dir_all(directory.path()).unwrap();
    assert!(runtime
        .block_on(fresh_listing(path, TraceHandle::none()))
        .is_err());
}

/// #1022: a traced fresh listing records every native scan phase in order,
/// with its entry counts, so a slow-load record can name the slow phase.
#[test]
fn traced_fresh_listing_records_each_native_phase() {
    use crate::load_diagnostics::trace::{snapshot, Outcome, Phase, TraceScope};
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let directory = tempdir().unwrap();
    for index in 0..25 {
        fs::write(directory.path().join(format!("f{index}")), "x").unwrap();
    }
    fs::create_dir(directory.path().join("sub")).unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    // The command's own composition: scope, listing, then a traced reply.
    let traced = |id: &str, path: String| {
        let scope = TraceScope::begin(Some(id.to_owned()), &path);
        let trace = scope.handle();
        TracedReply::wrap(scope, runtime.block_on(fresh_listing(path, trace)))
    };
    let id = "1700000000000-fresh1";
    let reply = traced(id, path.clone()).unwrap();
    assert_eq!(
        snapshot(id).unwrap().outcome,
        Outcome::Pending,
        "open until encoded"
    );
    let wire = serde_json::to_value(&reply).unwrap();
    assert_eq!(wire["columns"]["names"].as_array().unwrap().len(), 26);
    let trace = snapshot(id).expect("finished trace is retained");
    assert_eq!(trace.outcome, Outcome::Ok);
    assert_eq!(trace.pending_phase, None);
    assert_eq!(trace.entries_listed, 26);
    assert_eq!(trace.entries_statted, 26);
    assert_eq!(trace.entries_done, 26);
    assert_eq!(trace.stat_failures, 0);
    assert!(trace.git_repo_probe);
    let phases: Vec<Phase> = trace.phases.iter().map(|phase| phase.phase).collect();
    assert_eq!(
        phases,
        vec![
            // Waiting for a pool thread, then resolving on it.
            Phase::BlockingQueue,
            Phase::ResolvePath,
            Phase::BlockingQueue,
            Phase::RootMetadata,
            Phase::ReadDir,
            Phase::EntryMetadata,
            Phase::Sort,
            Phase::Respond,
            Phase::Serialize,
        ]
    );

    let missing = "1700000000000-fresh2";
    fs::remove_dir_all(directory.path()).unwrap();
    assert!(traced(missing, path).is_err());
    let failed = snapshot(missing).unwrap();
    assert_eq!(failed.outcome, Outcome::Error);
    assert_eq!(failed.phases.last().unwrap().phase, Phase::RootMetadata);
}

/// Stands in for the watcher's pending lease in `observed_listing`.
struct AdmittedForTest(super::super::directory_watches::Lease);

impl AdmittedLease for AdmittedForTest {
    fn path(&self) -> &str {
        &self.0.path
    }
    fn take(self) -> super::super::directory_watches::Lease {
        self.0
    }
}

#[test]
fn observed_listing_traces_ownership_watch_and_scan_in_production_order() {
    use crate::load_diagnostics::trace::{snapshot, Outcome, Phase, TraceScope};
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let directory = tempdir().unwrap();
    fs::write(directory.path().join("a.txt"), "a").unwrap();
    let path = directory.path().to_string_lossy().into_owned();
    let run = |id: &str, owner: Owner| {
        let scope = TraceScope::begin(Some(id.to_owned()), &path);
        let trace = scope.handle();
        let observed_path = path.clone();
        let result = runtime.block_on(observed_listing(
            trace,
            || Ok(owner),
            |owner, trace| async move {
                // The watcher's own phases, as `acquire_pending_directory` marks them.
                trace.enter(Phase::WatchLock);
                trace.enter(Phase::WatchRegister);
                let _ = owner;
                Ok(AdmittedForTest(super::super::directory_watches::Lease {
                    id: "lease".into(),
                    path: observed_path,
                }))
            },
        ));
        TracedReply::wrap(scope, result)
    };

    let id = "1700000000000-observed1";
    let reply = run(id, Owner::default()).unwrap();
    let wire = serde_json::to_value(&reply).unwrap();
    assert_eq!(wire["watch_lease"]["id"], "lease");
    let trace = snapshot(id).unwrap();
    assert_eq!(trace.outcome, Outcome::Ok);
    let phases: Vec<Phase> = trace.phases.iter().map(|phase| phase.phase).collect();
    assert_eq!(
        phases,
        vec![
            Phase::OwnerAcquire,
            Phase::WatchLock,
            Phase::WatchRegister,
            Phase::BlockingQueue,
            Phase::RootMetadata,
            Phase::ReadDir,
            Phase::EntryMetadata,
            Phase::Sort,
            Phase::Respond,
            Phase::Serialize,
        ]
    );

    // A renderer replaced mid-scan fails the listing and settles the trace.
    let replaced = Owner::default();
    replaced.retire();
    let id = "1700000000000-observed2";
    assert!(run(id, replaced).is_err());
    assert_eq!(snapshot(id).unwrap().outcome, Outcome::Error);
}
