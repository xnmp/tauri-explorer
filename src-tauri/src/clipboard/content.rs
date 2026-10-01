//! Clipboard images: the report-screenshot read and paste-image-to-file.

use super::backend::ClipboardReader;
use crate::error::AppError;
use std::io::{Cursor, Write};
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
    let data = reader.read_image_result("image/png")?.ok_or_else(|| {
        AppError::Other("No image data in clipboard. Copy an image and try again.".to_string())
    })?;
    let dir = Path::new(directory);
    if !dir.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Not a directory: {directory}"
        )));
    }
    // Decode before publishing: a clipboard provider can advertise PNG but
    // return truncated/corrupt bytes. ImageReader's default allocation limits
    // also reject unreasonable decoded sizes. Preserve the original PNG bytes.
    image::ImageReader::with_format(Cursor::new(&data), image::ImageFormat::Png)
        .decode()
        .map_err(|error| AppError::Other(format!("Invalid clipboard image: {error}")))?;
    let mut staged = tempfile::Builder::new()
        .prefix(".clipboard-image-")
        .tempfile_in(dir)
        .map_err(|error| {
            AppError::Other(format!(
                "Failed to create image: {}",
                std::io::Error::from(error.kind())
            ))
        })?;
    staged
        .write_all(&data)
        .map_err(|error| AppError::Other(format!("Failed to write image: {error}")))?;
    for attempt in 0..1024 {
        let name = match attempt {
            0 => format!("img-{}.png", now.format("%Y%m%d-%H%M%S")),
            1 => format!("img-{}.png", now.format("%Y%m%d-%H%M%S-%3f")),
            _ => format!(
                "img-{}-{}.png",
                now.format("%Y%m%d-%H%M%S-%3f"),
                attempt - 1
            ),
        };
        let filepath = dir.join(name);
        match staged.persist_noclobber(&filepath) {
            Ok(_) => {
                log::info!("Pasted clipboard image to: {}", filepath.display());
                return Ok(filepath.to_string_lossy().to_string());
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                staged = error.file;
            }
            Err(error) => {
                return Err(AppError::Other(format!(
                    "Failed to save image: {}",
                    error.error
                )))
            }
        }
    }
    Err(AppError::Other(
        "Could not find an unused clipboard image filename".into(),
    ))
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

    fn png(color: [u8; 4]) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(3, 2, image::Rgba(color));
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        encoded.into_inner()
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
        let first_bytes = png([255, 0, 0, 255]);
        let second_bytes = png([0, 255, 0, 255]);
        let third_bytes = png([0, 0, 255, 255]);
        let first = paste_image(
            &reader(&[("image/png", &first_bytes)]),
            directory,
            at_noon(),
        )
        .expect("first paste");
        assert!(first.ends_with("img-20260930-120000.png"), "{first}");

        let second = paste_image(
            &reader(&[("image/png", &second_bytes)]),
            directory,
            at_noon(),
        )
        .expect("second paste");
        let third = paste_image(
            &reader(&[("image/png", &third_bytes)]),
            directory,
            at_noon(),
        )
        .expect("third paste");
        assert_ne!(first, second);
        assert_ne!(second, third);
        for (path, bytes) in [
            (first, first_bytes),
            (second, second_bytes),
            (third, third_bytes),
        ] {
            let saved = std::fs::read(path).unwrap();
            assert_eq!(saved, bytes);
            let decoded = image::load_from_memory(&saved).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), (3, 2));
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3);
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

    #[test]
    fn paste_rejects_corrupt_image_data_without_publishing_a_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(paste_image(
            &reader(&[("image/png", b"not an image")]),
            dir.path().to_str().unwrap(),
            at_noon()
        )
        .is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn concurrent_same_timestamp_pastes_preserve_every_image() {
        let dir = tempfile::tempdir().unwrap();
        let saved = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|red| {
                    let directory = dir.path().to_str().unwrap();
                    scope.spawn(move || {
                        let bytes = png([red, 120, 240, 255]);
                        let path =
                            paste_image(&reader(&[("image/png", &bytes)]), directory, at_noon())
                                .unwrap();
                        (path, bytes)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        let paths: std::collections::HashSet<_> = saved.iter().map(|(path, _)| path).collect();
        assert_eq!(paths.len(), 8);
        for (path, bytes) in saved {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 8);
    }

    #[test]
    fn read_failures_keep_their_reason_and_create_nothing() {
        struct FailedReader;
        impl ClipboardReader for FailedReader {
            fn read_text(&self) -> Result<String, AppError> {
                unreachable!()
            }
            fn has_image(&self) -> bool {
                true
            }
            fn read_image(&self, _: &str) -> Option<Vec<u8>> {
                None
            }
            fn read_image_result(&self, _: &str) -> Result<Option<Vec<u8>>, AppError> {
                Err(AppError::Other("clipboard encoder failed".into()))
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let error =
            paste_image(&FailedReader, dir.path().to_str().unwrap(), at_noon()).unwrap_err();
        assert!(error.to_string().contains("clipboard encoder failed"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_write_leaves_no_image_or_temporary_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let bytes = png([255, 0, 0, 255]);
        let result = paste_image(
            &reader(&[("image/png", &bytes)]),
            dir.path().to_str().unwrap(),
            at_noon(),
        );
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
