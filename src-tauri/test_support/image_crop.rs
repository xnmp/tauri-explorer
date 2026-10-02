use super::*;
use image::{AnimationDecoder, Rgba, RgbaImage};

const REGION: CropRect = CropRect {
    left: 2,
    top: 1,
    right: 7,
    bottom: 4,
};
fn fixture() -> RgbaImage {
    RgbaImage::from_fn(8, 6, |x, y| {
        Rgba([
            (x * 29) as u8,
            (y * 41) as u8,
            83,
            if x % 3 == 0 { 0 } else { 255 },
        ])
    })
}
fn encoded(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut data = Cursor::new(Vec::new());
    image.write_to(&mut data, format).unwrap();
    data.into_inner()
}

#[test]
fn cropped_lossless_formats_retain_four_edges_and_alpha() {
    let source = fixture();
    for format in [ImageFormat::Png, ImageFormat::WebP, ImageFormat::Bmp] {
        let original = encoded(DynamicImage::ImageRgba8(source.clone()), format);
        let output = encode(&original, REGION).unwrap();
        assert_eq!(image::guess_format(&output).unwrap(), format);
        let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (5, 3), "{format:?}");
        for y in 0..3 {
            for x in 0..5 {
                assert_eq!(
                    decoded.get_pixel(x, y),
                    source.get_pixel(x + 2, y + 1),
                    "{format:?} ({x},{y})"
                );
            }
        }
    }
}

#[test]
fn jpeg_retains_format_dimensions_and_recognizable_region() {
    let source = image::RgbImage::from_fn(64, 48, |x, y| {
        image::Rgb(if x < 32 {
            if y < 24 {
                [220, 20, 20]
            } else {
                [20, 20, 220]
            }
        } else if y < 24 {
            [20, 220, 20]
        } else {
            [220, 220, 20]
        })
    });
    let original = encoded(DynamicImage::ImageRgb8(source), ImageFormat::Jpeg);
    let output = encode(
        &original,
        CropRect {
            left: 8,
            top: 8,
            right: 56,
            bottom: 40,
        },
    )
    .unwrap();
    assert_eq!(image::guess_format(&output).unwrap(), ImageFormat::Jpeg);
    let image = image::load_from_memory(&output).unwrap().to_rgb8();
    assert_eq!(image.dimensions(), (48, 32));
    for (x, y, expected) in [
        (8, 8, [220, 20, 20]),
        (40, 8, [20, 220, 20]),
        (8, 24, [20, 20, 220]),
        (40, 24, [220, 220, 20]),
    ] {
        for (actual, expected) in image.get_pixel(x, y).0.into_iter().zip(expected) {
            assert!(actual.abs_diff(expected) < 25);
        }
    }
}

fn avif_region() -> CropRect {
    CropRect {
        left: 3,
        top: 2,
        right: 13,
        bottom: 9,
    }
}

#[test]
fn avif_static_crop_preserves_decoded_rgba_alpha_and_icc_profile() {
    let original = include_bytes!("fixtures/image-crop-static.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!(
        (
            source.metadata.width,
            source.metadata.height,
            source.metadata.depth
        ),
        (16, 12, 8)
    );
    let output = encode(original, avif_region()).unwrap();
    assert_eq!(image::guess_format(&output).unwrap(), ImageFormat::Avif);
    let decoded = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(
        (
            decoded.metadata.width,
            decoded.metadata.height,
            decoded.metadata.depth
        ),
        (10, 7, 8)
    );
    assert_eq!(decoded.metadata.alpha_present, 1);
    for y in 0..7_usize {
        for x in 0..10_usize {
            let actual = &decoded.pixels[(y * 10 + x) * 4..(y * 10 + x + 1) * 4];
            let sx = x + 3;
            let sy = y + 2;
            assert_eq!(
                actual,
                &[
                    sx as u8 * 13,
                    sy as u8 * 19,
                    83,
                    if sx % 3 == 0 { 64 } else { 255 }
                ]
            );
        }
    }
    let profile = include_bytes!("fixtures/image-crop-srgb.icc");
    assert!(output.windows(profile.len()).any(|bytes| bytes == profile));
}

