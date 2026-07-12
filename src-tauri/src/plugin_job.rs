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
use tauri::{AppHandle, Emitter};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Generous upper bound for a single plugin job; external tools/APIs can be
/// slow but must never run forever.
pub const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

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
/// joined output path.
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
    Ok(output.join(output_filename))
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
    job: impl std::future::Future<Output = Result<String, AppError>>,
) {
    let result = match tokio::time::timeout(JOB_TIMEOUT, job).await {
        Ok(result) => result,
        Err(_) => Err(AppError::Other(format!(
            "{} job timed out after {} minutes",
            event_prefix,
            JOB_TIMEOUT.as_secs() / 60
        ))),
    };
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
        assert_eq!(joined, dir.join("out.png"));
        assert!(validate_output_target(dir.to_str().unwrap(), "../x.png").is_err());
        assert!(validate_output_target("/definitely/not/a/dir", "x.png").is_err());
    }
}
