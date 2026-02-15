//! OS clipboard file reading for Linux.
//! Issue: tauri-explorer-rdra
//!
//! Linux file managers use MIME types like `x-special/gnome-copied-files`
//! and `text/uri-list` that `tauri-plugin-clipboard-x` doesn't read.
//! This module shells out to `wl-paste` (Wayland) or `xclip` (X11) to
//! read file URIs directly.

use std::process::Command;

/// Detect whether the session is Wayland or X11.
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// Try to read a specific MIME type from the clipboard.
/// Returns `None` if the tool isn't available or the MIME type isn't present.
fn read_mime(mime: &str) -> Option<String> {
    let output = if is_wayland() {
        Command::new("wl-paste")
            .args(["--no-newline", "--type", mime])
            .output()
            .ok()?
    } else {
        Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", mime])
            .output()
            .ok()?
    };

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.is_empty() {
        return None;
    }
    Some(text)
}

/// Parse `file://` URIs into filesystem paths.
fn parse_file_uris(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let trimmed = line.trim().trim_end_matches('\0');
            if let Some(path) = trimmed.strip_prefix("file://") {
                // Decode percent-encoded characters (e.g. %20 -> space)
                Some(percent_decode(path))
            } else {
                None
            }
        })
        .collect()
}

/// Minimal percent-decoding for file paths.
fn percent_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(hi), Some(lo)) = (hi, lo) {
                let hex = [hi, lo];
                if let Ok(s) = std::str::from_utf8(&hex) {
                    if let Ok(byte) = u8::from_str_radix(s, 16) {
                        result.push(byte as char);
                        continue;
                    }
                }
            }
            // Malformed %-sequence, emit literally
            result.push('%');
        } else {
            result.push(b as char);
        }
    }
    result
}

/// Read file paths from the OS clipboard.
/// Tries `x-special/gnome-copied-files` first (GNOME/XFCE/MATE), then `text/uri-list` (KDE).
fn read_clipboard_file_paths() -> Vec<String> {
    // GNOME/XFCE format: first line is "copy" or "cut", rest are URIs
    if let Some(text) = read_mime("x-special/gnome-copied-files") {
        let uris: String = text
            .lines()
            .skip(1) // skip "copy" / "cut" line
            .collect::<Vec<_>>()
            .join("\n");
        let paths = parse_file_uris(&uris);
        if !paths.is_empty() {
            return paths;
        }
    }

    // KDE/generic format: plain URI list
    if let Some(text) = read_mime("text/uri-list") {
        let paths = parse_file_uris(&text);
        if !paths.is_empty() {
            return paths;
        }
    }

    Vec::new()
}

#[tauri::command]
pub fn clipboard_has_files() -> bool {
    !read_clipboard_file_paths().is_empty()
}

#[tauri::command]
pub fn clipboard_read_files() -> Vec<String> {
    read_clipboard_file_paths()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_uri_list() {
        let input = "file:///home/user/doc.txt\nfile:///home/user/image.png\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/home/user/doc.txt", "/home/user/image.png"]);
    }

    #[test]
    fn parse_uri_list_with_comments() {
        let input = "# comment\nfile:///tmp/test.txt\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/tmp/test.txt"]);
    }

    #[test]
    fn parse_gnome_format() {
        // x-special/gnome-copied-files: first line is operation
        let raw = "copy\nfile:///home/user/doc.txt\nfile:///home/user/pic.jpg";
        let uris: String = raw.lines().skip(1).collect::<Vec<_>>().join("\n");
        let paths = parse_file_uris(&uris);
        assert_eq!(paths, vec!["/home/user/doc.txt", "/home/user/pic.jpg"]);
    }

    #[test]
    fn parse_percent_encoded_path() {
        let input = "file:///home/user/My%20Documents/file%23name.txt\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/home/user/My Documents/file#name.txt"]);
    }

    #[test]
    fn parse_empty_input() {
        assert!(parse_file_uris("").is_empty());
        assert!(parse_file_uris("\n\n").is_empty());
    }

    #[test]
    fn parse_non_file_uris_ignored() {
        let input = "http://example.com\nfile:///tmp/ok.txt\n";
        let paths = parse_file_uris(input);
        assert_eq!(paths, vec!["/tmp/ok.txt"]);
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("/path/to/file"), "/path/to/file");
        assert_eq!(percent_decode("/path%20with%20spaces"), "/path with spaces");
        assert_eq!(percent_decode("%2Ftmp%2Ftest"), "/tmp/test");
    }
}
