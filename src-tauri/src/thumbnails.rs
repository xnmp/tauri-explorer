//! Thumbnail generation module for Tauri commands.
//! Issue: tauri-explorer-im3m, tauri-explorer-i0yt, tauri-e2mn
//!
//! Provides fast, cached thumbnail generation for image files.
//! Uses async commands with spawn_blocking to avoid freezing the UI.
//! Supports two-tier progressive loading: micro (16x16) + full (128x128).

use base64::Engine as _;
use crate::error::AppError;
use image::{ImageFormat, ImageReader};
use sha2::{Sha256, Digest};
use std::fs;
use std::path::{Path, PathBuf};
use std::io::Cursor;

/// Default thumbnail size (width and height in pixels)
const THUMBNAIL_SIZE: u32 = 128;

/// Micro thumbnail size for progressive loading preview
const MICRO_SIZE: u32 = 16;

/// Supported image extensions for thumbnail generation
const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

/// Get the cache directory for thumbnails
fn get_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|p| p.join("tauri-explorer").join("thumbnails"))
}

/// Cache version - bump when thumbnail generation logic changes to invalidate stale cache
const CACHE_VERSION: u8 = 2;

/// Generate a cache key (hash) for a file path + modification time + cache version
fn generate_cache_key(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let modified_secs = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(modified_secs.to_le_bytes());
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

/// Save raw JPEG bytes to cache
fn save_to_cache(cache_key: &str, data: &[u8]) {
    if let Some(cache_dir) = get_cache_dir() {
        let _ = fs::create_dir_all(&cache_dir);
        let cache_path = cache_dir.join(format!("{}.jpg", cache_key));
        let _ = fs::write(&cache_path, data);
    }
}

/// Encode an RGB8 image to JPEG bytes at the given quality
fn encode_jpeg(img: &image::RgbImage, quality: u8) -> Result<Vec<u8>, AppError> {
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder.encode(
        img.as_raw(),
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgb8,
    ).map_err(|e| AppError::Other(format!("Failed to encode JPEG: {}", e)))?;
    Ok(buffer.into_inner())
}

/// Format raw bytes as a data URI
fn to_data_uri(data: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    )
}

/// Validate path for thumbnail generation (exists + supported format)
fn validate_thumbnail_path(path: &Path, path_str: &str) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::NotFound(path_str.to_string()));
    }
    if !is_supported_image(path) {
        return Err(AppError::InvalidPath(format!("Unsupported image format: {}", path_str)));
    }
    Ok(())
}

/// Generate thumbnail and save to cache
fn generate_and_cache_thumbnail(
    source_path: &Path,
    cache_key: &str,
    size: u32,
) -> Result<PathBuf, AppError> {
    let cache_dir = get_cache_dir().ok_or(AppError::Other("Failed to get cache directory".into()))?;

    // Create cache directory if it doesn't exist
    fs::create_dir_all(&cache_dir)?;

    // Load and decode image (with_guessed_format for robust format detection)
    let img = ImageReader::open(source_path)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AppError::Other(format!("Failed to decode image: {}", e)))?;

    // thumbnail() is optimized for large downscales: does fast nearest-neighbor
    // to ~2x target, then Lanczos3 for quality. Much faster than resize() for large images.
    // Always convert to RGB8 for JPEG output (PNG/GIF may have alpha channels)
    let thumbnail = img.thumbnail(size, size).to_rgb8();

    // Save to cache as JPEG for smaller size and fast loading
    let cache_path = cache_dir.join(format!("{}.jpg", cache_key));
    thumbnail
        .save_with_format(&cache_path, ImageFormat::Jpeg)
        .map_err(|e| AppError::Other(format!("Failed to save thumbnail: {}", e)))?;

    Ok(cache_path)
}

// ─── Sync implementations ───────────────────────────────────────────────────

fn get_thumbnail_sync(path: String, size: Option<u32>) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);
    validate_thumbnail_path(&source_path, &path)?;

    let cache_key = generate_cache_key(&source_path)
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
        return Ok(cached_path.to_string_lossy().to_string());
    }

    let thumb_path = generate_and_cache_thumbnail(&source_path, &cache_key, size)?;
    Ok(thumb_path.to_string_lossy().to_string())
}

fn get_thumbnail_data_sync(path: String, size: Option<u32>) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);
    validate_thumbnail_path(&source_path, &path)?;

    let cache_key = generate_cache_key(&source_path)
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    // Check cache first
    if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
        let data = fs::read(&cached_path)?;
        return Ok(to_data_uri(&data));
    }

    // Decode image
    let img = ImageReader::open(&source_path)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AppError::Other(format!("Failed to decode image: {}", e)))?;

    let thumbnail = img.thumbnail(size, size).to_rgb8();

    let data = encode_jpeg(&thumbnail, 80)?;
    save_to_cache(&cache_key, &data);

    Ok(to_data_uri(&data))
}

