use super::*;
use image::AnimationDecoder;
use std::io::Cursor;

fn animated_frames(bytes: &[u8], extension: &str) -> Vec<image::Frame> {
    match extension {
        "gif" => {
            let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).unwrap();
            assert!(
                matches!(decoder.loop_count(), image::metadata::LoopCount::Finite(n) if n.get() == 3)
            );
            decoder.into_frames().collect_frames().unwrap()
        }
        "webp" => {
            let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).unwrap();
            assert!(decoder.has_animation());
            assert!(
                matches!(decoder.loop_count(), image::metadata::LoopCount::Finite(n) if n.get() == 3)
            );
            decoder.into_frames().collect_frames().unwrap()
        }
        "png" => {
            let metadata = png::Decoder::new(Cursor::new(bytes)).read_info().unwrap();
            let animation = metadata.info().animation_control.unwrap();
            assert_eq!((animation.num_frames, animation.num_plays), (3, 3));
            image::codecs::png::PngDecoder::new(Cursor::new(bytes))
                .unwrap()
                .apng()
                .unwrap()
                .into_frames()
                .collect_frames()
                .unwrap()
        }
        _ => unreachable!("fixture format"),
    }
}

#[tokio::test]
async fn real_copy_preserves_saved_animation_frames_timing_and_repetition() {
    for (extension, original) in [
        (
            "gif",
            include_bytes!("fixtures/image-crop-animation.gif").as_slice(),
        ),
        (
            "webp",
            include_bytes!("fixtures/image-crop-animation.webp").as_slice(),
        ),
        (
            "png",
            include_bytes!("fixtures/image-crop-animation.png").as_slice(),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(format!("source.{extension}"));
        fs::write(&path, original).unwrap();
        let captured = capture(path.clone()).unwrap();
        let mut save = request(
            &path,
            captured.revision,
            Destination::Copy {
                name: format!("copy.{extension}"),
            },
        );
        save.rect.bottom = 4;
        let runtime = super::super::admission::Runtime::new(root.path().join("recovery"));
        let receipt = execute(SavePlan::new(save).unwrap(), &runtime)
            .await
            .completion
            .result
            .unwrap();
        let output = fs::read(&receipt.path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), original, "{extension}");
        let expected = animated_frames(original, extension);
        let actual = animated_frames(&output, extension);
        assert_eq!(expected.len(), 3);
        assert_eq!(actual.len(), expected.len());
        for (actual, source) in actual.iter().zip(&expected) {
            assert_eq!(actual.delay(), source.delay());
            assert_eq!(
                actual.buffer(),
                &image::imageops::crop_imm(source.buffer(), 2, 1, 5, 3).to_image()
            );
        }
    }
}

#[tokio::test]
async fn real_copy_preserves_saved_avif_animation_pixels_and_timing() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("source.avif");
    let original = include_bytes!("fixtures/image-crop-animation.avif");
    fs::write(&path, original).unwrap();
    let captured = capture(path.clone()).unwrap();
    let mut save = request(
        &path,
        captured.revision,
        Destination::Copy {
            name: "copy.avif".into(),
        },
    );
    save.viewport = image_crop::SvgViewport {
        width: 16,
        height: 12,
    };
    save.rect = image_crop::CropRect {
        left: 3,
        top: 2,
        right: 13,
        bottom: 9,
    };
    let runtime = super::super::admission::Runtime::new(root.path().join("recovery"));
    let receipt = execute(SavePlan::new(save).unwrap(), &runtime)
        .await
        .completion
        .result
        .unwrap();
    let output = fs::read(&receipt.path).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    for (index, duration) in [7, 12, 15].into_iter().enumerate() {
        let source = explorer_avif::decode_frame(original, index as u32).unwrap();
        let actual = explorer_avif::decode_frame(&output, index as u32).unwrap();
        assert_eq!((actual.metadata.width, actual.metadata.height), (10, 7));
        assert_eq!(
            (
                actual.metadata.frame_count,
                actual.metadata.repetitions,
                actual.metadata.timescale,
                actual.metadata.frame_duration
            ),
            (3, 2, 100, duration)
        );
        for y in 0..7_usize {
            for x in 0..10_usize {
                let actual_pixel = (y * 10 + x) * 4;
                let source_pixel = ((y + 2) * 16 + x + 3) * 4;
                assert_eq!(
                    &actual.pixels[actual_pixel..actual_pixel + 4],
                    &source.pixels[source_pixel..source_pixel + 4]
                );
            }
        }
    }
    assert!(explorer_avif::decode_frame(&output, 3).is_err());
}

