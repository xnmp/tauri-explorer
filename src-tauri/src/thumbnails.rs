//! Thumbnail generation module for Tauri commands.
//! Issue: tauri-explorer-im3m, tauri-explorer-i0yt, tauri-e2mn
//!
//! Provides fast, cached thumbnail generation for image files.
//! Uses async commands with spawn_blocking to avoid freezing the UI.
//! Supports two-tier progressive loading: micro (16x16) + full (128x128).

use crate::error::AppError;
use base64::Engine as _;
use image::{ImageFormat, ImageReader};
use lru::LruCache;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Default thumbnail size (width and height in pixels)
const THUMBNAIL_SIZE: u32 = 128;

/// Micro thumbnail size for progressive loading preview
const MICRO_SIZE: u32 = 16;

/// Supported image extensions for thumbnail generation.
/// AVIF decodes via image's avif-native (dav1d), gated behind the optional
/// `avif` cargo feature (see Cargo.toml). Enabled by the Arch PKGBUILD.
#[cfg(feature = "avif")]
const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "icns", "avif"];
#[cfg(not(feature = "avif"))]
const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "icns"];

/// Supported video extensions for frame-extraction thumbnails (requires ffmpeg).
const SUPPORTED_VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "wmv", "flv", "m4v", "mpg", "mpeg",
];

/// Audio extensions that can carry embedded cover art. We extract the attached
/// picture (not a frame) via ffmpeg. m4a/mp3/flac/etc. commonly have album art.
const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &[
    "m4a", "mp3", "flac", "ogg", "opus", "aac", "wma", "m4b", "aiff", "alac",
];

/// Get the cache directory for thumbnails
fn get_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|p| p.join("tauri-explorer").join("thumbnails"))
}

/// Cache version - bump when thumbnail generation logic changes to invalidate stale cache
const CACHE_VERSION: u8 = 3;

/// Generate a cache key (hash) for a file path + modification time (secs + nanos)
/// + file length + thumbnail size + cache version.
fn generate_cache_key(path: &Path, size: u32) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;

    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(modified_dur.as_secs().to_le_bytes());
    hasher.update(modified_dur.subsec_nanos().to_le_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(size.to_le_bytes());
    hasher.update([CACHE_VERSION]);

    Some(hex::encode(hasher.finalize()))
}

