//! Shared helpers for commands that call the fal.ai REST API (#276).
//!
//! fal's queue protocol: upload the input to fal's CDN (documented
//! `api.fal.ai` file endpoints are forbidden for scoped keys, so this uses
//! the storage-initiate flow the official clients use), POST to
//! `queue.fal.run/<model>`, poll the returned status_url until COMPLETED,
//! then fetch the response. Model-side failures arrive as a `detail` array
//! in an otherwise-successful response — always check for it.

use crate::error::AppError;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into()
}

/// Resolve the fal.ai API key: the key configured in plugin settings wins,
/// otherwise fall back to the `FAL_KEY` environment variable so users never
/// have to persist the key to disk.
pub fn resolve_fal_key(provided: &str) -> Result<String, AppError> {
    if !provided.is_empty() {
        return Ok(provided.to_string());
    }
    match std::env::var("FAL_KEY") {
        Ok(key) if !key.is_empty() => Ok(key),
        _ => Err(AppError::Other(
            "fal.ai API key is not configured (set it in the plugin settings or export FAL_KEY)"
                .to_string(),
        )),
    }
}

fn http_err(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Other(format!("{}: {}", context, e))
}

/// MIME type for the upload from the file extension (fal only uses it as
/// storage metadata; unknown extensions fall back to octet-stream).
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Upload a local file to fal's CDN; returns the public file URL.
pub fn upload_file(
    local_path: &Path,
    api_key: &str,
    control: &crate::plugin_job::JobControl,
) -> Result<String, AppError> {
    control.check()?;
    let file_name = local_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.bin");
    let bytes = std::fs::read(local_path).map_err(|e| http_err("Failed to read input file", e))?;

    let agent = http_agent();
    let mut init = agent
        .post("https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3")
        .header("Authorization", &format!("Key {}", api_key))
        .send_json(serde_json::json!({
            "file_name": file_name,
            "content_type": content_type_for(local_path),
        }))
        .map_err(|e| http_err("fal storage initiate failed", e))?;
    let init: Value = init
        .body_mut()
        .read_json()
        .map_err(|e| http_err("fal storage initiate parse failed", e))?;

    let upload_url = init["upload_url"]
        .as_str()
        .ok_or_else(|| AppError::Other("fal storage initiate returned no upload_url".into()))?;
    let file_url = init["file_url"]
        .as_str()
        .ok_or_else(|| AppError::Other("fal storage initiate returned no file_url".into()))?;

    control.check()?;
    agent
        .put(upload_url)
        .header("Content-Type", content_type_for(local_path))
        .send(&bytes[..])
        .map_err(|e| http_err("fal storage upload failed", e))?;

    Ok(file_url.to_string())
}

/// Submit a request to a fal queue model and block until the result JSON is
/// available (polling every `poll_secs`). The caller owns the overall
/// timeout (wrap in `tokio::time::timeout`).
pub fn run_queue_job(
    model: &str,
    input: Value,
    api_key: &str,
    poll_secs: u64,
    control: &crate::plugin_job::JobControl,
) -> Result<Value, AppError> {
    control.check()?;
    let auth = format!("Key {}", api_key);
    let agent = http_agent();

    let mut submit = agent
        .post(&format!("https://queue.fal.run/{}", model))
        .header("Authorization", &auth)
        .send_json(input)
        .map_err(|e| http_err("fal submit failed", e))?;
    let submit: Value = submit
        .body_mut()
        .read_json()
        .map_err(|e| http_err("fal submit parse failed", e))?;

    let status_url = submit["status_url"]
        .as_str()
        .ok_or_else(|| AppError::Other(format!("fal submit returned no status_url: {}", submit)))?;
    let response_url = submit["response_url"]
        .as_str()
        .ok_or_else(|| AppError::Other("fal submit returned no response_url".into()))?;

    loop {
        control.check()?;
        let mut status = agent
            .get(status_url)
            .header("Authorization", &auth)
            .call()
            .map_err(|e| http_err("fal status poll failed", e))?;
        let status: Value = status
            .body_mut()
            .read_json()
            .map_err(|e| http_err("fal status parse failed", e))?;
        if status["status"].as_str() == Some("COMPLETED") {
            break;
        }
        for _ in 0..poll_secs.saturating_mul(10) {
            control.check()?;
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    control.check()?;
    let mut result = agent
        .get(response_url)
        .header("Authorization", &auth)
        .call()
        .map_err(|e| http_err("fal result fetch failed", e))?;
    let result: Value = result
        .body_mut()
        .read_json()
        .map_err(|e| http_err("fal result parse failed", e))?;

    // Validation errors surface as a `detail` array with status COMPLETED.
    if let Some(detail) = result.get("detail") {
        let msg = detail[0]["msg"].as_str().unwrap_or("unknown fal error");
        return Err(AppError::Other(format!(
            "fal rejected the request: {}",
            msg
        )));
    }
    Ok(result)
}

/// Download a result URL to `dest`.
pub fn download_to(
    url: &str,
    file: &mut std::fs::File,
    control: &crate::plugin_job::JobControl,
) -> Result<(), AppError> {
    control.check()?;
    let mut resp = http_agent()
        .get(url)
        .call()
        .map_err(|e| http_err("fal result download failed", e))?;
    let mut reader = resp.body_mut().as_reader();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        control.check()?;
        let read = std::io::Read::read(&mut reader, &mut buffer)
            .map_err(|e| http_err("Failed to read output file", e))?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(file, &buffer[..read])
            .map_err(|e| http_err("Failed to write output file", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provided_key_wins() {
        assert_eq!(resolve_fal_key("abc").unwrap(), "abc");
    }

    #[test]
    fn empty_key_without_env_errors() {
        if std::env::var("FAL_KEY").is_err() {
            let err = resolve_fal_key("").unwrap_err();
            assert!(err.to_string().contains("not configured"));
        }
    }

    #[test]
    fn content_types_map_by_extension() {
        assert_eq!(content_type_for(Path::new("a.JPG")), "image/jpeg");
        assert_eq!(content_type_for(Path::new("a.png")), "image/png");
        assert_eq!(content_type_for(Path::new("a.webp")), "image/webp");
        assert_eq!(
            content_type_for(Path::new("noext")),
            "application/octet-stream"
        );
    }
}
