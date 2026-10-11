//! Preview pane renditions (#1054): which images get one, its size and
//! encoding, and the disk-cache contract it shares with tile thumbnails.

use super::*;
use std::fs::File;
use std::time::SystemTime;
use tempfile::{tempdir, TempDir};

/// A source directory and a separate, initially empty cache directory.
struct Fixture {
    source: TempDir,
    cache: TempDir,
}

impl Fixture {
    fn new() -> Self {
        Self {
            source: tempdir().unwrap(),
            cache: tempdir().unwrap(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.source.path().join(name)
    }

    fn resolve(&self, name: &str, max_edge: u32) -> (PreviewImageSource, Resolution) {
        resolve_preview_image(&self.path(name), max_edge, self.cache.path()).unwrap()
    }

    fn cache_entries(&self) -> Vec<PathBuf> {
        fs::read_dir(self.cache.path())
            .map(|dir| dir.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }
}

fn opaque(width: u32, height: u32) -> image::RgbImage {
    image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 251) as u8, (y % 241) as u8, 90])
    })
}

fn rendition_path(source: &PreviewImageSource) -> PathBuf {
    match source {
        PreviewImageSource::Rendition { path } => PathBuf::from(path),
        PreviewImageSource::Original => panic!("expected a rendition, got the original"),
    }
}

fn with_mtime(path: &Path, mtime: SystemTime) {
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
}

#[test]
fn an_image_within_the_requested_edge_stays_the_original() {
    let fx = Fixture::new();
    opaque(1024, 600).save(fx.path("small.png")).unwrap();

    assert_eq!(
        fx.resolve("small.png", 1024),
        (PreviewImageSource::Original, Resolution::Original)
    );
    assert!(
        fx.cache_entries().is_empty(),
        "no rendition is written for a small image"
    );
}

#[test]
fn a_large_opaque_image_gets_a_jpeg_rendition_fitted_to_the_edge() {
    let fx = Fixture::new();
    opaque(3000, 1500).save(fx.path("wide.png")).unwrap();

    let (source, resolution) = fx.resolve("wide.png", 1024);
    assert!(matches!(resolution, Resolution::Generated { .. }));
    let path = rendition_path(&source);
    assert!(
        path.starts_with(fx.cache.path()),
        "rendition lives in the cache directory"
    );
    assert_eq!(path.extension().unwrap(), "jpg");
    assert_eq!(
        image::image_dimensions(&path).unwrap(),
        (1024, 512),
        "aspect ratio is preserved"
    );
}

#[test]
fn a_portrait_image_is_fitted_by_its_height() {
    let fx = Fixture::new();
    opaque(900, 2700).save(fx.path("tall.jpg")).unwrap();

    let path = rendition_path(&fx.resolve("tall.jpg", 1024).0);
    assert_eq!(image::image_dimensions(path).unwrap(), (341, 1024));
}

#[test]
fn a_translucent_image_gets_a_png_rendition_that_keeps_its_alpha() {
    let fx = Fixture::new();
    let translucent = image::RgbaImage::from_fn(2400, 1200, |x, _| {
        image::Rgba([200, 30, 30, if x < 1200 { 255 } else { 0 }])
    });
    translucent.save(fx.path("alpha.png")).unwrap();

    let path = rendition_path(&fx.resolve("alpha.png", 1024).0);
    assert_eq!(path.extension().unwrap(), "png");
    let decoded = image::open(&path).unwrap().to_rgba8();
    assert_eq!(decoded.dimensions(), (1024, 512));
    assert_eq!(
        decoded.get_pixel(1000, 256).0[3],
        0,
        "transparent half stays transparent"
    );
    assert_eq!(
        decoded.get_pixel(20, 256).0[3],
        255,
        "opaque half stays opaque"
    );
}

#[test]
fn an_rgba_image_with_no_translucent_pixel_is_stored_as_jpeg() {
    let fx = Fixture::new();
    image::DynamicImage::ImageRgb8(opaque(2400, 1200))
        .to_rgba8()
        .save(fx.path("opaque-rgba.png"))
        .unwrap();

    let path = rendition_path(&fx.resolve("opaque-rgba.png", 1024).0);
    assert_eq!(path.extension().unwrap(), "jpg");
}