#[test]
fn avif_hdr_crop_keeps_twelve_bit_samples_color_interpretation_and_alpha() {
    let original = include_bytes!("fixtures/image-crop-hdr.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!(source.metadata.depth, 12);
    assert_eq!(
        (
            source.metadata.color_primaries,
            source.metadata.transfer_function
        ),
        (9, 16)
    );
    assert_eq!(
        (source.metadata.max_cll, source.metadata.max_pall),
        (3000, 1000)
    );
    let output = encode(original, avif_region()).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(
        (
            result.metadata.width,
            result.metadata.height,
            result.metadata.depth
        ),
        (10, 7, 12)
    );
    assert_eq!(
        (
            result.metadata.color_primaries,
            result.metadata.transfer_function
        ),
        (9, 16)
    );
    assert_eq!(
        (result.metadata.max_cll, result.metadata.max_pall),
        (3000, 1000)
    );
    for y in 0..7_usize {
        for x in 0..10_usize {
            let actual = (y * 10 + x) * 8;
            let expected = ((y + 2) * 16 + x + 3) * 8;
            assert_eq!(
                &result.pixels[actual..actual + 8],
                &source.pixels[expected..expected + 8]
            );
        }
    }
    assert!(result
        .pixels
        .chunks_exact(2)
        .any(|word| u16::from_ne_bytes([word[0], word[1]]) > 255));
}

#[test]
fn avif_animation_keeps_each_frame_pixels_unequal_duration_timescale_and_repetitions() {
    let original = include_bytes!("fixtures/image-crop-animation.avif");
    let output = encode(original, avif_region()).unwrap();
    for (index, duration) in [7, 12, 15].into_iter().enumerate() {
        let source = explorer_avif::decode_frame(original, index as u32).unwrap();
        let result = explorer_avif::decode_frame(&output, index as u32).unwrap();
        assert_eq!(result.metadata.frame_count, 3);
        assert_eq!(result.metadata.repetitions, 2);
        assert_eq!(result.metadata.timescale, 100);
        assert_eq!(result.metadata.frame_duration, duration);
        for y in 0..7_usize {
            for x in 0..10_usize {
                let actual = (y * 10 + x) * 4;
                let expected = ((y + 2) * 16 + x + 3) * 4;
                assert_eq!(
                    &result.pixels[actual..actual + 4],
                    &source.pixels[expected..expected + 4]
                );
            }
        }
    }
    assert!(explorer_avif::decode_frame(&output, 3).is_err());
}

#[test]
fn avif_clean_aperture_rotation_and_mirroring_match_independent_decoder() {
    let original = include_bytes!("fixtures/image-crop-oriented.avif");
    let reference =
        image::load_from_memory(include_bytes!("fixtures/image-crop-oriented-reference.png"))
            .unwrap()
            .to_rgba8();
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!(
        (source.metadata.width, source.metadata.height),
        reference.dimensions()
    );
    assert_eq!(source.pixels, *reference.as_raw());
    let crop = CropRect {
        left: 1,
        top: 2,
        right: 7,
        bottom: 10,
    };
    let output = encode(original, crop).unwrap();
    let actual = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!((actual.metadata.width, actual.metadata.height), (6, 8));
    assert_eq!(
        actual.pixels,
        image::imageops::crop_imm(&reference, 1, 2, 6, 8)
            .to_image()
            .into_raw()
    );
}

#[test]
fn avif_rotated_pixel_aspect_is_normalized_with_the_pixel_axes() {
    let original = include_bytes!("fixtures/image-crop-aspect.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!((source.metadata.width, source.metadata.height), (12, 16));
    assert_eq!(
        (
            source.metadata.aspect_horizontal,
            source.metadata.aspect_vertical
        ),
        (2, 1)
    );
    let output = encode(
        original,
        CropRect {
            left: 1,
            top: 2,
            right: 9,
            bottom: 13,
        },
    )
    .unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(
        (
            result.metadata.aspect_horizontal,
            result.metadata.aspect_vertical
        ),
        (1, 2)
    );
    for y in 0..11_usize {
        for x in 0..8_usize {
            let actual = (y * 8 + x) * 4;
            let expected = ((y + 2) * 12 + x + 1) * 4;
            assert_eq!(
                &result.pixels[actual..actual + 4],
                &source.pixels[expected..expected + 4]
            );
        }
    }
}

#[test]
fn avif_unknown_loop_policy_remains_unspecified_without_losing_frames() {
    let original = include_bytes!("fixtures/image-crop-unknown-loops.avif");
    assert_eq!(
        explorer_avif::decode_frame(original, 0)
            .unwrap()
            .metadata
            .repetitions,
        -2
    );
    let output = encode(original, avif_region()).unwrap();
    for (index, duration) in [7, 12, 15].into_iter().enumerate() {
        let source = explorer_avif::decode_frame(original, index as u32).unwrap();
        let result = explorer_avif::decode_frame(&output, index as u32).unwrap();
        assert_eq!(result.metadata.repetitions, -2);
        assert_eq!(result.metadata.frame_count, 3);
        assert_eq!(result.metadata.timescale, 100);
        assert_eq!(result.metadata.frame_duration, duration);
        for y in 0..7_usize {
            let expected = ((y + 2) * 16 + 3) * 4;
            assert_eq!(
                &result.pixels[y * 40..(y + 1) * 40],
                &source.pixels[expected..expected + 40]
            );
        }
    }
}

#[test]
fn avif_one_frame_sequence_keeps_track_duration_and_repetitions() {
    let original = include_bytes!("fixtures/image-crop-one-frame-sequence.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!(source.metadata.sequence_present, 1);
    assert_eq!(
        (
            source.metadata.frame_count,
            source.metadata.timescale,
            source.metadata.frame_duration,
            source.metadata.repetitions
        ),
        (1, 100, 7, 2)
    );
    let output = encode(original, avif_region()).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(result.metadata.sequence_present, 1);
    assert_eq!(
        (
            result.metadata.frame_count,
            result.metadata.timescale,
            result.metadata.frame_duration,
            result.metadata.repetitions
        ),
        (1, 100, 7, 2)
    );
    for y in 0..7_usize {
        let expected = ((y + 2) * 16 + 3) * 4;
        assert_eq!(
            &result.pixels[y * 40..(y + 1) * 40],
            &source.pixels[expected..expected + 40]
        );
    }
    assert!(explorer_avif::decode_frame(&output, 1).is_err());
}

#[test]
fn avif_extended_samples_keep_sixteen_bit_precision() {
    let original = include_bytes!("fixtures/image-crop-sixteen-bit.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!(source.metadata.depth, 16);
    let output = encode(original, avif_region()).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(result.metadata.depth, 16);
    for y in 0..7_usize {
        for x in 0..10_usize {
            let actual = (y * 10 + x) * 8;
            let expected = ((y + 2) * 16 + x + 3) * 8;
            let values = [
                (x + 3) as u16 * 3801,
                (y + 2) as u16 * 5101,
                23456,
                if (x + 3) % 3 == 0 { 30001 } else { 65535 },
            ];
            let independent: Vec<u8> = values.into_iter().flat_map(u16::to_ne_bytes).collect();
            assert_eq!(&source.pixels[expected..expected + 8], &independent);
            assert_eq!(&result.pixels[actual..actual + 8], &independent);
        }
    }
}

#[test]
fn avif_gain_map_crop_keeps_hdr_reconstruction_and_alternate_image_metadata() {
    let original = include_bytes!("fixtures/image-crop-gain-map.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!(source.metadata.gain_map_present, 1);
    assert_eq!(
        (source.metadata.gain_width, source.metadata.gain_height),
        (8, 6)
    );
    assert_eq!(
        &source.metadata.gain_parameters[35..],
        &[1, 16, 0, 1, 12, 3, 6000, 1400]
    );
    let output = encode(original, avif_region()).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(result.metadata.gain_map_present, 1);
    assert_eq!(
        result.metadata.gain_parameters,
        source.metadata.gain_parameters
    );
    assert_eq!(
        (result.metadata.gain_width, result.metadata.gain_height),
        (10, 7)
    );
    for headroom in [0.0, 1.0, 2.0] {
        let source = explorer_avif::tone_map_frame(original, headroom).unwrap();
        let result = explorer_avif::tone_map_frame(&output, headroom).unwrap();
        for y in 0..7_usize {
            let expected = ((y + 2) * 16 + 3) * 8;
            assert_eq!(
                &result.pixels[y * 80..(y + 1) * 80],
                &source.pixels[expected..expected + 80],
                "headroom {headroom}, row {y}"
            );
        }
    }
}

#[test]
fn avif_transformed_gain_map_matches_independent_base_pixel_coordinates() {
    let original = include_bytes!("fixtures/image-crop-gain-map-oriented.avif");
    let crop = CropRect {
        left: 1,
        top: 2,
        right: 7,
        bottom: 10,
    };
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    assert_eq!((source.metadata.width, source.metadata.height), (8, 12));
    let output = encode(original, crop).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(
        result.metadata.gain_parameters,
        source.metadata.gain_parameters
    );
    for headroom in [0.0, 1.0, 2.0] {
        let source = explorer_avif::tone_map_frame(original, headroom).unwrap();
        let result = explorer_avif::tone_map_frame(&output, headroom).unwrap();
        for y in 0..8_usize {
            for x in 0..6_usize {
                // The independently encoded CLAP/IROT1/IMIR1 source maps
                // normalized pixel(x+1,y+2) to coded pixel(11-y,7-x).
                let expected = ((7 - x) * 16 + 11 - y) * 8;
                let actual = (y * 6 + x) * 8;
                assert_eq!(
                    &result.pixels[actual..actual + 8],
                    &source.pixels[expected..expected + 8],
                    "headroom {headroom} at{x},{y}"
                );
            }
        }
    }
}

#[test]
fn avif_subsampled_gain_map_keeps_nonlinear_hdr_reconstruction() {
    let original = include_bytes!("fixtures/image-crop-gain-map-subsampled.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    let output = encode(original, avif_region()).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    assert_eq!(
        result.metadata.gain_parameters,
        source.metadata.gain_parameters
    );
    for headroom in [0.5, 1.0, 2.0] {
        let source = explorer_avif::tone_map_frame(original, headroom).unwrap();
        let result = explorer_avif::tone_map_frame(&output, headroom).unwrap();
        for y in 0..7_usize {
            let expected = ((y + 2) * 16 + 3) * 8;
            assert_eq!(
                &result.pixels[y * 80..(y + 1) * 80],
                &source.pixels[expected..expected + 80],
                "headroom {headroom} at row{y}"
            );
        }
    }
}

#[test]
fn avif_alternate_icc_survives_without_changing_selected_base_pixels() {
    let original = include_bytes!("fixtures/image-crop-gain-map-icc.avif");
    let source = explorer_avif::decode_frame(original, 0).unwrap();
    let output = encode(original, avif_region()).unwrap();
    let result = explorer_avif::decode_frame(&output, 0).unwrap();
    let profile = include_bytes!("fixtures/image-crop-srgb.icc");
    assert!(output.windows(profile.len()).any(|bytes| bytes == profile));
    assert_eq!(result.metadata.gain_map_present, 1);
    assert_eq!(
        result.metadata.gain_parameters,
        source.metadata.gain_parameters
    );
    for y in 0..7_usize {
        let expected = ((y + 2) * 16 + 3) * 4;
        assert_eq!(
            &result.pixels[y * 40..(y + 1) * 40],
            &source.pixels[expected..expected + 40]
        );
    }
    // The upstream reconstruction utility explicitly does not implement ICC
    // color conversion; retaining the profile does not claim that capability.
    assert!(explorer_avif::tone_map_frame(original, 1.0).is_err());
    assert!(explorer_avif::tone_map_frame(&output, 1.0).is_err());
}

#[test]
fn svg_crop_preserves_the_vector_document_and_uses_pixel_bounds() {
    let original = br#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6" viewBox="0 0 80 60"><defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#paint)"/><circle cx="30" cy="20" r="9" opacity=".5"/></svg>"#;
    let output = encode(original, REGION).unwrap();
    let output = String::from_utf8(output).unwrap();
    assert!(output.contains("width=\"5\""));
    assert!(output.contains("height=\"3\""));
    assert!(output.contains("viewBox=\"2 1 5 3\""));
    let marker = "data:image/svg+xml;base64,";
    let start = output.find(marker).unwrap() + marker.len();
    let end = output[start..].find('"').unwrap() + start;
    use base64::Engine as _;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(&output[start..end])
            .unwrap(),
        original
    );
}

#[test]
fn svg_malformed_xml_is_rejected() {
    for child in [
        "<1bad/>",
        "<rect 1bad=\"x\"/>",
        "<text>&#1;</text>",
        "<rect fill=\"&#1;\"/>",
        "<rect fill=\"<\"/>",
    ] {
        let original = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"6\">{child}</svg>"
        );
        assert!(
            encode(original.as_bytes(), REGION).is_err(),
            "accepted {child}"
        );
    }
}

#[test]
fn svg_requires_a_captured_viewport_when_intrinsic_dimensions_are_ambiguous() {
    for attributes in [
        "",
        "width=\"100%\" height=\"100%\"",
        "width=\"2in\" height=\"1in\"",
        "width=\"8\" height=\"6\" style=\"width:100%\"",
    ] {
        let source = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" {attributes}><rect width=\"100%\" height=\"100%\"/></svg>");
        assert!(encode(source.as_bytes(), REGION).is_err());
        assert!(encode_with_viewport(
            source.as_bytes(),
            REGION,
            Some(SvgViewport {
                width: 8,
                height: 6
            })
        )
        .is_ok());
    }
}

#[test]
fn svg_refuses_unsupported_animated_document_context_instead_of_changing_its_appearance() {
    for body in [
        "<style>:root > rect {fill:red}</style><rect><animate attributeName=\"fill\" dur=\"1s\"/></rect>",
        "<script/><animate attributeName=\"opacity\" dur=\"1s\"/>",
        "<foreignObject/><animate attributeName=\"opacity\" dur=\"1s\"/>",
        "<animate attributeName=\"width\" dur=\"1s\"/>",
        "<g><animate href=\"#root\" attributeName=\"style\" dur=\"1s\"/></g>",
    ] {
        let source = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" id=\"root\" width=\"8\" height=\"6\">{body}</svg>");
        assert!(encode_with_viewport(source.as_bytes(), REGION, Some(SvgViewport { width: 8, height: 6 })).unwrap_err().to_string().contains("cannot preserve"));
    }
    let source = br#"<?xml-stylesheet href="theme.css"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><animate attributeName="opacity" dur="1s"/></svg>"#;
    assert!(encode(source, REGION)
        .unwrap_err()
        .to_string()
        .contains("cannot preserve"));
}

#[test]
fn svg_utf16_and_invalid_crop_inputs_are_handled_without_panics() {
    let source = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"6\"><text>é</text></svg>";
    for little in [false, true] {
        let mut bytes = if little {
            vec![0xff, 0xfe]
        } else {
            vec![0xfe, 0xff]
        };
        for word in source.encode_utf16() {
            bytes.extend_from_slice(&if little {
                word.to_le_bytes()
            } else {
                word.to_be_bytes()
            });
        }
        assert!(encode(&bytes, REGION).is_ok());
        bytes.pop();
        assert!(encode(&bytes, REGION).is_err());
    }
    let source = br#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"/>"#;
    for crop in [
        CropRect { right: 2, ..REGION },
        CropRect { right: 9, ..REGION },
        CropRect {
            bottom: u32::MAX,
            ..REGION
        },
    ] {
        assert!(encode(source, crop).is_err());
    }
    assert!(encode_with_viewport(
        source,
        REGION,
        Some(SvgViewport {
            width: u32::MAX,
            height: 6
        })
    )
    .is_err());
}

#[test]
fn svg_root_animation_guard_uses_svg_href_priority_and_namespace() {
    for attributes in [
        "href=\"#root\" xlink:href=\"#rect\" attributeName=\"width\"",
        "href=\"#root\" p:href=\"#rect\" attributeName=\"style\"",
        "href=\"#root\" attributeName=\"width\" p:attributeName=\"fill\"",
        "href=\"#%72oot\" attributeName=\"width\"",
    ] {
        let source = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:p=\"urn:metadata\" id=\"root\" width=\"8\" height=\"6\"><rect id=\"rect\"/><animate {attributes} dur=\"1s\"/></svg>");
        assert!(
            encode(source.as_bytes(), REGION).is_err(),
            "accepted root animation: {attributes}"
        );
    }
}

