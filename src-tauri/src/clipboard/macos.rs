//! macOS clipboard: `NSPasteboard` file-list writes, `clipboard-rs` file-list
//! reads, `pbpaste` for text, and `osascript` for images (#162).
//! AppleScript's «class PNGf» coercion reads the general pasteboard as PNG
//! (AppKit transcodes TIFF screenshots) and returns a hex dump that
//! `parse_applescript_png` decodes. The parser also compiles in tests on
//! every platform so it stays covered off-Mac.
//!
//! Cut ownership (#877): a file write declares `NSFilenamesPboardType` (what
//! Finder pastes, as `clipboard-rs` wrote it before) and a private type that
//! carries the write's token, in one pasteboard ownership change. The
//! `changeCount` is then read around a read-back of the files and token
//! (`change_counter.rs`); the write owns the pasteboard while the count is
//! unchanged, so any later write by any program ends it.

#[cfg(target_os = "macos")]
pub(super) use platform::{backend, reader};

#[cfg(target_os = "macos")]
mod platform {
    use super::parse_applescript_png;
    use crate::clipboard::backend::{
        ClipboardBackend, ClipboardOperation, ClipboardReader, SelectionOwner,
    };
    use crate::clipboard::change_counter::CounterOwnership;
    use crate::error::AppError;
    use objc2::rc::{autoreleasepool, Retained};
    // Deprecated in favour of one file-URL item per file, but it is what
    // Finder pastes and what `clipboard-rs` writes and reads (`get_files`).
    #[allow(deprecated)]
    use objc2_app_kit::NSFilenamesPboardType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::process::Command;

    /// The private pasteboard type that carries a write's token. The change
    /// count, not the type, proves ownership; the token proves that the count
    /// observed after the write names this write.
    const TOKEN_TYPE: &str = "io.github.xnmp.tauri-explorer.file-clipboard-token";

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

    /// Replace the general pasteboard with `paths` plus `token`, in one
    /// ownership change. Returns whether both types were written.
    #[allow(deprecated)] // NSFilenamesPboardType, as imported above.
    fn write_pasteboard(paths: &[String], token: &str) -> (bool, bool) {
        autoreleasepool(|_| {
            let pasteboard = NSPasteboard::generalPasteboard();
            let token_type = NSString::from_str(TOKEN_TYPE);
            let files: Vec<Retained<NSString>> =
                paths.iter().map(|path| NSString::from_str(path)).collect();
            let files = NSArray::from_retained_slice(&files);
            // SAFETY: `NSFilenamesPboardType` is an immutable AppKit constant;
            // no owner object is passed; the property list is an array of
            // strings, which is what this type holds.
            unsafe {
                let filenames = NSFilenamesPboardType;
                pasteboard
                    .declareTypes_owner(&NSArray::from_slice(&[filenames, &token_type]), None);
                let wrote_files = pasteboard.setPropertyList_forType(&files, filenames);
                let wrote_token = pasteboard
                    .setData_forType(Some(&NSData::with_bytes(token.as_bytes())), &token_type);
                (wrote_files, wrote_token)
            }
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
            if paths.is_empty() {
                return Err(AppError::InvalidPath("No paths to copy".into()));
            }
            let (wrote_files, wrote_token) = write_pasteboard(paths, token);
            if !wrote_files {
                return Err(AppError::Other("Mac clipboard write failed".into()));
            }
            // The token alone would survive another program adding its data
            // to our declared types; the files must read back as well.
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

        /// The change count identifies the pasteboard's content, which is what
        /// a failed Copy mirror compares.
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
            Command::new("osascript")
                .args(["-e", "clipboard info"])
                .output()
                .map(|output| {
                    output.status.success() && {
                        let info = String::from_utf8_lossy(&output.stdout);
                        info.contains("PNGf") || info.contains("TIFF") || info.contains("picture")
                    }
                })
                .unwrap_or(false)
        }

        /// PNG only: AppKit transcodes other pasteboard images to it.
        fn read_image(&self, media_type: &str) -> Option<Vec<u8>> {
            if media_type != "image/png" {
                return None;
            }
            let output = Command::new("osascript")
                .args(["-e", "get the clipboard as \u{ab}class PNGf\u{bb}"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            parse_applescript_png(&String::from_utf8_lossy(&output.stdout))
        }
    }
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
    use super::parse_applescript_png;

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
    use super::platform::backend;
    use crate::clipboard::backend::ClipboardOperation;

    #[test]
    #[ignore = "replaces the macOS pasteboard"]
    fn native_clipboard_ownership_round_trip() {
        let paths = vec!["/tmp/cut me é.txt".to_string()];
        let mut backend = backend();
        assert_eq!(backend.cut_unavailable_reason(), None);

        let first = "a".repeat(32);
        backend
            .write_files(&paths, ClipboardOperation::Cut, &first)
            .unwrap();
        assert_eq!(backend.owner_token(), Some(first.clone()));
        assert_eq!(backend.read_files().unwrap(), paths, "Finder's file list");
        assert_eq!(backend.owner_token(), Some(first), "reads keep ownership");

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
        assert_ne!(backend.selection_owner(), owner_before);
        assert_eq!(backend.read_files().unwrap(), paths);
    }
}
