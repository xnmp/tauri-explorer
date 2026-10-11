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
//! streams through the asset protocol. Renditions live in their own `previews`
//! subdirectory of the tile-thumbnail cache with their own size budget, and
//! share its key scheme (namespaced), atomic writes, pruning, in-flight
//! de-duplication and decode gate; they never enter the in-memory data-URI LRU.
//!
//! The asset protocol must be allowed to serve that directory explicitly
//! (`allow_rendition_assets`, at startup): on Unix, Tauri's scope globs require
//! a literal leading dot, so `$HOME/**/*` does not match `~/.cache/...`.

use super::{
    check_image_file_size, decode_image_ungated, decode_limits, diag,
    generate_namespaced_cache_key, get_cache_dir, maybe_prune_with_budget, with_decode_gate,
    with_inflight_lock, write_file_atomic, PruneBudget,
};
use crate::error::AppError;
use image::codecs::jpeg::JpegDecoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngDecoder, PngEncoder};
use image::codecs::webp::WebPDecoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, RgbaImage};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Renditions' subdirectory of the thumbnail cache.
const RENDITION_DIR: &str = "previews";

/// Renditions are 0.4–1.5 MB each, against a few KB per tile thumbnail; a
/// separate cap keeps them from evicting the thumbnails.
const MAX_RENDITION_CACHE_BYTES: u64 = 300 * 1024 * 1024;
static RENDITION_BUDGET: PruneBudget = PruneBudget::new(MAX_RENDITION_CACHE_BYTES);

/// JPEG headers are read from at most this prefix: image's JPEG decoder reads
/// its whole input into memory, and a header check must not.
const JPEG_HEADER_PREFIX_BYTES: u64 = 2 * 1024 * 1024;

/// ICC profiles larger than 255 APP2 segments cannot be embedded in a JPEG.
const ICC_SEGMENT_PAYLOAD: usize = 65_519;

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
    /// None when it could not be read: the original is kept.
    orientation: Option<Orientation>,
    animated: bool,
    /// CMYK/YCCK JPEGs: the rendition path is RGB-only, so keep the original.
    cmyk: bool,
    /// Embedded colour profile, carried into the rendition.
    icc_profile: Option<Vec<u8>>,
}

impl SourceHeader {
    /// A header that keeps the original (unsupported or disguised content).
    fn keep_original(format: ImageFormat) -> Self {
        Self {
            width: 0,
            height: 0,
            format,
            orientation: None,
            animated: true,
            cmyk: false,
            icc_profile: None,
        }
    }
}

/// The directory renditions are cached in, under the thumbnail cache.
pub(crate) fn rendition_cache_dir(thumbnail_cache_dir: &Path) -> PathBuf {
    thumbnail_cache_dir.join(RENDITION_DIR)
}

/// Lets `scope` serve the files directly inside `dir` (created if missing),
/// under both its given and its canonical spelling, because the scope matches
/// canonicalised request paths.
pub(crate) fn allow_rendition_directory(
    scope: &tauri::scope::fs::Scope,
    dir: &Path,
) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    let allow = |path: &Path| {
        scope
            .allow_directory(path, false)
            .map_err(|e| image_error("Failed to allow the rendition directory", e))
    };
    allow(dir)?;
    match fs::canonicalize(dir) {
        Ok(canonical) if canonical != dir => allow(&canonical),
        _ => Ok(()),
    }
}

/// Startup: lets the asset protocol serve renditions. The configured
/// `$HOME/**/*` scope does not match `~/.cache` on Unix (leading-dot rule), nor
/// a cache outside `$HOME`; without this every rendition would 403 and the
/// pane would fall back to the slow original.
pub(crate) fn allow_rendition_assets<R: tauri::Runtime, M: tauri::Manager<R>>(manager: &M) {
    let Some(cache_dir) = get_cache_dir() else {
        log::warn!("Preview renditions disabled: no cache directory");
        return;
    };
    let dir = rendition_cache_dir(&cache_dir);
    if let Err(error) = allow_rendition_directory(&manager.asset_protocol_scope(), &dir) {
        log::warn!("Preview renditions cannot be served from {dir:?}: {error}");
    }
}

fn has_rendition_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RENDITION_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn image_error(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Other(format!("{context}: {error}"))
}

