//! APNG crops raw frame regions, retaining blend/disposal operations and 16-bit
//! samples. Geometry is transformed before emission, never by flattening frames.
use super::{decoder, dimensions, failure, CropRect, Encoded, MAX_FRAMES};
use crate::error::AppError;
use image::{metadata::Orientation, ImageDecoder, ImageFormat};
use std::io::{Cursor, Write};

pub(super) fn metadata(bytes: &[u8]) -> Result<png::Info<'static>, AppError> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 64 * 1024 * 1024,
    });
    decoder.set_ignore_text_chunk(true);
    let mut reader = decoder.read_info().map_err(failure)?;
    // cLLI may legally follow image data. This pass skips decoding pixels;
    // only accepted metadata up to IEND survives, including CRC decisions.
    reader.finish().map_err(failure)?;
    Ok(reader.info().clone())
}

#[derive(Clone, Copy)]
pub(super) struct ColorMetadata {
    coding_independent_code_points: Option<png::CodingIndependentCodePoints>,
    mastering_display_color_volume: Option<png::MasteringDisplayColorVolume>,
    content_light_level: Option<png::ContentLightLevelInfo>,
}

impl From<&png::Info<'_>> for ColorMetadata {
    fn from(info: &png::Info<'_>) -> Self {
        Self {
            coding_independent_code_points: info.coding_independent_code_points,
            mastering_display_color_volume: info.mastering_display_color_volume,
            content_light_level: info.content_light_level,
        }
    }
}

/// png0.18's encoder omits HDR fields. Serialize only the decoder's accepted
/// values; copying raw chunks would repair bad CRCs or promote ignored metadata.
pub(super) fn color_chunks<W: Write>(
    info: &ColorMetadata,
    writer: &mut png::Writer<W>,
) -> Result<(), AppError> {
    if let Some(value) = info.coding_independent_code_points {
        writer
            .write_chunk(
                png::chunk::ChunkType(*b"cICP"),
                &[
                    value.color_primaries,
                    value.transfer_function,
                    value.matrix_coefficients,
                    u8::from(value.is_video_full_range_image),
                ],
            )
            .map_err(failure)?;
    }
    if let Some(value) = info.mastering_display_color_volume {
        let mut payload = Vec::with_capacity(24);
        let color = value.chromaticities;
        for (x, y) in [color.red, color.green, color.blue, color.white] {
            for coordinate in [x, y] {
                let scaled = coordinate.into_scaled();
                if scaled % 2 != 0 {
                    return Err(failure("Invalid PNG mastering chromaticity"));
                }
                payload
                    .extend_from_slice(&u16::try_from(scaled / 2).map_err(failure)?.to_be_bytes());
            }
        }
        payload.extend_from_slice(&value.max_luminance.to_be_bytes());
        payload.extend_from_slice(&value.min_luminance.to_be_bytes());
        writer
            .write_chunk(png::chunk::ChunkType(*b"mDCV"), &payload)
            .map_err(failure)?;
    }
    if let Some(value) = info.content_light_level {
        let mut payload = value.max_content_light_level.to_be_bytes().to_vec();
        payload.extend_from_slice(&value.max_frame_average_light_level.to_be_bytes());
        writer
            .write_chunk(png::chunk::ChunkType(*b"cLLI"), &payload)
            .map_err(failure)?;
    }
    Ok(())
}

fn oriented(rect: CropRect, width: u32, height: u32, orientation: Orientation) -> CropRect {
    let CropRect {
        left: l,
        top: t,
        right: r,
        bottom: b,
    } = rect;
    let (left, top, right, bottom) = match orientation {
        Orientation::NoTransforms => (l, t, r, b),
        Orientation::Rotate90 => (height - b, l, height - t, r),
        Orientation::Rotate180 => (width - r, height - b, width - l, height - t),
        Orientation::Rotate270 => (t, width - r, b, width - l),
        Orientation::FlipHorizontal => (width - r, t, width - l, b),
        Orientation::FlipVertical => (l, height - b, r, height - t),
        Orientation::Rotate90FlipH => (t, l, b, r),
        Orientation::Rotate270FlipH => (height - b, width - r, height - t, width - l),
    };
    CropRect {
        left,
        top,
        right,
        bottom,
    }
}

fn inverse(orientation: Orientation) -> Orientation {
    match orientation {
        Orientation::Rotate90 => Orientation::Rotate270,
        Orientation::Rotate270 => Orientation::Rotate90,
        other => other,
    }
}

fn intersection(a: CropRect, b: CropRect) -> Option<CropRect> {
    let rect = CropRect {
        left: a.left.max(b.left),
        top: a.top.max(b.top),
        right: a.right.min(b.right),
        bottom: a.bottom.min(b.bottom),
    };
    (rect.left < rect.right && rect.top < rect.bottom).then_some(rect)
}