#[test]
fn a_cached_rendition_is_reused_without_decoding_again() {
    let fx = Fixture::new();
    opaque(3000, 1500).save(fx.path("wide.png")).unwrap();
    let first = rendition_path(&fx.resolve("wide.png", 1024).0);
    // A re-decode would overwrite this marker with a real JPEG.
    fs::write(&first, b"cached").unwrap();

    let (second, resolution) = fx.resolve("wide.png", 1024);
    assert_eq!(resolution, Resolution::CacheHit);
    assert_eq!(rendition_path(&second), first);
    assert_eq!(fs::read(&first).unwrap(), b"cached");
}

#[test]
fn changing_the_source_mtime_produces_a_new_rendition() {
    let fx = Fixture::new();
    let source = fx.path("wide.png");
    opaque(3000, 1500).save(&source).unwrap();
    with_mtime(
        &source,
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000),
    );
    let first = rendition_path(&fx.resolve("wide.png", 1024).0);

    with_mtime(
        &source,
        SystemTime::UNIX_EPOCH + Duration::from_secs(2_000_000),
    );
    let (second, resolution) = fx.resolve("wide.png", 1024);
    assert!(matches!(resolution, Resolution::Generated { .. }));
    assert_ne!(rendition_path(&second), first);
}

#[test]
fn each_requested_edge_has_its_own_rendition() {
    let fx = Fixture::new();
    opaque(5000, 2500).save(fx.path("huge.png")).unwrap();

    let small = rendition_path(&fx.resolve("huge.png", 1024).0);
    let large = rendition_path(&fx.resolve("huge.png", 2048).0);
    assert_ne!(small, large);
    assert_eq!(image::image_dimensions(large).unwrap(), (2048, 1024));
}

#[test]
fn rendition_keys_never_collide_with_tile_thumbnail_keys() {
    let fx = Fixture::new();
    let source = fx.path("wide.png");
    opaque(3000, 1500).save(&source).unwrap();

    let thumbnail = crate::thumbnails::generate_cache_key(&source, 1024).unwrap();
    let rendition = rendition_path(&fx.resolve("wide.png", 1024).0);
    assert!(!rendition
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(&thumbnail));
}

#[test]
fn requested_edges_are_clamped_to_a_sane_range() {
    let fx = Fixture::new();
    opaque(1200, 600).save(fx.path("mid.png")).unwrap();

    // 0 is clamped up to 256, so this still downsizes rather than failing.
    let path = rendition_path(&fx.resolve("mid.png", 0).0);
    assert_eq!(image::image_dimensions(path).unwrap(), (256, 128));
    // u32::MAX is clamped down, and 1200 px is within it: the original.
    assert_eq!(
        fx.resolve("mid.png", u32::MAX).0,
        PreviewImageSource::Original
    );
}

#[test]
fn formats_the_webview_must_render_stay_the_original() {
    let fx = Fixture::new();
    // GIF (animation) and SVG (vector) by extension, whatever their size.
    image::DynamicImage::ImageRgb8(opaque(3000, 1500))
        .save_with_format(fx.path("big.gif"), ImageFormat::Gif)
        .unwrap();
    fs::write(
        fx.path("drawing.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
    )
    .unwrap();
    // A GIF named .png: its content decides.
    fs::copy(fx.path("big.gif"), fx.path("disguised.png")).unwrap();

    for name in ["big.gif", "drawing.svg", "disguised.png"] {
        assert_eq!(
            fx.resolve(name, 1024).0,
            PreviewImageSource::Original,
            "{name}"
        );
    }
    assert!(fx.cache_entries().is_empty());
}

#[test]
fn an_animated_png_stays_the_original() {
    let fx = Fixture::new();
    let file = File::create(fx.path("anim.png")).unwrap();
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), 2000, 1000);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_animated(2, 0).unwrap();
    let mut writer = encoder.write_header().unwrap();
    let frame = vec![120u8; 2000 * 1000 * 3];
    writer.write_image_data(&frame).unwrap();
    writer.write_image_data(&frame).unwrap();
    writer.finish().unwrap();

    assert_eq!(fx.resolve("anim.png", 1024).0, PreviewImageSource::Original);
}