/// Check if a file is a supported image type
pub fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Check if a file is a supported audio type (thumbnail via embedded cover art)
pub fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Check if a file is a supported video type (thumbnail via ffmpeg frame extraction)
pub fn is_supported_video(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_VIDEO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Get cached thumbnail path if it exists
fn get_cached_thumbnail(cache_key: &str) -> Option<PathBuf> {
    let cache_dir = get_cache_dir()?;
    let cache_path = cache_dir.join(format!("{}.jpg", cache_key));

    if cache_path.exists() {
        Some(cache_path)
    } else {
        None
    }
}

/// Write bytes to `dest` atomically: write a temp file in the same directory,
/// then rename over the destination so readers never see a half-written file.
fn write_file_atomic(dest: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = dest
        .parent()
        .ok_or_else(|| std::io::Error::other("Cache path has no parent directory"))?;
    let file_name = dest
        .file_name()
        .ok_or_else(|| std::io::Error::other("Cache path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let tmp = parent.join(format!(".{}.tmp-{}", file_name, std::process::id()));
    if let Err(e) = fs::write(&tmp, data) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, dest).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Save raw JPEG bytes to cache (atomic write), occasionally pruning the cache.
fn save_to_cache(cache_key: &str, data: &[u8]) {
    if let Some(cache_dir) = get_cache_dir() {
        let _ = fs::create_dir_all(&cache_dir);
        let cache_path = cache_dir.join(format!("{}.jpg", cache_key));
        let _ = write_file_atomic(&cache_path, data);
        maybe_prune_disk_cache(&cache_dir);
    }
}

// ─── Disk cache pruning ─────────────────────────────────────────────────────

/// Maximum total size of the on-disk thumbnail cache (~500 MB).
const MAX_DISK_CACHE_BYTES: u64 = 500 * 1024 * 1024;

/// Prune at most every N cache writes to keep the directory scan cheap.
const PRUNE_EVERY_N_WRITES: u64 = 256;

static CACHE_WRITE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Every `PRUNE_EVERY_N_WRITES` writes (including the first of a session),
/// evict oldest-mtime entries until the cache fits under the size cap.
/// Callers are already on a blocking thread (spawn_blocking), so the
/// directory scan never runs on the async runtime.
fn maybe_prune_disk_cache(cache_dir: &Path) {
    let count = CACHE_WRITE_COUNT.fetch_add(1, Ordering::Relaxed);
    if !count.is_multiple_of(PRUNE_EVERY_N_WRITES) {
        return;
    }
    prune_disk_cache(cache_dir, MAX_DISK_CACHE_BYTES);
}

fn prune_disk_cache(cache_dir: &Path, max_bytes: u64) {
    let Ok(read_dir) = fs::read_dir(cache_dir) else {
        return;
    };

    let mut entries: Vec<(PathBuf, std::time::SystemTime, u64)> = read_dir
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((entry.path(), modified, metadata.len()))
        })
        .collect();

    let mut total: u64 = entries.iter().map(|(_, _, len)| len).sum();
    if total <= max_bytes {
        return;
    }

    // Oldest first
    entries.sort_by_key(|(_, modified, _)| *modified);
    for (path, _, len) in entries {
        if total <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    log::info!("Pruned thumbnail disk cache to {} bytes", total);
}

// ─── In-flight generation dedup ─────────────────────────────────────────────

/// Per-cache-key locks so concurrent requests for the same thumbnail don't
/// decode the same image twice. The second caller blocks until the first
/// finishes, then hits the freshly written cache.
static INFLIGHT: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn inflight_map() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Acquire the lock object for a cache key (creating it if absent).
fn inflight_lock(cache_key: &str) -> Arc<Mutex<()>> {
    let mut map = inflight_map().lock().unwrap_or_else(|p| p.into_inner());
    map.entry(cache_key.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Drop the map entry once no other caller holds the lock.
fn inflight_release(cache_key: &str, lock: Arc<Mutex<()>>) {
    let mut map = inflight_map().lock().unwrap_or_else(|p| p.into_inner());
    // 2 = the map's clone + ours; nobody else is waiting on this key.
    if Arc::strong_count(&lock) <= 2 {
        map.remove(cache_key);
    }
}

/// Run `work` while holding the per-key in-flight lock for `cache_key`.
fn with_inflight_lock<T>(cache_key: &str, work: impl FnOnce() -> T) -> T {
    let lock = inflight_lock(cache_key);
    let result = {
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        work()
    };
    inflight_release(cache_key, lock);
    result
}

/// Encode an RGB8 image to JPEG bytes at the given quality
fn encode_jpeg(img: &image::RgbImage, quality: u8) -> Result<Vec<u8>, AppError> {
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder
        .encode(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| AppError::Other(format!("Failed to encode JPEG: {}", e)))?;
    Ok(buffer.into_inner())
}

/// Format raw bytes as a data URI
fn to_data_uri(data: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    )
}

// ─── In-memory LRU cache ────────────────────────────────────────────────────

const LRU_CAPACITY: usize = 512;

static THUMB_LRU: OnceLock<Mutex<LruCache<String, String>>> = OnceLock::new();

fn get_lru_cache() -> &'static Mutex<LruCache<String, String>> {
    THUMB_LRU.get_or_init(|| Mutex::new(LruCache::new(NonZeroUsize::new(LRU_CAPACITY).unwrap())))
}

fn lru_get(key: &str) -> Option<String> {
    get_lru_cache().lock().ok()?.get(key).cloned()
}

fn lru_put(key: String, value: String) {
    if let Ok(mut cache) = get_lru_cache().lock() {
        cache.put(key, value);
    }
}

fn lru_clear() {
    if let Ok(mut cache) = get_lru_cache().lock() {
        cache.clear();
    }
}

// ─── JPEG DCT scaling ───────────────────────────────────────────────────────

const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg"];

fn is_jpeg(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| JPEG_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn decode_jpeg_scaled(path: &Path, target_size: u32) -> Result<image::DynamicImage, AppError> {
    let jpeg_data = fs::read(path)?;
    let mut decompressor = turbojpeg::Decompressor::new()
        .map_err(|e| AppError::Other(format!("turbojpeg init failed: {}", e)))?;

    let header = decompressor
        .read_header(&jpeg_data)
        .map_err(|e| AppError::Other(format!("turbojpeg header read failed: {}", e)))?;

    let max_dim = header.width.max(header.height) as u32;
    let scale = if max_dim / 8 >= target_size {
        turbojpeg::ScalingFactor::ONE_EIGHTH
    } else if max_dim / 4 >= target_size {
        turbojpeg::ScalingFactor::ONE_QUARTER
    } else if max_dim / 2 >= target_size {
        turbojpeg::ScalingFactor::ONE_HALF
    } else {
        turbojpeg::ScalingFactor::ONE
    };

    decompressor
        .set_scaling_factor(scale)
        .map_err(|e| AppError::Other(format!("turbojpeg set scale failed: {}", e)))?;

    let scaled = header.scaled(scale);
    let format = turbojpeg::PixelFormat::RGB;
    let pitch = scaled.width * format.size();
    let mut output = turbojpeg::Image {
        pixels: vec![0u8; scaled.height * pitch],
        width: scaled.width,
        pitch,
        height: scaled.height,
        format,
    };

    decompressor
        .decompress(&jpeg_data, output.as_deref_mut())
        .map_err(|e| AppError::Other(format!("turbojpeg decompress failed: {}", e)))?;

    let rgb = image::RgbImage::from_raw(scaled.width as u32, scaled.height as u32, output.pixels)
        .ok_or_else(|| {
        AppError::Other("Failed to create RgbImage from turbojpeg output".into())
    })?;

    Ok(image::DynamicImage::ImageRgb8(rgb))
}

fn is_icns(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("icns"))
        .unwrap_or(false)
}

fn decode_icns(path: &Path) -> Result<image::DynamicImage, AppError> {
    let file = fs::File::open(path)?;
    let icon_family = icns::IconFamily::read(file)
        .map_err(|e| AppError::Other(format!("Failed to read icns: {}", e)))?;

    let best = icon_family
        .available_icons()
        .iter()
        .max_by_key(|t| t.pixel_width())
        .copied()
        .ok_or_else(|| AppError::Other("No icons in icns file".into()))?;

    let icon_image = icon_family
        .get_icon_with_type(best)
        .map_err(|e| AppError::Other(format!("Failed to decode icns icon: {}", e)))?;

    let width = icon_image.width();
    let height = icon_image.height();
    let rgba_data = icon_image.data().to_vec();

    image::RgbaImage::from_raw(width, height, rgba_data)
        .map(image::DynamicImage::ImageRgba8)
        .ok_or_else(|| AppError::Other("Failed to create image from icns data".into()))
}

fn decode_image(path: &Path, target_size: u32) -> Result<image::DynamicImage, AppError> {
    if is_jpeg(path) {
        match decode_jpeg_scaled(path, target_size) {
            Ok(img) => return Ok(img),
            Err(e) => log::warn!(
                "turbojpeg fast path failed for {:?}, falling back: {}",
                path,
                e
            ),
        }
    }
    if is_icns(path) {
        return decode_icns(path);
    }
    ImageReader::open(path)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AppError::Other(format!("Failed to decode image: {}", e)))
}

/// Validate path for thumbnail generation (exists + supported format)
fn validate_thumbnail_path(path: &Path, path_str: &str) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::NotFound(path_str.to_string()));
    }
    if !is_supported_image(path) {
        return Err(AppError::InvalidPath(format!(
            "Unsupported image format: {}",
            path_str
        )));
    }
    Ok(())
}