#[test]
fn svg_smil_refuses_document_relative_units_including_css_escapes() {
    for attributes in [
        "width=\"50vw\"",
        "height=\"50dvh\"",
        "width=\"5rem\"",
        "height=\"2rlh\"",
        "style=\"width:10cqw\"",
        r#"style="width:calc(50v\77 + 2px)""#,
        r#"style="width:50\76&#13;&#10;w""#,
    ] {
        let source = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"6\"><rect {attributes}/><set attributeName=\"opacity\" to=\"1\" begin=\"indefinite\"/></svg>");
        assert!(
            encode_with_viewport(
                source.as_bytes(),
                REGION,
                Some(SvgViewport {
                    width: 8,
                    height: 6
                })
            )
            .is_err(),
            "accepted document-relative units: {attributes}"
        );
    }
}

/// Export only outputs from the production Rust encoder for the independent
/// headless renderer check in scripts/verify-image-crop-svg.mjs.
#[test]
fn svg_renderer_fixtures() {
    use base64::Engine as _;
    let cases = [
        ("letterbox", "viewBox=\"0 0 100 100\"", "<rect width=\"100\" height=\"100\" fill=\"red\"/>", false),
        ("aligned-meet", "viewBox=\"10 20 100 100\" preserveAspectRatio=\"xMinYMax meet\"", "<rect x=\"10\" y=\"20\" width=\"100\" height=\"100\" fill=\"green\"/>", false),
        ("slice", "viewBox=\"10 20 100 100\" preserveAspectRatio=\"xMaxYMin slice\"", "<rect x=\"10\" y=\"20\" width=\"100\" height=\"100\" fill=\"blue\"/><rect x=\"30\" y=\"40\" width=\"20\" height=\"20\" fill=\"red\"/>", false),
        ("stretch", "viewBox=\"0 0 100 100\" preserveAspectRatio=\"none\"", "<circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"purple\"/>", false),
        ("css-root-percent", "style=\"width:200px;height:100px\"", "<style>:root { color: #2468ac } :root > rect { fill: currentColor }</style><rect width=\"75%\" height=\"80%\"/>", false),
        ("gradient-mask-filter", "viewBox=\"0 0 200 100\"", "<defs><linearGradient id=\"g\"><stop stop-color=\"red\"/><stop offset=\"1\" stop-color=\"blue\"/></linearGradient><mask id=\"m\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><circle cx=\"100\" cy=\"50\" r=\"20\" fill=\"black\"/></mask><filter id=\"f\"><feGaussianBlur stdDeviation=\"2\"/></filter></defs><rect width=\"100%\" height=\"100%\" fill=\"url(#g)\" mask=\"url(#m)\" filter=\"url(#f)\"/>", false),
        ("embedded-vector", "", "<image width=\"200\" height=\"100\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='100'%3E%3Crect width='150' height='90' fill='orange'/%3E%3C/svg%3E\"/>", false),
        ("smil-animation", "", "<rect width=\"200\" height=\"100\" fill=\"red\"><animate attributeName=\"fill\" values=\"red;blue;red\" dur=\".4s\" repeatCount=\"indefinite\"/></rect>", true),
        ("entity-inline-style", "style=\"fill:&#114;ed;font-family:&quot;Arial&quot;\"", "<rect width=\"200\" height=\"100\"/>", false),
        ("prefixed-namespace", "xmlns:p=\"http://www.w3.org/2000/svg\"", "<p:rect width=\"200\" height=\"100\" fill=\"red\"/><rect width=\"200\" height=\"100\" fill=\"green\"/><p:set attributeName=\"opacity\" to=\"1\" begin=\"indefinite\"/>", false),
        ("css-animation", "", "<style>@keyframes pulse { from { fill: red } to { fill: blue } } rect { animation: pulse .2s infinite alternate }</style><rect width=\"200\" height=\"100\"/>", true),
    ];
    let viewport = SvgViewport {
        width: 200,
        height: 100,
    };
    let crop = CropRect {
        left: 25,
        top: 15,
        right: 180,
        bottom: 85,
    };
    let second = CropRect {
        left: 10,
        top: 8,
        right: 145,
        bottom: 62,
    };
    let mut exported = Vec::new();
    for (name, attributes, body, animated) in cases {
        let variants = if !animated && !body.contains("<style>") && name != "prefixed-namespace" {
            vec![false, true]
        } else {
            vec![false]
        };
        for inline in variants {
            let name = if inline {
                format!("smil-{name}")
            } else {
                name.to_owned()
            };
            let body = if inline {
                format!("{body}<set attributeName=\"opacity\" to=\"1\" begin=\"indefinite\"/>")
            } else {
                body.to_owned()
            };
            let original = if name == "prefixed-namespace" {
                format!("<p:svg width=\"200\" height=\"100\" {attributes}>{body}</p:svg>")
            } else {
                format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"100\" {attributes}>{body}</svg>")
            };
            let output = encode_with_viewport(original.as_bytes(), crop, Some(viewport)).unwrap();
            let repeated = encode_with_viewport(
                &output,
                second,
                Some(SvgViewport {
                    width: crop.width(),
                    height: crop.height(),
                }),
            )
            .unwrap();
            let base64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
            exported.push(serde_json::json!({
                "name": name, "original": base64(original.as_bytes()),
                "output": base64(&output), "repeated": base64(&repeated),
                "viewport": viewport, "crop": crop, "second": second, "animated": animated,
            }));
        }
    }
    if let Some(path) = std::env::var_os("EXPLORER_SVG_RENDER_FIXTURES") {
        std::fs::write(path, serde_json::to_vec(&exported).unwrap()).unwrap();
    }
}

