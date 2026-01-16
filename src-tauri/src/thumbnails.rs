//! Thumbnail generation module for Tauri commands.
//! Issue: tauri-explorer-im3m, tauri-explorer-i0yt
//!
//! Provides fast, cached thumbnail generation for image files.

use image::{ImageReader, ImageFormat};
use sha2::{Sha256, Digest};
use std::fs;
use std::path::{Path, PathBuf};
use std::io::Cursor;

/// Default thumbnail size (width and height in pixels)
const THUMBNAIL_SIZE: u32 = 128;

/// Supported image extensions for thumbnail generation
const SUPPORTED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

/// Get the cache directory for thumbnails
fn get_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|p| p.join("tauri-explorer").join("thumbnails"))
}

/// Generate a cache key (hash) for a file path + modification time
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

/// Generate thumbnail and save to cache
fn generate_and_cache_thumbnail(
    source_path: &Path,
    cache_key: &str,
    size: u32,
) -> Result<PathBuf, String> {
    let cache_dir = get_cache_dir().ok_or("Failed to get cache directory")?;

    // Create cache directory if it doesn't exist
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create cache directory: {}", e))?;

    // Load and decode image
    let img = ImageReader::open(source_path)
        .map_err(|e| format!("Failed to open image: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Generate thumbnail using fast Lanczos3 sampling
    let thumbnail = img.thumbnail(size, size);

    // Save to cache as JPEG for smaller size and fast loading
    let cache_path = cache_dir.join(format!("{}.jpg", cache_key));
    thumbnail
        .save_with_format(&cache_path, ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

    Ok(cache_path)
}

/// Get or generate thumbnail for an image file.
/// Returns the path to the cached thumbnail.
#[tauri::command]
pub fn get_thumbnail(path: String, size: Option<u32>) -> Result<String, String> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);

    if !source_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !is_supported_image(&source_path) {
        return Err(format!("Unsupported image format: {}", path));
    }

    // Generate cache key
    let cache_key = generate_cache_key(&source_path)
        .ok_or_else(|| format!("Failed to generate cache key for: {}", path))?;

    // Check if thumbnail is already cached
    if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
        return Ok(cached_path.to_string_lossy().to_string());
    }

    // Generate and cache thumbnail
    let thumb_path = generate_and_cache_thumbnail(&source_path, &cache_key, size)?;
    Ok(thumb_path.to_string_lossy().to_string())
}

/// Get thumbnail as base64-encoded data URI.
/// More efficient for small thumbnails as it avoids file I/O.
#[tauri::command]
pub fn get_thumbnail_data(path: String, size: Option<u32>) -> Result<String, String> {
    let source_path = PathBuf::from(&path);
    let size = size.unwrap_or(THUMBNAIL_SIZE);

    if !source_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !is_supported_image(&source_path) {
        return Err(format!("Unsupported image format: {}", path));
    }

    // Generate cache key
    let cache_key = generate_cache_key(&source_path)
        .ok_or_else(|| format!("Failed to generate cache key for: {}", path))?;

    // Check if thumbnail is already cached
    if let Some(cached_path) = get_cached_thumbnail(&cache_key) {
        let data = fs::read(&cached_path)
            .map_err(|e| format!("Failed to read cached thumbnail: {}", e))?;
        return Ok(format!("data:image/jpeg;base64,{}", base64_encode(&data)));
    }

    // Load and decode image
    let img = ImageReader::open(&source_path)
        .map_err(|e| format!("Failed to open image: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Generate thumbnail
    let thumbnail = img.thumbnail(size, size);

    // Encode to JPEG in memory
    let mut buffer = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut buffer, ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;

    let data = buffer.into_inner();

    // Also save to cache for future use
    let cache_dir = get_cache_dir();
    if let Some(cache_dir) = cache_dir {
        let _ = fs::create_dir_all(&cache_dir);
        let cache_path = cache_dir.join(format!("{}.jpg", cache_key));
        let _ = fs::write(&cache_path, &data);
    }

    Ok(format!("data:image/jpeg;base64,{}", base64_encode(&data)))
}

/// Simple base64 encoding
fn base64_encode(data: &[u8]) -> String {
    use std::fmt::Write;
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut result = String::new();
    let chunks = data.chunks(3);

    for chunk in chunks {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;

        let _ = result.write_char(ALPHABET[b0 >> 2] as char);
        let _ = result.write_char(ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] as char);

        if chunk.len() > 1 {
            let _ = result.write_char(ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
        } else {
            let _ = result.write_char('=');
        }

        if chunk.len() > 2 {
            let _ = result.write_char(ALPHABET[b2 & 0x3f] as char);
        } else {
            let _ = result.write_char('=');
        }
    }

    result
}

/// Clear the thumbnail cache
#[tauri::command]
pub fn clear_thumbnail_cache() -> Result<u64, String> {
    let cache_dir = get_cache_dir().ok_or("Failed to get cache directory")?;

    if !cache_dir.exists() {
        return Ok(0);
    }

    let mut cleared = 0u64;

    for entry in fs::read_dir(&cache_dir).map_err(|e| e.to_string())? {
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
pub fn get_thumbnail_cache_stats() -> Result<ThumbnailCacheStats, String> {
    let cache_dir = get_cache_dir().ok_or("Failed to get cache directory")?;

    if !cache_dir.exists() {
        return Ok(ThumbnailCacheStats {
            count: 0,
            total_size: 0,
            path: cache_dir.to_string_lossy().to_string(),
        });
    }

    let mut count = 0;
    let mut total_size = 0u64;

    for entry in fs::read_dir(&cache_dir).map_err(|e| e.to_string())? {
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
    use std::io::Write;
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
        assert_eq!(base64_encode(b"Hello"), "SGVsbG8=");
        assert_eq!(base64_encode(b"Hi"), "SGk=");
        assert_eq!(base64_encode(b""), "");
    }
}