/// Generate thumbnail and save to cache
fn generate_and_cache_thumbnail(
    source_path: &Path,
    cache_key: &str,
    size: u32,
) -> Result<PathBuf, AppError> {
    let cache_dir =
        get_cache_dir().ok_or(AppError::Other("Failed to get cache directory".into()))?;

    // Create cache directory if it doesn't exist
    fs::create_dir_all(&cache_dir)?;

    let img = decode_image(source_path, size)?;
    let thumbnail = img.thumbnail(size, size).to_rgb8();

    // Save to cache as JPEG for smaller size and fast loading.
    // Encode in memory, then write atomically (temp + rename).
    let cache_path = cache_dir.join(format!("{}.jpg", cache_key));
    let mut buffer = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(thumbnail)
        .write_to(&mut buffer, ImageFormat::Jpeg)
        .map_err(|e| AppError::Other(format!("Failed to encode thumbnail: {}", e)))?;
    write_file_atomic(&cache_path, buffer.get_ref())
        .map_err(|e| AppError::Other(format!("Failed to save thumbnail: {}", e)))?;
    maybe_prune_disk_cache(&cache_dir);

    Ok(cache_path)
}

// ─── Sync implementations ───────────────────────────────────────────────────

fn get_thumbnail_sync(path: String, size: Option<u32>) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);
    validate_thumbnail_path(&source_path, &path)?;

    let cache_key = generate_cache_key(&source_path, size)
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    with_inflight_lock(&cache_key, || {
        if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
            return Ok(cached_path.to_string_lossy().to_string());
        }

        let thumb_path = generate_and_cache_thumbnail(&source_path, &cache_key, size)?;
        Ok(thumb_path.to_string_lossy().to_string())
    })
}

fn get_thumbnail_data_sync(
    path: String,
    size: Option<u32>,
    quality: Option<u8>,
) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);
    let quality = quality.unwrap_or(80);
    validate_thumbnail_path(&source_path, &path)?;

    let cache_key = generate_cache_key(&source_path, size)
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    // Check in-memory LRU first (fastest)
    if let Some(uri) = lru_get(&cache_key) {
        return Ok(uri);
    }

    with_inflight_lock(&cache_key.clone(), || {
        // Re-check caches: another request may have generated while we waited
        if let Some(uri) = lru_get(&cache_key) {
            return Ok(uri);
        }
        if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
            let data = fs::read(&cached_path)?;
            let uri = to_data_uri(&data);
            lru_put(cache_key.clone(), uri.clone());
            return Ok(uri);
        }

        let img = decode_image(&source_path, size)?;
        let thumbnail = img.thumbnail(size, size).to_rgb8();

        let data = encode_jpeg(&thumbnail, quality)?;
        save_to_cache(&cache_key, &data);

        let uri = to_data_uri(&data);
        lru_put(cache_key.clone(), uri.clone());
        Ok(uri)
    })
}