#[test]
fn avif_malformed_input_and_invalid_crops_return_errors_without_panics() {
    for bytes in [
        b"".as_slice(),
        b"broken AVIF",
        &include_bytes!("fixtures/image-crop-static.avif")[..32],
    ] {
        assert!(explorer_avif::decode_frame(bytes, 0).is_err());
        assert!(explorer_avif::crop(
            bytes,
            explorer_avif::CropRect {
                left: 0,
                top: 0,
                right: 1,
                bottom: 1
            }
        )
        .is_err());
    }
    let original = include_bytes!("fixtures/image-crop-static.avif");
    for crop in [
        CropRect {
            left: 2,
            top: 1,
            right: 2,
            bottom: 4,
        },
        CropRect {
            left: 2,
            top: 1,
            right: u32::MAX,
            bottom: 4,
        },
        CropRect {
            left: 8,
            top: 1,
            right: 2,
            bottom: 4,
        },
    ] {
        assert!(encode(original, crop).is_err());
    }
}

#[test]
fn png_sixteen_bit_samples_are_not_reduced_to_eight_bits() {
    let source = image::ImageBuffer::<image::Rgba<u16>, Vec<u16>>::from_fn(8, 6, |x, y| {
        image::Rgba([(x * 7001) as u16, (y * 10301) as u16, 12345, 34567])
    });
    let original = encoded(DynamicImage::ImageRgba16(source.clone()), ImageFormat::Png);
    let output = encode(&original, REGION).unwrap();
    let decoded = image::load_from_memory(&output).unwrap();
    assert_eq!(decoded.color(), image::ColorType::Rgba16);
    let decoded = decoded.to_rgba16();
    assert_eq!(decoded.get_pixel(0, 0), source.get_pixel(2, 1));
    assert_eq!(decoded.get_pixel(4, 2), source.get_pixel(6, 3));
}

