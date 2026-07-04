//! Shared byte-level progress + cooperative cancellation for streaming file work.
//!
//! Long-running filesystem operations (zip compress/extract, large copies)
//! stream their data in chunks. Each chunk advances a [`ProgressTracker`],
//! which emits a throttled Tauri progress event and checks a cancellation
//! flag so the operation can be aborted mid-file. Extracted so archive and
//! copy paths share one implementation instead of duplicating the pattern.

use crate::error::AppError;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Minimum spacing between progress emits, so a fast operation on many small
/// chunks doesn't flood the event loop.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Payload of byte-progress events (`zip-progress`, `unzip-progress`,
/// `copy-progress`). Shape is stable across all three so the frontend can
/// share one `ZipProgressEvent` type.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ByteProgress {
    pub job_id: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current_file: String,
}

/// Byte-level progress + cancellation, threaded through a streaming file walk.
///
/// `event` is the Tauri event name to emit; `cancel_msg` is the error returned
/// when the job is cancelled. When `app` is `None` (unit tests, or an internal
/// copy with no UI job) no events are emitted; when `cancelled` is `None` the
/// job can never be cancelled.
pub struct ProgressTracker<'a> {
    app: Option<&'a tauri::AppHandle>,
    event: &'static str,
    cancel_msg: &'static str,
    job_id: u64,
    bytes_done: u64,
    bytes_total: u64,
    cancelled: Option<&'a AtomicBool>,
    last_emit: Instant,
}

impl<'a> ProgressTracker<'a> {
    pub fn new(
        app: Option<&'a tauri::AppHandle>,
        event: &'static str,
        cancel_msg: &'static str,
        job_id: u64,
        bytes_total: u64,
        cancelled: Option<&'a AtomicBool>,
    ) -> Self {
        Self {
            app,
            event,
            cancel_msg,
            job_id,
            bytes_done: 0,
            bytes_total,
            cancelled,
            // Backdated so the very first chunk emits immediately.
            last_emit: Instant::now() - PROGRESS_EMIT_INTERVAL,
        }
    }

    /// Return an error if the job has been cancelled. Cheap enough to call
    /// before every chunk.
    pub fn check_cancelled(&self) -> Result<(), AppError> {
        if self
            .cancelled
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Err(AppError::Other(self.cancel_msg.into()));
        }
        Ok(())
    }

    /// Record `n` more bytes processed; throttled progress emit + cancel check.
    pub fn advance(&mut self, n: u64, current_file: &Path) -> Result<(), AppError> {
        self.bytes_done += n;
        self.check_cancelled()?;
        if let Some(app) = self.app {
            if self.last_emit.elapsed() >= PROGRESS_EMIT_INTERVAL {
                self.last_emit = Instant::now();
                let _ = app.emit(
                    self.event,
                    ByteProgress {
                        job_id: self.job_id,
                        bytes_done: self.bytes_done,
                        bytes_total: self.bytes_total,
                        current_file: current_file.to_string_lossy().to_string(),
                    },
                );
            }
        }
        Ok(())
    }
}