fn get_micro_thumbnail_sync(
    path: String,
    prewarm_size: Option<u32>,
    prewarm_quality: Option<u8>,
) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    let full_size = prewarm_size.unwrap_or(THUMBNAIL_SIZE);
    let full_quality = prewarm_quality.unwrap_or(80);
    validate_thumbnail_path(&source_path, &path)?;

    let micro_cache_key = generate_cache_key(&source_path, MICRO_SIZE)
        .map(|k| format!("{}_micro", k))
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    // Check in-memory LRU first
    if let Some(uri) = lru_get(&micro_cache_key) {
        return Ok(uri);
    }

    with_inflight_lock(&micro_cache_key.clone(), || {
        // Re-check caches: another request may have generated while we waited
        if let Some(uri) = lru_get(&micro_cache_key) {
            return Ok(uri);
        }
        if let Some(cached_path) = get_cached_thumbnail(&micro_cache_key) {
            let data = fs::read(&cached_path)?;
            let uri = to_data_uri(&data);
            lru_put(micro_cache_key.clone(), uri.clone());
            return Ok(uri);
        }

        let img = decode_image(&source_path, full_size)?;

        // Generate micro thumbnail (Nearest = fastest resize algorithm)
        let micro = img
            .resize(MICRO_SIZE, MICRO_SIZE, image::imageops::FilterType::Nearest)
            .to_rgb8();
        let micro_data = encode_jpeg(&micro, 50)?;
        save_to_cache(&micro_cache_key, &micro_data);

        // Pre-warm full thumbnail cache if not already present.
        // Since the image is already decoded in memory, this is nearly free.
        let full_cache_key = generate_cache_key(&source_path, full_size);
        if let Some(ref key) = full_cache_key {
            if get_cached_thumbnail(key).is_none() {
                let full = img.thumbnail(full_size, full_size).to_rgb8();
                if let Ok(full_data) = encode_jpeg(&full, full_quality) {
                    save_to_cache(key, &full_data);
                    lru_put(key.clone(), to_data_uri(&full_data));
                }
            }
        }

        let uri = to_data_uri(&micro_data);
        lru_put(micro_cache_key.clone(), uri.clone());
        Ok(uri)
    })
}

// ─── Video frame thumbnails (ffmpeg) ────────────────────────────────────────