#[test]
fn capture_pins_bytes_and_rejects_changed_contents() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.png");
    fs::write(&path, b"first").unwrap();
    let (bytes, revision, _) = read_source(&path).unwrap();
    assert_eq!(bytes, b"first");
    assert_eq!(verify_source(&path, &revision).unwrap().0, b"first");
    fs::write(&path, b"other").unwrap();
    assert!(verify_source(&path, &revision).is_err());
}

#[test]
fn restored_timestamp_does_not_hide_a_content_edit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.png");
    fs::write(&path, b"first").unwrap();
    let (_, revision, _) = read_source(&path).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, b"other").unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(verify_source(&path, &revision).is_err());
}

fn source(root: &Path) -> (PathBuf, Vec<u8>, SourceRevision) {
    let path = root.join("source.png");
    let pixels = image::RgbaImage::from_fn(8, 6, |x, y| {
        image::Rgba([
            x as u8 * 20,
            y as u8 * 30,
            120,
            if x < 3 { 90 } else { 255 },
        ])
    });
    pixels.save(&path).unwrap();
    let (bytes, revision, _) = read_source(&path).unwrap();
    (path, bytes, revision)
}

#[test]
fn native_capture_returns_original_bytes_and_refuses_a_misleading_extension() {
    let root = tempfile::tempdir().unwrap();
    let (path, bytes, revision) = source(root.path());
    let captured = capture(path.clone()).unwrap();
    assert_eq!(captured.revision, revision);
    assert_eq!(captured.format, "PNG");
    assert_eq!(
        STANDARD
            .decode(
                captured
                    .data_url
                    .strip_prefix("data:image/png;base64,")
                    .unwrap()
            )
            .unwrap(),
        bytes
    );
    let wrong = root.path().join("source.jpg");
    fs::rename(&path, &wrong).unwrap();
    assert!(capture(wrong.clone()).is_err());
    assert_eq!(fs::read(&wrong).unwrap(), bytes);
}
fn request(path: &Path, revision: SourceRevision, destination: Destination) -> SaveRequest {
    SaveRequest {
        path: path.to_string_lossy().into_owned(),
        revision,
        destination,
        rect: image_crop::CropRect {
            left: 2,
            top: 1,
            right: 7,
            bottom: 5,
        },
        viewport: image_crop::SvgViewport {
            width: 8,
            height: 6,
        },
    }
}

#[tokio::test]
async fn real_copy_saves_exact_region_and_preserves_original_bytes() {
    let root = tempfile::tempdir().unwrap();
    let (path, bytes, revision) = source(root.path());
    let runtime = super::super::admission::Runtime::new(root.path().join("recovery"));
    let plan = SavePlan::new(request(
        &path,
        revision,
        Destination::Copy {
            name: "copy.png".into(),
        },
    ))
    .unwrap();
    let result = execute(plan, &runtime).await.completion.result.unwrap();
    let actual = image::open(&result.path).unwrap().to_rgba8();
    let expected = image::load_from_memory(&bytes)
        .unwrap()
        .crop_imm(2, 1, 5, 4)
        .to_rgba8();
    assert_eq!(actual, expected);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        result.entry.unwrap().size,
        fs::metadata(&result.path).unwrap().len()
    );
}