#[test]
fn png_retains_gamma_interpretation_instead_of_darkening_the_crop() {
    let mut original = Vec::new();
    let mut encoder = png::Encoder::new(&mut original, 8, 6);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_source_gamma(png::ScaledFloat::new(1.0));
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&vec![128; 8 * 6 * 3]).unwrap();
    writer.finish().unwrap();
    let output = encode(&original, REGION).unwrap();
    let decoder = png::Decoder::new(Cursor::new(&output)).read_info().unwrap();
    assert_eq!(decoder.info().gama_chunk, Some(png::ScaledFloat::new(1.0)));
    assert_eq!(
        image::load_from_memory(&output)
            .unwrap()
            .to_rgb8()
            .get_pixel(0, 0)
            .0,
        [128, 128, 128]
    );
}

#[test]
fn png_ignored_trailing_color_metadata_does_not_change_crop_interpretation() {
    let mut original = encoded(
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(8, 6, image::Rgb([128; 3]))),
        ImageFormat::Png,
    );
    // A real, CRC-valid chunk appended after IEND is ignored by PNG readers.
    // Moving it into the header would change these samples to linear light.
    let mut chunk = Vec::new();
    {
        let mut writer = png::Encoder::new(&mut chunk, 1, 1).write_header().unwrap();
        writer
            .write_chunk(png::chunk::ChunkType(*b"cICP"), &[1, 8, 0, 1])
            .unwrap();
        writer.write_image_data(&[0]).unwrap();
        writer.finish().unwrap();
    }
    let offset = chunk.windows(4).position(|word| word == b"cICP").unwrap() - 4;
    original.extend_from_slice(&chunk[offset..offset + 16]);
    let output = encode(&original, REGION).unwrap();
    let reader = png::Decoder::new(Cursor::new(&output)).read_info().unwrap();
    assert!(reader.info().coding_independent_code_points.is_none());
    assert_eq!(
        image::load_from_memory(&output)
            .unwrap()
            .to_rgb8()
            .get_pixel(0, 0)
            .0,
        [128; 3]
    );
}

#[test]
fn png_bad_crc_color_metadata_stays_ignored_instead_of_being_repaired() {
    let mut original = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut original, 8, 6);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer
            .write_chunk(png::chunk::ChunkType(*b"cICP"), &[1, 8, 0, 1])
            .unwrap();
        writer.write_image_data(&[128; 8 * 6 * 3]).unwrap();
        writer.finish().unwrap();
    }
    let offset = original
        .windows(4)
        .position(|word| word == b"cICP")
        .unwrap();
    original[offset + 8] ^= 1; // Corrupt only its CRC, preserving the payload.
    let source = png::Decoder::new(Cursor::new(&original))
        .read_info()
        .unwrap();
    assert!(source.info().coding_independent_code_points.is_none());
    let output = encode(&original, REGION).unwrap();
    let reader = png::Decoder::new(Cursor::new(&output)).read_info().unwrap();
    assert!(reader.info().coding_independent_code_points.is_none());
}

#[test]
fn png_and_apng_retain_accepted_hdr_metadata_including_late_content_light() {
    for animated in [false, true] {
        let mut original = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut original, 8, 6);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            if animated {
                encoder.set_animated(1, 3).unwrap();
            }
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_chunk(png::chunk::ChunkType(*b"cICP"), &[9, 16, 0, 1])
                .unwrap();
            let mut volume: Vec<_> = [35400_u16, 14600, 8500, 39850, 6550, 2300, 15635, 16450]
                .into_iter()
                .flat_map(u16::to_be_bytes)
                .collect();
            volume.extend_from_slice(&10000000_u32.to_be_bytes());
            volume.extend_from_slice(&50_u32.to_be_bytes());
            writer
                .write_chunk(png::chunk::ChunkType(*b"mDCV"), &volume)
                .unwrap();
            writer.write_image_data(&[128; 8 * 6 * 3]).unwrap();
            let light: Vec<_> = [4000000_u32, 1000000]
                .into_iter()
                .flat_map(u32::to_be_bytes)
                .collect();
            writer
                .write_chunk(png::chunk::ChunkType(*b"cLLI"), &light)
                .unwrap();
            writer.finish().unwrap();
        }
        let expected = png_crop::metadata(&original).unwrap();
        assert!(expected.coding_independent_code_points.is_some());
        assert!(expected.mastering_display_color_volume.is_some());
        assert!(expected.content_light_level.is_some());
        let output = encode(&original, REGION).unwrap();
        let actual = png_crop::metadata(&output).unwrap();
        assert_eq!(
            actual.coding_independent_code_points,
            expected.coding_independent_code_points
        );
        assert_eq!(
            actual.mastering_display_color_volume,
            expected.mastering_display_color_volume
        );
        assert_eq!(actual.content_light_level, expected.content_light_level);
    }
}

