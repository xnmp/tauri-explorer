//! Clipboard images: the report-screenshot read and paste-image-to-file.

use super::backend::ClipboardReader;
use crate::error::AppError;
use std::path::Path;

/// Image types a report accepts from the clipboard, in preference order.
const REPORT_IMAGE_TYPES: [&str; 2] = ["image/png", "image/jpeg"];

/// A clipboard screenshot for a user report, with its media type.
pub(super) fn read_report_image(reader: &dyn ClipboardReader) -> Option<(Vec<u8>, &'static str)> {
    REPORT_IMAGE_TYPES.into_iter().find_map(|media_type| {
        reader
            .read_image(media_type)
            .map(|bytes| (bytes, media_type))
    })
}

/// Save the clipboard's PNG image into `directory` under a timestamped name
/// that never overwrites an existing file. Returns the created path.
pub(super) fn paste_image(
    reader: &dyn ClipboardReader,
    directory: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Result<String, AppError> {
    let data = reader
        .read_image("image/png")
        .ok_or_else(|| AppError::Other("No image data in clipboard".to_string()))?;
    let dir = Path::new(directory);
    if !dir.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Not a directory: {directory}"
        )));
    }
    let seconds = dir.join(format!("img-{}.png", now.format("%Y%m%d-%H%M%S")));
    let filepath = if seconds.exists() {
        // Add milliseconds to disambiguate.
        dir.join(format!("img-{}.png", now.format("%Y%m%d-%H%M%S-%3f")))
    } else {
        seconds
    };
    std::fs::write(&filepath, &data)
        .map_err(|error| AppError::Other(format!("Failed to write image: {error}")))?;
    log::info!("Pasted clipboard image to: {}", filepath.display());
    Ok(filepath.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    struct FakeReader {
        images: Vec<(&'static str, Vec<u8>)>,
    }

    impl ClipboardReader for FakeReader {
        fn read_text(&self) -> Result<String, AppError> {
            Ok(String::new())
        }

        fn has_image(&self) -> bool {
            !self.images.is_empty()
        }

        fn read_image(&self, media_type: &str) -> Option<Vec<u8>> {
            self.images
                .iter()
                .find(|(offered, _)| *offered == media_type)
                .map(|(_, bytes)| bytes.clone())
        }
    }

    fn reader(images: &[(&'static str, &[u8])]) -> FakeReader {
        FakeReader {
            images: images
                .iter()
                .map(|(media_type, bytes)| (*media_type, bytes.to_vec()))
                .collect(),
        }
    }

    fn at_noon() -> chrono::DateTime<chrono::Local> {
        chrono::Local
            .with_ymd_and_hms(2026, 9, 30, 12, 0, 0)
            .single()
            .expect("unambiguous local time")
    }

    #[test]
    fn report_prefers_png_and_falls_back_to_jpeg() {
        let both = reader(&[("image/jpeg", b"jpeg"), ("image/png", b"png")]);
        assert_eq!(
            read_report_image(&both),
            Some((b"png".to_vec(), "image/png"))
        );
        let jpeg = reader(&[("image/jpeg", b"jpeg")]);
        assert_eq!(
            read_report_image(&jpeg),
            Some((b"jpeg".to_vec(), "image/jpeg"))
        );
        assert_eq!(read_report_image(&reader(&[("image/gif", b"gif")])), None);
    }

    #[test]
    fn paste_writes_png_without_overwriting_an_existing_image() {
        let dir = tempfile::tempdir().expect("temp dir");
        let directory = dir.path().to_str().expect("utf-8 temp path");
        let png = reader(&[("image/png", b"first")]);
        let first = paste_image(&png, directory, at_noon()).expect("first paste");
        assert!(first.ends_with("img-20260930-120000.png"), "{first}");

        let second = paste_image(&reader(&[("image/png", b"second")]), directory, at_noon())
            .expect("second paste");
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
        assert_eq!(std::fs::read(&second).unwrap(), b"second");
    }

    #[test]
    fn paste_rejects_missing_images_and_non_directories() {
        let dir = tempfile::tempdir().expect("temp dir");
        let directory = dir.path().to_str().expect("utf-8 temp path");
        let jpeg_only = reader(&[("image/jpeg", b"jpeg")]);
        let error = paste_image(&jpeg_only, directory, at_noon()).unwrap_err();
        assert!(error.to_string().contains("No image data"), "{error}");

        let file = dir.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let png = reader(&[("image/png", b"png")]);
        let error = paste_image(&png, file.to_str().unwrap(), at_noon()).unwrap_err();
        assert!(error.to_string().contains("Not a directory"), "{error}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
