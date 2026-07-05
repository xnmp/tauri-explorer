//! Dominant-color extraction for theme generation (#203).
//!
//! Median-cut quantization over a downscaled copy of the image: repeatedly
//! split the color box with the widest channel range at its median until
//! `count` boxes remain, then average each box. Deterministic, no deps
//! beyond the `image` crate already used by thumbnails.

use crate::error::AppError;
use image::imageops::FilterType;

/// Longest edge of the working copy — palette quality plateaus well below
/// this; keeps extraction O(few ms) for arbitrarily large wallpapers.
const SAMPLE_EDGE: u32 = 64;

fn widest_channel(pixels: &[[u8; 3]]) -> (usize, u8) {
    let mut min = [255u8; 3];
    let mut max = [0u8; 3];
    for p in pixels {
        for c in 0..3 {
            min[c] = min[c].min(p[c]);
            max[c] = max[c].max(p[c]);
        }
    }
    let ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let channel = (0..3).max_by_key(|&c| ranges[c]).unwrap_or(0);
    (channel, ranges[channel])
}

fn average(pixels: &[[u8; 3]]) -> [u8; 3] {
    let n = pixels.len().max(1) as u64;
    let mut sum = [0u64; 3];
    for p in pixels {
        for c in 0..3 {
            sum[c] += p[c] as u64;
        }
    }
    [(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8]
}

/// Median-cut quantization: returns up to `count` representative colors,
/// ordered by the population of the box they came from (dominant first).
pub fn median_cut(pixels: Vec<[u8; 3]>, count: usize) -> Vec<[u8; 3]> {
    if pixels.is_empty() || count == 0 {
        return Vec::new();
    }
    let mut boxes: Vec<Vec<[u8; 3]>> = vec![pixels];
    while boxes.len() < count {
        // Split the box with the widest channel range; stop when nothing
        // splittable remains (uniform boxes / fewer distinct colors).
        let candidate = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .max_by_key(|(_, b)| widest_channel(b).1);
        let Some((idx, _)) = candidate else { break };
        let mut b = boxes.swap_remove(idx);
        let (channel, range) = widest_channel(&b);
        if range == 0 {
            boxes.push(b);
            break;
        }
        b.sort_unstable_by_key(|p| p[channel]);
        let right = b.split_off(b.len() / 2);
        boxes.push(b);
        boxes.push(right);
    }
    boxes.sort_by_key(|b| std::cmp::Reverse(b.len()));
    boxes.iter().map(|b| average(b)).collect()
}

fn to_hex(c: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// Extract the `count` dominant colors of the image at `path` as hex strings,
/// dominant first.
#[tauri::command]
pub async fn extract_palette(path: String, count: u8) -> Result<Vec<String>, AppError> {
    let count = count.clamp(2, 12) as usize;
    tokio::task::spawn_blocking(move || {
        crate::thumbnails::check_image_file_size(std::path::Path::new(&path))?;
        let mut reader = image::ImageReader::open(&path)
            .map_err(|e| AppError::Other(format!("Failed to open image: {e}")))?
            .with_guessed_format()
            .map_err(|e| AppError::Other(format!("Failed to sniff image format: {e}")))?;
        reader.limits(crate::thumbnails::decode_limits());
        let img = reader
            .decode()
            .map_err(|e| AppError::Other(format!("Failed to decode image: {e}")))?;
        let small = img.resize(SAMPLE_EDGE, SAMPLE_EDGE, FilterType::Triangle);
        let rgb = small.to_rgb8();
        let pixels: Vec<[u8; 3]> = rgb.pixels().map(|p| [p[0], p[1], p[2]]).collect();
        Ok(median_cut(pixels, count).into_iter().map(to_hex).collect())
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_color_image_yields_both_colors() {
        // Half red, half blue.
        let mut pixels = vec![[200u8, 20, 20]; 500];
        pixels.extend(vec![[20u8, 20, 200]; 500]);
        let colors = median_cut(pixels, 2);
        assert_eq!(colors.len(), 2);
        let has_reddish = colors.iter().any(|c| c[0] > 150 && c[2] < 80);
        let has_bluish = colors.iter().any(|c| c[2] > 150 && c[0] < 80);
        assert!(has_reddish && has_bluish, "got {colors:?}");
    }

    #[test]
    fn dominant_color_comes_first() {
        let mut pixels = vec![[10u8, 10, 10]; 900]; // dominant near-black
        pixels.extend(vec![[240u8, 240, 240]; 100]);
        let colors = median_cut(pixels, 2);
        assert!(
            colors[0][0] < 100,
            "dominant should be the dark box: {colors:?}"
        );
    }

    #[test]
    fn uniform_image_degrades_gracefully() {
        let colors = median_cut(vec![[42u8, 42, 42]; 100], 6);
        assert!(!colors.is_empty() && colors.len() <= 6);
        assert_eq!(colors[0], [42, 42, 42]);
    }

    #[test]
    fn empty_input_yields_empty() {
        assert!(median_cut(Vec::new(), 4).is_empty());
    }

    #[test]
    fn extract_palette_reads_a_real_png() {
        // 2x1 png: one red pixel, one blue pixel.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tiny.png");
        let mut img = image::RgbImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgb([255, 0, 0]));
        img.put_pixel(1, 0, image::Rgb([0, 0, 255]));
        img.save(&path).unwrap();

        let colors = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(extract_palette(path.to_string_lossy().into_owned(), 2))
            .unwrap();
        assert_eq!(colors.len(), 2);
        for c in &colors {
            assert!(c.starts_with('#') && c.len() == 7, "bad hex: {c}");
        }
    }
}
