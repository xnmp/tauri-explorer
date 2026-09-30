//! OS clipboard commands.
//!
//! - File lists (Copy/Cut/Paste/rename) go through one process-wide ordered
//!   worker that owns a `FileClipboardCoordinator` (`coordinator.rs`, #835,
//!   #871). Commands enqueue before awaiting, so a cancelled renderer request
//!   cannot cancel or overtake an accepted OS write.
//! - Text and images are stateless reads (`content.rs`), run off the worker.
//!
//! Platform code sits behind `backend::ClipboardBackend` (file lists) and
//! `backend::ClipboardReader` (text/images), selected once per process:
//! - Linux/freedesktop (`linux/`): on Wayland, a held `wl-copy --foreground`
//!   child owns each file write and `wl-paste` reads; on X11, `clipboard-rs`
//!   owns multi-target file writes with a Cut ownership token, `xclip` reads,
//!   and `x11rb` identifies the selection owner.
//! - macOS (`macos.rs`): `NSPasteboard` file writes with a private token
//!   type, `clipboard-rs` file reads, `pbpaste` and `osascript`.
//! - Windows (`windows.rs`): a PowerShell shell-out per operation, plus the
//!   native clipboard sequence number and private token format.
//!
//! Cut needs proof that our write still owns the OS clipboard (#835, #877).
//! Windows and macOS prove it with a change counter (`change_counter.rs`).
//! Whenever a backend cannot prove it, Cut fails closed.

mod backend;
#[cfg(any(windows, target_os = "macos", test))]
mod change_counter;
mod content;
mod coordinator;
#[cfg(test)]
mod fake_backend;
#[cfg(any(all(not(windows), not(target_os = "macos")), test))]
mod file_uri;
#[cfg(all(not(windows), not(target_os = "macos")))]
mod linux;
#[cfg(any(target_os = "macos", test))]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(all(not(windows), not(target_os = "macos")))]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

use crate::error::AppError;
use backend::ClipboardBackend;
use coordinator::{FileClipboardCoordinator, FileClipboardSnapshot};
use std::sync::mpsc;
use tokio::sync::oneshot;

#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, AppError> {
    tokio::task::spawn_blocking(|| platform::reader().read_text())
        .await
        .map_err(|error| AppError::Other(format!("Clipboard task failed: {error}")))?
}

/// Check if the clipboard contains image data.
#[tauri::command]
pub async fn clipboard_has_image() -> bool {
    tokio::task::spawn_blocking(|| platform::reader().has_image())
        .await
        .unwrap_or(false)
}

/// Read a clipboard screenshot for a user report without creating a file in
/// the current directory.
#[tauri::command]
pub async fn clipboard_read_report_image(
) -> Result<crate::user_report::ReportAttachment, crate::user_report::SubmitReportError> {
    let (bytes, media_type) =
        tokio::task::spawn_blocking(|| content::read_report_image(platform::reader().as_ref()))
            .await
            .map_err(|error| {
                crate::user_report::SubmitReportError::new(
                    "clipboard_unavailable",
                    format!("Clipboard task failed: {error}"),
                )
            })?
            .ok_or_else(|| {
                crate::user_report::SubmitReportError::new(
                    "clipboard_unavailable",
                    "No image data in clipboard",
                )
            })?;
    let extension = if media_type == "image/jpeg" {
        "jpg"
    } else {
        "png"
    };
    crate::user_report::attachment_from_image_bytes(
        format!("Clipboard screenshot.{extension}"),
        media_type,
        bytes,
    )
}

