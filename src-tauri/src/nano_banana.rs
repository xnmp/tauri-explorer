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

/// Generous upper bound for a single edit job; gemini can be slow but should
/// never run forever (it's spawned detached with --yolo).
const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Single-quote a string for embedding in the gemini slash-command string.
/// Same escaping for paths and prompt: a filename like `x'; rm -rf ~'.png`
/// must not be able to inject arguments into an auto-approving agent.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

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
    output_filename: String,
    api_key: String,
    model: String,
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
        let job = run_gemini_edit(
            &source_path,
            &prompt,
            &output_dir,
            &output_filename,
            &api_key,
            &model,
        );
        let result = match tokio::time::timeout(JOB_TIMEOUT, job).await {
            Ok(result) => result,
            Err(_) => Err(AppError::Other(format!(
                "Nano Banana job timed out after {} minutes",
                JOB_TIMEOUT.as_secs() / 60
            ))),
        };
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
    output_filename: &str,
    api_key: &str,
    model: &str,
) -> Result<String, AppError> {
    let output_path = PathBuf::from(output_dir).join(output_filename);
    let edit_command = format!(
        "/edit {} {} --output {}",
        shell_quote(source_path),
        shell_quote(prompt),
        shell_quote(&output_path.to_string_lossy())
    );

    log::info!(
        "Starting Nano Banana (model={}): gemini --yolo \"{}\"",
        model,
        edit_command,
    );

    // Snapshot the launch time so the fallback scan below can't pick up a
    // stale file that existed in nanobanana-output/ before this job ran.
    let started_at = std::time::SystemTime::now();

    let result = tokio::process::Command::new("gemini")
        .arg("--yolo")
        .arg(&edit_command)
        .current_dir(output_dir)
        .env("GEMINI_API_KEY", api_key)
        .env("NANOBANANA_MODEL", model)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            AppError::Other(format!(
                "Failed to start gemini CLI (is it installed?): {}",
                e
            ))
        })?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let stdout = String::from_utf8_lossy(&result.stdout);
        return Err(AppError::Other(format!(
            "gemini exited with {}: {}{}",
            result.status,
            stderr,
            if stdout.is_empty() {
                String::new()
            } else {
                format!("\nstdout: {}", stdout)
            }
        )));
    }

    // Check if the output file was created
    if output_path.exists() {
        return Ok(output_path.to_string_lossy().to_string());
    }

    // Fallback: scan nanobanana-output/ in case the CLI ignores --output.
    // Only accept files created/modified after this job started.
    let nb_output_dir = PathBuf::from(output_dir).join("nanobanana-output");
    if nb_output_dir.exists() {
        if let Some(path) = find_newest_file(&nb_output_dir, started_at)? {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    Err(AppError::Other(format!(
        "Output file not found: {}",
        output_path.to_string_lossy()
    )))
}

/// Find the newest file in `dir` that was modified after `newer_than`.
fn find_newest_file(
    dir: &PathBuf,
    newer_than: std::time::SystemTime,
) -> Result<Option<PathBuf>, AppError> {
    let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;

    for entry in std::fs::read_dir(dir)
        .map_err(|e| AppError::Other(format!("Failed to read output directory: {}", e)))?
    {
        let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
        let metadata = entry
            .metadata()
            .map_err(|e| AppError::Other(e.to_string()))?;
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if modified < newer_than {
            // Pre-existing file from an earlier job; not our output
            continue;
        }
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
