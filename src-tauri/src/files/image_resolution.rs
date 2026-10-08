//! Lazy intrinsic image metadata, independent of thumbnail decoding.
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct ImageResolution {
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub async fn get_image_resolution(_path: String) -> Option<ImageResolution> {
    None
}