#[tokio::test]
async fn copy_collision_and_changed_source_leave_both_files_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let (path, bytes, revision) = source(root.path());
    let runtime = super::super::admission::Runtime::new(root.path().join("recovery"));
    let target = root.path().join("copy.png");
    fs::write(&target, b"sentinel").unwrap();
    let plan = SavePlan::new(request(
        &path,
        revision.clone(),
        Destination::Copy {
            name: "copy.png".into(),
        },
    ))
    .unwrap();
    assert!(execute(plan, &runtime).await.completion.result.is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read(&target).unwrap(), b"sentinel");
    fs::write(&path, b"new source").unwrap();
    let plan = SavePlan::new(request(&path, revision, Destination::Replace)).unwrap();
    assert!(execute(plan, &runtime).await.completion.result.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"new source");
    assert_eq!(fs::read(&target).unwrap(), b"sentinel");
}

#[tokio::test]
async fn real_replacement_saves_region_and_keeps_native_receipt() {
    let root = tempfile::tempdir().unwrap();
    let (path, bytes, revision) = source(root.path());
    let runtime = super::super::admission::Runtime::new(root.path().join("recovery"));
    let plan = SavePlan::new(request(&path, revision, Destination::Replace)).unwrap();
    let receipt = execute(plan, &runtime).await.completion.result.unwrap();
    assert_eq!(
        image::open(&path).unwrap().to_rgba8(),
        image::load_from_memory(&bytes)
            .unwrap()
            .crop_imm(2, 1, 5, 4)
            .to_rgba8()
    );
    assert_eq!(receipt.path, path.to_string_lossy());
    assert!(receipt.publication.is_none());
    #[cfg(target_os = "linux")]
    {
        assert_eq!(
            receipt.replacement.is_some(),
            super::super::recovery::Runtime::DURABLE
        );
        if let Some(replacement) = receipt.replacement {
            // The generated source/parent were private staging owned only by
            // the forward save. Undo and Redo must survive their cleanup.
            assert!(!fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tauri-explorer-stage-")));
            let crop = fs::read(&path).unwrap();
            let restored = runtime
                .execute_history(
                    replacement.history,
                    super::super::recovery::ReplacementDirection::Restore,
                )
                .await
                .unwrap();
            assert_eq!(fs::read(&path).unwrap(), bytes);
            runtime
                .execute_history(
                    restored.history,
                    super::super::recovery::ReplacementDirection::Reapply,
                )
                .await
                .unwrap();
            assert_eq!(fs::read(&path).unwrap(), crop);
        }
    }
}

#[test]
fn failed_replacement_rolls_back_without_replacing_a_foreign_writer() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.png");
    fs::write(&path, b"original").unwrap();
    let failure = super::super::replacement::replace_verified(
        &path,
        |_| {
            fs::write(&path, b"foreign writer").unwrap();
            Err(AppError::Other("refused before publication".into()))
        },
        || Ok(()),
    )
    .err()
    .unwrap();
    assert!(matches!(failure, AppError::MutationUncertain(_)));
    assert_eq!(fs::read(&path).unwrap(), b"foreign writer");
    let recovery = fs::read_dir(root.path())
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".tauri-explorer-recovery-")
        })
        .unwrap();
    assert_eq!(
        fs::read(recovery.path().join("original")).unwrap(),
        b"original"
    );
}

#[test]
fn refused_replacement_restores_original_bytes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.png");
    fs::write(&path, b"original").unwrap();
    assert!(super::super::replacement::replace_verified(
        &path,
        |_| Err(AppError::Other("source changed".into())),
        || Ok(())
    )
    .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"original");
}

#[test]
fn malformed_region_and_copy_destination_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let (path, bytes, revision) = source(root.path());
    for name in ["../escape.png", "source.png", "copy.jpg", "", "."] {
        assert!(SavePlan::new(request(
            &path,
            revision.clone(),
            Destination::Copy { name: name.into() }
        ))
        .is_err());
    }
    let mut empty = request(&path, revision, Destination::Replace);
    empty.rect.right = empty.rect.left;
    assert!(SavePlan::new(empty).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn identical_replacement_is_a_different_source() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.png");
    fs::write(&path, b"first").unwrap();
    let (_, revision, _) = read_source(&path).unwrap();
    fs::rename(&path, root.path().join("retained.png")).unwrap();
    fs::write(&path, b"first").unwrap();
    assert!(verify_source(&path, &revision).is_err());
}

