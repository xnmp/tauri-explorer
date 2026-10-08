//! Lazy intrinsic image metadata, independent of thumbnail decoding.
use serde::Serialize;
use std::{
    fs::File,
    io::{Cursor, Read},
    sync::{Arc, LazyLock},
};
use tokio::sync::Semaphore;

#[derive(Debug, Serialize, PartialEq)]
pub struct ImageResolution {
    pub width: u32,
    pub height: u32,
}

// Bound metadata IO across all windows, and bound malformed/huge header input.
static READ_SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
const MAX_HEADER_BYTES: u64 = 1024 * 1024;

#[tauri::command]
pub async fn get_image_resolution(path: String) -> Option<ImageResolution> {
    let permit = Arc::clone(&READ_SLOTS).acquire_owned().await.ok()?;
    tauri::async_runtime::spawn_blocking(move || {
        // The worker owns admission even if its async caller disappears.
        let _permit = permit;
        let metadata = std::fs::metadata(&path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        File::open(&path)
            .ok()?
            .take(MAX_HEADER_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        let reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .ok()?;
        if !matches!(
            reader.format(),
            Some(
                image::ImageFormat::Png
                    | image::ImageFormat::Jpeg
                    | image::ImageFormat::Gif
                    | image::ImageFormat::WebP
                    | image::ImageFormat::Bmp
            )
        ) {
            return None;
        }
        let (width, height) = reader.into_dimensions().ok()?;
        (width > 0 && height > 0).then_some(ImageResolution { width, height })
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
#[path = "../../test_support/image_resolution.rs"]
mod tests;
