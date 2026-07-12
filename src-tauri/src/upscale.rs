//! Image upscaling via fal.ai SeedVR2 (#276).
//!
//! Job scaffolding (id allocation, output validation, timeout, event
//! emission) comes from `plugin_job.rs` (#278). The HTTP legwork (CDN
//! upload, queue submit/poll, download) lives in `fal.rs`; it's all
//! blocking `ureq`, so it runs under `spawn_blocking`.

use crate::error::AppError;
use crate::plugin_job;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const POLL_SECS: u64 = 3;

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

    let final_output = plugin_job::validate_output_target(&output_dir, &output_filename)?;

    if !(1.0..=8.0).contains(&upscale_factor) {
        return Err(AppError::InvalidPath(format!(
            "Upscale factor out of range (1-8): {}",
            upscale_factor
        )));
    }

    let api_key = crate::fal::resolve_fal_key(&api_key)?;
    let job_id = plugin_job::next_job_id();

    tokio::spawn(async move {
        let job = async {
            tokio::task::spawn_blocking(move || {
                run_seedvr_upscale(&source, &final_output, &api_key, upscale_factor)
            })
            .await
            .map_err(|e| AppError::Other(format!("Upscale task failed: {}", e)))?
        };
        plugin_job::run_and_emit(&app, "upscale", job_id, job).await;
    });

    Ok(job_id)
}

/// Blocking: upload → queue → poll → download. Runs under spawn_blocking.
fn run_seedvr_upscale(
    source: &Path,
    final_output: &Path,
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
