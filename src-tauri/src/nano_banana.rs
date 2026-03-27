//! Nano Banana image editing via Gemini CLI.
//! Issue: feat/nano-banana
//!
//! Spawns `gemini --yolo "/edit <source> '<prompt>'"` as a subprocess,
//! returns a job ID immediately, and emits completion/error events.

use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct NanoBananaCompleteEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    #[serde(rename = "outputPath")]
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NanoBananaErrorEvent {
    #[serde(rename = "jobId")]
    pub job_id: u64,
    pub error: String,
}

/// Start a Nano Banana image editing job.
/// Returns the job ID immediately; emits `nano-banana-complete` or `nano-banana-error` events.
#[tauri::command]
pub async fn start_nano_banana_job(
    app: AppHandle,
    source_path: String,
    prompt: String,
    output_dir: String,
    api_key: String,
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

    if api_key.is_empty() {
        return Err(AppError::Other(
            "Gemini API key is not configured".to_string(),
        ));
    }

    let job_id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let result = run_gemini_edit(&source_path, &prompt, &output_dir, &api_key).await;
        match result {
            Ok(output_path) => {
                let _ = app.emit(
                    "nano-banana-complete",
                    NanoBananaCompleteEvent {
                        job_id,
                        output_path,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "nano-banana-error",
                    NanoBananaErrorEvent {
                        job_id,
                        error: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(job_id)
}

async fn run_gemini_edit(
    source_path: &str,
    prompt: &str,
    output_dir: &str,
    api_key: &str,
) -> Result<String, AppError> {
    let edit_command = format!("/edit {} '{}'", source_path, prompt.replace('\'', "'\\''"));

    log::info!(
        "Starting Nano Banana: gemini --yolo \"{}\" in {}",
        edit_command,
        output_dir
    );

    let output = tokio::process::Command::new("gemini")
        .arg("--yolo")
        .arg(&edit_command)
        .current_dir(output_dir)
        .env("GEMINI_API_KEY", api_key)
        .output()
        .await
        .map_err(|e| {
            AppError::Other(format!(
                "Failed to start gemini CLI (is it installed?): {}",
                e
            ))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(AppError::Other(format!(
            "gemini exited with {}: {}{}",
            output.status,
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\nstdout: {}", stdout)
            }
        )));
    }

    // Scan nanobanana-output/ for the newest file
    let nb_output_dir = PathBuf::from(output_dir).join("nanobanana-output");
    if !nb_output_dir.exists() {
        return Err(AppError::Other(
            "nanobanana-output directory was not created by gemini".to_string(),
        ));
    }

    let newest = find_newest_file(&nb_output_dir)?;
    match newest {
        Some(path) => Ok(path.to_string_lossy().to_string()),
        None => Err(AppError::Other(
            "No output file found in nanobanana-output/".to_string(),
        )),
    }
}

fn find_newest_file(dir: &PathBuf) -> Result<Option<PathBuf>, AppError> {
    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;

    for entry in std::fs::read_dir(dir).map_err(|e| {
        AppError::Other(format!("Failed to read nanobanana-output: {}", e))
    })? {
        let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
        let metadata = entry.metadata().map_err(|e| AppError::Other(e.to_string()))?;
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        match &newest {
            Some((_, prev_time)) if modified > *prev_time => {
                newest = Some((entry.path(), modified));
            }
            None => {
                newest = Some((entry.path(), modified));
            }
            _ => {}
        }
    }

    Ok(newest.map(|(path, _)| path))
}