/// Paste clipboard image data to a file in the given directory.
/// Returns the path of the created file, or an error.
#[tauri::command]
pub async fn clipboard_paste_image(directory: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        content::paste_image(
            platform::reader().as_ref(),
            &directory,
            chrono::Local::now(),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

enum FileClipboardJob {
    Publish {
        entries: Vec<serde_json::Value>,
        operation: String,
        reply: oneshot::Sender<Result<FileClipboardSnapshot, AppError>>,
    },
    Snapshot {
        reply: oneshot::Sender<Result<FileClipboardSnapshot, AppError>>,
    },
    Clear {
        revision: u64,
        reply: oneshot::Sender<Result<bool, AppError>>,
    },
    Rekey {
        revision: u64,
        old_path: String,
        entry: serde_json::Value,
        reply: oneshot::Sender<Result<Option<FileClipboardSnapshot>, AppError>>,
    },
    ClaimCut {
        revision: u64,
        reply: oneshot::Sender<Result<bool, AppError>>,
    },
    ReleaseCut {
        revision: u64,
        reply: oneshot::Sender<bool>,
    },
}

impl FileClipboardJob {
    /// Apply the job. A dropped reply (a cancelled renderer request) does not
    /// undo it: the job was accepted when it was queued.
    fn run(self, coordinator: &mut FileClipboardCoordinator) {
        match self {
            Self::Publish {
                entries,
                operation,
                reply,
            } => {
                let _ = reply.send(coordinator.publish(entries, &operation));
            }
            Self::Snapshot { reply } => {
                let _ = reply.send(coordinator.snapshot());
            }
            Self::Clear { revision, reply } => {
                let _ = reply.send(coordinator.clear(revision));
            }
            Self::Rekey {
                revision,
                old_path,
                entry,
                reply,
            } => {
                let _ = reply.send(coordinator.rekey(revision, &old_path, entry));
            }
            Self::ClaimCut { revision, reply } => {
                let _ = reply.send(coordinator.claim_cut(revision));
            }
            Self::ReleaseCut { revision, reply } => {
                let _ = reply.send(coordinator.release_cut(revision));
            }
        }
    }
}

/// Start a worker that applies jobs in submission order. The backend is
/// created on the worker thread, which then owns its native state.
fn spawn_worker(
    make_backend: impl FnOnce() -> Box<dyn ClipboardBackend> + Send + 'static,
) -> mpsc::Sender<FileClipboardJob> {
    let (sender, receiver) = mpsc::channel::<FileClipboardJob>();
    std::thread::Builder::new()
        .name("file-clipboard".into())
        .spawn(move || {
            let mut coordinator = FileClipboardCoordinator::new(make_backend());
            while let Ok(job) = receiver.recv() {
                job.run(&mut coordinator);
            }
        })
        .expect("clipboard worker must start");
    sender
}

fn clipboard_queue() -> &'static mpsc::Sender<FileClipboardJob> {
    static QUEUE: std::sync::OnceLock<mpsc::Sender<FileClipboardJob>> = std::sync::OnceLock::new();
    QUEUE.get_or_init(|| spawn_worker(platform::backend))
}

/// Queue a job, then wait for its reply. Queueing happens before the first
/// await, so the job runs even if the caller is cancelled.
async fn request<T>(
    queue: &mpsc::Sender<FileClipboardJob>,
    job: impl FnOnce(oneshot::Sender<T>) -> FileClipboardJob,
) -> Result<T, AppError> {
    let (reply, received) = oneshot::channel();
    queue
        .send(job(reply))
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))
}

#[tauri::command]
pub async fn clipboard_publish(
    entries: Vec<serde_json::Value>,
    operation: String,
) -> Result<FileClipboardSnapshot, AppError> {
    request(clipboard_queue(), |reply| FileClipboardJob::Publish {
        entries,
        operation,
        reply,
    })
    .await?
}

#[tauri::command]
pub async fn clipboard_snapshot() -> Result<FileClipboardSnapshot, AppError> {
    request(clipboard_queue(), |reply| FileClipboardJob::Snapshot {
        reply,
    })
    .await?
}

#[tauri::command]
pub async fn clipboard_compare_and_clear(revision: u64) -> Result<bool, AppError> {
    request(clipboard_queue(), |reply| FileClipboardJob::Clear {
        revision,
        reply,
    })
    .await?
}

#[tauri::command]
pub async fn clipboard_rekey(
    revision: u64,
    old_path: String,
    entry: serde_json::Value,
) -> Result<Option<FileClipboardSnapshot>, AppError> {
    request(clipboard_queue(), |reply| FileClipboardJob::Rekey {
        revision,
        old_path,
        entry,
        reply,
    })
    .await?
}

/// Claim the Cut at `revision` so exactly one paste moves it. A complete move
/// then clears it with `clipboard_compare_and_clear`; an unfinished one
/// returns it with `clipboard_release_cut`.
#[tauri::command]
pub async fn clipboard_claim_cut(revision: u64) -> Result<bool, AppError> {
    request(clipboard_queue(), |reply| FileClipboardJob::ClaimCut {
        revision,
        reply,
    })
    .await?
}

