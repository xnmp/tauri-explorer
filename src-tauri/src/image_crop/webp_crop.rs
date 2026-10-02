//! Lossless cropped composited frames in a standard animated WebP container.
//! https://developers.google.com/speed/webp/docs/riff_container
use super::{dimensions, failure, CropRect, MAX_BYTES, MAX_FRAMES};
use crate::error::AppError;
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageEncoder};
use std::io::{BufRead, Seek};

fn uint24(value: u32) -> Result<[u8; 3], AppError> {
    if value > 0xff_ffff {
        return Err(failure("WebP animation field exceeds its limit"));
    }
    let bytes = value.to_le_bytes();
    Ok([bytes[0], bytes[1], bytes[2]])
}

fn chunk(output: &mut Vec<u8>, name: &[u8; 4], bytes: &[u8]) -> Result<(), AppError> {
    if output.len().saturating_add(bytes.len()).saturating_add(9) > MAX_BYTES {
        return Err(failure("Encoded crop exceeds the output size limit"));
    }
    output.extend_from_slice(name);
    output.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(bytes);
    if !bytes.len().is_multiple_of(2) {
        output.push(0);
    }
    Ok(())
}

pub(super) fn encode<R: BufRead + Seek>(
    mut decoder: image::codecs::webp::WebPDecoder<R>,
    crop: CropRect,
) -> Result<Vec<u8>, AppError> {
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    decoder
        .set_limits(crate::thumbnails::decode_limits())
        .map_err(failure)?;
    let orientation = decoder.orientation().map_err(failure)?;
    let profile = decoder.icc_profile().map_err(failure)?;
    let loops = match decoder.loop_count() {
        image::metadata::LoopCount::Infinite => 0,
        image::metadata::LoopCount::Finite(count) => u16::try_from(count.get()).map_err(failure)?,
    };
    let oriented = match orientation {
        image::metadata::Orientation::Rotate90
        | image::metadata::Orientation::Rotate270
        | image::metadata::Orientation::Rotate90FlipH
        | image::metadata::Orientation::Rotate270FlipH => (height, width),
        _ => (width, height),
    };
    crop.validate(oriented.0, oriented.1)?;
    let mut output = b"RIFF\0\0\0\0WEBP".to_vec();
    let mut extended = vec![0x12 | if profile.is_some() { 0x20 } else { 0 }, 0, 0, 0];
    extended.extend_from_slice(&uint24(crop.width() - 1)?);
    extended.extend_from_slice(&uint24(crop.height() - 1)?);
    chunk(&mut output, b"VP8X", &extended)?;
    if let Some(profile) = profile {
        chunk(&mut output, b"ICCP", &profile)?;
    }
    let mut animation = vec![0, 0, 0, 0];
    animation.extend_from_slice(&loops.to_le_bytes());
    chunk(&mut output, b"ANIM", &animation)?;
    let mut count = 0;
    for frame in decoder.into_frames() {
        count += 1;
        if count > MAX_FRAMES {
            return Err(failure("Animation exceeds the crop frame limit"));
        }
        let frame = frame.map_err(failure)?;
        let (numerator, denominator) = frame.delay().numer_denom_ms();
        if denominator == 0 || numerator % denominator != 0 {
            return Err(failure("WebP frame delay is not an integral millisecond"));
        }
        let mut image = DynamicImage::ImageRgba8(frame.into_buffer());
        image.apply_orientation(orientation);
        let image = crop.image(&image)?.to_rgba8();
        let mut encoded = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(failure)?;
        // The lossless encoder emits one VP8L image chunk, without metadata.
        if encoded.get(12..16) != Some(b"VP8L") {
            return Err(failure("Unexpected WebP frame encoding"));
        }
        let mut payload = vec![0, 0, 0, 0, 0, 0];
        payload.extend_from_slice(&uint24(crop.width() - 1)?);
        payload.extend_from_slice(&uint24(crop.height() - 1)?);
        payload.extend_from_slice(&uint24(numerator / denominator)?);
        payload.push(2); // Replace the complete canvas; no blend, no disposal.
        payload.extend_from_slice(&encoded[12..]);
        chunk(&mut output, b"ANMF", &payload)?;
    }
    if count == 0 {
        return Err(failure("WebP contains no image frames"));
    }
    let length = (output.len() - 8) as u32;
    output[4..8].copy_from_slice(&length.to_le_bytes());
    Ok(output)
}
