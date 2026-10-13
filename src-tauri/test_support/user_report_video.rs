use super::*;
#[test]
fn video_reports_validate_at_native_submission_boundary() {
    for (media, bytes) in [
        ("video/mp4", &b"\0\0\0\x18ftypisom\0\0\0\0isommp42"[..]),
        ("video/quicktime", &b"\0\0\0\x14ftypqt  \0\0\0\0qt  "[..]),
        ("video/webm", &b"\x1a\x45\xdf\xa3"[..]),
    ] {
        let attachment = attachment_from_image_bytes("clip".into(), media, bytes.to_vec()).unwrap();
        validate_attachments(&[attachment]).unwrap();
        assert!(attachment_from_image_bytes("fake".into(), media, b"notmedia".to_vec()).is_err());
    }
}

#[test]
fn copied_video_file_is_bounded_and_validated() {
    let dir = tempfile::tempdir().unwrap();
    for (name, bytes, media) in [
        (
            "clip.MP4",
            &b"\0\0\0\x18ftypisom\0\0\0\0isommp42"[..],
            "video/mp4",
        ),
        (
            "clip.mov",
            &b"\0\0\0\x14ftypqt  \0\0\0\0qt  "[..],
            "video/quicktime",
        ),
        ("clip.webm", &b"\x1a\x45\xdf\xa3"[..], "video/webm"),
    ] {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        let attachment =
            attachment_from_clipboard_files(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(attachment.name, name);
        assert_eq!(attachment.media_type, media);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(attachment.data)
                .unwrap(),
            bytes
        );
    }
    let path = dir.path().join("clip.mp4");
    std::fs::write(&path, b"GIF89a").unwrap();
    let paths = vec![path.to_string_lossy().into_owned()];
    assert_eq!(
        attachment_from_clipboard_files(&paths).unwrap_err().kind,
        "malformed_input"
    );
    std::fs::File::create(&path)
        .unwrap()
        .set_len(MAX_ATTACHMENT_BYTES as u64 + 1)
        .unwrap();
    assert!(attachment_from_clipboard_files(&paths)
        .unwrap_err()
        .message
        .contains("shorter clip"));
    assert!(
        attachment_from_clipboard_files(&[paths[0].clone(), paths[0].clone()])
            .unwrap_err()
            .message
            .contains("Copy one")
    );
    assert!(attachment_from_clipboard_files(&[dir
        .path()
        .join("bad.avi")
        .to_string_lossy()
        .into_owned()])
    .unwrap_err()
    .message
    .contains("Unsupported"));
}

#[test]
fn native_video_validation_retains_limits_and_container_identity() {
    assert!(attachment_from_image_bytes(
        "clip".into(),
        "video/mp4",
        b"\0\0\0\x14ftypqt  \0\0\0\0qt  ".to_vec()
    )
    .is_err());
    assert!(attachment_from_image_bytes(
        "clip".into(),
        "video/quicktime",
        b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec()
    )
    .is_err());
    let mut bytes = vec![0; MAX_ATTACHMENT_BYTES];
    bytes[..4].copy_from_slice(b"\x1a\x45\xdf\xa3");
    let at_limit = attachment_from_image_bytes("clip".into(), "video/webm", bytes.clone()).unwrap();
    assert!(validate_attachments(&[at_limit.clone(), at_limit.clone()])
        .unwrap_err()
        .message
        .contains("3 MiB"));
    assert!(validate_attachments(&vec![at_limit; 4]).is_err());
    bytes.push(0);
    assert!(
        attachment_from_image_bytes("clip".into(), "video/webm", bytes)
            .unwrap_err()
            .message
            .contains("shorter clip")
    );
}
