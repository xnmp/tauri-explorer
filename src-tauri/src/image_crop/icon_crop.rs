//! Each original ICNS representation retains its density and fixed canvas.
//! The normalized crop is centered without resampling, with transparent padding.
use super::{dimensions, failure, CropRect, Encoded};
use crate::error::AppError;
use image::{ImageDecoder, ImageEncoder};
use std::io::Cursor;

fn word(bytes: &[u8], offset: usize) -> Result<u32, AppError> {
    let field = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| failure("Truncated ICNS header"))?;
    Ok(u32::from_be_bytes(
        field.try_into().expect("four-byte field"),
    ))
}

/// rust-icns allocates from declared lengths before reading. Validate every
/// boundary against the actual bounded input before handing it any bytes.
fn preflight(bytes: &[u8]) -> Result<(), AppError> {
    if word(bytes, 4)? as usize != bytes.len() {
        return Err(failure("Invalid ICNS container length"));
    }
    let mut offset = 8;
    let mut count = 0;
    while offset < bytes.len() {
        count += 1;
        if count > 128 {
            return Err(failure("ICNS has too many representations"));
        }
        let length = word(bytes, offset + 4)? as usize;
        let end = offset
            .checked_add(length)
            .filter(|end| length >= 8 && *end <= bytes.len())
            .ok_or_else(|| failure("Invalid ICNS element length"))?;
        let kind = icns::IconType::from_ostype(icns::OSType(
            bytes[offset..offset + 4]
                .try_into()
                .expect("validated element header"),
        ));
        if let Some(kind) = kind.filter(|kind| kind.encoding() == icns::Encoding::JP2PNG) {
            let payload = &bytes[offset + 8..end];
            let actual = if payload.starts_with(b"\x89PNG\r\n\x1a\n") {
                let decoder = image::codecs::png::PngDecoder::with_limits(
                    Cursor::new(payload),
                    crate::thumbnails::decode_limits(),
                )
                .map_err(failure)?;
                decoder.dimensions()
            } else {
                jpeg2000_dimensions(payload)?
            };
            if actual != (kind.pixel_width(), kind.pixel_height()) {
                return Err(failure(
                    "Embedded ICNS image dimensions do not match its representation",
                ));
            }
        }
        offset = end;
    }
    Ok(())
}

fn jpeg2000_dimensions(bytes: &[u8]) -> Result<(u32, u32), AppError> {
    let stream = if bytes.starts_with(&[0xff, 0x4f]) {
        bytes
    } else {
        let mut offset = 0;
        let mut codestream = None;
        while offset < bytes.len() {
            let mut length = word(bytes, offset)? as usize;
            let tag = bytes
                .get(offset + 4..offset + 8)
                .ok_or_else(|| failure("Truncated JP2 box"))?;
            let header = if length == 1 {
                let field = bytes
                    .get(offset + 8..offset + 16)
                    .ok_or_else(|| failure("Truncated JP2 extended box"))?;
                length = usize::try_from(u64::from_be_bytes(
                    field.try_into().expect("eight-byte field"),
                ))
                .map_err(failure)?;
                16
            } else {
                8
            };
            if length == 0 {
                length = bytes.len() - offset;
            }
            let end = offset
                .checked_add(length)
                .filter(|end| length >= header && *end <= bytes.len())
                .ok_or_else(|| failure("Invalid JP2 box length"))?;
            if tag == b"jp2c" {
                if codestream.is_some() {
                    return Err(failure("Multiple JP2 codestreams"));
                }
                codestream = Some(&bytes[offset + header..end]);
            }
            offset = end;
        }
        codestream.ok_or_else(|| failure("JP2 has no codestream"))?
    };
    if stream.get(..4) != Some(&[0xff, 0x4f, 0xff, 0x51]) {
        return Err(failure("Invalid JPEG2000 size marker"));
    }
    let size_length = stream
        .get(4..6)
        .ok_or_else(|| failure("Truncated JP2 size marker"))?;
    let size_length = u16::from_be_bytes(size_length.try_into().expect("two-byte field")) as usize;
    let components = stream
        .get(40..42)
        .ok_or_else(|| failure("Truncated JP2 components"))?;
    let components = u16::from_be_bytes(components.try_into().expect("two-byte field")) as usize;
    if components == 0
        || components > 4
        || size_length != 38 + 3 * components
        || stream.len() < 4 + size_length
    {
        return Err(failure("Invalid JP2 component table"));
    }
    for component in stream[42..4 + size_length].chunks_exact(3) {
        if (component[0] & 0x7f) >= 16 || component[1] == 0 || component[2] == 0 {
            return Err(failure("Unsupported JP2 sample geometry"));
        }
    }
    let grid_width = word(stream, 8)?;
    let grid_height = word(stream, 12)?;
    dimensions(grid_width, grid_height)?;
    let x_origin = word(stream, 16)?;
    let y_origin = word(stream, 20)?;
    let width = grid_width
        .checked_sub(x_origin)
        .ok_or_else(|| failure("Invalid JP2 horizontal bounds"))?;
    let height = grid_height
        .checked_sub(y_origin)
        .ok_or_else(|| failure("Invalid JP2 vertical bounds"))?;
    dimensions(width, height)?;
    let tile_width = word(stream, 24)?;
    let tile_height = word(stream, 28)?;
    let tile_x = word(stream, 32)?;
    let tile_y = word(stream, 36)?;
    if tile_width == 0
        || tile_height == 0
        || tile_width > 16_384
        || tile_height > 16_384
        || tile_x > x_origin
        || tile_y > y_origin
    {
        return Err(failure("Invalid JP2 tile geometry"));
    }
    let count_x = u64::from(grid_width - tile_x).div_ceil(u64::from(tile_width));
    let count_y = u64::from(grid_height - tile_y).div_ceil(u64::from(tile_height));
    if count_x
        .checked_mul(count_y)
        .is_none_or(|tiles| tiles > 4096)
    {
        return Err(failure("JP2 exceeds the crop tile-work limit"));
    }
    // hayro reduces display dimensions when every component has the same
    // sampling. Keep the reference-grid/tile bounds above, but compare the
    // representation against actual decoded dimensions, not that grid.
    let components = &stream[42..4 + size_length];
    let sampling = [components[1], components[2]];
    let uniform = components
        .chunks_exact(3)
        .all(|component| component[1..] == sampling);
    if uniform {
        Ok((
            width.div_ceil(u32::from(sampling[0])),
            height.div_ceil(u32::from(sampling[1])),
        ))
    } else {
        Ok((width, height))
    }
}

