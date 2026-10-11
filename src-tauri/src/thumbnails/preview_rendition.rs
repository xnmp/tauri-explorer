//! Display-sized Preview pane renditions of large raster images (#1054).
//!
//! The Preview pane used to stream every image's full-resolution original to
//! the webview. A 33–50 MP wallpaper then took 650–1550 ms per selection to
//! decode on WebKitGTK, with main-thread stalls up to 1.6 s. Like Quick Look
//! and Explorer's preview, the pane now shows a rendition no larger than its
//! surface needs, and loads the original only on demand (fullscreen/zoom).
//!
//! `get_preview_image` answers `original` (the webview renders the file as
//! before) or `rendition` with the absolute path of a cached file the webview
//! streams through the asset protocol. Renditions share the tile-thumbnail
//! cache directory, key scheme (namespaced), atomic writes, pruning, in-flight
//! de-duplication and decode gate; they never enter the in-memory data-URI LRU.

use super::{
    decode_image_ungated, decode_limits, diag, generate_namespaced_cache_key, get_cache_dir,
    maybe_prune_disk_cache, with_decode_gate, with_inflight_lock, write_file_atomic,
};
use crate::error::AppError;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngDecoder, PngEncoder};
use image::codecs::webp::WebPDecoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use std::fs::{self, File};
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Hashed ahead of the shared key fields so a rendition can never collide with
/// a tile thumbnail of the same file and size.
const CACHE_NAMESPACE: &[u8] = b"preview-rendition/v1";

/// Requested edges are clamped to this range: the frontend asks for 1024, 2048
/// or 3072 (see `domain/preview-rendition.ts`); anything else is a bug or abuse.
const MIN_MAX_EDGE: u32 = 256;
const MAX_MAX_EDGE: u32 = 4096;

const JPEG_QUALITY: i32 = 88;

/// Extensions a rendition may be made for. GIF (usually animated) and AVIF
/// (webviews and decoders disagree on its rotation/aperture) stay originals, as
/// does every format the webview renders itself (SVG) or the decoder lacks.
const RENDITION_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];

/// What the Preview pane should load for an image.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewImageSource {
    /// Show the file itself (small enough, animated, or not decodable here).
    Original,
    /// Show this cached display-sized file instead.
    Rendition { path: String },
}

/// Header facts read without decoding pixels.
struct SourceHeader {
    width: u32,
    height: u32,
    format: ImageFormat,
    orientation: Orientation,
    animated: bool,
}

fn has_rendition_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RENDITION_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn image_error(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Other(format!("{context}: {error}"))
}

/// Reads dimensions, orientation and animation from the header only.
fn read_header(path: &Path) -> Result<SourceHeader, AppError> {
    let reader = ImageReader::open(path)?.with_guessed_format()?;
    let format = reader
        .format()
        .ok_or_else(|| AppError::Other("Unrecognised image format".into()))?;
    let open = || -> Result<BufReader<File>, AppError> { Ok(BufReader::new(File::open(path)?)) };
    let header = |mut decoder: Box<dyn ImageDecoder + '_>, animated: bool| {
        let (width, height) = decoder.dimensions();
        let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
        SourceHeader {
            width,
            height,
            format,
            orientation,
            animated,
        }
    };
    Ok(match format {
        ImageFormat::Png => {
            let decoder = PngDecoder::with_limits(open()?, decode_limits())
                .map_err(|e| image_error("Failed to read PNG header", e))?;
            let animated = decoder
                .is_apng()
                .map_err(|e| image_error("Failed to read PNG header", e))?;
            header(Box::new(decoder), animated)
        }
        ImageFormat::WebP => {
            let decoder = WebPDecoder::new(open()?)
                .map_err(|e| image_error("Failed to read WebP header", e))?;
            let animated = decoder.has_animation();
            header(Box::new(decoder), animated)
        }
        ImageFormat::Jpeg | ImageFormat::Bmp => {
            let decoder = reader
                .into_decoder()
                .map_err(|e| image_error("Failed to read image header", e))?;
            header(Box::new(decoder), false)
        }
        // Content that disagrees with a rendition extension (a GIF named .png,
        // say): leave it to the webview, as before.
        other => SourceHeader {
            width: 0,
            height: 0,
            format: other,
            orientation: Orientation::NoTransforms,
            animated: true,
        },
    })
}

/// Whether the webview must render the original: small enough already (never
/// upscale), animated, or carrying a non-JPEG orientation tag that webviews
/// disagree on (applying it here could show the image differently from the
/// original the pane shows in fullscreen).
fn keeps_original(header: &SourceHeader, max_edge: u32) -> bool {
    header.animated
        || header.width.max(header.height) <= max_edge
        || (header.format != ImageFormat::Jpeg && header.orientation != Orientation::NoTransforms)
}

/// Fits `width`×`height` inside a `max_edge` square, preserving aspect ratio.
fn fitted_size(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height).max(1) as f64;
    let scale = (max_edge as f64 / longest).min(1.0);
    let fit = |edge: u32| ((edge as f64 * scale).round() as u32).max(1);
    (fit(width), fit(height))
}

/// Downscales for viewing with an area-averaging reduction. It costs about a
/// fifth of a separable Catmull-Rom pass at these 3–8x ratios (measured on a
/// 7680x4320 PNG: ~220 ms vs ~1.2 s) and averages every source pixel, so large
/// reductions do not alias. JPEG sources already arrive DCT-scaled.
fn downscale(image: &DynamicImage, max_edge: u32) -> DynamicImage {
    let (width, height) = fitted_size(image.width(), image.height(), max_edge);
    image.thumbnail_exact(width, height)
}

