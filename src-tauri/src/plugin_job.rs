//! Shared scaffolding for plugin background jobs (#278).
//!
//! Extracted from duplicated skeletons in nano_banana.rs and upscale.rs:
//! job-id allocation, output-target validation, the timeout wrapper, and
//! the `{prefix}-complete` / `{prefix}-error` event emission the frontend
//! plugins listen for. A third AI plugin should need none of this copied.

use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Generous upper bound for a single plugin job; external tools/APIs can be
/// slow but must never run forever.
pub const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const CANCEL_DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone)]
pub struct JobControl {
    state: Arc<Mutex<JobState>>,
}

enum JobState {
    Active,
    Cancelled,
    Committed,
}

impl JobControl {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(JobState::Active)),
        }
    }

    pub fn cancel(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*state, JobState::Active) {
            *state = JobState::Cancelled;
            true
        } else {
            false
        }
    }

    pub fn check(&self) -> Result<(), AppError> {
        if matches!(
            *self.state.lock().unwrap_or_else(|e| e.into_inner()),
            JobState::Cancelled
        ) {
            Err(AppError::Other("Plugin job cancelled".into()))
        } else {
            Ok(())
        }
    }
}

/// Allocate a process-unique job id.
pub fn next_job_id() -> u64 {
    NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
}

/// A bare filename that cannot escape its directory.
pub fn is_valid_output_filename(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

/// Validate the job's write target: `output_dir` must be an existing
/// directory and `output_filename` a bare, traversal-free name. Returns the
/// canonical output path. Resolving the directory once keeps a later symlink
/// retarget from redirecting either staging or publication.
pub fn validate_output_target(
    output_dir: &str,
    output_filename: &str,
) -> Result<PathBuf, AppError> {
    let output = PathBuf::from(output_dir);
    if !output.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Output directory does not exist: {}",
            output_dir
        )));
    }
    // The output filename must stay inside output_dir — reject separators
    // and traversal outright rather than trusting the caller.
    if !is_valid_output_filename(output_filename) {
        return Err(AppError::InvalidPath(format!(
            "Invalid output filename: {}",
            output_filename
        )));
    }
    let output = std::fs::canonicalize(&output).map_err(|error| {
        AppError::InvalidPath(format!(
            "Failed to resolve output directory {output_dir}: {error}"
        ))
    })?;
    Ok(output.join(output_filename))
}

/// Publish a fully-written staging file only while this job still owns output.
/// The staging file is removed on cancellation or rename failure.
pub struct StagedOutput(tempfile::NamedTempFile);

impl StagedOutput {
    pub fn new(final_output: &std::path::Path) -> Result<Self, AppError> {
        let parent = final_output
            .parent()
            .ok_or_else(|| AppError::InvalidPath("Output has no parent".into()))?;
        tempfile::Builder::new()
            .prefix(".plugin-output-")
            .tempfile_in(parent)
            .map(Self)
            .map_err(|error| AppError::Other(format!("Failed to create staging output: {error}")))
    }

    pub fn file_mut(&mut self) -> &mut std::fs::File {
        self.0.as_file_mut()
    }

    pub fn commit(
        self,
        final_output: &std::path::Path,
        control: &JobControl,
    ) -> Result<(), AppError> {
        let mut state = control.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*state, JobState::Cancelled) {
            return Err(AppError::Other("Plugin job cancelled".into()));
        }
        let result = self.0.persist(final_output).map(|_| ()).map_err(|error| {
            AppError::Other(format!("Failed to publish plugin output: {}", error.error))
        });
        if result.is_ok() {
            *state = JobState::Committed;
        }
        result
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginJobCompleteEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    #[serde(rename = "outputPath")]
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginJobErrorEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    pub error: String,
}

/// Await `job` under [`JOB_TIMEOUT`], then emit `{prefix}-complete` with the
/// output path or `{prefix}-error` with the failure message.
pub async fn run_and_emit(
    app: &AppHandle,
    event_prefix: &str,
    job_id: u64,
    control: JobControl,
    job: impl std::future::Future<Output = Result<String, AppError>>,
) {
    run_and_emit_with_timeout(app, event_prefix, job_id, control, JOB_TIMEOUT, job).await;
}

