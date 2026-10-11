//! Startup requests use the same transactional installer as the UI.
use crate::error::AppError;
use std::{fs, path::Path, sync::Mutex, thread::JoinHandle, time::SystemTime};

pub(super) fn apply(
    directory: &Path,
    mut install: impl FnMut(&Path) -> Result<(), AppError>,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<String>, AppError> {
    match fs::symlink_metadata(directory) {
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(cause) => return Err(cause.into()),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(AppError::Other(
                "Plugin queue must be a directory, not a symlink".into(),
            ))
        }
        Ok(_) => {}
    }
    let entries = fs::read_dir(directory)?
        .take(257)
        .collect::<Result<Vec<_>, _>>()?;
    if entries.len() > 256 {
        return Err(AppError::Other(
            "Plugin queue exceeds its entry limit".into(),
        ));
    }
    let mut packages = entries
        .into_iter()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("teplugin"))
        })
        .collect::<Vec<_>>();
    if packages.len() > 64 {
        return Err(AppError::Other("Too many queued plugin packages".into()));
    }
    // Earlier requests precede newer ones; an explicit later downgrade is respected.
    packages.sort_by_key(|entry| {
        (
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH),
            entry.file_name(),
        )
    });
    let mut errors = vec![];
    for entry in packages {
        if cancelled() {
            break;
        }
        let result = if !entry.file_type()?.is_file() {
            Err(AppError::Other(
                "Queued plugin must be a regular file".into(),
            ))
        } else {
            install(&entry.path())
        };
        match result {
            Ok(()) => {
                fs::remove_file(entry.path())?;
            }
            Err(cause) if super::service_host::is_busy(&cause) => {
                // Durable claims or live work own this package. Keep this and
                // every later request in publication order for a later launch,
                // so neither participant upgrades before its claims recover.
                errors.push(format!(
                    "Queued plugin change will retry on next launch once its AI operations are resolved: {cause}"
                ));
                break;
            }
            Err(cause) => {
                if cancelled() {
                    break;
                }
                let failed = directory.join("failed");
                fs::create_dir_all(&failed)?;
                let metadata = fs::symlink_metadata(&failed)?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(AppError::Other(
                        "Failed plugin requests must use a real directory".into(),
                    ));
                }
                // A failed older request must never retry over a newer success.
                fs::rename(entry.path(), failed.join(entry.file_name()))?;
                errors.push(format!("Queued plugin could not be installed: {cause}"));
            }
        }
    }
    Ok(errors)
}

pub(super) type WorkerSlot = Mutex<Option<JoinHandle<()>>>;

/// Publishes the queue worker while the caller holds the mutation gate.
/// Shutdown sets Closing before taking that gate, so a worker is either
/// published before shutdown inspects the slot or never spawned at all.
/// Returns Ok(false) when Closing already won.
pub(super) fn publish_worker(
    slot: &WorkerSlot,
    closing: impl Fn() -> bool,
    spawn: impl FnOnce() -> std::io::Result<JoinHandle<()>>,
) -> std::io::Result<bool> {
    if closing() {
        return Ok(false);
    }
    let worker = spawn()?;
    *slot.lock().unwrap_or_else(|cause| cause.into_inner()) = Some(worker);
    Ok(true)
}