/// Return true if `cmd` runs `-version` successfully (i.e. it's a real ffmpeg).
fn ffmpeg_runs(cmd: &Path) -> bool {
    use crate::process_ext::NoConsole;
    use std::process::Command;
    log::info!("[spawn-diag] thumbnails: probing ffmpeg candidate {}", cmd.display());
    Command::new(cmd)
        .arg("-version")
        .no_console()
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Common absolute install locations to try when `ffmpeg` isn't on PATH — most
/// relevant on Windows, where ffmpeg is usually unzipped into a folder rather
/// than added to PATH (winget/scoop/choco/manual), and macOS Homebrew.
fn ffmpeg_fallback_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    let env = |k: &str| std::env::var(k).ok();
    #[cfg(target_os = "windows")]
    {
        for base in [env("LOCALAPPDATA"), env("ProgramFiles"), env("USERPROFILE")]
            .into_iter()
            .flatten()
        {
            v.push(PathBuf::from(&base).join(r"Microsoft\WinGet\Links\ffmpeg.exe"));
            v.push(PathBuf::from(&base).join(r"ffmpeg\bin\ffmpeg.exe"));
            v.push(PathBuf::from(&base).join(r"scoop\shims\ffmpeg.exe"));
        }
        v.push(PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"));
        v.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"));

        // winget installs into versioned package subdirs (e.g.
        // %LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_…\ffmpeg-7.x-full_build\bin\ffmpeg.exe),
        // so glob: for each package dir whose name contains "ffmpeg", look for
        // <pkg>/<any>/bin/ffmpeg.exe.
        if let Some(local) = env("LOCALAPPDATA") {
            let packages = PathBuf::from(local).join(r"Microsoft\WinGet\Packages");
            if let Ok(pkg_dirs) = std::fs::read_dir(&packages) {
                for pkg in pkg_dirs.flatten() {
                    if !pkg
                        .file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .contains("ffmpeg")
                    {
                        continue;
                    }
                    if let Ok(inner) = std::fs::read_dir(pkg.path()) {
                        for sub in inner.flatten() {
                            v.push(sub.path().join(r"bin\ffmpeg.exe"));
                        }
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = env; // unused on non-windows
        for p in [
            "/opt/homebrew/bin/ffmpeg",
            "/usr/local/bin/ffmpeg",
            "/usr/bin/ffmpeg",
        ] {
            v.push(PathBuf::from(p));
        }
    }
    v
}

/// User-configured explicit ffmpeg path (from settings). Takes priority over
/// auto-detection. Empty/unset = auto-detect only.
fn ffmpeg_override() -> &'static Mutex<Option<String>> {
    static OVERRIDE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// Cached resolution: `None` = not yet computed, `Some(opt)` = computed.
/// Invalidated by `set_ffmpeg_path` so a newly-configured path takes effect.
fn ffmpeg_resolved() -> &'static Mutex<Option<Option<PathBuf>>> {
    static RESOLVED: OnceLock<Mutex<Option<Option<PathBuf>>>> = OnceLock::new();
    RESOLVED.get_or_init(|| Mutex::new(None))
}

/// Set (or clear) the explicit ffmpeg path and invalidate the cached lookup so
/// the next thumbnail request re-resolves. Called from the frontend when the
/// "FFmpeg path" setting changes.
fn set_ffmpeg_path_impl(path: Option<String>) {
    *ffmpeg_override().lock().unwrap() = path.filter(|p| !p.trim().is_empty());
    *ffmpeg_resolved().lock().unwrap() = None;
}

fn resolve_ffmpeg_path() -> Option<PathBuf> {
    // 1. Explicit user-configured path wins.
    if let Some(p) = ffmpeg_override().lock().unwrap().clone() {
        let pb = PathBuf::from(&p);
        if ffmpeg_runs(&pb) {
            log::info!(
                "[thumbnails] using configured ffmpeg path: {}",
                pb.display()
            );
            return Some(pb);
        }
        log::warn!("[thumbnails] configured ffmpeg path does not run: {}", p);
    }
    // 2. PATH.
    if ffmpeg_runs(Path::new("ffmpeg")) {
        log::info!("[thumbnails] ffmpeg found on PATH");
        return Some(PathBuf::from("ffmpeg"));
    }
    // 3. Common install locations.
    let candidates = ffmpeg_fallback_candidates();
    for c in &candidates {
        if c.exists() && ffmpeg_runs(c) {
            log::info!("[thumbnails] ffmpeg found at {}", c.display());
            return Some(c.clone());
        }
    }
    log::warn!(
        "[thumbnails] ffmpeg NOT found on PATH or in {} fallback locations — set an explicit FFmpeg path in Settings, or add ffmpeg to PATH and restart. Video/audio thumbnails are unavailable.",
        candidates.len()
    );
    None
}

/// Locate a working `ffmpeg` binary (configured path → PATH → install locations).
/// Result is cached until `set_ffmpeg_path` invalidates it.
fn ffmpeg_path() -> Option<PathBuf> {
    let cell = ffmpeg_resolved();
    let mut guard = cell.lock().unwrap();
    if let Some(ref resolved) = *guard {
        return resolved.clone();
    }
    let resolved = resolve_ffmpeg_path();
    *guard = Some(resolved.clone());
    resolved
}

/// Extract a thumbnail JPEG of `size`x`size` (aspect-preserved, fit inside the
/// box) from a media file via ffmpeg. For video this grabs a frame ~1s in; for
/// audio (`is_audio`) it extracts the embedded cover art (attached picture) and
/// does not seek. Returns the JPEG bytes; errors if ffmpeg is missing or the
/// file has no usable image (e.g. an audio file with no album art).
fn extract_media_thumbnail(source: &Path, size: u32, is_audio: bool) -> Result<Vec<u8>, AppError> {
    use crate::process_ext::NoConsole;
    use std::process::Command;

    let ffmpeg = ffmpeg_path().ok_or_else(|| {
        AppError::Other("ffmpeg not found on PATH; cannot generate media thumbnail".into())
    })?;

    let vf =
        format!("scale='min({size},iw)':'min({size},ih)':force_original_aspect_ratio=decrease");

    log::info!("[spawn-diag] thumbnails: spawning ffmpeg to extract frame from {}", source.display());
    let mut cmd = Command::new(ffmpeg);
    if is_audio {
        // Cover art is an attached-picture video stream; select it explicitly,
        // drop audio, take one frame. No -ss (it's a static image).
        cmd.arg("-i")
            .arg(source)
            .args(["-an", "-map", "0:v:0", "-frames:v", "1"]);
    } else {
        // Seek 1s in to skip black intro frames, then grab one frame.
        cmd.args(["-ss", "1", "-i"])
            .arg(source)
            .args(["-frames:v", "1"]);
    }
    // Capture stderr so failures are diagnosable in the logs (ffmpeg is chatty,
    // but the last line usually says exactly why it failed).
    let output = cmd
        .args(["-vf", &vf, "-f", "image2", "-vcodec", "mjpeg", "-"])
        .no_console()
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| {
            log::warn!(
                "[thumbnails] failed to spawn ffmpeg for {}: {}",
                source.display(),
                e
            );
            AppError::Other(format!("Failed to run ffmpeg: {}", e))
        })?;

    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.lines().last().unwrap_or("").trim();
        log::warn!(
            "[thumbnails] ffmpeg {} extraction failed for {} (exit {:?}, {} stdout bytes): {}",
            if is_audio { "cover-art" } else { "frame" },
            source.display(),
            output.status.code(),
            output.stdout.len(),
            reason
        );
        return Err(AppError::Other(format!(
            "ffmpeg failed to extract {} thumbnail from {}: {}",
            if is_audio { "cover-art" } else { "frame" },
            source.display(),
            reason
        )));
    }

    log::info!(
        "[thumbnails] ffmpeg extracted {} bytes from {}",
        output.stdout.len(),
        source.display()
    );
    Ok(output.stdout)
}

fn get_video_thumbnail_data_sync(
    path: String,
    size: Option<u32>,
    quality: Option<u8>,
) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);
    let quality = quality.unwrap_or(80);

    log::info!("[thumbnails] media thumbnail requested: {}", path);

    if !source_path.exists() {
        log::warn!("[thumbnails] media path does not exist: {}", path);
        return Err(AppError::NotFound(path.clone()));
    }
    let is_audio = is_supported_audio(&source_path);
    if !is_supported_video(&source_path) && !is_audio {
        log::warn!(
            "[thumbnails] unsupported media format (not video/audio): {}",
            path
        );
        return Err(AppError::InvalidPath(format!(
            "Unsupported media format: {}",
            path
        )));
    }

    // Distinct cache namespace so video keys never collide with image keys.
    let cache_key = generate_cache_key(&source_path, size)
        .map(|k| format!("{}_video", k))
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    if let Some(uri) = lru_get(&cache_key) {
        return Ok(uri);
    }

    with_inflight_lock(&cache_key.clone(), || {
        if let Some(uri) = lru_get(&cache_key) {
            return Ok(uri);
        }
        if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
            let data = fs::read(&cached_path)?;
            let uri = to_data_uri(&data);
            lru_put(cache_key.clone(), uri.clone());
            return Ok(uri);
        }

        // ffmpeg already scales the frame; re-encode through the image crate so
        // the output is a clean square-fit JPEG at the requested quality.
        let frame = extract_media_thumbnail(&source_path, size, is_audio)?;
        let img = ImageReader::new(Cursor::new(frame))
            .with_guessed_format()?
            .decode()
            .map_err(|e| {
                log::warn!(
                    "[thumbnails] failed to decode ffmpeg output for {}: {}",
                    source_path.display(),
                    e
                );
                AppError::Other(format!("Failed to decode video frame: {}", e))
            })?;
        let thumbnail = img.thumbnail(size, size).to_rgb8();

        let data = encode_jpeg(&thumbnail, quality)?;
        save_to_cache(&cache_key, &data);

        log::info!(
            "[thumbnails] generated media thumbnail for {} ({} bytes)",
            source_path.display(),
            data.len()
        );
        let uri = to_data_uri(&data);
        lru_put(cache_key.clone(), uri.clone());
        Ok(uri)
    })
}