#[test]
fn directory_and_oversized_file_are_refused_before_read() {
    let root = tempfile::tempdir().unwrap();
    assert!(read_source(root.path()).is_err());
    let path = root.path().join("large.png");
    File::create(&path)
        .unwrap()
        .set_len(MAX_CAPTURE_BYTES + 1)
        .unwrap();
    assert!(read_source(&path).is_err());
}

#[cfg(unix)]
#[test]
fn symlink_is_refused_without_touching_target() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("image.png");
    let alias = root.path().join("alias.png");
    fs::write(&path, b"first").unwrap();
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    assert!(read_source(&alias).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"first");
}

#[tokio::test]
async fn canonical_capture_and_save_use_the_same_oriented_pixel_grid() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oriented.png");
    let original = include_bytes!("../../e2e-tauri/fixtures/image-crop/oriented.png");
    fs::write(&path, original).unwrap();
    let captured = capture(path.clone()).unwrap();
    let preview = STANDARD
        .decode(
            captured
                .data_url
                .strip_prefix("data:image/png;base64,")
                .unwrap(),
        )
        .unwrap();
    let expected = image::load_from_memory(original)
        .unwrap()
        .rotate90()
        .to_rgba8();
    let observed = image::load_from_memory(&preview).unwrap().to_rgba8();
    assert_eq!(observed.dimensions(), (384, 512));
    assert_eq!(observed, expected);
    let mut save = request(
        &path,
        captured.revision,
        Destination::Copy {
            name: "copy.png".into(),
        },
    );
    save.viewport = image_crop::SvgViewport {
        width: 384,
        height: 512,
    };
    save.rect = image_crop::CropRect {
        left: 24,
        top: 32,
        right: 360,
        bottom: 480,
    };
    let runtime = super::super::admission::Runtime::new(root.path().join("recovery"));
    let receipt = execute(SavePlan::new(save).unwrap(), &runtime)
        .await
        .completion
        .result
        .unwrap();
    assert_eq!(
        image::load_from_memory(&fs::read(receipt.path).unwrap())
            .unwrap()
            .to_rgba8(),
        image::imageops::crop_imm(&expected, 24, 32, 336, 448).to_image()
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn canonical_capture_preserves_every_oriented_apng_frame_and_timing() {
    use image::metadata::Orientation;
    let input = include_bytes!("fixtures/image-crop-animation.png");
    for (tag, orientation) in [
        (1, Orientation::NoTransforms),
        (2, Orientation::FlipHorizontal),
        (3, Orientation::Rotate180),
        (4, Orientation::FlipVertical),
        (5, Orientation::Rotate90FlipH),
        (6, Orientation::Rotate90),
        (7, Orientation::Rotate270FlipH),
        (8, Orientation::Rotate270),
    ] {
        let exif = [
            73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, tag, 0, 0, 0, 0, 0, 0, 0,
        ];
        let mut encoded = Vec::new();
        {
            let mut header = png::Encoder::new(&mut encoded, 1, 1)
                .write_header()
                .unwrap();
            header
                .write_chunk(png::chunk::ChunkType(*b"eXIf"), &exif)
                .unwrap();
        }
        let original = [
            &input[..33],
            &encoded[33..33 + 12 + exif.len()],
            &input[33..],
        ]
        .concat();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("animated.png");
        fs::write(&path, &original).unwrap();
        let captured = capture(path.clone()).unwrap();
        let preview = STANDARD
            .decode(
                captured
                    .data_url
                    .strip_prefix("data:image/png;base64,")
                    .unwrap(),
            )
            .unwrap();
        let expected = animated_frames(&original, "png");
        let actual = animated_frames(&preview, "png");
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            let mut oriented = image::DynamicImage::ImageRgba8(expected.buffer().clone());
            oriented.apply_orientation(orientation);
            assert_eq!(actual.buffer(), &oriented.to_rgba8(), "EXIF {tag}");
            assert_eq!(actual.delay(), expected.delay());
        }
        assert_eq!(fs::read(path).unwrap(), original);
    }
}

