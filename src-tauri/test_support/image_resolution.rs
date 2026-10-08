use super::*;
use image::{DynamicImage, ImageFormat};

#[test]
fn image_resolution_reads_source_headers_and_refreshes_replaced_files() {
    let dir = tempfile::tempdir().unwrap();
    for (extension, format) in [
        ("png", ImageFormat::Png),
        ("jpg", ImageFormat::Jpeg),
        ("gif", ImageFormat::Gif),
        ("webp", ImageFormat::WebP),
        ("bmp", ImageFormat::Bmp),
    ] {
        let path = dir.path().join(format!("photo.{extension}"));
        for (width, height) in [(37, 19), (13, 29)] {
            DynamicImage::new_rgb8(width, height)
                .save_with_format(&path, format)
                .unwrap();
            let actual = tauri::async_runtime::block_on(get_image_resolution(
                path.to_string_lossy().into_owned(),
            ));
            assert_eq!(
                actual,
                Some(ImageResolution { width, height }),
                "{extension}"
            );
        }
    }
}

#[test]
fn image_resolution_unavailable_inputs_do_not_break_listing_consumers() {
    let dir = tempfile::tempdir().unwrap();
    let corrupt = dir.path().join("bad.png");
    std::fs::write(&corrupt, b"not an image").unwrap();
    let unsupported = dir.path().join("vector.svg");
    std::fs::write(&unsupported, b"<svg width='100' height='50'></svg>").unwrap();
    for path in [
        dir.path().to_path_buf(),
        corrupt,
        unsupported,
        dir.path().join("missing.jpg"),
    ] {
        assert_eq!(
            tauri::async_runtime::block_on(get_image_resolution(
                path.to_string_lossy().into_owned()
            )),
            None
        );
    }
}
