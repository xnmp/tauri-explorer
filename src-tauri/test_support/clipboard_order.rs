//! Controlled writes through the production worker, not a queue in a mock.
use super::backend::{ClipboardOperation, SelectionOwner};
use super::fake_backend::{Capabilities, FakeOs};
use super::*;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(10);

struct DeferredBackend {
    inner: Box<dyn ClipboardBackend>,
    gates: std::collections::HashMap<String, mpsc::Receiver<()>>,
    started: mpsc::Sender<String>,
}

impl ClipboardBackend for DeferredBackend {
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        self.inner.read_files()
    }
    fn write_files(
        &mut self,
        paths: &[String],
        operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError> {
        self.started.send(paths[0].clone()).unwrap();
        self.gates
            .remove(&paths[0])
            .expect("write gate")
            .recv_timeout(DEADLINE)
            .expect("release write");
        self.inner.write_files(paths, operation, token)
    }
    fn owner_token(&mut self) -> Option<String> {
        self.inner.owner_token()
    }
    fn selection_owner(&mut self) -> SelectionOwner {
        self.inner.selection_owner()
    }
    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        self.inner.cut_unavailable_reason()
    }
}

fn publish(
    queue: &mpsc::Sender<FileClipboardJob>,
    path: &str,
    operation: &str,
    notifications: mpsc::Sender<u64>,
) -> oneshot::Receiver<Result<FileClipboardSnapshot, AppError>> {
    let (reply, received) = oneshot::channel();
    queue
        .send(FileClipboardJob::Publish {
            entries: vec![serde_json::json!({"path": path, "name": path})],
            operation: operation.into(),
            reply,
            notify: Box::new(move |revision| {
                notifications.send(revision).unwrap();
            }),
        })
        .unwrap();
    received
}

fn snapshot(queue: &mpsc::Sender<FileClipboardJob>) -> FileClipboardSnapshot {
    let (reply, received) = oneshot::channel();
    queue.send(FileClipboardJob::Snapshot { reply }).unwrap();
    received.blocking_recv().unwrap().unwrap()
}

