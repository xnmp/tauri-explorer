//! Crop indexed frames independently. Retain palettes, disposal, delays and
//! looping, avoiding colour loss from quantizing a composited animation.
use super::{dimensions, failure, CropRect, Encoded, MAX_FRAMES};
use crate::error::AppError;
use std::borrow::Cow;

pub(super) fn encode(bytes: &[u8], crop: CropRect) -> Result<Vec<u8>, AppError> {
    // Extensions can occur after a frame. Read the bounded metadata stream
    // first, then put its loop extension before output frames so players that
    // start playback while parsing see the original repeat contract.
    let mut metadata_options = gif::DecodeOptions::new();
    metadata_options.skip_frame_decoding(true);
    let mut metadata = metadata_options.read_info(bytes).map_err(failure)?;
    dimensions(metadata.width().into(), metadata.height().into())?;
    let mut frame_count = 0;
    while metadata.read_next_frame().map_err(failure)?.is_some() {
        frame_count += 1;
        if frame_count > MAX_FRAMES {
            return Err(failure("Animation exceeds the crop frame limit"));
        }
    }
    let repeat = metadata.repeat();
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    options.check_frame_consistency(true);
    let mut decoder = options.read_info(bytes).map_err(failure)?;
    dimensions(decoder.width().into(), decoder.height().into())?;
    crop.validate(decoder.width().into(), decoder.height().into())?;
    let palette = decoder.global_palette().unwrap_or_default().to_vec();
    let background = decoder.bg_color();
    let mut output = Encoded::default();
    {
        let mut encoder = gif::Encoder::new(
            &mut output,
            crop.width() as u16,
            crop.height() as u16,
            &palette,
        )
        .map_err(failure)?;
        encoder.set_repeat(repeat).map_err(failure)?;
        let mut count = 0;
        while let Some(frame) = decoder.read_next_frame().map_err(failure)? {
            count += 1;
            if count > MAX_FRAMES {
                return Err(failure("Animation exceeds the crop frame limit"));
            }
            let left = crop.left.max(frame.left.into());
            let top = crop.top.max(frame.top.into());
            let right = crop
                .right
                .min(u32::from(frame.left) + u32::from(frame.width));
            let bottom = crop
                .bottom
                .min(u32::from(frame.top) + u32::from(frame.height));
            let next = if left < right && top < bottom {
                let mut pixels = Vec::with_capacity(((right - left) * (bottom - top)) as usize);
                for y in top..bottom {
                    let start = ((y - u32::from(frame.top)) * u32::from(frame.width) + left
                        - u32::from(frame.left)) as usize;
                    pixels.extend_from_slice(&frame.buffer[start..start + (right - left) as usize]);
                }
                gif::Frame {
                    left: (left - crop.left) as u16,
                    top: (top - crop.top) as u16,
                    width: (right - left) as u16,
                    height: (bottom - top) as u16,
                    interlaced: false, // Decoder returned ordinary scanline order.
                    buffer: Cow::Owned(pixels),
                    ..frame.clone()
                }
            } else {
                // Keep this frame's time even when its original region is
                // outside the crop. Its disposal cannot affect retained pixels.
                gif::Frame {
                    width: 1,
                    height: 1,
                    transparent: Some(0),
                    delay: frame.delay,
                    dispose: gif::DisposalMethod::Keep,
                    palette: Some(vec![0, 0, 0]),
                    buffer: Cow::Owned(vec![0]),
                    ..Default::default()
                }
            };
            encoder.write_frame(&next).map_err(failure)?;
        }
        if count == 0 {
            return Err(failure("GIF contains no image frames"));
        }
    }
    if let Some(background) = background {
        output.bytes_mut()[11] = background as u8;
    }
    Ok(output.into_bytes())
}
