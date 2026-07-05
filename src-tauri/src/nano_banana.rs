//! Nano Banana image editing via Gemini CLI.
//! Issue: feat/nano-banana, fix/tier2-hardening (audit S2)
//!
//! Spawns `gemini "/edit <staged-source> '<prompt>' --output <staged-output>"`
//! as a subprocess, returns a job ID immediately, and emits completion/error
//! events.
//!
//! The slash-command string is re-parsed by gemini, so nothing
//! attacker-influenceable may appear in it: the source image is first copied
//! into a job-scoped work dir under a neutral name, gemini writes to a neutral
//! output name there, and only then is the result moved to the user's
//! requested destination. Tool auto-approval is restricted to `edit_image`
//! (no `--yolo`).

use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Generous upper bound for a single edit job; gemini can be slow but should
/// never run forever.
const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Single-quote a string for embedding in the gemini slash-command string.
/// A prompt like `x'; rm -rf ~'` must stay a single token when gemini
/// re-parses the command.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A bare filename that cannot escape its directory.
fn is_valid_output_filename(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != ".."
}

/// A file extension safe to embed in the slash-command: ascii-alphanumeric
/// only, non-empty, lowercase. Falls back to `png`.
fn sanitized_ext(name: &Path) -> String {
    let ext: String = name
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    if ext.is_empty() {
        "png".to_string()
    } else {
        ext
    }
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

    // The output filename must stay inside output_dir — reject separators
    // and traversal outright rather than trusting the caller.
    if !is_valid_output_filename(&output_filename) {
        return Err(AppError::InvalidPath(format!(
            "Invalid output filename: {}",
            output_filename
        )));
    }

    let api_key = crate::gemini::resolve_api_key(&api_key)?;

    let job_id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let work_dir = std::env::temp_dir().join(format!("tauri-explorer-nanobanana-{}", job_id));
        let job = run_gemini_edit(
            &work_dir,
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
        let _ = std::fs::remove_dir_all(&work_dir);
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
    work_dir: &Path,
    source_path: &str,
    prompt: &str,
    output_dir: &str,
    output_filename: &str,
    api_key: &str,
    model: &str,
) -> Result<String, AppError> {
    let final_output_path = PathBuf::from(output_dir).join(output_filename);

    // Stage the source under a neutral name: the slash-command string is
    // re-parsed by gemini, so the (attacker-influenceable) original filename
    // must never appear in it.
    std::fs::create_dir_all(work_dir)
        .map_err(|e| AppError::Other(format!("Failed to create work dir: {}", e)))?;
    let staged_source = work_dir.join(format!("source.{}", sanitized_ext(Path::new(source_path))));
    std::fs::copy(source_path, &staged_source)
        .map_err(|e| AppError::Other(format!("Failed to stage source image: {}", e)))?;

    // No --output flag: nanobanana ≥1.0.10 rejects it as an invalid option
    // (the whole /edit errors out) and always writes to ./nanobanana-output/.
    let edit_command = format!(
        "/edit {} {}",
        shell_quote(&staged_source.to_string_lossy()),
        shell_quote(prompt),
    );

    log::info!(
        "Starting Nano Banana (model={}): gemini --allowed-tools edit_image \"{}\"",
        model,
        edit_command,
    );

    // Snapshot the launch time so the fallback scan below can't pick up a
    // stale file that existed before this job ran.
    let started_at = std::time::SystemTime::now();

    // Only the image-edit tool may run unattended — never `--yolo`, which
    // would auto-approve *any* tool call a prompt-injected model makes.
    let result = tokio::process::Command::new("gemini")
        .arg("--allowed-tools")
        .arg("edit_image")
        .arg(&edit_command)
        .current_dir(work_dir)
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

    // The tool writes to <work_dir>/nanobanana-output/<derived name>; take
    // the newest file created after this job started.
    let nb_output_dir = work_dir.join("nanobanana-output");
    let produced = if nb_output_dir.exists() {
        find_newest_file(&nb_output_dir, started_at)?
    } else {
        None
    };
    let produced = produced.ok_or_else(|| {
        AppError::Other(format!(
            "gemini produced no output file in {}",
            nb_output_dir.to_string_lossy()
        ))
    })?;

    // Move the result to the user's requested destination (copy+remove:
    // the work dir usually lives on a different filesystem, where a plain
    // rename fails with EXDEV).
    std::fs::copy(&produced, &final_output_path)
        .map_err(|e| AppError::Other(format!("Failed to move output into place: {}", e)))?;
    let _ = std::fs::remove_file(&produced);

    Ok(final_output_path.to_string_lossy().to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Naive re-parse of a single-quoted shell token stream, mirroring how
    /// gemini tokenizes the slash-command. Returns the recovered tokens.
    fn untokenize(s: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut cur = String::new();
        let mut chars = s.chars().peekable();
        let mut in_quote = false;
        let mut in_token = false;
        while let Some(c) = chars.next() {
            match c {
                '\'' => {
                    in_quote = !in_quote;
                    in_token = true;
                }
                '\\' if !in_quote => {
                    if let Some(&next) = chars.peek() {
                        cur.push(next);
                        chars.next();
                        in_token = true;
                    }
                }
                ' ' if !in_quote => {
                    if in_token || !cur.is_empty() {
                        tokens.push(std::mem::take(&mut cur));
                        in_token = false;
                    }
                }
                _ => {
                    cur.push(c);
                    in_token = true;
                }
            }
        }
        if in_token || !cur.is_empty() {
            tokens.push(cur);
        }
        tokens
    }

    #[test]
    fn shell_quote_round_trips_hostile_strings() {
        let hostile = [
            "simple",
            "with space",
            "x'; rm -rf ~'.png",
            "'--yolo",
            "--output /etc/passwd",
            "a'b'c",
            "''",
            "back\\slash",
            "new\nline",
        ];
        for s in hostile {
            let quoted = shell_quote(s);
            let tokens = untokenize(&quoted);
            assert_eq!(tokens, vec![s.to_string()], "quoting broke for {s:?}");
        }
    }

    #[test]
    fn hostile_filename_never_reaches_the_command_string() {
        // The command embeds only staged names (source.<ext>/output.<ext>);
        // the extension is the sole survivor of the original filename and is
        // reduced to ascii-alphanumeric.
        assert_eq!(sanitized_ext(Path::new("evil' --yolo x.p'ng")), "png");
        assert_eq!(sanitized_ext(Path::new("photo.JPEG")), "jpeg");
        assert_eq!(sanitized_ext(Path::new("noext")), "png");
        assert_eq!(sanitized_ext(Path::new("dots...")), "png");
        assert_eq!(sanitized_ext(Path::new("x.-'-")), "png");
    }

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
}
