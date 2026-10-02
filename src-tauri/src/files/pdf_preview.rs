//! Bounded, read-only PDF transport. Rendering remains in the WebView worker.
use crate::error::AppError;
use std::{fs::OpenOptions, io::Read, path::Path};

const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;

fn read_pdf(path: &Path, limit: u64) -> Result<Vec<u8>, AppError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::InvalidPath(
            "PDF preview requires a regular file".into(),
        ));
    }
    if metadata.len() > limit {
        return Err(AppError::Other(
            "PDF is too large to preview (maximum 64 MiB)".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(AppError::Other(
            "PDF grew beyond the preview size limit".into(),
        ));
    }
    Ok(bytes)
}

fn validated_link(url: &str) -> Result<tauri::Url, AppError> {
    let parsed =
        tauri::Url::parse(url).map_err(|_| AppError::InvalidPath("Invalid PDF link".into()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(AppError::InvalidPath("Unsupported PDF link scheme".into()));
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn open_pdf_link(url: String) -> Result<(), AppError> {
    let safe = validated_link(&url)?.to_string();
    super::run_blocking(move || {
        opener::open(safe).map_err(|error| AppError::Other(error.to_string()))
    })
    .await
}

#[tauri::command]
pub async fn read_pdf_bytes(path: String) -> Result<tauri::ipc::Response, AppError> {
    let bytes = super::run_blocking(move || read_pdf(Path::new(&path), MAX_PDF_BYTES)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returns_exact_bytes_without_mutating_source() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.pdf");
        let bytes = b"%PDF-1.7\nfixture";
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(read_pdf(&path, 100).unwrap(), bytes);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn rejects_large_missing_and_non_regular_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.pdf");
        std::fs::write(&path, b"12345").unwrap();
        assert!(read_pdf(&path, 4).is_err());
        assert!(read_pdf(directory.path(), 100).is_err());
        assert!(read_pdf(&directory.path().join("missing"), 100).is_err());
    }
    #[test]
    fn link_schemes_are_checked_before_external_launch() {
        for url in [
            "https://example.com",
            "http://example.com/page",
            "mailto:person@example.com",
        ] {
            assert!(validated_link(url).is_ok());
        }
        for url in [
            "javascript:alert(1)",
            "file:///secret",
            "data:text/html,bad",
            "not a URL",
        ] {
            assert!(validated_link(url).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("named-pipe.pdf");
        let encoded = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(encoded.as_ptr(), 0o600) }, 0);
        assert!(read_pdf(&path, 100).is_err());
    }
}