#[tauri::command]
pub async fn clipboard_release_cut(revision: u64) -> Result<bool, AppError> {
    request(clipboard_queue(), |reply| FileClipboardJob::ReleaseCut {
        revision,
        reply,
    })
    .await
}

#[cfg(test)]
mod worker_tests {
    use super::*;
    use crate::clipboard::backend::ClipboardOperation;
    use crate::clipboard::fake_backend::{Capabilities, FakeOs};
    use serde_json::json;

    fn worker(capabilities: Capabilities) -> (FakeOs, mpsc::Sender<FileClipboardJob>) {
        let os = FakeOs::default();
        let handle = os.clone();
        let queue = spawn_worker(move || handle.backend(capabilities));
        (os, queue)
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("test runtime")
            .block_on(future)
    }

    fn publish_job(
        path: &str,
        operation: &str,
    ) -> impl FnOnce(oneshot::Sender<Result<FileClipboardSnapshot, AppError>>) -> FileClipboardJob
    {
        let entries = vec![json!({ "name": path, "path": path })];
        let operation = operation.to_string();
        move |reply| FileClipboardJob::Publish {
            entries,
            operation,
            reply,
        }
    }

    #[test]
    fn an_accepted_job_completes_after_its_caller_is_cancelled() {
        let (os, queue) = worker(Capabilities::COPY_ONLY);
        // Poll the command's request once, then drop it: the renderer
        // cancelled while the job was already queued.
        block_on(async {
            tokio::select! {
                biased;
                // The worker may win the race and reply within that poll.
                _ = request(&queue, publish_job("/tmp/survives.txt", "copy")) => {}
                _ = std::future::ready(()) => {}
            }
        });

        let observed = block_on(request(&queue, |reply| FileClipboardJob::Snapshot {
            reply,
        }))
        .unwrap();
        let observed = observed.unwrap();
        assert_eq!(observed.paths, vec!["/tmp/survives.txt"]);
        assert_eq!(observed.operation, Some(ClipboardOperation::Copy));
        assert_eq!(os.paths(), vec!["/tmp/survives.txt"]);
    }

    #[test]
    fn jobs_apply_in_submission_order_across_callers() {
        let (os, queue) = worker(Capabilities::OWNED);
        // Two windows publish without waiting; the later request wins.
        let (first, first_reply) = oneshot::channel();
        let (second, second_reply) = oneshot::channel();
        queue
            .send(publish_job("/tmp/a.txt", "copy")(first))
            .unwrap();
        queue
            .send(publish_job("/tmp/b.txt", "cut")(second))
            .unwrap();
        first_reply.blocking_recv().unwrap().unwrap();
        let cut = second_reply.blocking_recv().unwrap().unwrap();
        assert_eq!(os.paths(), vec!["/tmp/b.txt"]);

        // Two windows paste the same Cut: exactly one claim succeeds.
        let claims = [0, 1].map(|_| {
            let (reply, received) = oneshot::channel();
            queue
                .send(FileClipboardJob::ClaimCut {
                    revision: cut.revision,
                    reply,
                })
                .unwrap();
            received
        });
        let won: Vec<bool> = claims
            .into_iter()
            .map(|claim| claim.blocking_recv().unwrap().unwrap())
            .collect();
        assert_eq!(won, vec![true, false]);

        let released = block_on(request(&queue, |reply| FileClipboardJob::ReleaseCut {
            revision: cut.revision,
            reply,
        }))
        .unwrap();
        assert!(released);

        // A finished move consumes the Cut; it cannot be claimed again.
        let cleared = block_on(request(&queue, |reply| FileClipboardJob::Clear {
            revision: cut.revision,
            reply,
        }))
        .unwrap()
        .unwrap();
        assert!(cleared);
        let reclaimed = block_on(request(&queue, |reply| FileClipboardJob::ClaimCut {
            revision: cut.revision,
            reply,
        }))
        .unwrap()
        .unwrap();
        assert!(!reclaimed);
    }

    #[test]
    fn a_stopped_worker_reports_failure_instead_of_hanging() {
        let (queue, receiver) = mpsc::channel::<FileClipboardJob>();
        drop(receiver);
        let error = block_on(request(&queue, |reply| FileClipboardJob::Snapshot {
            reply,
        }))
        .unwrap_err();
        assert!(matches!(error, AppError::WorkerFailed(_)), "{error}");
    }
}
