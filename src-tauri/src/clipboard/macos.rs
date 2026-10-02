//! macOS clipboard: `NSPasteboard` file-list writes, `clipboard-rs` file-list
//! reads, `pbpaste` for text, and `osascript` for images (#162).
//! AppleScript's «class PNGf» coercion reads the general pasteboard as PNG
//! (AppKit transcodes TIFF screenshots) and returns a hex dump that
//! `parse_applescript_png` decodes. The parser also compiles in tests on
//! every platform so it stays covered off-Mac.
//!
//! Cut ownership (#877): one prepared pasteboard batch carries a file-URL
//! item per path, with the write's private token on its first item. This
//! matches clipboard-rs 0.3's NSURL reader. `changeCount` is then read
//! around a read-back of the files and token (`change_counter.rs`); the
//! write owns the pasteboard while the count is
//! unchanged; an external pasteboard replacement ends that ownership.

#[cfg(target_os = "macos")]
pub(super) use platform::{backend, reader};

#[cfg(target_os = "macos")]
mod platform {
    use super::{parse_applescript_png, valid_file_paths};
    use crate::clipboard::backend::{
        ClipboardBackend, ClipboardOperation, ClipboardReader, SelectionOwner,
    };
    use crate::clipboard::change_counter::CounterOwnership;
    use crate::error::AppError;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSString, NSURL};
    use std::process::Command;

    /// The private pasteboard type that carries a write's token. The change
    /// count, not the type, proves ownership; the token proves that the count
    /// observed after the write names this write.
    pub(super) const TOKEN_TYPE: &str = "io.github.xnmp.tauri-explorer.file-clipboard-token";

    pub(in crate::clipboard) fn backend() -> Box<dyn ClipboardBackend> {
        Box::new(MacFileClipboard::default())
    }

    pub(in crate::clipboard) fn reader() -> Box<dyn ClipboardReader> {
        Box::new(MacClipboard)
    }

    /// Stateless text and image reads.
    struct MacClipboard;

    /// The worker-owned file-list backend.
    #[derive(Default)]
    struct MacFileClipboard {
        ownership: CounterOwnership,
    }

    fn pasteboard() -> Result<clipboard_rs::ClipboardContext, AppError> {
        clipboard_rs::ClipboardContext::new()
            .map_err(|error| AppError::Other(format!("Mac clipboard unavailable: {error}")))
    }

    fn change_count() -> i64 {
        autoreleasepool(|_| NSPasteboard::generalPasteboard().changeCount() as i64)
    }

    /// Publish prepared file-URL items together with their private token.
    /// Preparing the representations first keeps the token and files in the
    /// same writeObjects batch, rather than adding a token to a later writer.
    fn write_pasteboard(paths: &[String], token: &str) -> (bool, bool) {
        autoreleasepool(|_| {
            let items: Option<Vec<Retained<NSPasteboardItem>>> = paths
                .iter()
                .map(|path| {
                    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
                    let url = url.absoluteString()?;
                    let item = NSPasteboardItem::new();
                    // SAFETY: the pasteboard type is an immutable AppKit constant.
                    item.setString_forType(&url, unsafe { NSPasteboardTypeFileURL })
                        .then_some(item)
                })
                .collect();
            let Some(items) = items else {
                return (false, false);
            };
            let Some(first) = items.first() else {
                return (false, false);
            };
            let wrote_token = first.setData_forType(
                &NSData::with_bytes(token.as_bytes()),
                &NSString::from_str(TOKEN_TYPE),
            );
            let objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
                .into_iter()
                .map(ProtocolObject::from_retained)
                .collect();
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            let wrote_files = pasteboard.writeObjects(&NSArray::from_retained_slice(&objects));
            (wrote_files, wrote_token)
        })
    }

    fn read_token() -> Option<Vec<u8>> {
        autoreleasepool(|_| {
            NSPasteboard::generalPasteboard()
                .dataForType(&NSString::from_str(TOKEN_TYPE))
                .map(|data| data.to_vec())
        })
    }

    impl ClipboardBackend for MacFileClipboard {
        fn read_files(&mut self) -> Result<Vec<String>, AppError> {
            use clipboard_rs::Clipboard;
            // clipboard-rs reports an empty clipboard as "no files".
            Ok(pasteboard()?.get_files().unwrap_or_default())
        }

        fn write_files(
            &mut self,
            paths: &[String],
            _operation: ClipboardOperation,
            token: &str,
        ) -> Result<(), AppError> {
            if !valid_file_paths(paths) {
                return Err(AppError::InvalidPath(
                    "Clipboard file paths must be nonempty, absolute and contain no NUL bytes"
                        .into(),
                ));
            }
            let (wrote_files, wrote_token) = write_pasteboard(paths, token);
            if !wrote_files {
                return Err(AppError::Other("Mac clipboard write failed".into()));
            }
            // Accept ownership only when both the private token and the
            // ordered file list read back at a stable change count.
            let before = Some(change_count());
            let files_read_back = self.read_files().is_ok_and(|files| files == paths);
            let read_back = read_token().filter(|_| wrote_token && files_read_back);
            let after = Some(change_count());
            self.ownership
                .record_write(token, before, read_back.as_deref(), after);
            Ok(())
        }

        fn owner_token(&mut self) -> Option<String> {
            self.ownership.owner_token(Some(change_count()))
        }

        /// The change count identifies the ownership generation, which is
        /// what a failed Copy mirror compares.
        fn selection_owner(&mut self) -> SelectionOwner {
            SelectionOwner::Known(change_count().unsigned_abs())
        }

        fn cut_unavailable_reason(&self) -> Option<&'static str> {
            None
        }
    }

    impl ClipboardReader for MacClipboard {
        fn read_text(&self) -> Result<String, AppError> {
            let output = Command::new("pbpaste")
                .output()
                .map_err(|error| AppError::Other(format!("Failed to start pbpaste: {error}")))?;
            if !output.status.success() {
                return Err(AppError::Other(format!(
                    "pbpaste exited with {}",
                    output.status
                )));
            }
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }

        fn has_image(&self) -> bool {
            self.has_image_result().unwrap_or(false)
        }

        fn has_image_result(&self) -> Result<bool, AppError> {
            let output = Command::new("osascript")
                .args(["-e", "clipboard info"])
                .output()
                .map_err(|error| {
                    AppError::Other(format!("Could not inspect clipboard: {error}"))
                })?;
            if !output.status.success() {
                return Err(AppError::Other(format!(
                    "Could not inspect clipboard: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            let info = String::from_utf8_lossy(&output.stdout);
            Ok(info.contains("PNGf") || info.contains("TIFF") || info.contains("picture"))
        }

        /// PNG only: AppKit transcodes other pasteboard images to it.
        fn read_image(&self, media_type: &str) -> Option<Vec<u8>> {
            self.read_image_result(media_type).ok().flatten()
        }

        fn read_image_result(&self, media_type: &str) -> Result<Option<Vec<u8>>, AppError> {
            if media_type != "image/png" {
                return Ok(None);
            }
            if !self.has_image_result()? {
                return Ok(None);
            }
            let output = Command::new("osascript")
                .args(["-e", "get the clipboard as \u{ab}class PNGf\u{bb}"])
                .output()
                .map_err(|error| {
                    AppError::Other(format!("Could not read clipboard image: {error}"))
                })?;
            if !output.status.success() {
                return Err(AppError::Other(format!(
                    "Could not read or encode clipboard image: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            parse_applescript_png(&String::from_utf8_lossy(&output.stdout))
                .map(Some)
                .ok_or_else(|| {
                    AppError::Other("Clipboard image encoding returned invalid PNG data".into())
                })
        }
    }
}

// NSURL resolves relative and empty paths against the working directory.
// Reject those inputs before the writer can replace the current clipboard.
#[cfg(any(target_os = "macos", test))]
fn valid_file_paths(paths: &[String]) -> bool {
    !paths.is_empty()
        && paths
            .iter()
            .all(|path| path.starts_with('/') && !path.contains('\0'))
}

/// Parse osascript's «data PNGf<hex>» output into PNG bytes.
fn parse_applescript_png(text: &str) -> Option<Vec<u8>> {
    let tag = "\u{ab}data PNGf"; // «data PNGf
    let start = text.find(tag)? + tag.len();
    let end = text[start..].find('\u{bb}')? + start; // »
    let hex: String = text[start..end]
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    if hex.len() < 16 || !hex.len().is_multiple_of(2) {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    let bytes = bytes?;
    if bytes.len() < 8 || &bytes[..4] != b"\x89PNG" {
        return None;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::{parse_applescript_png, valid_file_paths};

    #[test]
    fn file_paths_require_an_absolute_nonempty_nul_free_selection() {
        assert!(valid_file_paths(&[
            "/tmp/cut me é.txt".into(),
            "/tmp/100% #?.md".into()
        ]));
        assert!(!valid_file_paths(&[]));
        for invalid in ["", "relative.txt", "/tmp/nul\0.txt"] {
            assert!(!valid_file_paths(&[
                "/tmp/valid.txt".into(),
                invalid.into()
            ]));
        }
    }

    #[test]
    fn applescript_png_parses_hex_dump() {
        // 8-byte PNG magic + IHDR fragment, as osascript renders it.
        let text = "\u{ab}data PNGf89504E470D0A1A0A0000000D\u{bb}\n";
        let bytes = parse_applescript_png(text).expect("should parse");
        assert_eq!(&bytes[..4], b"\x89PNG");
        assert_eq!(bytes.len(), 12);
    }

    #[test]
    fn applescript_png_rejects_garbage() {
        assert!(parse_applescript_png("no data here").is_none());
        // valid wrapper but not PNG magic
        assert!(parse_applescript_png("\u{ab}data PNGfDEADBEEFDEADBEEFDEADBEEF\u{bb}").is_none());
        // odd-length hex
        assert!(parse_applescript_png("\u{ab}data PNGf89504E470D0A1A0A00000\u{bb}").is_none());
        // unterminated
        assert!(parse_applescript_png("\u{ab}data PNGf89504E470D0A1A0A0000000D").is_none());
    }
}

// Replaces the pasteboard, so it is ignored by default; rust-platforms.yml
// runs it on the macOS runner:
// cargo test --lib native_clipboard_ownership -- --ignored
#[cfg(all(test, target_os = "macos"))]
mod native_clipboard_tests {
    use super::platform::{backend, TOKEN_TYPE};
    use crate::clipboard::backend::ClipboardOperation;
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSString, NSURL};

    #[test]
    #[ignore = "replaces the macOS pasteboard"]
    fn native_clipboard_ownership_round_trip() {
        // clipboard-rs 0.3 validates file URLs against the filesystem.
        // Exercise ownership with real files, as Copy/Cut supplies in the app.
        let directory = tempfile::tempdir().unwrap();
        let paths: Vec<String> = ["cut me é.txt", "100% #?.md"]
            .into_iter()
            .map(|name| {
                let path = directory.path().join(name);
                std::fs::write(&path, b"native clipboard fixture").unwrap();
                path.to_str().unwrap().to_owned()
            })
            .collect();
        let mut backend = backend();
        assert_eq!(backend.cut_unavailable_reason(), None);

        let first = "a".repeat(32);
        backend
            .write_files(&paths, ClipboardOperation::Cut, &first)
            .unwrap();
        assert_eq!(backend.owner_token(), Some(first.clone()));
        // Inspect the published wire representation, not just our reader:
        // each ordered item is a real file URL and only the first carries
        // the private nonce. Reserved filename characters stay in the path.
        autoreleasepool(|_| {
            let items = NSPasteboard::generalPasteboard().pasteboardItems().unwrap();
            assert_eq!(items.len(), paths.len());
            for (index, (item, path)) in items.iter().zip(&paths).enumerate() {
                // SAFETY: this is AppKit's immutable public file-URL type.
                let encoded = item
                    .stringForType(unsafe { NSPasteboardTypeFileURL })
                    .unwrap();
                let url = NSURL::URLWithString(&encoded).unwrap();
                assert!(url.isFileURL());
                assert_eq!(url.path().unwrap().to_string(), *path);
                assert!(url.query().is_none());
                assert!(url.fragment().is_none());
                assert_eq!(
                    item.dataForType(&NSString::from_str(TOKEN_TYPE))
                        .map(|data| data.to_vec()),
                    (index == 0).then(|| first.as_bytes().to_vec()),
                );
            }
        });
        assert_eq!(backend.read_files().unwrap(), paths, "native file list");
        assert_eq!(backend.owner_token(), Some(first), "reads keep ownership");

        // Invalid paths must fail before publication and preserve our lease.
        for invalid in [
            vec![],
            vec![String::new()],
            vec!["relative.txt".into()],
            vec!["/tmp/nul\0.txt".into()],
        ] {
            assert!(backend
                .write_files(&invalid, ClipboardOperation::Copy, "invalid")
                .is_err());
            assert_eq!(backend.owner_token(), Some("a".repeat(32)));
            assert_eq!(backend.read_files().unwrap(), paths);
        }

        let second = "b".repeat(32);
        backend
            .write_files(&paths, ClipboardOperation::Cut, &second)
            .unwrap();
        assert_eq!(backend.owner_token(), Some(second));

        // Another writer puts the identical file list on the pasteboard.
        let owner_before = backend.selection_owner();
        {
            use clipboard_rs::Clipboard;
            clipboard_rs::ClipboardContext::new()
                .unwrap()
                .set_files(paths.clone())
                .unwrap();
        }
        assert_eq!(backend.owner_token(), None);
        autoreleasepool(|_| {
            assert!(NSPasteboard::generalPasteboard()
                .dataForType(&NSString::from_str(TOKEN_TYPE))
                .is_none());
        });
        assert_ne!(backend.selection_owner(), owner_before);
        assert_eq!(backend.read_files().unwrap(), paths);
    }
}