// ─── Async Tauri commands ───────────────────────────────────────────────────

/// Get or generate thumbnail for an image file.
/// Returns the path to the cached thumbnail.
#[tauri::command]
pub async fn get_thumbnail(path: String, size: Option<u32>) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || get_thumbnail_sync(path, size))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Get thumbnail as base64-encoded data URI.
/// More efficient for small thumbnails as it avoids file I/O.
#[tauri::command]
pub async fn get_thumbnail_data(
    path: String,
    size: Option<u32>,
    quality: Option<u8>,
) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || get_thumbnail_data_sync(path, size, quality))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Get a tiny 16x16 micro thumbnail for progressive loading.
/// Also pre-warms the full thumbnail cache as a side effect.
#[tauri::command]
pub async fn get_micro_thumbnail(
    path: String,
    prewarm_size: Option<u32>,
    prewarm_quality: Option<u8>,
) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        get_micro_thumbnail_sync(path, prewarm_size, prewarm_quality)
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Get a video thumbnail (extracted frame) as a base64 data URI.
/// Requires ffmpeg on PATH; returns an error otherwise so the UI can fall back
/// to the file-type icon.
#[tauri::command]
pub async fn get_video_thumbnail_data(
    path: String,
    size: Option<u32>,
    quality: Option<u8>,
) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || get_video_thumbnail_data_sync(path, size, quality))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Configure an explicit ffmpeg binary path (from Settings). Pass an empty
/// string to clear it and fall back to auto-detection.
#[tauri::command]
pub async fn set_ffmpeg_path(path: String) {
    set_ffmpeg_path_impl(if path.trim().is_empty() {
        None
    } else {
        Some(path)
    });
}

/// Clear the thumbnail cache
#[tauri::command]
pub async fn clear_thumbnail_cache() -> Result<u64, AppError> {
    tokio::task::spawn_blocking(clear_thumbnail_cache_sync)
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn clear_thumbnail_cache_sync() -> Result<u64, AppError> {
    let cache_dir =
        get_cache_dir().ok_or(AppError::Other("Failed to get cache directory".into()))?;

    if !cache_dir.exists() {
        return Ok(0);
    }

    log::info!("Clearing thumbnail cache");
    lru_clear();
    let mut cleared = 0u64;

    for entry in fs::read_dir(&cache_dir).map_err(AppError::Io)?.flatten() {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() && fs::remove_file(entry.path()).is_ok() {
                cleared += metadata.len();
            }
        }
    }

    Ok(cleared)
}

