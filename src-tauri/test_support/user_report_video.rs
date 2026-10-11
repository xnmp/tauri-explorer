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