#[test]
fn deferred_writes_converge_in_both_release_orders_under_load() {
    // 128 queued selections on one worker; alternate release order and all
    // four Copy/Cut combinations. Snapshot is the actual Paste contract.
    let os = FakeOs::default();
    let (started, starts) = mpsc::channel();
    let (notifications, notices) = mpsc::channel();
    let mut gates = std::collections::HashMap::new();
    let releases: Vec<_> = (0..128)
        .map(|index| {
            let (release, gate) = mpsc::channel();
            gates.insert(format!("/file-{index}"), gate);
            release
        })
        .collect();
    let handle = os.clone();
    let queue = spawn_worker(move || {
        Box::new(DeferredBackend {
            inner: handle.backend(Capabilities::OWNED),
            gates,
            started,
        })
    });
    for pair in 0..64 {
        let a = format!("/file-{}", pair * 2);
        let b = format!("/file-{}", pair * 2 + 1);
        let operation_a = if (pair / 2) % 4 < 2 { "copy" } else { "cut" };
        let operation_b = if (pair / 2) % 2 == 0 { "copy" } else { "cut" };
        let first = publish(&queue, &a, operation_a, notifications.clone());
        assert_eq!(starts.recv_timeout(DEADLINE).unwrap(), a);
        let second = publish(&queue, &b, operation_b, notifications.clone());
        // Both windows ask to paste while A is held and B is queued.
        let readers: Vec<_> = (0..2)
            .map(|_| {
                let (reply, received) = oneshot::channel();
                queue.send(FileClipboardJob::Snapshot { reply }).unwrap();
                received
            })
            .collect();
        // Accepted in-app work remains authoritative until its mirror settles.
        os.external_copy(&["/external-during-pending"]);
        if pair % 2 == 0 {
            releases[pair * 2 + 1].send(()).unwrap();
            assert!(
                matches!(
                    starts.recv_timeout(Duration::from_millis(10)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ),
                "B must not start while A is held, even when B's permit is ready"
            );
            releases[pair * 2].send(()).unwrap();
        } else {
            releases[pair * 2].send(()).unwrap();
            releases[pair * 2 + 1].send(()).unwrap();
        }
        let older = first.blocking_recv().unwrap().unwrap();
        let latest = second.blocking_recv().unwrap().unwrap();
        assert_eq!(starts.recv_timeout(DEADLINE).unwrap(), b);
        assert_eq!(os.paths(), vec![b.clone()]);
        assert_eq!(latest.entries.as_ref().unwrap()[0]["path"], b);
        assert_eq!(
            latest.operation,
            Some(ClipboardOperation::parse(operation_b).unwrap())
        );
        assert!(latest.revision > older.revision);
        for reader in readers {
            assert_eq!(reader.blocking_recv().unwrap().unwrap(), latest);
        }
        assert_eq!(notices.recv_timeout(DEADLINE).unwrap(), older.revision);
        assert_eq!(notices.recv_timeout(DEADLINE).unwrap(), latest.revision);
        let (reply, received) = oneshot::channel();
        queue
            .send(FileClipboardJob::ClaimCut {
                revision: older.revision,
                reply,
            })
            .unwrap();
        assert!(
            !received.blocking_recv().unwrap().unwrap(),
            "a losing Cut cannot move"
        );
        let (reply, received) = oneshot::channel();
        queue
            .send(FileClipboardJob::ClaimCut {
                revision: latest.revision,
                reply,
            })
            .unwrap();
        assert_eq!(
            received.blocking_recv().unwrap().unwrap(),
            operation_b == "cut"
        );
        os.external_copy(&["/external"]);
        let external = snapshot(&queue);
        assert_eq!(external.paths, vec!["/external"]);
        assert!(external.entries.is_none());
        assert!(external.operation.is_none());
    }
}

#[test]
fn accepted_publish_notifies_other_windows_after_the_caller_disappears() {
    let os = FakeOs::default();
    let handle = os.clone();
    let queue = spawn_worker(move || handle.backend(Capabilities::OWNED));
    let (notifications, notices) = mpsc::channel();
    drop(publish(&queue, "/survives", "cut", notifications));
    let settled = snapshot(&queue);
    assert_eq!(os.paths(), vec!["/survives"]);
    assert_eq!(settled.operation, Some(ClipboardOperation::Cut));
    assert_eq!(
        notices
            .recv_timeout(DEADLINE)
            .expect("other windows must be invalidated without the caller"),
        settled.revision
    );
}

#[test]
fn rejected_publish_does_not_advertise_a_new_selection() {
    let os = FakeOs::default();
    let queue = spawn_worker(move || os.backend(Capabilities::COPY_ONLY));
    let (notifications, notices) = mpsc::channel();
    assert!(publish(&queue, "/refused-cut", "cut", notifications)
        .blocking_recv()
        .unwrap()
        .is_err());
    assert!(
        matches!(
            notices.recv_timeout(DEADLINE),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ),
        "a rejected publish must send no notification and drop its sender"
    );
    assert!(snapshot(&queue).paths.is_empty());
}

#[test]
fn a_backlog_of_competing_publishers_leaves_the_last_selection_on_the_os() {
    let os = FakeOs::default();
    let handle = os.clone();
    let (started, starts) = mpsc::channel();
    let (notifications, notices) = mpsc::channel();
    let mut gates = std::collections::HashMap::new();
    let releases: Vec<_> = (0..256)
        .map(|index| {
            let (release, gate) = mpsc::channel();
            gates.insert(format!("/burst-{index}"), gate);
            release
        })
        .collect();
    let queue = spawn_worker(move || {
        Box::new(DeferredBackend {
            inner: handle.backend(Capabilities::OWNED),
            gates,
            started,
        })
    });
    let replies: Vec<_> = (0..256)
        .map(|index| {
            publish(
                &queue,
                &format!("/burst-{index}"),
                if index % 2 == 0 { "copy" } else { "cut" },
                notifications.clone(),
            )
        })
        .collect();
    assert_eq!(starts.recv_timeout(DEADLINE).unwrap(), "/burst-0");
    // The entire backlog is admitted while the oldest OS write is held.
    // Permit every newer write before that oldest one.
    for release in releases.into_iter().rev() {
        release.send(()).unwrap();
    }
    let mut latest = None;
    for reply in replies {
        let result = reply.blocking_recv().unwrap().unwrap();
        assert_eq!(notices.recv_timeout(DEADLINE).unwrap(), result.revision);
        latest = Some(result);
    }
    let latest = latest.unwrap();
    assert_eq!(os.paths(), vec!["/burst-255"]);
    assert_eq!(latest.operation, Some(ClipboardOperation::Cut));
    assert_eq!(latest.entries.as_ref().unwrap()[0]["path"], "/burst-255");
    assert_eq!(snapshot(&queue), latest);
}