#[test]
fn exif_rotation_is_applied_before_crop_and_not_applied_twice() {
    let source = RgbaImage::from_fn(3, 2, |x, y| Rgba([(10 + x + y * 3) as u8, 0, 0, 255]));
    let mut original = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut original);
    let exif = vec![
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    encoder.set_exif_metadata(exif).unwrap();
    encoder
        .write_image(source.as_raw(), 3, 2, image::ExtendedColorType::Rgba8)
        .unwrap();
    let output = encode(
        &original,
        CropRect {
            left: 1,
            top: 0,
            right: 2,
            bottom: 3,
        },
    )
    .unwrap();
    let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
    assert_eq!(decoded.dimensions(), (1, 3));
    assert_eq!(
        (0..3)
            .map(|y| decoded.get_pixel(0, y).0[0])
            .collect::<Vec<_>>(),
        vec![10, 11, 12]
    );
    assert_eq!(
        decoder(&output, ImageFormat::Png)
            .unwrap()
            .orientation()
            .unwrap(),
        image::metadata::Orientation::NoTransforms
    );
}

#[test]
fn malformed_and_invalid_rectangles_return_errors_without_panicking() {
    let original = encoded(DynamicImage::ImageRgba8(fixture()), ImageFormat::Png);
    for rect in [
        CropRect {
            left: 1,
            top: 0,
            right: 1,
            bottom: 1,
        },
        CropRect {
            left: 0,
            top: 0,
            right: u32::MAX,
            bottom: 1,
        },
        CropRect {
            left: 0,
            top: 5,
            right: 1,
            bottom: 4,
        },
    ] {
        assert!(encode(&original, rect).is_err());
    }
    assert!(encode(b"broken image", REGION).is_err());
    assert!(dimensions(u32::MAX, 1).is_err());
}

#[test]
fn animated_gif_preserves_rendered_regions_frame_times_and_loop_count() {
    let original = include_bytes!("fixtures/image-crop-animation.gif");
    let output = encode(original, REGION).unwrap();
    let source = image::codecs::gif::GifDecoder::new(Cursor::new(original))
        .unwrap()
        .into_frames()
        .collect_frames()
        .unwrap();
    let result = image::codecs::gif::GifDecoder::new(Cursor::new(&output))
        .unwrap()
        .into_frames()
        .collect_frames()
        .unwrap();
    assert_eq!(result.len(), source.len());
    for (actual, expected) in result.iter().zip(&source) {
        assert_eq!(actual.delay(), expected.delay());
        assert_eq!(
            actual.buffer(),
            &image::imageops::crop_imm(expected.buffer(), 2, 1, 5, 3).to_image()
        );
    }
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(&output)).unwrap();
    assert!(matches!(decoder.loop_count(),image::metadata::LoopCount::Finite(n) if n.get()==3));
}

#[test]
fn animated_webp_preserves_composited_rgba_timing_and_loops() {
    let original = include_bytes!("fixtures/image-crop-animation.webp");
    let output = encode(original, REGION).unwrap();
    let source = image::codecs::webp::WebPDecoder::new(Cursor::new(original))
        .unwrap()
        .into_frames()
        .collect_frames()
        .unwrap();
    let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(&output)).unwrap();
    assert!(decoder.has_animation());
    assert!(matches!(decoder.loop_count(),image::metadata::LoopCount::Finite(n) if n.get()==3));
    let result = decoder.into_frames().collect_frames().unwrap();
    assert_eq!(result.len(), source.len());
    for (actual, expected) in result.iter().zip(&source) {
        assert_eq!(actual.delay(), expected.delay());
        assert_eq!(
            actual.buffer(),
            &image::imageops::crop_imm(expected.buffer(), 2, 1, 5, 3).to_image()
        );
    }
}

#[test]
fn animated_png_preserves_composited_regions_timing_loop_count_and_default_image() {
    for original in [
        include_bytes!("fixtures/image-crop-animation.png").as_slice(),
        include_bytes!("fixtures/image-crop-animation-poster.png").as_slice(),
    ] {
        let output = encode(original, REGION).unwrap();
        let source_info = png::Decoder::new(Cursor::new(original))
            .read_info()
            .unwrap();
        let output_info = png::Decoder::new(Cursor::new(&output)).read_info().unwrap();
        let animation = |info: &png::Info<'_>| {
            info.animation_control
                .map(|control| (control.num_frames, control.num_plays))
        };
        assert_eq!(animation(output_info.info()), animation(source_info.info()));
        assert_eq!(
            output_info.info().frame_control.is_none(),
            source_info.info().frame_control.is_none()
        );
        let source = image::codecs::png::PngDecoder::new(Cursor::new(original))
            .unwrap()
            .apng()
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap();
        let result = image::codecs::png::PngDecoder::new(Cursor::new(&output))
            .unwrap()
            .apng()
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap();
        assert_eq!(result.len(), source.len());
        for (actual, expected) in result.iter().zip(&source) {
            assert_eq!(actual.delay(), expected.delay());
            assert_eq!(
                actual.buffer(),
                &image::imageops::crop_imm(expected.buffer(), 2, 1, 5, 3).to_image()
            );
        }
        let poster = image::load_from_memory(original).unwrap().to_rgba8();
        let cropped_poster = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_eq!(
            cropped_poster,
            image::imageops::crop_imm(&poster, 2, 1, 5, 3).to_image()
        );
    }
}

#[test]
fn animated_png_sixteen_bit_frame_samples_and_fractional_delays_survive_crop() {
    let mut original = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut original, 8, 6);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Sixteen);
        encoder.set_animated(2, 3).unwrap();
        let mut writer = encoder.write_header().unwrap();
        for index in 0..2_u16 {
            writer.set_frame_delay(1 + index, 60).unwrap();
            let pixels: Vec<_> = (0..48_u16)
                .flat_map(|pixel| {
                    [12345 + pixel + index * 1000, 23456, 34567, 45678]
                        .into_iter()
                        .flat_map(u16::to_be_bytes)
                })
                .collect();
            writer.write_image_data(&pixels).unwrap();
        }
        writer.finish().unwrap();
    }
    let output = encode(&original, REGION).unwrap();
    let mut reader = png::Decoder::new(Cursor::new(&output)).read_info().unwrap();
    assert_eq!(reader.info().bit_depth, png::BitDepth::Sixteen);
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    for index in 0..2_u16 {
        let frame = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((frame.width, frame.height), (5, 3));
        let control = reader.info().frame_control.unwrap();
        assert_eq!((control.delay_num, control.delay_den), (1 + index, 60));
        for y in 0..3_usize {
            for x in 0..5_usize {
                let offset = (y * 5 + x) * 8;
                let actual: Vec<_> = pixels[offset..offset + 8]
                    .chunks_exact(2)
                    .map(|word| u16::from_be_bytes([word[0], word[1]]))
                    .collect();
                assert_eq!(
                    actual,
                    [
                        12345 + ((y + 1) * 8 + x + 2) as u16 + index * 1000,
                        23456,
                        34567,
                        45678
                    ]
                );
            }
        }
    }
}