/// Joins any published worker after Closing is set. The slot is read under
/// the mutation gate (publication is settled), but the join happens outside
/// it: the worker's own installer must be able to acquire the gate to observe
/// Closing and return.
pub(super) fn settle_worker(mutations: &Mutex<()>, slot: &WorkerSlot) {
    let worker = {
        let _published = mutations.lock().unwrap_or_else(|cause| cause.into_inner());
        slot.lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .take()
    };
    if let Some(worker) = worker {
        let _ = worker.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_cannot_finish_before_a_worker_published_during_initialization() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        };
        let mutations = Arc::new(Mutex::new(()));
        let slot = Arc::new(WorkerSlot::new(None));
        let closing = Arc::new(AtomicBool::new(false));
        let io_finished = Arc::new(AtomicBool::new(false));
        let (eligible_tx, eligible_rx) = mpsc::channel();
        let (resume_init_tx, resume_init_rx) = mpsc::channel::<()>();
        let (io_started_tx, io_started_rx) = mpsc::channel();
        let (release_io_tx, release_io_rx) = mpsc::channel::<()>();
        // Initialization: holds the gate, passes the Closing check, then pauses
        // between eligibility and handle publication.
        let init = {
            let (mutations, slot, closing, io_finished) = (
                mutations.clone(),
                slot.clone(),
                closing.clone(),
                io_finished.clone(),
            );
            std::thread::spawn(move || {
                let _initializing = mutations.lock().unwrap();
                let resume_init = Mutex::new(Some(resume_init_rx));
                let published = publish_worker(
                    &slot,
                    || {
                        let open = !closing.load(Ordering::SeqCst);
                        if let Some(resume) = resume_init.lock().unwrap().take() {
                            eligible_tx.send(()).unwrap();
                            resume.recv().unwrap();
                        }
                        !open
                    },
                    || {
                        let mutations = mutations.clone();
                        std::thread::Builder::new().spawn(move || {
                            io_started_tx.send(()).unwrap();
                            release_io_rx.recv().unwrap();
                            // The installer re-enters the gate to observe Closing.
                            drop(mutations.lock().unwrap());
                            io_finished.store(true, Ordering::SeqCst);
                        })
                    },
                )
                .unwrap();
                assert!(published);
            })
        };
        eligible_rx.recv().unwrap();
        closing.store(true, Ordering::SeqCst);
        let (shutdown_done_tx, shutdown_done_rx) = mpsc::channel();
        let shutdown = {
            let (mutations, slot, io_finished) =
                (mutations.clone(), slot.clone(), io_finished.clone());
            std::thread::spawn(move || {
                settle_worker(&mutations, &slot);
                // Profile ownership would be released here.
                shutdown_done_tx
                    .send(io_finished.load(Ordering::SeqCst))
                    .unwrap();
            })
        };
        // Let shutdown reach the gate first: the old ordering read the slot here.
        std::thread::sleep(std::time::Duration::from_millis(50));
        resume_init_tx.send(()).unwrap();
        init.join().unwrap();
        io_started_rx.recv().unwrap();
        assert!(
            shutdown_done_rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "shutdown must wait for in-flight queue IO"
        );
        release_io_tx.send(()).unwrap();
        assert!(
            shutdown_done_rx.recv().unwrap(),
            "queue IO outlived shutdown"
        );
        shutdown.join().unwrap();
    }
    #[test]
    fn closing_before_eligibility_never_spawns_a_worker() {
        let slot = WorkerSlot::new(None);
        let published = publish_worker(&slot, || true, || panic!("No worker expected")).unwrap();
        assert!(!published);
        assert!(slot.lock().unwrap().is_none());
        settle_worker(&Mutex::new(()), &slot);
    }
    #[test]
    fn spawn_refusal_leaves_no_worker_and_reports_the_cause() {
        let slot = WorkerSlot::new(None);
        let refused = publish_worker(
            &slot,
            || false,
            || {
                Err(std::io::Error::new(
                    std::io::ErrorKind::OutOfMemory,
                    "thread limit",
                ))
            },
        );
        assert_eq!(refused.unwrap_err().kind(), std::io::ErrorKind::OutOfMemory);
        assert!(slot.lock().unwrap().is_none());
    }
    #[test]
    fn missing_queue_is_optional() {
        let temp = tempfile::tempdir().unwrap();
        assert!(apply(
            &temp.path().join("absent"),
            |_| panic!("No install expected"),
            || false
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn applies_complete_packages_once_and_quarantines_failed_requests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("good.teplugin"), b"complete bytes").unwrap();
        fs::write(root.join("bad.teplugin"), b"invalid bytes").unwrap();
        fs::write(root.join(".stage-partial"), b"partial").unwrap();
        let mut installed = vec![];
        let errors = apply(
            root,
            |path| {
                let bytes = fs::read(path)?;
                if bytes == b"invalid bytes" {
                    return Err(AppError::Other("Invalid archive".into()));
                }
                installed.push(bytes);
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(installed, vec![b"complete bytes".to_vec()]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("Invalid archive"));
        assert!(!root.join("good.teplugin").exists());
        assert!(!root.join("bad.teplugin").exists());
        assert!(root.join("failed/bad.teplugin").exists());
        assert!(root.join(".stage-partial").exists());
        assert!(apply(
            root,
            |_| panic!("Committed packages must not replay"),
            || false
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn a_failed_older_request_never_replays_after_a_newer_success() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("v1.teplugin"), b"v1").unwrap();
        fs::write(root.join("v2.teplugin"), b"v2").unwrap();
        let mut current = String::new();
        apply(
            root,
            |path| {
                let version = fs::read_to_string(path)?;
                if version == "v1" {
                    return Err(AppError::Other("Transient failure".into()));
                }
                current = version;
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(current, "v2");
        apply(
            root,
            |_| panic!("A stale failed request must not downgrade v2"),
            || false,
        )
        .unwrap();
        assert!(root.join("failed/v1.teplugin").exists());
    }
    #[test]
    fn shutdown_retains_interrupted_and_unstarted_requests_for_next_launch() {
        use std::cell::Cell;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("first.teplugin"), b"first").unwrap();
        fs::write(root.join("second.teplugin"), b"second").unwrap();
        let closing = Cell::new(false);
        apply(
            root,
            |_| {
                closing.set(true);
                Err(AppError::Other("Host shutting down".into()))
            },
            || closing.get(),
        )
        .unwrap();
        assert_eq!(fs::read(root.join("first.teplugin")).unwrap(), b"first");
        assert_eq!(fs::read(root.join("second.teplugin")).unwrap(), b"second");
        assert!(!root.join("failed").exists());
    }
    #[test]
    fn rejects_an_excessive_queue_without_installing_or_removing_anything() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..65 {
            fs::write(temp.path().join(format!("{index}.teplugin")), b"fixture").unwrap();
        }
        assert!(apply(temp.path(), |_| panic!("No install expected"), || false).is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 65);
    }
    #[test]
    fn preserves_a_new_request_published_while_installing_an_older_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("old.teplugin"), b"old").unwrap();
        apply(
            root,
            |_| {
                fs::write(root.join("new.teplugin"), b"new")?;
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert!(!root.join("old.teplugin").exists());
        assert_eq!(fs::read(root.join("new.teplugin")).unwrap(), b"new");
    }
    #[test]
    fn installs_requests_in_publication_order_even_when_filenames_sort_differently() {
        use std::time::Duration;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for (name, seconds) in [("z-first.teplugin", 1), ("a-latest.TEPLUGIN", 2)] {
            let file = fs::File::create(root.join(name)).unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
                .unwrap();
        }
        let mut order = vec![];
        apply(
            root,
            |path| {
                order.push(path.file_name().unwrap().to_owned());
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(order, ["z-first.teplugin", "a-latest.TEPLUGIN"]);
    }
    #[cfg(unix)]
    #[test]
    fn never_follows_a_queue_or_package_symlink() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir(root.join("queue")).unwrap();
        fs::write(root.join("outside"), b"outside").unwrap();
        symlink(root.join("outside"), root.join("queue/link.teplugin")).unwrap();
        assert_eq!(
            apply(
                &root.join("queue"),
                |_| panic!("Symlink must not install"),
                || false
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(fs::read(root.join("outside")).unwrap(), b"outside");
        symlink(root.join("queue"), root.join("linked-queue")).unwrap();
        assert!(apply(
            &root.join("linked-queue"),
            |_| panic!("No install expected"),
            || false
        )
        .is_err());
    }
}