async fn run_and_emit_with_timeout(
    app: &AppHandle,
    event_prefix: &str,
    job_id: u64,
    control: JobControl,
    timeout: std::time::Duration,
    job: impl std::future::Future<Output = Result<String, AppError>>,
) {
    let result = run_with_timeout(event_prefix, control, timeout, job).await;
    emit_result(app, event_prefix, job_id, result);
}

async fn run_with_timeout(
    event_prefix: &str,
    control: JobControl,
    timeout: std::time::Duration,
    job: impl std::future::Future<Output = Result<String, AppError>>,
) -> Result<String, AppError> {
    tokio::pin!(job);
    match tokio::time::timeout(timeout, &mut job).await {
        Ok(result) => result,
        Err(_) => {
            let cancelled = control.cancel();
            // `spawn_blocking` work cannot be aborted once running. Signal its
            // cooperative owner and briefly drain it before publishing the
            // terminal timeout event. Any worker still alive after this bound
            // cannot publish because final output commit checks `control`.
            match tokio::time::timeout(CANCEL_DRAIN_TIMEOUT, &mut job).await {
                Ok(result) if !cancelled => result,
                _ => Err(AppError::Other(format!("{} job timed out", event_prefix))),
            }
        }
    }
}

fn emit_result(app: &AppHandle, event_prefix: &str, job_id: u64, result: Result<String, AppError>) {
    match result {
        Ok(output_path) => {
            let _ = app.emit(
                &format!("{}-complete", event_prefix),
                PluginJobCompleteEvent {
                    job_id,
                    output_path,
                },
            );
        }
        Err(e) => {
            let _ = app.emit(
                &format!("{}-error", event_prefix),
                PluginJobErrorEvent {
                    job_id,
                    error: e.to_string(),
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_filename_cannot_traverse() {
        assert!(is_valid_output_filename("edited.png"));
        assert!(!is_valid_output_filename(""));
        assert!(!is_valid_output_filename("../escape.png"));
        assert!(!is_valid_output_filename("a/b.png"));
        assert!(!is_valid_output_filename("a\\b.png"));
        assert!(!is_valid_output_filename("."));
        assert!(!is_valid_output_filename(".."));
    }

    #[test]
    fn job_ids_are_unique_and_increasing() {
        let a = next_job_id();
        let b = next_job_id();
        assert!(b > a);
    }

    #[test]
    fn validate_output_target_joins_valid_names() {
        let dir = std::env::temp_dir();
        let joined = validate_output_target(dir.to_str().unwrap(), "out.png").unwrap();
        assert_eq!(joined, std::fs::canonicalize(&dir).unwrap().join("out.png"));
        assert!(validate_output_target(dir.to_str().unwrap(), "../x.png").is_err());
        assert!(validate_output_target("/definitely/not/a/dir", "x.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolved_output_target_is_stable_when_directory_symlink_is_retargeted() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let alias = root.path().join("output");
        symlink(&first, &alias).unwrap();

        let target = validate_output_target(alias.to_str().unwrap(), "result.png").unwrap();
        std::fs::remove_file(&alias).unwrap();
        symlink(&second, &alias).unwrap();

        let control = JobControl::new();
        let mut staging = StagedOutput::new(&target).unwrap();
        std::io::Write::write_all(staging.file_mut(), b"owned").unwrap();
        staging.commit(&target, &control).unwrap();

        assert_eq!(std::fs::read(first.join("result.png")).unwrap(), b"owned");
        assert!(!second.join("result.png").exists());
    }

    #[test]
    fn timeout_revokes_late_blocking_output_before_reporting_failure() {
        let dir = tempfile::tempdir().unwrap();
        let final_output = dir.path().join("result.png");
        let control = JobControl::new();
        let worker_control = control.clone();
        let worker_final = final_output.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        let result = runtime.block_on(run_with_timeout(
            "test",
            control,
            std::time::Duration::from_millis(10),
            async move {
                tokio::task::spawn_blocking(move || {
                    let mut staging = StagedOutput::new(&worker_final)?;
                    std::io::Write::write_all(staging.file_mut(), b"late").unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(40));
                    staging.commit(&worker_final, &worker_control)?;
                    Ok(worker_final.to_string_lossy().into_owned())
                })
                .await
                .unwrap()
            },
        ));

        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert!(
            !final_output.exists(),
            "timed-out worker published final output"
        );
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "timed-out worker left staging output"
        );
    }
}
