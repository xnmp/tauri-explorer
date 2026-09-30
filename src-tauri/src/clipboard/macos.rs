//! macOS clipboard: `clipboard-rs` (NSPasteboard) for file lists, `pbpaste`
//! for text, and `osascript` for images (#162). AppleScript's «class PNGf»
//! coercion reads the general pasteboard as PNG (AppKit transcodes TIFF
//! screenshots) and returns a hex dump that `parse_applescript_png` decodes.
//!
//! No ownership proof yet, so Cut fails closed. #877 plans a private UTI that
//! carries the token plus the `NSPasteboard.changeCount` recorded after the
//! write, which only requires overriding `owner_token` and
//! `cut_unavailable_reason`. The parser also compiles in tests on every
//! platform so it stays covered off-Mac.

#[cfg(target_os = "macos")]
pub(super) use platform::{backend, reader};

#[cfg(target_os = "macos")]
mod platform {
    use super::parse_applescript_png;
    use crate::clipboard::backend::{ClipboardBackend, ClipboardOperation, ClipboardReader};
    use crate::error::AppError;
    use std::process::Command;

    pub(in crate::clipboard) fn backend() -> Box<dyn ClipboardBackend> {
        Box::new(MacClipboard)
    }

    pub(in crate::clipboard) fn reader() -> Box<dyn ClipboardReader> {
        Box::new(MacClipboard)
    }

    struct MacClipboard;

    fn pasteboard() -> Result<clipboard_rs::ClipboardContext, AppError> {
        clipboard_rs::ClipboardContext::new()
            .map_err(|error| AppError::Other(format!("Mac clipboard unavailable: {error}")))
    }

    impl ClipboardBackend for MacClipboard {
        fn read_files(&mut self) -> Result<Vec<String>, AppError> {
            use clipboard_rs::Clipboard;
            // clipboard-rs reports an empty clipboard as "no files".
            Ok(pasteboard()?.get_files().unwrap_or_default())
        }

        fn write_files(
            &mut self,
            paths: &[String],
            _operation: ClipboardOperation,
            _token: &str,
        ) -> Result<(), AppError> {
            use clipboard_rs::Clipboard;
            if paths.is_empty() {
                return Err(AppError::InvalidPath("No paths to copy".into()));
            }
            pasteboard()?
                .set_files(paths.to_vec())
                .map_err(|error| AppError::Other(format!("Mac clipboard write failed: {error}")))
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