/// Get cache statistics
#[tauri::command]
pub async fn get_thumbnail_cache_stats() -> Result<ThumbnailCacheStats, AppError> {
    tokio::task::spawn_blocking(get_thumbnail_cache_stats_sync)
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn get_thumbnail_cache_stats_sync() -> Result<ThumbnailCacheStats, AppError> {
    let cache_dir =
        get_cache_dir().ok_or(AppError::Other("Failed to get cache directory".into()))?;

    if !cache_dir.exists() {
        return Ok(ThumbnailCacheStats {
            count: 0,
            total_size: 0,
            path: cache_dir.to_string_lossy().to_string(),
        });
    }

    let mut count = 0;
    let mut total_size = 0u64;

    for entry in fs::read_dir(&cache_dir).map_err(AppError::Io)?.flatten() {
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                count += 1;
                total_size += metadata.len();
            }
        }
    }

    Ok(ThumbnailCacheStats {
        count,
        total_size,
        path: cache_dir.to_string_lossy().to_string(),
    })
}

#[derive(Debug, serde::Serialize)]
pub struct ThumbnailCacheStats {
    count: usize,
    #[serde(rename = "totalSize")]
    total_size: u64,
    path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_is_supported_image() {
        assert!(is_supported_image(Path::new("test.jpg")));
        assert!(is_supported_image(Path::new("test.JPEG")));
        assert!(is_supported_image(Path::new("test.png")));
        assert!(is_supported_image(Path::new("test.gif")));
        assert!(is_supported_image(Path::new("test.webp")));
        assert!(is_supported_image(Path::new("test.bmp")));
        assert!(!is_supported_image(Path::new("test.txt")));
        assert!(!is_supported_image(Path::new("test.pdf")));
    }

    #[test]
    #[cfg(feature = "avif")]
    fn avif_is_supported_and_decodes() {
        assert!(is_supported_image(Path::new("photo.avif")));
        assert!(is_supported_image(Path::new("PHOTO.AVIF")));

        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/red32.avif");
        let img = decode_image(&fixture, 64).expect("AVIF fixture must decode");
        assert_eq!((img.width(), img.height()), (32, 32));
        let pixel = img.to_rgb8().get_pixel(16, 16).0;
        assert!(
            pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60,
            "expected red center pixel, got {pixel:?}"
        );
    }

    #[test]
    fn test_is_supported_video() {
        assert!(is_supported_video(Path::new("clip.mp4")));
        assert!(is_supported_video(Path::new("CLIP.MOV")));
        assert!(is_supported_video(Path::new("movie.mkv")));
        assert!(is_supported_video(Path::new("stream.webm")));
        assert!(!is_supported_video(Path::new("photo.jpg")));
        assert!(!is_supported_video(Path::new("notes.txt")));
        // Audio files are NOT videos (they go through the cover-art path).
        assert!(!is_supported_video(Path::new("song.m4a")));
    }

    #[test]
    fn test_is_supported_audio() {
        assert!(is_supported_audio(Path::new("song.m4a")));
        assert!(is_supported_audio(Path::new("TRACK.MP3")));
        assert!(is_supported_audio(Path::new("lossless.flac")));
        assert!(is_supported_audio(Path::new("audiobook.m4b")));
        assert!(!is_supported_audio(Path::new("clip.mp4")));
        assert!(!is_supported_audio(Path::new("photo.jpg")));
    }

    #[test]
    fn test_generate_cache_key() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.jpg");
        File::create(&file_path).unwrap();

