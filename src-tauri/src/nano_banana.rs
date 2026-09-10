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
use crate::plugin_job;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

async fn wait_for_child(
    child: &mut tokio::process::Child,
    control: &plugin_job::JobControl,
) -> Result<std::process::ExitStatus, AppError> {
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(50), child.wait()).await {
            Ok(result) => {
                return result
                    .map_err(|e| AppError::Other(format!("Failed to wait for gemini CLI: {e}")))
            }
            Err(_) => {
                if control.check().is_err() {
                    child
                        .kill()
                        .await
                        .map_err(|e| AppError::Other(format!("Failed to kill gemini CLI: {e}")))?;
                    return Err(AppError::Other("Plugin job cancelled".into()));
                }
            }
        }
    }
}

struct GeminiEdit<'a> {
    source_path: &'a str,
    prompt: &'a str,
    final_output_path: &'a Path,
    api_key: &'a str,
    model: &'a str,
}

/// Single-quote a string for embedding in the gemini slash-command string.
/// A prompt like `x'; rm -rf ~'` must stay a single token when gemini
/// re-parses the command.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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

    let final_output_path = plugin_job::validate_output_target(&output_dir, &output_filename)?;

    let api_key = crate::gemini::resolve_api_key(&api_key)?;
    let job_id = plugin_job::next_job_id();
    let control = plugin_job::JobControl::new();
    let worker_control = control.clone();

    tokio::spawn(async move {
        let job = async {
            // tempfile: unpredictable name and 0700 on unix. A fixed,
            // sequential name in the shared system temp dir would let another
            // local user pre-plant a symlink and receive the staged source.
            let work_dir = tempfile::Builder::new()
                .prefix(&format!("tauri-explorer-nanobanana-{}-", job_id))
                .tempdir()
                .map_err(|e| AppError::Other(format!("Failed to create work dir: {}", e)))?;
            // TempDir removes itself when this future completes (drop).
            run_gemini_edit(
                work_dir.path(),
                GeminiEdit {
                    source_path: &source_path,
                    prompt: &prompt,
                    final_output_path: &final_output_path,
                    api_key: &api_key,
                    model: &model,
                },
                &worker_control,
            )
            .await
        };
        plugin_job::run_and_emit(&app, "nano-banana", job_id, control, job).await;
    });

    Ok(job_id)
}

async fn run_gemini_edit(
    work_dir: &Path,
    request: GeminiEdit<'_>,
    control: &plugin_job::JobControl,
) -> Result<String, AppError> {
    let GeminiEdit {
        source_path,
        prompt,
        final_output_path,
        api_key,
        model,
    } = request;
    control.check()?;
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
    let mut command = tokio::process::Command::new("gemini");
    command
        .arg("--allowed-tools")
        .arg("edit_image")
        .arg(&edit_command)
        .current_dir(work_dir)
        .env("GEMINI_API_KEY", api_key)
        .env("NANOBANANA_MODEL", model)
        .kill_on_drop(true);
    let stdout_path = work_dir.join("gemini.stdout");
    let stderr_path = work_dir.join("gemini.stderr");
    let stdout = std::fs::File::create(&stdout_path)
        .map_err(|e| AppError::Other(format!("Failed to create gemini stdout: {e}")))?;
    let stderr = std::fs::File::create(&stderr_path)
        .map_err(|e| AppError::Other(format!("Failed to create gemini stderr: {e}")))?;
    command.stdout(stdout).stderr(stderr);
    let mut child = command.spawn().map_err(|e| {
        AppError::Other(format!(
            "Failed to start gemini CLI (is it installed?): {}",
            e
        ))
    })?;
    let status = wait_for_child(&mut child, control).await?;
    let stdout = std::fs::read_to_string(stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(stderr_path).unwrap_or_default();

    if !status.success() {
        return Err(AppError::Other(format!(
            "gemini exited with {}: {}{}",
            status,
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
    control.check()?;
    let mut staging = plugin_job::StagedOutput::new(final_output_path)?;
    let mut produced_file = std::fs::File::open(&produced)
        .map_err(|e| AppError::Other(format!("Failed to open generated output: {e}")))?;
    std::io::copy(&mut produced_file, staging.file_mut())
        .map_err(|e| AppError::Other(format!("Failed to stage generated output: {e}")))?;
    staging.commit(final_output_path, control)?;

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

    #[cfg(unix)]
    #[test]
    fn cancellation_kills_owned_cli_before_it_can_finish() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("late-marker");
        let control = plugin_job::JobControl::new();
        let cancel = control.clone();
        let child_marker = marker.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .unwrap();
        let result = runtime.block_on(async move {
            let mut command = tokio::process::Command::new("sh");
            command
                .args(["-c", "sleep 1; printf late > \"$MARKER\""])
                .env("MARKER", &child_marker)
                .kill_on_drop(true);
            let mut child = command.spawn().unwrap();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                cancel.cancel();
            });
            wait_for_child(&mut child, &control).await
        });
        assert!(result.unwrap_err().to_string().contains("cancelled"));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            !marker.exists(),
            "cancelled CLI survived and wrote late output"
        );
    }

    // Output-filename traversal rejection is covered by plugin_job::tests.
}
