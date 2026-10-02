//! Full-resolution crop encoding. No filesystem writes or renderer state.
//! Save ownership, captured source validation and publication live in files.
use crate::error::AppError;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Write};

mod gif_crop;
mod icon_crop;
mod png_crop;
mod webp_crop;

pub(crate) const MAX_BYTES: usize = 200 * 1024 * 1024;
pub(super) const MAX_FRAMES: usize = 1024;

/// Encoders cannot grow an output beyond the same bounded file-size contract.
/// This is a per-buffer bound, not a claim about total process memory use.
#[derive(Default)]
pub(super) struct Encoded(Vec<u8>);
impl Encoded {
    fn into_bytes(self) -> Vec<u8> {
        self.0
    }
    fn bytes_mut(&mut self) -> &mut [u8] {
        &mut self.0
    }
}
impl Write for Encoded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_BYTES {
            return Err(std::io::Error::other(
                "Encoded crop exceeds the output size limit",
            ));
        }
        self.0
            .try_reserve(bytes.len())
            .map_err(std::io::Error::other)?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CropRect {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl CropRect {
    pub(crate) fn validate(self, width: u32, height: u32) -> Result<Self, AppError> {
        if self.left >= self.right
            || self.top >= self.bottom
            || self.right > width
            || self.bottom > height
        {
            return Err(failure("Choose a nonempty crop inside the image"));
        }
        Ok(self)
    }
    pub fn width(self) -> u32 {
        self.right - self.left
    }
    pub fn height(self) -> u32 {
        self.bottom - self.top
    }
    fn image(self, image: &DynamicImage) -> Result<DynamicImage, AppError> {
        self.validate(image.width(), image.height())?;
        Ok(image.crop_imm(self.left, self.top, self.width(), self.height()))
    }
}

pub(super) fn failure(message: impl std::fmt::Display) -> AppError {
    AppError::Other(format!("Cannot crop image: {message}"))
}

pub(super) fn dimensions(width: u32, height: u32) -> Result<(), AppError> {
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u64::from(width) * u64::from(height) * 8 > 256 * 1024 * 1024
    {
        return Err(failure("Image dimensions exceed the crop decode limit"));
    }
    Ok(())
}

fn decoder(bytes: &[u8], format: ImageFormat) -> Result<impl ImageDecoder + '_, AppError> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(crate::thumbnails::decode_limits());
    reader.into_decoder().map_err(failure)
}

/// Normalize EXIF orientation before interpreting the renderer's pixel edges.
/// Re-encoding does not retain the old orientation tag, which would rotate twice.
fn still(bytes: &[u8], format: ImageFormat, crop: CropRect) -> Result<Vec<u8>, AppError> {
    let mut decoder = decoder(bytes, format)?;
    let orientation = decoder.orientation().map_err(failure)?;
    let profile = decoder.icc_profile().map_err(failure)?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(failure)?;
    image.apply_orientation(orientation);
    let image = crop.image(&image)?;
    let mut output = Encoded::default();
    match format {
        ImageFormat::Jpeg => {
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 95);
            if let Some(profile) = profile {
                encoder.set_icc_profile(profile).map_err(failure)?;
            }
            encoder.encode_image(&image).map_err(failure)?;
        }
        ImageFormat::Png => {
            let mut info = png_crop::metadata(bytes)?;
            let color_metadata = png_crop::ColorMetadata::from(&info);
            info.source_gamma = info.gamma();
            info.source_chromaticities = info.chromaticities();
            info.width = image.width();
            info.height = image.height();
            let (color, depth) = match image.color() {
                image::ColorType::L8 => (png::ColorType::Grayscale, png::BitDepth::Eight),
                image::ColorType::La8 => (png::ColorType::GrayscaleAlpha, png::BitDepth::Eight),
                image::ColorType::Rgb8 => (png::ColorType::Rgb, png::BitDepth::Eight),
                image::ColorType::Rgba8 => (png::ColorType::Rgba, png::BitDepth::Eight),
                image::ColorType::L16 => (png::ColorType::Grayscale, png::BitDepth::Sixteen),
                image::ColorType::La16 => (png::ColorType::GrayscaleAlpha, png::BitDepth::Sixteen),
                image::ColorType::Rgb16 => (png::ColorType::Rgb, png::BitDepth::Sixteen),
                image::ColorType::Rgba16 => (png::ColorType::Rgba, png::BitDepth::Sixteen),
                _ => return Err(failure("Unsupported PNG sample type")),
            };
            info.color_type = color;
            info.bit_depth = depth;
            info.palette = None;
            info.trns = None;
            info.sbit = None;
            info.exif_metadata = None; // Pixel orientation was normalized above.
            info.interlaced = false; // DynamicImage contains ordinary scanlines.
            info.animation_control = None;
            info.frame_control = None;
            let mut writer = png::Encoder::with_info(&mut output, info)
                .map_err(failure)?
                .write_header()
                .map_err(failure)?;
            png_crop::color_chunks(&color_metadata, &mut writer)?;
            let mut stream = writer.stream_writer().map_err(failure)?;
            if depth == png::BitDepth::Sixteen {
                let row_bytes = image.width() as usize * color.samples() * 2;
                for row in image.as_bytes().chunks_exact(row_bytes) {
                    let big_endian: Vec<_> = row
                        .chunks_exact(2)
                        .flat_map(|sample| u16::from_ne_bytes([sample[0], sample[1]]).to_be_bytes())
                        .collect();
                    stream.write_all(&big_endian)?;
                }
            } else {
                stream.write_all(image.as_bytes())?;
            }
            stream.finish().map_err(failure)?;
            writer.finish().map_err(failure)?;
        }
        ImageFormat::WebP => {
            let image = image.to_rgba8();
            let mut encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut output);
            if let Some(profile) = profile {
                encoder.set_icc_profile(profile).map_err(failure)?;
            }
            encoder
                .write_image(
                    image.as_raw(),
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(failure)?;
        }
        ImageFormat::Bmp => {
            let mut encoder = image::codecs::bmp::BmpEncoder::new(&mut output);
            encoder
                .encode(
                    image.as_bytes(),
                    image.width(),
                    image.height(),
                    image.color().into(),
                )
                .map_err(failure)?;
        }
        _ => return Err(failure("This image codec has no crop encoder")),
    }
    Ok(output.into_bytes())
}

pub(crate) fn encode(bytes: &[u8], crop: CropRect) -> Result<Vec<u8>, AppError> {
    if bytes.len() > MAX_BYTES {
        return Err(failure("Image file exceeds the crop size limit"));
    }
    if bytes.starts_with(b"icns") {
        return icon_crop::encode(bytes, crop);
    }
    let format = image::guess_format(bytes).map_err(failure)?;
    match format {
        ImageFormat::Gif => gif_crop::encode(bytes, crop),
        ImageFormat::WebP => {
            let decoder =
                image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(failure)?;
            if decoder.has_animation() {
                webp_crop::encode(decoder, crop)
            } else {
                still(bytes, format, crop)
            }
        }
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::with_limits(
                Cursor::new(bytes),
                crate::thumbnails::decode_limits(),
            )
            .map_err(failure)?;
            if decoder.is_apng().map_err(failure)? {
                return png_crop::encode(bytes, crop);
            }
            still(bytes, format, crop)
        }
        _ => still(bytes, format, crop),
    }
}

#[cfg(test)]
#[path = "../test_support/image_crop.rs"]
mod tests;