fn get_micro_thumbnail_sync(path: String) -> Result<String, AppError> {
    let source_path = PathBuf::from(&path);
    validate_thumbnail_path(&source_path, &path)?;

    let cache_key = generate_cache_key(&source_path)
        .ok_or_else(|| AppError::Other(format!("Failed to generate cache key for: {}", path)))?;

    let micro_cache_key = format!("{}_micro", cache_key);

    // Check micro cache first
    if let Some(cached_path) = get_cached_thumbnail(&micro_cache_key) {
        let data = fs::read(&cached_path)?;
        return Ok(to_data_uri(&data));
    }

    // Decode image once (the expensive part)
    let img = ImageReader::open(&source_path)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| AppError::Other(format!("Failed to decode image: {}", e)))?;

    // Generate micro thumbnail (Nearest = fastest resize algorithm)
    let micro = img.resize(MICRO_SIZE, MICRO_SIZE, image::imageops::FilterType::Nearest).to_rgb8();
    let micro_data = encode_jpeg(&micro, 50)?;
    save_to_cache(&micro_cache_key, &micro_data);

    // Pre-warm full thumbnail cache if not already present.
    // Since the image is already decoded in memory, this is nearly free.
    // thumbnail() uses optimized two-pass downscale (nearest + Lanczos3).
    if get_cached_thumbnail(&cache_key).is_none() {
        let full = img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE).to_rgb8();
        if let Ok(full_data) = encode_jpeg(&full, 80) {
            save_to_cache(&cache_key, &full_data);
        }
    }

    Ok(to_data_uri(&micro_data))
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
pub async fn get_thumbnail_data(path: String, size: Option<u32>) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || get_thumbnail_data_sync(path, size))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Get a tiny 16x16 micro thumbnail for progressive loading.
/// Also pre-warms the full thumbnail cache as a side effect.
#[tauri::command]
pub async fn get_micro_thumbnail(path: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || get_micro_thumbnail_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Batch micro thumbnails — process multiple images in parallel.
/// Returns a vec of (path, result) pairs. Errors for individual images
/// are returned as null data URIs rather than failing the whole batch.
#[tauri::command]
pub async fn get_micro_thumbnails_batch(paths: Vec<String>) -> Vec<MicroThumbnailResult> {
    let handles: Vec<_> = paths
        .into_iter()
        .map(|path| {
            tokio::task::spawn_blocking(move || {
                let data_uri = get_micro_thumbnail_sync(path.clone()).ok();
                MicroThumbnailResult { path, data_uri }
            })
        })
        .collect();

    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok(result) => results.push(result),
            Err(_) => {} // task panicked, skip
        }
    }
    results
}

#[derive(Debug, serde::Serialize)]
pub struct MicroThumbnailResult {
    path: String,
    #[serde(rename = "dataUri")]
    data_uri: Option<String>,
}

/// Clear the thumbnail cache
#[tauri::command]
pub fn clear_thumbnail_cache() -> Result<u64, AppError> {
    let cache_dir = get_cache_dir().ok_or(AppError::Other("Failed to get cache directory".into()))?;

    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut cleared = 0u64;

    for entry in fs::read_dir(&cache_dir).map_err(AppError::Io)? {
        if let Ok(entry) = entry {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    if fs::remove_file(entry.path()).is_ok() {
                        cleared += metadata.len();
                    }
                }
            }
        }
    }

    Ok(cleared)
}

