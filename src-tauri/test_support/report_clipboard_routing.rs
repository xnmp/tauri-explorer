use super::*;
use std::cell::Cell;

struct Reader {
    image: Option<Vec<u8>>,
    image_reads: Cell<usize>,
}
impl Reader {
    fn new(image: bool) -> Self {
        Self {
            image: image.then(|| b"\x89PNG\r\n\x1a\npayload".to_vec()),
            image_reads: Cell::new(0),
        }
    }
}
impl ClipboardReader for Reader {
    fn read_text(&self) -> Result<String, AppError> {
        Ok(String::new())
    }
    fn has_image(&self) -> bool {
        self.image.is_some()
    }
    fn read_image(&self, media: &str) -> Option<Vec<u8>> {
        self.image_reads.set(self.image_reads.get() + 1);
        if media == "image/png" {
            self.image.clone()
        } else {
            None
        }
    }
}
fn message(error: crate::user_report::SubmitReportError) -> String {
    serde_json::to_value(error).unwrap()["message"]
        .as_str()
        .unwrap()
        .to_string()
}
#[test]
fn png_file_list_does_not_hide_clipboard_image_data() {
    let reader = Reader::new(true);
    let attachment = read_report_attachment(&["/tmp/foo.png".into()], &reader).unwrap();
    assert_eq!(attachment.media_type, "image/png");
    assert_eq!(attachment.name, "Clipboard screenshot.png");
    assert_eq!(
        attachment.data,
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            reader.image.as_ref().unwrap()
        )
    );
}
#[test]
fn supported_video_takes_priority_over_image_data() {
    let directory = tempfile::tempdir().unwrap();
    for name in ["clip.mp4", "clip.MP4"] {
        let path = directory.path().join(name);
        std::fs::write(&path, b"\0\0\0\x18ftypisom\0\0\0\0isommp42").unwrap();
        let reader = Reader::new(true);
        let attachment =
            read_report_attachment(&[path.to_string_lossy().into_owned()], &reader).unwrap();
        assert_eq!(attachment.name, name);
        assert_eq!(attachment.media_type, "video/mp4");
        assert_eq!(reader.image_reads.get(), 0);
    }
}
#[test]
fn multiple_files_report_copy_one_without_reading_image() {
    let reader = Reader::new(true);
    let error = read_report_attachment(&["/tmp/foo.png".into(), "/tmp/clip.mp4".into()], &reader)
        .unwrap_err();
    assert!(message(error).contains("Copy one"));
    assert_eq!(reader.image_reads.get(), 0);
}
#[test]
fn unsupported_file_without_image_has_an_explicit_error() {
    let error = read_report_attachment(&["/tmp/file.txt".into()], &Reader::new(false)).unwrap_err();
    assert!(message(error).contains("Unsupported clipboard file"));
}
#[test]
fn unsupported_paths_do_not_enable_the_button_without_image_data() {
    for path in ["/tmp/foo.png", "/tmp/file.txt", "/tmp/folder"] {
        assert!(!has_report_attachment(&[path.into()], &Reader::new(false)).unwrap());
        assert!(has_report_attachment(&[path.into()], &Reader::new(true)).unwrap());
    }
    assert!(has_report_attachment(&["/tmp/clip.MOV".into()], &Reader::new(false)).unwrap());
    assert!(has_report_attachment(
        &["/tmp/a.txt".into(), "/tmp/clip.webm".into()],
        &Reader::new(false)
    )
    .unwrap());
}
#[test]
fn no_paths_preserves_image_result_and_no_image_error() {
    assert_eq!(
        read_report_attachment(&[], &Reader::new(true))
            .unwrap()
            .media_type,
        "image/png"
    );
    assert_eq!(
        message(read_report_attachment(&[], &Reader::new(false)).unwrap_err()),
        "No image data in clipboard"
    );
    assert!(!has_report_attachment(&[], &Reader::new(false)).unwrap());
}

#[test]
fn malformed_image_data_keeps_its_validation_error_with_non_video_path() {
    let reader = Reader {
        image: Some(b"not PNG bytes".to_vec()),
        image_reads: Cell::new(0),
    };
    let error = read_report_attachment(&["/tmp/foo.png".into()], &reader).unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["kind"],
        "malformed_input"
    );
    assert_eq!(reader.image_reads.get(), 1);
}