/// Reads a JPEG header from a bounded prefix: dimensions and colour space via
/// libjpeg-turbo, orientation and ICC profile via image's EXIF/APP2 parsing.
fn read_jpeg_header(path: &Path) -> Result<SourceHeader, AppError> {
    let mut prefix = Vec::new();
    File::open(path)?
        .take(JPEG_HEADER_PREFIX_BYTES)
        .read_to_end(&mut prefix)?;
    let header = turbojpeg::Decompressor::new()
        .and_then(|mut decompressor| decompressor.read_header(&prefix))
        .map_err(|e| image_error("Failed to read JPEG header", e))?;
    let cmyk = matches!(
        header.colorspace,
        turbojpeg::Colorspace::CMYK | turbojpeg::Colorspace::YCCK
    );
    let (orientation, icc_profile) = match JpegDecoder::new(Cursor::new(prefix.as_slice())) {
        Ok(mut decoder) => (
            decoder.orientation().ok(),
            decoder.icc_profile().ok().flatten(),
        ),
        Err(_) => (None, None),
    };
    Ok(SourceHeader {
        width: u32::try_from(header.width).unwrap_or(u32::MAX),
        height: u32::try_from(header.height).unwrap_or(u32::MAX),
        format: ImageFormat::Jpeg,
        orientation,
        animated: false,
        cmyk,
        icc_profile,
    })
}

/// Reads dimensions, orientation, animation and colour profile from the header
/// only, after rejecting files too large to decode safely.
fn read_header(path: &Path) -> Result<SourceHeader, AppError> {
    check_image_file_size(path)?;
    let format = ImageReader::open(path)?
        .with_guessed_format()?
        .format()
        .ok_or_else(|| AppError::Other("Unrecognised image format".into()))?;
    let open = || -> Result<BufReader<File>, AppError> { Ok(BufReader::new(File::open(path)?)) };
    let header = |mut decoder: Box<dyn ImageDecoder + '_>, animated: bool| SourceHeader {
        width: decoder.dimensions().0,
        height: decoder.dimensions().1,
        format,
        orientation: decoder.orientation().ok(),
        animated,
        cmyk: false,
        icc_profile: decoder.icc_profile().ok().flatten(),
    };
    Ok(match format {
        ImageFormat::Jpeg => read_jpeg_header(path)?,
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
        ImageFormat::Bmp => {
            let decoder = ImageReader::with_format(open()?, ImageFormat::Bmp)
                .into_decoder()
                .map_err(|e| image_error("Failed to read BMP header", e))?;
            header(Box::new(decoder), false)
        }
        // Content that disagrees with a rendition extension (a GIF named .png,
        // say): leave it to the webview, as before.
        other => SourceHeader::keep_original(other),
    })
}

/// Whether the webview must render the original: small enough already (never
/// upscale), animated, CMYK, of unknown orientation, or carrying a non-JPEG
/// orientation tag that webviews disagree on (applying it here could show the
/// image differently from the original the pane shows in fullscreen).
fn keeps_original(header: &SourceHeader, max_edge: u32) -> bool {
    let orientation_unsafe = match header.orientation {
        None => true,
        Some(Orientation::NoTransforms) => false,
        Some(_) => header.format != ImageFormat::Jpeg,
    };
    header.animated
        || header.cmyk
        || orientation_unsafe
        || header.width.max(header.height) <= max_edge
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
/// reductions do not alias. JPEG sources already arrive DCT-scaled. Images
/// with alpha are averaged premultiplied: averaging straight alpha pulls the
/// colour of fully transparent pixels into the edges as dark halos.
fn downscale(image: DynamicImage, max_edge: u32) -> DynamicImage {
    let (width, height) = fitted_size(image.width(), image.height(), max_edge);
    if !image.color().has_alpha() {
        return image.thumbnail_exact(width, height);
    }
    let mut rgba = image.into_rgba8();
    premultiply(&mut rgba);
    let mut reduced = image::imageops::thumbnail(&rgba, width, height);
    drop(rgba);
    unpremultiply(&mut reduced);
    DynamicImage::ImageRgba8(reduced)
}

fn premultiply(image: &mut RgbaImage) {
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel.0[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 127) / 255) as u8;
        }
    }
}