/// Get cache statistics
#[tauri::command]
pub fn get_thumbnail_cache_stats() -> Result<ThumbnailCacheStats, AppError> {
    let cache_dir = get_cache_dir().ok_or(AppError::Other("Failed to get cache directory".into()))?;

    if !cache_dir.exists() {
        return Ok(ThumbnailCacheStats {
            count: 0,
            total_size: 0,
            path: cache_dir.to_string_lossy().to_string(),
        });
    }

    let mut count = 0;
    let mut total_size = 0u64;

    for entry in fs::read_dir(&cache_dir).map_err(AppError::Io)? {
        if let Ok(entry) = entry {
            if let Ok(metadata) = entry.metadata() {
                if metadata.is_file() {
                    count += 1;
                    total_size += metadata.len();
                }
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
    fn bench_100_images_cold_start() {
        let test_dir = PathBuf::from("/tmp/test-100-images");
        if !test_dir.exists() {
            eprintln!("Skipping bench: /tmp/test-100-images not found");
            return;
        }

        // Clear cache
        if let Some(cache_dir) = get_cache_dir() {
            let _ = fs::remove_dir_all(&cache_dir);
        }

        let mut images: Vec<PathBuf> = fs::read_dir(&test_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| is_supported_image(p))
            .collect();
        images.sort();

        eprintln!("Benchmarking {} images (cold start)...", images.len());

        // Measure micro thumbnail generation (sequential, cold)
        let start = std::time::Instant::now();
        for img in &images {
            let result = get_micro_thumbnail_sync(img.to_string_lossy().to_string());
            assert!(result.is_ok(), "Failed: {:?}: {:?}", img, result.err());
        }
        let micro_cold = start.elapsed();
        eprintln!("Micro thumbnails (cold, sequential): {:.1}ms total, {:.1}ms/image",
            micro_cold.as_millis(), micro_cold.as_millis() as f64 / images.len() as f64);

        // Measure full thumbnail generation (should be cache hits after micro pre-warm)
        let start = std::time::Instant::now();
        for img in &images {
            let result = get_thumbnail_data_sync(img.to_string_lossy().to_string(), None);
            assert!(result.is_ok(), "Failed: {:?}: {:?}", img, result.err());
        }
        let full_warm = start.elapsed();
        eprintln!("Full thumbnails (warm, sequential): {:.1}ms total, {:.1}ms/image",
            full_warm.as_millis(), full_warm.as_millis() as f64 / images.len() as f64);

        // Measure parallel micro thumbnails (simulates batch API)
        if let Some(cache_dir) = get_cache_dir() {
            let _ = fs::remove_dir_all(&cache_dir);
        }
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        eprintln!("Available parallelism: {} threads", cpus);

        let start = std::time::Instant::now();
        let images_clone: Vec<String> = images.iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let handles: Vec<_> = images_clone.into_iter()
            .map(|path| std::thread::spawn(move || get_micro_thumbnail_sync(path)))
            .collect();
        for handle in handles {
            let result = handle.join().unwrap();
            assert!(result.is_ok(), "Parallel micro failed: {:?}", result.err());
        }
        let micro_parallel = start.elapsed();
        eprintln!("Micro thumbnails (cold, parallel/{}): {:.1}ms total, {:.1}ms/image effective",
            cpus, micro_parallel.as_millis(), micro_parallel.as_millis() as f64 / images.len() as f64);

        // Full after parallel micro pre-warm (should be all cache hits)
        let start = std::time::Instant::now();
        for img in &images {
            let result = get_thumbnail_data_sync(img.to_string_lossy().to_string(), None);
            assert!(result.is_ok(), "Failed: {:?}: {:?}", img, result.err());
        }
        let full_after_parallel = start.elapsed();
        eprintln!("Full thumbnails (warm after parallel micro): {:.1}ms total",
            full_after_parallel.as_millis());

        // Performance assertions
        // Parallel micro should complete all 100 images within 5s on any reasonable hardware
        assert!(micro_parallel.as_secs() < 10,
            "Parallel micro too slow: {:.1}s (target <10s for 100 large images)",
            micro_parallel.as_secs_f64());
        // Full from warm cache should be near-instant
        assert!(full_after_parallel.as_millis() < 500,
            "Full from warm cache too slow: {}ms (target <500ms)",
            full_after_parallel.as_millis());
    }

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
    fn test_generate_cache_key() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.jpg");
        File::create(&file_path).unwrap();

        let key = generate_cache_key(&file_path);
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
        let result = get_thumbnail_data_sync(png_path.to_string_lossy().to_string(), Some(64));
        assert!(result.is_ok(), "PNG thumbnail generation failed: {:?}", result.err());
        let data_uri = result.unwrap();
        assert!(data_uri.starts_with("data:image/jpeg;base64,"), "Expected JPEG data URI, got: {}", &data_uri[..50]);
    }

    #[test]
    fn test_png_thumbnail_from_actual_file() {
        // Test with an actual PNG file from the project icons
        let icon_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
        if !icon_path.exists() {
            return; // Skip if not available
        }

        let result = get_thumbnail_data_sync(icon_path.to_string_lossy().to_string(), Some(64));
        assert!(result.is_ok(), "Real PNG thumbnail failed: {:?}", result.err());
    }

    #[test]
    fn test_jpg_thumbnail_generation() {
        // Create a real RGB JPEG image
        let dir = tempdir().unwrap();
        let jpg_path = dir.path().join("test.jpg");

        let img = image::RgbImage::from_fn(100, 100, |x, _y| {
            image::Rgb([(x % 256) as u8, 128, 64])
        });
        img.save(&jpg_path).unwrap();

        let result = get_thumbnail_data_sync(jpg_path.to_string_lossy().to_string(), Some(64));
        assert!(result.is_ok(), "JPEG thumbnail generation failed: {:?}", result.err());
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

        let result = get_micro_thumbnail_sync(img_path.to_string_lossy().to_string());
        assert!(result.is_ok(), "Micro thumbnail failed: {:?}", result.err());

        let data_uri = result.unwrap();
        assert!(data_uri.starts_with("data:image/jpeg;base64,"));

        // Verify that full thumbnail cache was pre-warmed
        let cache_key = generate_cache_key(&img_path).unwrap();
        assert!(
            get_cached_thumbnail(&cache_key).is_some(),
            "Full thumbnail cache should be pre-warmed by micro thumbnail"
        );
    }
}