#[test]
fn animated_png_partial_frames_follow_all_exif_orientations() {
    for (tag, orientation) in [
        (1, image::metadata::Orientation::NoTransforms),
        (2, image::metadata::Orientation::FlipHorizontal),
        (3, image::metadata::Orientation::Rotate180),
        (4, image::metadata::Orientation::FlipVertical),
        (5, image::metadata::Orientation::Rotate90FlipH),
        (6, image::metadata::Orientation::Rotate90),
        (7, image::metadata::Orientation::Rotate270FlipH),
        (8, image::metadata::Orientation::Rotate270),
    ] {
        let mut original = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut original, 8, 6);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_animated(3, 2).unwrap();
            let mut writer = encoder.write_header().unwrap();
            let exif = [
                b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, tag, 0, 0, 0, 0,
                0, 0, 0,
            ];
            writer
                .write_chunk(png::chunk::ChunkType(*b"eXIf"), &exif)
                .unwrap();
            writer.set_frame_delay(7, 100).unwrap();
            writer.write_image_data(fixture().as_raw()).unwrap();
            writer.set_frame_dimension(3, 2).unwrap();
            writer.set_frame_position(3, 2).unwrap();
            writer.set_frame_delay(12, 100).unwrap();
            writer.set_blend_op(png::BlendOp::Over).unwrap();
            writer.set_dispose_op(png::DisposeOp::Previous).unwrap();
            writer
                .write_image_data(&[190, 45, 50, 128].repeat(6))
                .unwrap();
            writer.set_frame_position(0, 0).unwrap();
            writer.set_frame_dimension(1, 1).unwrap();
            writer.set_frame_delay(15, 100).unwrap();
            writer.set_dispose_op(png::DisposeOp::Background).unwrap();
            writer.write_image_data(&[10, 220, 50, 255]).unwrap();
            writer.finish().unwrap();
        }
        let source = image::codecs::png::PngDecoder::new(Cursor::new(&original))
            .unwrap()
            .apng()
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap();
        let mut first = DynamicImage::ImageRgba8(source[0].buffer().clone());
        first.apply_orientation(orientation);
        let crop = CropRect {
            left: 1,
            top: 1,
            right: first.width() - 1,
            bottom: first.height() - 1,
        };
        let output = encode(&original, crop).unwrap();
        let result = image::codecs::png::PngDecoder::new(Cursor::new(&output))
            .unwrap()
            .apng()
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap();
        assert_eq!(result.len(), source.len());
        for (actual, expected) in result.iter().zip(source) {
            let mut expected_image = DynamicImage::ImageRgba8(expected.buffer().clone());
            expected_image.apply_orientation(orientation);
            assert_eq!(actual.delay(), expected.delay());
            assert_eq!(
                actual.buffer(),
                &expected_image
                    .crop_imm(crop.left, crop.top, crop.width(), crop.height())
                    .to_rgba8(),
                "EXIF {tag}"
            );
        }
        assert_eq!(
            decoder(&output, ImageFormat::Png)
                .unwrap()
                .orientation()
                .unwrap(),
            image::metadata::Orientation::NoTransforms
        );
    }
}

#[test]
fn animated_png_adam7_partial_frame_rows_preserve_the_encoded_pixels() {
    let original = include_bytes!("fixtures/image-crop-interlaced-animation.png");
    let output = encode(original, REGION).unwrap();
    let frames = image::codecs::png::PngDecoder::new(Cursor::new(output))
        .unwrap()
        .apng()
        .unwrap()
        .into_frames()
        .collect_frames()
        .unwrap();
    assert_eq!(frames.len(), 2);
    for y in 0..3_u32 {
        for x in 0..5_u32 {
            assert_eq!(frames[0].buffer().get_pixel(x, y).0, [200, 20, 30, 255]);
            let expected = if x < 3 {
                [10 + x as u8 * 40, 100 + y as u8 * 30, 180, 255]
            } else {
                [200, 20, 30, 255]
            };
            assert_eq!(
                frames[1].buffer().get_pixel(x, y).0,
                expected,
                "partial pixel ({x},{y})"
            );
        }
    }
}

#[test]
fn icns_jp2_uniform_sampling_uses_decoded_representation_dimensions() {
    let mut source = icns::IconFamily::new();
    source.elements.push(icns::IconElement::new(
        icns::IconType::RGBA32_16x16.ostype(),
        include_bytes!("fixtures/image-crop-subsampled.jp2").to_vec(),
    ));
    let decoded = source
        .get_icon_with_type(icns::IconType::RGBA32_16x16)
        .unwrap()
        .convert_to(icns::PixelFormat::RGBA);
    assert_eq!((decoded.width(), decoded.height()), (16, 16));
    let mut original = Vec::new();
    source.write(&mut original).unwrap();
    let output = encode(
        &original,
        CropRect {
            left: 4,
            top: 2,
            right: 12,
            bottom: 10,
        },
    )
    .unwrap();
    let result = icns::IconFamily::read(output.as_slice()).unwrap();
    let result = result
        .get_icon_with_type(icns::IconType::RGBA32_16x16)
        .unwrap()
        .convert_to(icns::PixelFormat::RGBA);
    assert_eq!(&result.data()[..4], &[0, 0, 0, 0]);
    let to = ((4 * 16 + 4) * 4) as usize;
    let from = ((2 * 16 + 4) * 4) as usize;
    assert_eq!(&result.data()[to..to + 4], &decoded.data()[from..from + 4]);
}

#[test]
fn icns_keeps_every_original_canvas_density_and_transparent_padding() {
    let kinds = [icns::IconType::RGBA32_16x16, icns::IconType::RGBA32_64x64];
    let mut source = icns::IconFamily::new();
    for kind in kinds {
        let size = kind.pixel_width();
        let mut image = icns::Image::new(icns::PixelFormat::RGBA, size, size);
        for (index, pixel) in image.data_mut().chunks_exact_mut(4).enumerate() {
            pixel.copy_from_slice(&[
                (index as u32 % size) as u8,
                (index as u32 / size) as u8,
                155,
                255,
            ]);
        }
        source.add_icon_with_type(&image, kind).unwrap();
    }
    let mut original = Vec::new();
    source.write(&mut original).unwrap();
    let output = encode(
        &original,
        CropRect {
            left: 16,
            top: 8,
            right: 48,
            bottom: 40,
        },
    )
    .unwrap();
    let result = icns::IconFamily::read(output.as_slice()).unwrap();
    assert_eq!(result.available_icons(), source.available_icons());
    for kind in kinds {
        let decoded = result
            .get_icon_with_type(kind)
            .unwrap()
            .convert_to(icns::PixelFormat::RGBA);
        let size = kind.pixel_width();
        assert_eq!((decoded.width(), decoded.height()), (size, size));
        assert_eq!(&decoded.data()[..4], &[0, 0, 0, 0]);
        let offset = size / 4;
        let index = ((offset * size + offset) * 4) as usize;
        assert_eq!(
            &decoded.data()[index..index + 4],
            &[(size / 4) as u8, (size / 8) as u8, 155, 255]
        );
        let last = (((offset + size / 2 - 1) * size + offset + size / 2 - 1) * 4) as usize;
        assert_eq!(
            &decoded.data()[last..last + 4],
            &[(size * 3 / 4 - 1) as u8, (size * 5 / 8 - 1) as u8, 155, 255]
        );
    }
}