pub(crate) fn preview(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    preflight(bytes)?;
    let family = icns::IconFamily::read(bytes).map_err(failure)?;
    let kind = crate::thumbnails::complete_icns_icons(&family)
        .into_iter()
        .max_by_key(|kind| kind.pixel_width())
        .ok_or_else(|| failure("ICNS has no complete image representation"))?;
    let icon = family
        .get_icon_with_type(kind)
        .map_err(failure)?
        .convert_to(icns::PixelFormat::RGBA);
    dimensions(icon.width(), icon.height())?;
    let image = image::RgbaImage::from_raw(icon.width(), icon.height(), icon.data().to_vec())
        .ok_or_else(|| failure("Invalid ICNS pixels"))?;
    let mut output = Encoded::default();
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(failure)?;
    Ok(output.into_bytes())
}

pub(super) fn encode(bytes: &[u8], crop: CropRect) -> Result<Vec<u8>, AppError> {
    preflight(bytes)?;
    let source = icns::IconFamily::read(bytes).map_err(failure)?;
    let mut icons = crate::thumbnails::complete_icns_icons(&source);
    // Combined monochrome entries also supply palette alpha masks. Encode
    // them first so regenerating a palette mask cannot replace their pixels.
    icons.sort_by_key(|kind| kind.encoding() != icns::Encoding::MonoA);
    if source
        .elements
        .iter()
        .filter_map(|element| element.icon_type())
        .any(|kind| !kind.is_mask() && !source.has_icon_with_type(kind))
    {
        return Err(failure("ICNS contains an incomplete representation"));
    }
    let largest = icons
        .iter()
        .max_by_key(|kind| kind.pixel_width())
        .ok_or_else(|| failure("ICNS has no complete image representation"))?;
    let width = largest.pixel_width();
    let height = largest.pixel_height();
    crop.validate(width, height)?;
    let mut output = icns::IconFamily::new();
    for kind in icons.iter().copied() {
        // A masked original already represents this canvas. Promoting the bare
        // variant too would produce duplicate ICN# entries and shadow its mask.
        if kind == icns::IconType::Mono_32x32 && icons.contains(&icns::IconType::MonoA_32x32) {
            continue;
        }
        let image = source
            .get_icon_with_type(kind)
            .map_err(failure)?
            .convert_to(icns::PixelFormat::RGBA);
        let canvas_width = image.width();
        let canvas_height = image.height();
        dimensions(canvas_width, canvas_height)?;
        // Integer division avoids floating precision drifting an exact edge.
        let left = (u64::from(crop.left) * u64::from(canvas_width) / u64::from(width)) as u32;
        let top = (u64::from(crop.top) * u64::from(canvas_height) / u64::from(height)) as u32;
        let right =
            (u64::from(crop.right) * u64::from(canvas_width)).div_ceil(u64::from(width)) as u32;
        let bottom =
            (u64::from(crop.bottom) * u64::from(canvas_height)).div_ceil(u64::from(height)) as u32;
        let selected_width = right - left;
        let selected_height = bottom - top;
        let offset_x = (canvas_width - selected_width) / 2;
        let offset_y = (canvas_height - selected_height) / 2;
        let mut canvas = icns::Image::new(icns::PixelFormat::RGBA, canvas_width, canvas_height);
        canvas.data_mut().fill(0);
        for row in 0..selected_height {
            let from = (((top + row) * canvas_width + left) * 4) as usize;
            let to = (((offset_y + row) * canvas_width + offset_x) * 4) as usize;
            let length = (selected_width * 4) as usize;
            canvas.data_mut()[to..to + length].copy_from_slice(&image.data()[from..from + length]);
        }
        // Bare ICON is monochrome without an alpha mask. Its masked equivalent
        // keeps the same32×32 canvas/density and can represent transparent padding.
        let output_kind = if kind == icns::IconType::Mono_32x32 {
            icns::IconType::MonoA_32x32
        } else {
            kind
        };
        let mut encoded = icns::IconFamily::new();
        encoded
            .add_icon_with_type(&canvas, output_kind)
            .map_err(failure)?;
        for element in encoded.elements {
            if !output
                .elements
                .iter()
                .any(|existing| existing.ostype == element.ostype)
            {
                output.elements.push(element);
            }
        }
    }
    // Keep non-image metadata; the optional table of contents describes old
    // payload lengths and must not be copied into a rewritten container.
    for element in &source.elements {
        if element.icon_type().is_none() && element.ostype != icns::OSType(*b"TOC ") {
            output
                .elements
                .push(icns::IconElement::new(element.ostype, element.data.clone()));
        }
    }
    let mut bytes = Encoded::default();
    output.write(&mut bytes).map_err(failure)?;
    Ok(bytes.into_bytes())
}