/// A big-endian TIFF/EXIF block holding only an Orientation tag.
fn exif_orientation(value: u16) -> Vec<u8> {
    let mut exif = b"MM\0\x2a\0\0\0\x08".to_vec();
    exif.extend_from_slice(&1u16.to_be_bytes()); // one IFD entry
    exif.extend_from_slice(&0x0112u16.to_be_bytes()); // Orientation
    exif.extend_from_slice(&3u16.to_be_bytes()); // SHORT
    exif.extend_from_slice(&1u32.to_be_bytes()); // count
    exif.extend_from_slice(&value.to_be_bytes());
    exif.extend_from_slice(&[0, 0]); // value padding
    exif.extend_from_slice(&0u32.to_be_bytes()); // no next IFD
    exif
}

#[test]
fn a_rotated_jpeg_rendition_is_stored_upright() {
    let fx = Fixture::new();
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90);
    encoder.set_exif_metadata(exif_orientation(6)).unwrap(); // rotate 90° clockwise
    let landscape = opaque(3000, 1500);
    encoder
        .encode(
            landscape.as_raw(),
            3000,
            1500,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    fs::write(fx.path("camera.jpg"), bytes).unwrap();

    let path = rendition_path(&fx.resolve("camera.jpg", 1024).0);
    assert_eq!(
        image::image_dimensions(path).unwrap(),
        (512, 1024),
        "shown as the webview shows the original"
    );
}

#[test]
fn a_rotated_png_stays_the_original() {
    let fx = Fixture::new();
    let mut bytes = Vec::new();
    let mut encoder = PngEncoder::new(&mut bytes);
    encoder.set_exif_metadata(exif_orientation(6)).unwrap();
    encoder
        .write_image(
            opaque(3000, 1500).as_raw(),
            3000,
            1500,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    fs::write(fx.path("tagged.png"), bytes).unwrap();

    assert_eq!(
        fx.resolve("tagged.png", 1024).0,
        PreviewImageSource::Original
    );
}

#[test]
fn a_missing_source_is_an_error() {
    let fx = Fixture::new();
    let result = resolve_preview_image(&fx.path("gone.png"), 1024, fx.cache.path());
    assert!(matches!(result, Err(AppError::NotFound(_))));
}

#[test]
fn a_corrupt_large_image_is_an_error_not_a_rendition() {
    let fx = Fixture::new();
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            opaque(3000, 1500).as_raw(),
            3000,
            1500,
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    bytes.truncate(bytes.len() / 2);
    fs::write(fx.path("truncated.png"), bytes).unwrap();

    assert!(resolve_preview_image(&fx.path("truncated.png"), 1024, fx.cache.path()).is_err());
    assert!(
        fx.cache_entries().is_empty(),
        "a failed decode leaves nothing cached"
    );
}

#[test]
fn concurrent_requests_for_one_rendition_decode_it_once() {
    let fx = Fixture::new();
    opaque(3000, 1500).save(fx.path("shared.png")).unwrap();
    let source = fx.path("shared.png");
    let cache = fx.cache.path().to_path_buf();

    let results: Vec<_> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| resolve_preview_image(&source, 1024, &cache).unwrap()))
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect()
    });

    let generated = results
        .iter()
        .filter(|(_, resolution)| matches!(resolution, Resolution::Generated { .. }))
        .count();
    assert_eq!(generated, 1, "one decode; the others hit its cache entry");
    assert!(results.iter().all(|(source, _)| *source == results[0].0));
}

#[test]
fn fitted_size_never_upscales_and_never_reaches_zero() {
    assert_eq!(fitted_size(800, 600, 1024), (800, 600));
    assert_eq!(fitted_size(40_000, 10, 1024), (1024, 1));
    assert_eq!(fitted_size(0, 0, 1024), (1, 1));
}

#[test]
fn the_command_answer_serialises_as_the_frontend_expects() {
    assert_eq!(
        serde_json::to_value(PreviewImageSource::Original).unwrap(),
        serde_json::json!({ "kind": "original" })
    );
    assert_eq!(
        serde_json::to_value(PreviewImageSource::Rendition {
            path: "/c/a.preview.jpg".into()
        })
        .unwrap(),
        serde_json::json!({ "kind": "rendition", "path": "/c/a.preview.jpg" })
    );
}