fn unpremultiply(image: &mut RgbaImage) {
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel.0[3]);
        for channel in &mut pixel.0[..3] {
            *channel = match alpha {
                0 => 0,
                _ => ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8,
            };
        }
    }
}

/// The encoded rendition: JPEG for opaque images, PNG when any pixel is
/// translucent so transparent images stay transparent.
struct Encoded {
    bytes: Vec<u8>,
    extension: &'static str,
}

fn encode(image: &DynamicImage, icc_profile: Option<&[u8]>) -> Result<Encoded, AppError> {
    if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        if rgba.pixels().any(|p| p.0[3] < u8::MAX) {
            let mut buffer = Cursor::new(Vec::new());
            let mut encoder = PngEncoder::new_with_quality(
                &mut buffer,
                CompressionType::Fast,
                PngFilter::Adaptive,
            );
            if let Some(profile) = icc_profile {
                encoder
                    .set_icc_profile(profile.to_vec())
                    .map_err(|e| image_error("Failed to embed the colour profile", e))?;
            }
            encoder
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
    // 4:4:4 keeps coloured text and UI screenshots free of chroma fringes.
    let jpeg = turbojpeg::compress_image(&image.to_rgb8(), JPEG_QUALITY, turbojpeg::Subsamp::None)
        .map_err(|e| image_error("Failed to encode preview JPEG", e))?;
    let bytes = match icc_profile {
        Some(profile) => with_icc_profile(&jpeg, profile)?,
        None => jpeg.to_vec(),
    };
    Ok(Encoded {
        bytes,
        extension: "jpg",
    })
}

/// Embeds `profile` in `jpeg` as ICC APP2 segments (ICC.1 Annex B.4), after
/// the JFIF APP0 segment when there is one.
fn with_icc_profile(jpeg: &[u8], profile: &[u8]) -> Result<Vec<u8>, AppError> {
    let chunks: Vec<&[u8]> = profile.chunks(ICC_SEGMENT_PAYLOAD).collect();
    let count = u8::try_from(chunks.len())
        .map_err(|_| AppError::Other("Colour profile too large to embed".into()))?;
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return Err(AppError::Other("Encoder produced no JPEG SOI".into()));
    }
    let insert_at = match jpeg.get(2..6) {
        Some([0xFF, 0xE0, high, low]) => 4 + usize::from(u16::from_be_bytes([*high, *low])),
        _ => 2,
    }
    .min(jpeg.len());
    let mut out = Vec::with_capacity(jpeg.len() + profile.len() + 18 * chunks.len());
    out.extend_from_slice(&jpeg[..insert_at]);
    for (index, chunk) in chunks.iter().enumerate() {
        let length = (2 + 14 + chunk.len()) as u16;
        out.extend_from_slice(&[0xFF, 0xE2]);
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(b"ICC_PROFILE\0");
        out.extend_from_slice(&[index as u8 + 1, count]);
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&jpeg[insert_at..]);
    Ok(out)
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
    let mut image = downscale(decode_image_ungated(source, max_edge)?, max_edge);
    // Webviews honour JPEG EXIF orientation when they render the original, so
    // the rendition (which carries no EXIF) must be stored upright. Rotating
    // after the downscale touches a fraction of the pixels.
    if let (ImageFormat::Jpeg, Some(orientation)) = (header.format, header.orientation) {
        image.apply_orientation(orientation);
    }
    let encoded = encode(&image, header.icc_profile.as_deref())?;
    drop(image);
    fs::create_dir_all(cache_dir)?;
    let path = cache_dir.join(format!("{cache_key}.preview.{}", encoded.extension));
    write_file_atomic(&path, &encoded.bytes)
        .map_err(|e| image_error("Failed to save preview rendition", e))?;
    maybe_prune_with_budget(cache_dir, encoded.bytes.len() as u64, &RENDITION_BUDGET);
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
/// renditions in `cache_dir` (the renditions directory itself). Pure apart from
/// that directory, so tests run it against a temporary one.
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
    let cache_dir = get_cache_dir()
        .map(|dir| rendition_cache_dir(&dir))
        .ok_or_else(|| AppError::Other("Failed to get cache directory".into()))?;
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