pub(super) fn encode(bytes: &[u8], crop: CropRect) -> Result<Vec<u8>, AppError> {
    let orientation = decoder(bytes, ImageFormat::Png)?
        .orientation()
        .map_err(failure)?;
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 64 * 1024 * 1024,
    });
    decoder.set_ignore_text_chunk(true);
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder.read_info().map_err(failure)?;
    let separate_default = reader.info().frame_control.is_none();
    let original_info = metadata(bytes)?;
    let (width, height) = (original_info.width, original_info.height);
    dimensions(width, height)?;
    let animation = original_info
        .animation_control
        .ok_or_else(|| failure("PNG is not animated"))?;
    if animation.num_frames == 0 || animation.num_frames as usize > MAX_FRAMES {
        return Err(failure("PNG animation exceeds the crop frame limit"));
    }
    let full = oriented(
        CropRect {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        },
        width,
        height,
        orientation,
    );
    crop.validate(full.right, full.bottom)?;
    let source_crop = oriented(crop, full.right, full.bottom, inverse(orientation));
    let (source_color, depth) = reader.output_color_type();
    let color = match source_color {
        png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha => {
            png::ColorType::GrayscaleAlpha
        }
        png::ColorType::Rgb | png::ColorType::Rgba => png::ColorType::Rgba,
        png::ColorType::Indexed => return Err(failure("PNG palette was not expanded")),
    };
    let sample_bytes = match depth {
        png::BitDepth::Eight => 1,
        png::BitDepth::Sixteen => 2,
        _ => return Err(failure("PNG samples were not expanded")),
    };
    let pixel_bytes = color.samples() * sample_bytes;
    let source_pixel_bytes = source_color.samples() * sample_bytes;
    let color_metadata = ColorMetadata::from(&original_info);
    let mut info = original_info;
    info.source_gamma = info.gamma();
    info.source_chromaticities = info.chromaticities();
    info.width = crop.width();
    info.height = crop.height();
    info.color_type = color;
    info.bit_depth = depth;
    info.palette = None;
    info.trns = None;
    info.sbit = None;
    info.exif_metadata = None;
    info.interlaced = false;
    info.frame_control = Some(png::FrameControl {
        width: crop.width(),
        height: crop.height(),
        ..Default::default()
    });
    let mut output = Encoded::default();
    let mut encoder = png::Encoder::with_info(&mut output, info).map_err(failure)?;
    encoder.set_sep_def_img(separate_default).map_err(failure)?;
    encoder.validate_sequence(true);
    let mut writer = encoder.write_header().map_err(failure)?;
    color_chunks(&color_metadata, &mut writer)?;
    let count = animation.num_frames as usize + usize::from(separate_default);
    let mut raw = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or_else(|| failure("PNG frame is too large"))?
    ];
    for index in 0..count {
        let frame = reader.next_frame(&mut raw).map_err(failure)?;
        let control = reader.info().frame_control;
        let source_rect = if let Some(control) = control {
            CropRect {
                left: control.x_offset,
                top: control.y_offset,
                right: control
                    .x_offset
                    .checked_add(control.width)
                    .ok_or_else(|| failure("PNG frame bounds overflow"))?,
                bottom: control
                    .y_offset
                    .checked_add(control.height)
                    .ok_or_else(|| failure("PNG frame bounds overflow"))?,
            }
        } else {
            CropRect {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            }
        };
        source_rect.validate(width, height)?;
        if frame.width != source_rect.width() || frame.height != source_rect.height() {
            return Err(failure("PNG frame dimensions do not match control"));
        }
        // png0.18 expands Adam7 subframes using the canvas-wide row stride.
        // Noninterlaced subframes are packed using their own width instead.
        let source_stride = if reader.info().interlaced {
            width
        } else {
            frame.width
        };
        let selected = intersection(source_rect, source_crop);
        let destination = selected.map(|rect| oriented(rect, width, height, orientation));
        let (frame_width, frame_height, x, y) = destination
            .map(|rect| {
                (
                    rect.width(),
                    rect.height(),
                    rect.left - crop.left,
                    rect.top - crop.top,
                )
            })
            .unwrap_or((1, 1, 0, 0));
        let mut pixels = vec![0; frame_width as usize * frame_height as usize * pixel_bytes];
        if let (Some(selected), Some(destination)) = (selected, destination) {
            for sy in selected.top..selected.bottom {
                for sx in selected.left..selected.right {
                    let mapped = oriented(
                        CropRect {
                            left: sx,
                            top: sy,
                            right: sx + 1,
                            bottom: sy + 1,
                        },
                        width,
                        height,
                        orientation,
                    );
                    let from = ((sy - source_rect.top) as usize * source_stride as usize
                        + (sx - source_rect.left) as usize)
                        * source_pixel_bytes;
                    let to = ((mapped.top - destination.top) as usize * frame_width as usize
                        + (mapped.left - destination.left) as usize)
                        * pixel_bytes;
                    pixels[to..to + source_pixel_bytes]
                        .copy_from_slice(&raw[from..from + source_pixel_bytes]);
                    if source_pixel_bytes != pixel_bytes {
                        pixels[to + source_pixel_bytes..to + pixel_bytes].fill(255);
                    }
                }
            }
        }
        if !(separate_default && index == 0) {
            let control = control.ok_or_else(|| failure("Animation frame has no control"))?;
            // Reset position before changing size; the previous frame's offset
            // otherwise makes a valid larger successor fail the encoder's bound.
            writer.set_frame_position(0, 0).map_err(failure)?;
            writer
                .set_frame_dimension(frame_width, frame_height)
                .map_err(failure)?;
            writer.set_frame_position(x, y).map_err(failure)?;
            writer
                .set_frame_delay(control.delay_num, control.delay_den)
                .map_err(failure)?;
            writer
                .set_blend_op(if selected.is_some() {
                    control.blend_op
                } else {
                    png::BlendOp::Over
                })
                .map_err(failure)?;
            writer
                .set_dispose_op(if selected.is_some() {
                    control.dispose_op
                } else {
                    png::DisposeOp::None
                })
                .map_err(failure)?;
        }
        writer.write_image_data(&pixels).map_err(failure)?;
    }
    reader.finish().map_err(failure)?;
    writer.finish().map_err(failure)?;
    Ok(output.into_bytes())
}