#[test]
fn icns_untrusted_element_lengths_are_rejected_before_allocation() {
    let mut input = b"icns\0\0\0\x10ic10".to_vec();
    input.extend_from_slice(&u32::MAX.to_be_bytes());
    assert!(encode(&input, REGION)
        .unwrap_err()
        .to_string()
        .contains("element length"));
    for length in [0_u32, 1, 7, 9, 100] {
        input[12..16].copy_from_slice(&length.to_be_bytes());
        assert!(encode(&input, REGION).is_err());
    }
}

#[test]
fn icns_maskless_monochrome_uses_same_size_masked_canvas() {
    let image =
        icns::Image::from_data(icns::PixelFormat::Gray, 32, 32, vec![255; 32 * 32]).unwrap();
    let mut source = icns::IconFamily::new();
    source
        .add_icon_with_type(&image, icns::IconType::Mono_32x32)
        .unwrap();
    let mut original = Vec::new();
    source.write(&mut original).unwrap();
    let output = encode(
        &original,
        CropRect {
            left: 8,
            top: 8,
            right: 24,
            bottom: 24,
        },
    )
    .unwrap();
    let result = icns::IconFamily::read(output.as_slice()).unwrap();
    let decoded = result
        .get_icon_with_type(icns::IconType::MonoA_32x32)
        .unwrap()
        .convert_to(icns::PixelFormat::RGBA);
    assert_eq!((decoded.width(), decoded.height()), (32, 32));
    assert_eq!(&decoded.data()[..4], &[0, 0, 0, 0]);
    let index = ((8 * 32 + 8) * 4) as usize;
    assert_eq!(&decoded.data()[index..index + 4], &[255, 255, 255, 255]);
}

#[test]
fn icns_existing_masked_representation_wins_over_maskless_promotion() {
    let mut source = icns::IconFamily::new();
    let bare = icns::Image::from_data(icns::PixelFormat::Gray, 32, 32, vec![255; 1024]).unwrap();
    source
        .add_icon_with_type(&bare, icns::IconType::Mono_32x32)
        .unwrap();
    let mut masked = icns::Image::new(icns::PixelFormat::RGBA, 32, 32);
    for (index, pixel) in masked.data_mut().chunks_exact_mut(4).enumerate() {
        pixel.copy_from_slice(&[0, 0, 0, if index == 8 * 32 + 8 { 0 } else { 255 }]);
    }
    source
        .add_icon_with_type(&masked, icns::IconType::MonoA_32x32)
        .unwrap();
    let mut original = Vec::new();
    source.write(&mut original).unwrap();
    let output = encode(
        &original,
        CropRect {
            left: 8,
            top: 8,
            right: 24,
            bottom: 24,
        },
    )
    .unwrap();
    let result = icns::IconFamily::read(output.as_slice()).unwrap();
    assert_eq!(
        crate::thumbnails::complete_icns_icons(&result),
        vec![icns::IconType::MonoA_32x32]
    );
    let actual = result
        .get_icon_with_type(icns::IconType::MonoA_32x32)
        .unwrap()
        .convert_to(icns::PixelFormat::RGBA);
    let first = ((8 * 32 + 8) * 4) as usize;
    assert_eq!(&actual.data()[first..first + 4], &[0, 0, 0, 0]);
    assert_eq!(&actual.data()[first + 4..first + 8], &[0, 0, 0, 255]);
}

#[test]
fn icns_jp2_tile_bomb_is_rejected_before_codec_allocation() {
    let mut stream = vec![0xff, 0x4f, 0xff, 0x51, 0, 41, 0, 0];
    for value in [1024_u32, 1024, 0, 0, 1, 1, 0, 0] {
        stream.extend_from_slice(&value.to_be_bytes());
    }
    stream.extend_from_slice(&[0, 1, 7, 1, 1]);
    let mut input = b"icns".to_vec();
    input.extend_from_slice(&((stream.len() + 16) as u32).to_be_bytes());
    input.extend_from_slice(b"ic10");
    input.extend_from_slice(&((stream.len() + 8) as u32).to_be_bytes());
    input.extend_from_slice(&stream);
    assert!(encode(&input, REGION)
        .unwrap_err()
        .to_string()
        .contains("tile-work limit"));
}

#[test]
fn interlaced_input_crops_decode_into_the_expected_scanlines() {
    let region = CropRect {
        left: 2,
        top: 1,
        right: 7,
        bottom: 21,
    };
    for original in [
        include_bytes!("fixtures/image-crop-interlaced.png").as_slice(),
        include_bytes!("fixtures/image-crop-interlaced.gif").as_slice(),
    ] {
        let source = image::load_from_memory(original).unwrap().to_rgba8();
        let output = encode(original, region).unwrap();
        let decoded = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_eq!(
            decoded,
            image::imageops::crop_imm(&source, 2, 1, 5, 20).to_image()
        );
    }
}

#[test]
fn gif_frames_outside_the_crop_keep_their_duration_without_changing_pixels() {
    let mut original = Vec::new();
    {
        let mut encoder =
            gif::Encoder::new(&mut original, 8, 6, &[0, 0, 0, 255, 0, 0, 0, 0, 255]).unwrap();
        encoder
            .write_frame(&gif::Frame {
                width: 8,
                height: 6,
                delay: 10,
                dispose: gif::DisposalMethod::Keep,
                buffer: std::borrow::Cow::Owned(vec![1; 48]),
                ..Default::default()
            })
            .unwrap();
        encoder
            .write_frame(&gif::Frame {
                width: 1,
                height: 1,
                delay: 20,
                dispose: gif::DisposalMethod::Previous,
                buffer: std::borrow::Cow::Owned(vec![2]),
                ..Default::default()
            })
            .unwrap();
    }
    let output = encode(&original, REGION).unwrap();
    let frames = image::codecs::gif::GifDecoder::new(Cursor::new(&output))
        .unwrap()
        .into_frames()
        .collect_frames()
        .unwrap();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].delay().numer_denom_ms(), (100, 1));
    assert_eq!(frames[1].delay().numer_denom_ms(), (200, 1));
    for frame in &frames {
        assert!(frame
            .buffer()
            .pixels()
            .all(|pixel| pixel.0 == [255, 0, 0, 255]));
    }
}