#[test]
fn normalized_preview_refusal_preserves_the_captured_source() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oriented.png");
    let original = include_bytes!("../../e2e-tauri/fixtures/image-crop/oriented.png");
    fs::write(&path, original).unwrap();
    assert!(original.len() as u64 <= MAX_CAPTURE_BYTES);
    let error = capture_with_preview_limit(path.clone(), 1024)
        .err()
        .unwrap();
    assert!(error
        .to_string()
        .contains("Normalized image preview exceeds"));
    assert_eq!(fs::read(path).unwrap(), original);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn canonical_avif_capture_preserves_pixel_grid_and_every_frame() {
    for name in [
        "image-crop-static.avif",
        "image-crop-oriented.avif",
        "image-crop-aspect.avif",
        "image-crop-animation.avif",
        "image-crop-one-frame-sequence.avif",
        "image-crop-sixteen-bit.avif",
        "image-crop-gain-map-oriented.avif",
    ] {
        let original = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("test_support/fixtures")
                .join(name),
        )
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(name);
        fs::write(&path, &original).unwrap();
        let captured = capture(path.clone()).unwrap();
        let preview = STANDARD
            .decode(
                captured
                    .data_url
                    .strip_prefix("data:image/avif;base64,")
                    .unwrap(),
            )
            .unwrap();
        let frames = explorer_avif::decode_frame(&original, 0)
            .unwrap()
            .metadata
            .frame_count;
        for index in 0..frames {
            let expected = explorer_avif::decode_frame(&original, index).unwrap();
            let actual = explorer_avif::decode_frame(&preview, index).unwrap();
            assert_eq!(
                (actual.metadata.width, actual.metadata.height),
                (expected.metadata.width, expected.metadata.height),
                "{name}"
            );
            assert_eq!(actual.pixels, expected.pixels, "{name}/{index}");
            assert_eq!(actual.metadata.depth, expected.metadata.depth);
            assert_eq!(actual.metadata.frame_count, expected.metadata.frame_count);
            assert_eq!(actual.metadata.timescale, expected.metadata.timescale);
            assert_eq!(
                actual.metadata.frame_duration,
                expected.metadata.frame_duration
            );
            assert_eq!(actual.metadata.repetitions, expected.metadata.repetitions);
            assert_eq!(
                actual.metadata.sequence_present,
                expected.metadata.sequence_present
            );
        }
        assert!(explorer_avif::decode_frame(&preview, frames).is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }
}

#[test]
fn canonical_capture_preserves_oriented_animated_webp_frames_and_timing() {
    use image::metadata::Orientation;
    let input = include_bytes!("fixtures/image-crop-animation.webp");
    for (tag, orientation) in [
        (1, Orientation::NoTransforms),
        (2, Orientation::FlipHorizontal),
        (3, Orientation::Rotate180),
        (4, Orientation::FlipVertical),
        (5, Orientation::Rotate90FlipH),
        (6, Orientation::Rotate90),
        (7, Orientation::Rotate270FlipH),
        (8, Orientation::Rotate270),
    ] {
        let exif = [
            73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, tag, 0, 0, 0, 0, 0, 0, 0,
        ];
        let mut original = input.to_vec();
        assert_eq!(&original[12..16], b"VP8X");
        original[20] |= 8;
        original.extend_from_slice(b"EXIF");
        original.extend_from_slice(&(exif.len() as u32).to_le_bytes());
        original.extend_from_slice(&exif);
        let length = (original.len() as u32 - 8).to_le_bytes();
        original[4..8].copy_from_slice(&length);
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("animated.webp");
        fs::write(&path, &original).unwrap();
        let captured = capture(path.clone()).unwrap();
        let preview = STANDARD
            .decode(
                captured
                    .data_url
                    .strip_prefix("data:image/webp;base64,")
                    .unwrap(),
            )
            .unwrap();
        let expected = animated_frames(&original, "webp");
        let actual = animated_frames(&preview, "webp");
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            let mut oriented = image::DynamicImage::ImageRgba8(expected.buffer().clone());
            oriented.apply_orientation(orientation);
            assert_eq!(actual.buffer(), &oriented.to_rgba8(), "EXIF {tag}");
            assert_eq!(actual.delay(), expected.delay());
        }
        assert_eq!(fs::read(path).unwrap(), original);
    }
}