/// The encoded rendition: JPEG for opaque images, PNG when any pixel is
/// translucent so transparent images stay transparent.
struct Encoded {
    bytes: Vec<u8>,
    extension: &'static str,
}

fn encode(image: &DynamicImage) -> Result<Encoded, AppError> {
    if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        if rgba.pixels().any(|p| p.0[3] < u8::MAX) {
            let mut buffer = Cursor::new(Vec::new());
            PngEncoder::new_with_quality(&mut buffer, CompressionType::Fast, PngFilter::Adaptive)
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| image_error("Failed to encode preview PNG", e))?;
            return Ok(Encoded {
                bytes: buffer.into_inner(),
                extension: "png",
            });
        }
    }
    // libjpeg-turbo: the image crate's encoder took ~300 ms for a 2048 px frame.
    let jpeg =
        turbojpeg::compress_image(&image.to_rgb8(), JPEG_QUALITY, turbojpeg::Subsamp::Sub2x2)
            .map_err(|e| image_error("Failed to encode preview JPEG", e))?;
    Ok(Encoded {
        bytes: jpeg.to_vec(),
        extension: "jpg",
    })
}

fn cached_rendition(cache_dir: &Path, cache_key: &str) -> Option<PathBuf> {
    ["jpg", "png"]
        .iter()
        .map(|extension| cache_dir.join(format!("{cache_key}.preview.{extension}")))
        .find(|path| path.is_file())
}

fn generate(
    source: &Path,
    header: &SourceHeader,
    max_edge: u32,
    cache_dir: &Path,
    cache_key: &str,
) -> Result<PathBuf, AppError> {
    let mut image = decode_image_ungated(source, max_edge)?;
    // Webviews honour JPEG EXIF orientation when they render the original, so
    // the rendition (which carries no EXIF) must be stored upright.
    if header.format == ImageFormat::Jpeg {
        image.apply_orientation(header.orientation);
    }
    let encoded = encode(&downscale(&image, max_edge))?;
    drop(image);
    fs::create_dir_all(cache_dir)?;
    let path = cache_dir.join(format!("{cache_key}.preview.{}", encoded.extension));
    write_file_atomic(&path, &encoded.bytes)
        .map_err(|e| image_error("Failed to save preview rendition", e))?;
    maybe_prune_disk_cache(cache_dir, encoded.bytes.len() as u64);
    Ok(path)
}

/// Where a rendition request was answered from, for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Resolution {
    Original,
    CacheHit,
    /// Decoded now, after `gate_wait` queued for a decode permit.
    Generated {
        gate_wait: Duration,
    },
}

/// Resolves `source` for a surface needing at most `max_edge` pixels, caching
/// renditions in `cache_dir`. Pure apart from that directory, so tests run it
/// against a temporary one.
pub(crate) fn resolve_preview_image(
    source: &Path,
    max_edge: u32,
    cache_dir: &Path,
) -> Result<(PreviewImageSource, Resolution), AppError> {
    let max_edge = max_edge.clamp(MIN_MAX_EDGE, MAX_MAX_EDGE);
    if !source.is_file() {
        return Err(AppError::NotFound(source.to_string_lossy().into_owned()));
    }
    if !has_rendition_extension(source) {
        return Ok((PreviewImageSource::Original, Resolution::Original));
    }
    let cache_key = generate_namespaced_cache_key(CACHE_NAMESPACE, source, max_edge)
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {source:?}")))?;
    let rendition = |path: PathBuf| PreviewImageSource::Rendition {
        path: path.to_string_lossy().into_owned(),
    };

    with_inflight_lock(&cache_key, || {
        if let Some(path) = cached_rendition(cache_dir, &cache_key) {
            return Ok((rendition(path), Resolution::CacheHit));
        }
        let header = read_header(source)?;
        if keeps_original(&header, max_edge) {
            return Ok((PreviewImageSource::Original, Resolution::Original));
        }
        let (generated, gate_wait) =
            with_decode_gate(|| generate(source, &header, max_edge, cache_dir, &cache_key));
        Ok((rendition(generated?), Resolution::Generated { gate_wait }))
    })
}

fn get_preview_image_sync(path: String, max_edge: u32) -> Result<PreviewImageSource, AppError> {
    let cache_dir =
        get_cache_dir().ok_or_else(|| AppError::Other("Failed to get cache directory".into()))?;
    let source = PathBuf::from(&path);
    let started = Instant::now();
    let (answer, resolution) = resolve_preview_image(&source, max_edge, &cache_dir)?;
    let elapsed = started.elapsed();
    let (source_kind, decode, gate_wait) = match resolution {
        Resolution::Original => return Ok(answer),
        Resolution::CacheHit => (diag::Source::DiskHit, None, Duration::ZERO),
        Resolution::Generated { gate_wait } => (diag::Source::Decoded, Some(elapsed), gate_wait),
    };
    diag::record(
        "rendition",
        source_kind,
        elapsed,
        decode,
        gate_wait,
        &source,
        max_edge,
    );
    Ok(answer)
}

/// What the Preview pane should load for `path` on a surface needing at most
/// `max_edge` device pixels: the original, or a cached display-sized rendition.
#[tauri::command]
pub async fn get_preview_image(
    path: String,
    max_edge: u32,
) -> Result<PreviewImageSource, AppError> {
    tokio::task::spawn_blocking(move || get_preview_image_sync(path, max_edge))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

#[cfg(test)]
#[path = "../../test_support/preview_rendition.rs"]
mod tests;
