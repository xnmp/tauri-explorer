//! Image upscaling via fal.ai SeedVR2 (#276).
//!
//! Same job skeleton as nano_banana.rs: return a job ID immediately, do the
//! work on a background task with a hard timeout, and emit
//! `upscale-complete` / `upscale-error` events the plugin listens for.
//! The HTTP legwork (CDN upload, queue submit/poll, download) lives in
//! `fal.rs`; it's all blocking `ureq`, so it runs under `spawn_blocking`.

use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Upscales of large images can queue + run for a while, but never forever.
const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const POLL_SECS: u64 = 3;

/// A bare filename that cannot escape its directory.
fn is_valid_output_filename(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

#[derive(Debug, Clone, Serialize)]
pub struct UpscaleCompleteEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    #[serde(rename = "outputPath")]
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpscaleErrorEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    pub error: String,
}

/// Start a SeedVR2 upscale job for a local image.
/// Returns the job ID immediately; emits `upscale-complete` or `upscale-error`.
#[tauri::command]
pub async fn start_upscale_job(
    app: AppHandle,
    source_path: String,
    output_dir: String,
    output_filename: String,
    api_key: String,
    upscale_factor: f64,
) -> Result<u64, AppError> {
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(AppError::NotFound(source_path));
    }

    let output = PathBuf::from(&output_dir);
    if !output.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Output directory does not exist: {}",
            output_dir
        )));
    }

    // The output filename must stay inside output_dir — reject separators
    // and traversal outright rather than trusting the caller.
    if !is_valid_output_filename(&output_filename) {
        return Err(AppError::InvalidPath(format!(
            "Invalid output filename: {}",
            output_filename
        )));
    }

    if !(1.0..=8.0).contains(&upscale_factor) {
        return Err(AppError::InvalidPath(format!(
            "Upscale factor out of range (1-8): {}",
            upscale_factor
        )));
    }

    let api_key = crate::fal::resolve_fal_key(&api_key)?;
    let job_id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let final_output = output.join(&output_filename);
        let job = tokio::task::spawn_blocking(move || {
            run_seedvr_upscale(&source, &final_output, &api_key, upscale_factor)
        });
        let result = match tokio::time::timeout(JOB_TIMEOUT, job).await {
            Ok(Ok(result)) => result,
            Ok(Err(join_err)) => Err(AppError::Other(format!("Upscale task failed: {}", join_err))),
            Err(_) => Err(AppError::Other(format!(
                "Upscale job timed out after {} minutes",
                JOB_TIMEOUT.as_secs() / 60
            ))),
        };
        match result {
            Ok(output_path) => {
                let _ = app.emit("upscale-complete", UpscaleCompleteEvent { job_id, output_path });
            }
            Err(e) => {
                let _ = app.emit(
                    "upscale-error",
                    UpscaleErrorEvent {
                        job_id,
                        error: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(job_id)
}

/// Blocking: upload → queue → poll → download. Runs under spawn_blocking.
fn run_seedvr_upscale(
    source: &PathBuf,
    final_output: &PathBuf,
    api_key: &str,
    upscale_factor: f64,
) -> Result<String, AppError> {
    let image_url = crate::fal::upload_file(source, api_key)?;

    // Preserve the output extension the user picked; fal re-encodes.
    let output_format = match final_output
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "jpg",
        Some("webp") => "webp",
        _ => "png",
    };

    let result = crate::fal::run_queue_job(
        "fal-ai/seedvr/upscale/image",
        serde_json::json!({
            "image_url": image_url,
            "upscale_mode": "factor",
            "upscale_factor": upscale_factor,
            "output_format": output_format,
        }),
        api_key,
        POLL_SECS,
    )?;

    let url = result["image"]["url"]
        .as_str()
        .ok_or_else(|| AppError::Other(format!("fal returned no image url: {}", result)))?;
    crate::fal::download_to(url, final_output)?;

    Ok(final_output.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_filename_cannot_traverse() {
        assert!(is_valid_output_filename("upscaled.png"));
        assert!(!is_valid_output_filename(""));
        assert!(!is_valid_output_filename("../escape.png"));
        assert!(!is_valid_output_filename("a/b.png"));
        assert!(!is_valid_output_filename("a\\b.png"));
        assert!(!is_valid_output_filename("."));
        assert!(!is_valid_output_filename(".."));
    }
}
