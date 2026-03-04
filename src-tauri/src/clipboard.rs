//! OS clipboard file operations for Linux.
//! Issue: tauri-explorer-rdra, tauri-gkfr
//!
//! Linux file managers use MIME types like `x-special/gnome-copied-files`
//! and `text/uri-list` that `tauri-plugin-clipboard-x` doesn't handle
//! reliably (its `clipboard-rs` backend is X11-only, broken on Wayland).
//! This module shells out to `wl-paste`/`wl-copy` (Wayland) or
//! `xclip` (X11) to read and write file URIs directly.

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

/// Percent-encode a file path for use in `file://` URIs.
fn percent_encode_path(path: &str) -> String {
    let mut result = String::with_capacity(path.len() * 2);
    for b in path.bytes() {
        match b {
            // Unreserved characters (RFC 3986) + '/' (path separator)
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                result.push(b as char);
            }
            _ => {
                result.push('%');
                result.push_str(&format!("{:02X}", b));
            }
        }
    }
    result
}

/// Build file URIs from paths.
fn paths_to_uris(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .map(|p| format!("file://{}", percent_encode_path(p)))
        .collect()
}

/// Write clipboard data with a specific MIME type using native tools.
/// Uses wl-copy on Wayland, xclip on X11.
fn write_mime(mime: &str, data: &[u8]) -> bool {
    let mut child = if is_wayland() {
        match Command::new("wl-copy")
            .args(["--type", mime])
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return false,
        }
    } else {
        match Command::new("xclip")
            .args(["-i", "-selection", "clipboard", "-t", mime])
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return false,
        }
    };

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        if stdin.write_all(data).is_err() {
            return false;
        }
    }
    // Drop stdin to signal EOF
    child.stdin.take();

    child.wait().map(|s| s.success()).unwrap_or(false)
}

/// Write file paths to the OS clipboard in formats understood by
/// GTK file managers (Thunar, Nautilus, Nemo, Caja, etc.).
fn write_clipboard_file_paths(paths: &[String]) -> bool {
    if paths.is_empty() {
        return false;
    }

    let uris = paths_to_uris(paths);

    // x-special/gnome-copied-files: "copy\nfile:///path1\nfile:///path2"
    let gnome_data = format!("copy\n{}", uris.join("\n"));
    write_mime("x-special/gnome-copied-files", gnome_data.as_bytes())
}

/// Read raw image data (PNG) from the OS clipboard.
/// Returns the raw bytes or None if no image is available.
fn read_clipboard_image() -> Option<Vec<u8>> {
    let output = if is_wayland() {
        Command::new("wl-paste")
            .args(["--no-newline", "--type", "image/png"])
            .output()
            .ok()?
    } else {
        Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", "image/png"])
            .output()
            .ok()?
    };

    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    // Verify it looks like PNG data (magic bytes)
    if output.stdout.len() < 8 || &output.stdout[..4] != b"\x89PNG" {
        return None;
    }

    Some(output.stdout)
}

/// Check if the clipboard contains image data.
#[tauri::command]
pub async fn clipboard_has_image() -> bool {
    let output = if is_wayland() {
        Command::new("wl-paste")
            .args(["--list-types"])
            .output()
            .ok()
    } else {
        Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", "TARGETS"])
            .output()
            .ok()
    };

    match output {
        Some(o) if o.status.success() => {
            let types = String::from_utf8_lossy(&o.stdout);
            types.contains("image/png") || types.contains("image/jpeg")
        }
        _ => false,
    }
}

/// Paste clipboard image data to a file in the given directory.
/// Returns the path of the created file, or an error.
#[tauri::command]
pub async fn clipboard_paste_image(directory: String) -> Result<String, String> {
    let data = read_clipboard_image().ok_or("No image data in clipboard")?;

    let dir = std::path::Path::new(&directory);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", directory));
    }

    // Generate a timestamped filename
    let now = chrono::Local::now();
    let filename = format!("clipboard-{}.png", now.format("%Y%m%d-%H%M%S"));
    let filepath = dir.join(&filename);

    // Avoid overwriting existing files
    if filepath.exists() {
        // Add milliseconds to disambiguate
        let filename = format!("clipboard-{}.png", now.format("%Y%m%d-%H%M%S-%3f"));
        let filepath = dir.join(&filename);
        std::fs::write(&filepath, &data)
            .map_err(|e| format!("Failed to write image: {}", e))?;
        return Ok(filepath.to_string_lossy().to_string());
    }

    std::fs::write(&filepath, &data)
        .map_err(|e| format!("Failed to write image: {}", e))?;

    Ok(filepath.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn clipboard_has_files() -> bool {
    !read_clipboard_file_paths().is_empty()
}

#[tauri::command]
pub async fn clipboard_read_files() -> Vec<String> {
    read_clipboard_file_paths()
}

#[tauri::command]
pub async fn clipboard_write_files(paths: Vec<String>) -> bool {
    write_clipboard_file_paths(&paths)
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

    #[test]
    fn percent_encode_path_basic() {
        assert_eq!(percent_encode_path("/home/user/file.txt"), "/home/user/file.txt");
    }

    #[test]
    fn percent_encode_path_spaces() {
        assert_eq!(percent_encode_path("/home/user/My Documents"), "/home/user/My%20Documents");
    }

    #[test]
    fn percent_encode_roundtrip() {
        let original = "/home/user/My Documents/file#name.txt";
        let encoded = percent_encode_path(original);
        let decoded = percent_decode(&encoded);
        assert_eq!(decoded, original);
    }

    #[test]
    fn paths_to_uris_basic() {
        let paths = vec![
            "/home/user/doc.txt".to_string(),
            "/tmp/test file.txt".to_string(),
        ];
        let uris = paths_to_uris(&paths);
        assert_eq!(uris, vec![
            "file:///home/user/doc.txt",
            "file:///tmp/test%20file.txt",
        ]);
    }
}