        let key = generate_cache_key(&file_path, THUMBNAIL_SIZE);
        assert!(key.is_some());
        assert_eq!(key.unwrap().len(), 64); // SHA256 hex is 64 chars
    }

    #[test]
    fn test_base64_encode() {
        use base64::Engine as _;
        let encode = |data: &[u8]| base64::engine::general_purpose::STANDARD.encode(data);
        assert_eq!(encode(b"Hello"), "SGVsbG8=");
        assert_eq!(encode(b"Hi"), "SGk=");
        assert_eq!(encode(b""), "");
    }

    #[test]
    fn test_png_thumbnail_generation() {
        // Create a real RGBA PNG image using the image crate
        let dir = tempdir().unwrap();
        let png_path = dir.path().join("test_rgba.png");

        let img = image::RgbaImage::from_fn(100, 100, |x, y| {
            if (x + y) % 2 == 0 {
                image::Rgba([255, 0, 0, 255]) // red opaque
            } else {
                image::Rgba([0, 0, 255, 128]) // blue semi-transparent
            }
        });
        img.save(&png_path).unwrap();

        // Test get_thumbnail_data_sync succeeds for PNG
        let result =
            get_thumbnail_data_sync(png_path.to_string_lossy().to_string(), Some(64), None);
        assert!(
            result.is_ok(),
            "PNG thumbnail generation failed: {:?}",
            result.err()
        );
        let data_uri = result.unwrap();
        assert!(
            data_uri.starts_with("data:image/jpeg;base64,"),
            "Expected JPEG data URI, got: {}",
            &data_uri[..50]
        );
    }

    #[test]
    fn test_png_thumbnail_from_actual_file() {
        // Test with an actual PNG file from the project icons
        let icon_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
        if !icon_path.exists() {
            return; // Skip if not available
        }

        let result =
            get_thumbnail_data_sync(icon_path.to_string_lossy().to_string(), Some(64), None);
        assert!(
            result.is_ok(),
            "Real PNG thumbnail failed: {:?}",
            result.err()
        );
    }

    #[test]
    fn test_jpg_thumbnail_generation() {
        // Create a real RGB JPEG image
        let dir = tempdir().unwrap();
        let jpg_path = dir.path().join("test.jpg");

        let img =
            image::RgbImage::from_fn(100, 100, |x, _y| image::Rgb([(x % 256) as u8, 128, 64]));
        img.save(&jpg_path).unwrap();

        let result =
            get_thumbnail_data_sync(jpg_path.to_string_lossy().to_string(), Some(64), None);
        assert!(
            result.is_ok(),
            "JPEG thumbnail generation failed: {:?}",
            result.err()
        );
        let data_uri = result.unwrap();
        assert!(data_uri.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn test_micro_thumbnail_generation() {
        let dir = tempdir().unwrap();
        let img_path = dir.path().join("test_micro.png");

        let img = image::RgbImage::from_fn(200, 200, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        img.save(&img_path).unwrap();

        let result = get_micro_thumbnail_sync(img_path.to_string_lossy().to_string(), None, None);
        assert!(result.is_ok(), "Micro thumbnail failed: {:?}", result.err());

        let data_uri = result.unwrap();
        assert!(data_uri.starts_with("data:image/jpeg;base64,"));

        // Verify that full thumbnail cache was pre-warmed
        let cache_key = generate_cache_key(&img_path, THUMBNAIL_SIZE).unwrap();
        assert!(
            get_cached_thumbnail(&cache_key).is_some(),
            "Full thumbnail cache should be pre-warmed by micro thumbnail"
        );
    }

    #[test]
    fn test_cache_key_changes_with_file_length_same_second() {
        // Two writes within the same second must produce different cache keys
        // (key includes mtime nanos + file length, not just whole seconds).
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.jpg");

        fs::write(&file_path, b"aaaa").unwrap();
        let key1 = generate_cache_key(&file_path, THUMBNAIL_SIZE).unwrap();

        fs::write(&file_path, b"aaaaaaaa").unwrap();
        let key2 = generate_cache_key(&file_path, THUMBNAIL_SIZE).unwrap();

        assert_ne!(key1, key2, "modifying a file must invalidate the cache key");
    }

    #[test]
    fn test_prune_disk_cache_evicts_oldest_first() {
        let dir = tempdir().unwrap();
        let old = dir.path().join("old.jpg");
        let newer = dir.path().join("new.jpg");

        fs::write(&old, vec![0u8; 100]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&newer, vec![0u8; 100]).unwrap();

        // Cap of 150 bytes: must evict the oldest entry only.
        prune_disk_cache(dir.path(), 150);

        assert!(!old.exists(), "oldest entry should be evicted");
        assert!(newer.exists(), "newest entry should survive");
    }

    #[test]
    fn test_quality_affects_jpeg_output_size() {
        // Higher JPEG quality should produce larger files
        let img = image::RgbImage::from_fn(200, 200, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });

        let low = encode_jpeg(&img, 50).unwrap();
        let mid = encode_jpeg(&img, 80).unwrap();
        let high = encode_jpeg(&img, 90).unwrap();

        assert!(
            low.len() < mid.len(),
            "quality 50 ({} bytes) should be smaller than quality 80 ({} bytes)",
            low.len(),
            mid.len()
        );
        assert!(
            mid.len() < high.len(),
            "quality 80 ({} bytes) should be smaller than quality 90 ({} bytes)",
            mid.len(),
            high.len()
        );
    }

    #[test]
    fn test_quality_param_reaches_encoder() {
        // Generate same image at different qualities via get_thumbnail_data_sync
        // and verify the data URIs differ (different quality = different bytes)
        let dir = tempdir().unwrap();
        let img_path = dir.path().join("quality_test.jpg");

        let img = image::RgbImage::from_fn(200, 200, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        img.save(&img_path).unwrap();

        let path_str = img_path.to_string_lossy().to_string();

        // Request at quality 50 with size 64
        let result_q50 = get_thumbnail_data_sync(path_str.clone(), Some(64), Some(50)).unwrap();
        // Clear both caches so next request generates fresh
        if let Some(cache_dir) = get_cache_dir() {
            let _ = std::fs::remove_dir_all(&cache_dir);
        }
        lru_clear();
        let result_q90 = get_thumbnail_data_sync(path_str, Some(64), Some(90)).unwrap();

        // Different quality should produce different data URIs
        assert_ne!(
            result_q50, result_q90,
            "quality 50 and quality 90 should produce different thumbnails"
        );
        // Higher quality = longer base64 string (larger file)
        assert!(
            result_q50.len() < result_q90.len(),
            "quality 90 ({} chars) should be larger than quality 50 ({} chars)",
            result_q90.len(),
            result_q50.len()
        );
    }
}
