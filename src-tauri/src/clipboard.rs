//! OS clipboard file operations.
//! Issue: tauri-explorer-rdra, tauri-gkfr
//!
//! Linux file managers use MIME types like `x-special/gnome-copied-files`
//! and `text/uri-list` that `tauri-plugin-clipboard-x` doesn't handle
//! reliably (its `clipboard-rs` backend is X11-only, broken on Wayland).
//! On Linux this module shells out to `wl-paste`/`wl-copy` (Wayland) or
//! `xclip` (X11) to read and write file URIs directly.
//!
//! On Windows the same operations go through the native clipboard's
//! `CF_HDROP` (file drop list) and bitmap formats via a short PowerShell
//! shell-out (`System.Windows.Forms.Clipboard`), keeping copy/paste of files
//! interoperable with Explorer. Data is passed via environment variables, never
//! interpolated into the script, so filenames can't break or inject it.

use crate::error::AppError;
use std::process::Command;

/// Detect whether the session is Wayland or X11.
#[cfg(not(windows))]
fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
}

/// A clipboard tool failed to start. Distinguish "not installed" — the
/// common, actionable case (#279) — from other spawn failures.
#[cfg(not(windows))]
fn tool_error(tool: &str, package: &str, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::Other(format!(
            "{} is not installed — install {} for clipboard file support",
            tool, package
        ))
    } else {
        AppError::Other(format!("Failed to start {}: {}", tool, e))
    }
}

/// Try to read a specific MIME type from the clipboard.
/// `Ok(None)` means the MIME type isn't present (an empty clipboard is not
/// an error); `Err` means the clipboard tool itself is unusable (#279).
#[cfg(not(windows))]
fn read_mime(mime: &str) -> Result<Option<String>, AppError> {
    let output = if is_wayland() {
        Command::new("wl-paste")
            .args(["--no-newline", "--type", mime])
            .output()
            .map_err(|e| tool_error("wl-paste", "wl-clipboard", e))?
    } else {
        Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", mime])
            .output()
            .map_err(|e| tool_error("xclip", "xclip", e))?
    };

    // Non-success here means "that MIME type isn't on the clipboard".
    if !output.status.success() {
        return Ok(None);
    }

    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(text))
}

/// Parse `file://` URIs into filesystem paths.
fn parse_file_uris(text: &str) -> Vec<String> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let trimmed = line.trim().trim_end_matches('\0');
            trimmed.strip_prefix("file://").map(percent_decode)
        })
        .collect()
}

/// Minimal percent-decoding for file paths.
/// Decodes to raw bytes first, then interprets the whole result as UTF-8 so
/// multi-byte sequences (e.g. %C3%A9 -> é) aren't mangled byte-by-byte.
fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut iter = input.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let hi = iter.next();
            let lo = iter.next();
            if let (Some(hi), Some(lo)) = (hi, lo) {
                let hex = [hi, lo];
                if let Ok(s) = std::str::from_utf8(&hex) {
                    if let Ok(byte) = u8::from_str_radix(s, 16) {
                        bytes.push(byte);
                        continue;
                    }
                }
                // Malformed %-sequence, emit literally
                bytes.push(b'%');
                bytes.push(hi);
                bytes.push(lo);
            } else {
                bytes.push(b'%');
                bytes.extend(hi);
                bytes.extend(lo);
            }
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Read file paths from the OS clipboard.
/// Tries `x-special/gnome-copied-files` first (GNOME/XFCE/MATE), then `text/uri-list` (KDE).
/// `Ok(vec![])` = no file paths on the clipboard; `Err` = broken tooling (#279).
#[cfg(not(windows))]
fn read_clipboard_file_paths() -> Result<Vec<String>, AppError> {
    // GNOME/XFCE format: first line is "copy" or "cut", rest are URIs
    if let Some(text) = read_mime("x-special/gnome-copied-files")? {
        let uris: String = text
            .lines()
            .skip(1) // skip "copy" / "cut" line
            .collect::<Vec<_>>()
            .join("\n");
        let paths = parse_file_uris(&uris);
        if !paths.is_empty() {
            return Ok(paths);
        }
    }

    // KDE/generic format: plain URI list
    if let Some(text) = read_mime("text/uri-list")? {
        let paths = parse_file_uris(&text);
        if !paths.is_empty() {
            return Ok(paths);
        }
    }

    Ok(Vec::new())
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
/// Uses wl-copy on Wayland, xclip on X11. Failures carry the reason (#279).
#[cfg(not(windows))]
fn write_mime(mime: &str, data: &[u8]) -> Result<(), AppError> {
    let tool = if is_wayland() { "wl-copy" } else { "xclip" };
    let package = if is_wayland() {
        "wl-clipboard"
    } else {
        "xclip"
    };
    let mut child = if is_wayland() {
        Command::new("wl-copy")
            .args(["--type", mime])
            .stdin(std::process::Stdio::piped())
            .spawn()
    } else {
        Command::new("xclip")
            .args(["-i", "-selection", "clipboard", "-t", mime])
            .stdin(std::process::Stdio::piped())
            .spawn()
    }
    .map_err(|e| tool_error(tool, package, e))?;

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        stdin
            .write_all(data)
            .map_err(|e| AppError::Other(format!("Failed to write to {}: {}", tool, e)))?;
    }
    // Drop stdin to signal EOF
    child.stdin.take();

    let status = child
        .wait()
        .map_err(|e| AppError::Other(format!("Failed to wait for {}: {}", tool, e)))?;
    if !status.success() {
        return Err(AppError::Other(format!("{} exited with {}", tool, status)));
    }
    Ok(())
}

/// Write file paths to the OS clipboard in formats understood by
/// GTK file managers (Thunar, Nautilus, Nemo, Caja, etc.).
///
/// Limitation: `wl-copy` and `xclip` can only own the clipboard with a single
/// MIME type per invocation, and each new invocation replaces the previous
/// clipboard owner. We therefore cannot offer `x-special/gnome-copied-files`
/// AND `text/uri-list` simultaneously — invoking the tool a second time would
/// clobber the first format instead of adding to it. We write the GNOME format
/// (richest: carries copy/cut semantics); KDE/Dolphin paste of our copies is
/// not supported until a multi-target clipboard backend is used.
#[cfg(not(windows))]
fn write_clipboard_file_paths(paths: &[String]) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::InvalidPath("No paths to copy".to_string()));
    }

    let uris = paths_to_uris(paths);

    // x-special/gnome-copied-files: "copy\nfile:///path1\nfile:///path2"
    let gnome_data = format!("copy\n{}", uris.join("\n"));
    write_mime("x-special/gnome-copied-files", gnome_data.as_bytes())
}

/// Read raw image data (PNG) from the OS clipboard.
/// Returns the raw bytes or None if no image is available.
#[cfg(all(not(windows), not(target_os = "macos")))]
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
    tokio::task::spawn_blocking(clipboard_has_image_sync)
        .await
        .unwrap_or(false)
}

/// Read a clipboard screenshot for a user report without creating a file in
/// the current directory.
#[tauri::command]
pub async fn clipboard_read_report_image(
) -> Result<crate::user_report::ReportAttachment, crate::user_report::SubmitReportError> {
    let bytes = tokio::task::spawn_blocking(read_clipboard_image)
        .await
        .map_err(|error| {
            crate::user_report::SubmitReportError::new(
                "clipboard_unavailable",
                format!("Clipboard task failed: {error}"),
            )
        })?
        .ok_or_else(|| {
            crate::user_report::SubmitReportError::new(
                "clipboard_unavailable",
                "No image data in clipboard",
            )
        })?;
    crate::user_report::attachment_from_image_bytes(
        "Clipboard screenshot.png".to_string(),
        "image/png",
        bytes,
    )
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn clipboard_has_image_sync() -> bool {
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

// ===========================================================================
// macOS backend: wl-paste/xclip don't exist there (#162). AppleScript's
// «class PNGf» coercion reads the general pasteboard as PNG (AppKit
// transcodes TIFF screenshots), returned as a hex dump we decode.
// ===========================================================================

/// Parse osascript's «data PNGf<hex>» output into PNG bytes.
/// Compiled on all platforms so the parser stays unit-tested off-mac.
#[allow(dead_code)]
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

#[cfg(target_os = "macos")]
fn read_clipboard_image() -> Option<Vec<u8>> {
    let output = Command::new("osascript")
        .args(["-e", "get the clipboard as \u{ab}class PNGf\u{bb}"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_applescript_png(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "macos")]
fn clipboard_has_image_sync() -> bool {
    Command::new("osascript")
        .args(["-e", "clipboard info"])
        .output()
        .map(|o| {
            o.status.success() && {
                let info = String::from_utf8_lossy(&o.stdout);
                info.contains("PNGf") || info.contains("TIFF") || info.contains("picture")
            }
        })
        .unwrap_or(false)
}

// ===========================================================================
// Windows backend: native clipboard via PowerShell + System.Windows.Forms.
// CF_HDROP for file lists, bitmap for images. STA is required for the WinForms
// clipboard APIs; `powershell.exe` (Windows PowerShell 5.1) is always present
// and runs STA. Data is carried in env vars so filenames can't break/inject
// the script.
// ===========================================================================

/// Run a PowerShell script and return its output, or `None` if it failed to
/// launch. `envs` carries data into the script via environment variables.
#[cfg(windows)]
fn run_powershell(script: &str, envs: &[(&str, &str)]) -> Option<std::process::Output> {
    use crate::process_ext::NoConsole;
    let mut cmd = Command::new("powershell");
    cmd.no_console();
    cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
    for (key, val) in envs {
        cmd.env(key, val);
    }
    cmd.output().ok()
}

/// Split PowerShell stdout (CRLF-terminated) into trimmed, non-empty lines.
#[cfg(windows)]
fn ps_lines(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

#[cfg(windows)]
fn read_clipboard_file_paths() -> Result<Vec<String>, AppError> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files) { $files -join "`n" }
"#;
    match run_powershell(script, &[]) {
        Some(o) if o.status.success() => Ok(ps_lines(&o.stdout)),
        Some(o) => Err(AppError::Other(format!(
            "PowerShell clipboard read exited with {}",
            o.status
        ))),
        None => Err(AppError::Other(
            "Failed to start PowerShell for clipboard read".to_string(),
        )),
    }
}

/// Write file paths to the Windows clipboard as a `CF_HDROP` file drop list,
/// so Explorer (and other apps) can paste them. Copy semantics, matching the
/// Linux path (which only offers "copy").
#[cfg(windows)]
fn write_clipboard_file_paths(paths: &[String]) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::InvalidPath("No paths to copy".to_string()));
    }
    let joined = paths.join("\n");
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$col = New-Object System.Collections.Specialized.StringCollection
foreach ($p in ($env:CLIP_PATHS -split "`n")) { if ($p) { [void]$col.Add($p) } }
[System.Windows.Forms.Clipboard]::SetFileDropList($col)
"#;
    match run_powershell(script, &[("CLIP_PATHS", &joined)]) {
        Some(o) if o.status.success() => Ok(()),
        Some(o) => Err(AppError::Other(format!(
            "PowerShell clipboard write exited with {}",
            o.status
        ))),
        None => Err(AppError::Other(
            "Failed to start PowerShell for clipboard write".to_string(),
        )),
    }
}

#[cfg(windows)]
fn clipboard_has_image_sync() -> bool {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsImage()) { 'yes' } else { 'no' }
"#;
    run_powershell(script, &[])
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("yes"))
        .unwrap_or(false)
}

/// Read the clipboard image and re-encode it as PNG bytes (the format the
/// frontend expects), so the cross-platform paste path works unchanged.
#[cfg(windows)]
fn read_clipboard_image() -> Option<Vec<u8>> {
    use base64::Engine as _;
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { exit 1 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
"#;
    let output = run_powershell(script, &[])?;
    if !output.status.success() {
        return None;
    }
    let b64: String = ps_lines(&output.stdout).concat();
    if b64.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// Paste clipboard image data to a file in the given directory.
/// Returns the path of the created file, or an error.
#[tauri::command]
pub async fn clipboard_paste_image(directory: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || clipboard_paste_image_sync(directory))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn clipboard_paste_image_sync(directory: String) -> Result<String, AppError> {
    let data = read_clipboard_image()
        .ok_or_else(|| AppError::Other("No image data in clipboard".to_string()))?;

    let dir = std::path::Path::new(&directory);
    if !dir.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Not a directory: {}",
            directory
        )));
    }

    // Generate a timestamped filename
    let now = chrono::Local::now();
    let filename = format!("img-{}.png", now.format("%Y%m%d-%H%M%S"));
    let filepath = dir.join(&filename);

    // Avoid overwriting existing files
    if filepath.exists() {
        // Add milliseconds to disambiguate
        let filename = format!("img-{}.png", now.format("%Y%m%d-%H%M%S-%3f"));
        let filepath = dir.join(&filename);
        std::fs::write(&filepath, &data)
            .map_err(|e| AppError::Other(format!("Failed to write image: {}", e)))?;
        return Ok(filepath.to_string_lossy().to_string());
    }

    std::fs::write(&filepath, &data)
        .map_err(|e| AppError::Other(format!("Failed to write image: {}", e)))?;

    log::info!("Pasted clipboard image to: {}", filename);
    Ok(filepath.to_string_lossy().to_string())
}

/// Probe used for paste-menu enablement — silent `false` on failure is the
/// right behavior here; the actionable errors surface on the actual
/// read/write commands (#279).
#[tauri::command]
pub async fn clipboard_has_files() -> bool {
    tokio::task::spawn_blocking(|| {
        read_clipboard_file_paths()
            .map(|p| !p.is_empty())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub async fn clipboard_read_files() -> Result<Vec<String>, AppError> {
    tokio::task::spawn_blocking(read_clipboard_file_paths)
        .await
        .map_err(|e| AppError::Other(format!("Clipboard task failed: {}", e)))?
}

#[tauri::command]
pub async fn clipboard_write_files(paths: Vec<String>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || write_clipboard_file_paths(&paths))
        .await
        .map_err(|e| AppError::Other(format!("Clipboard task failed: {}", e)))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

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
    fn percent_decode_utf8_multibyte() {
        // %C3%A9 = é (2 bytes), %E6%97%A5 = 日 (3 bytes)
        assert_eq!(percent_decode("/home/user/%C3%A9t%C3%A9"), "/home/user/été");
        assert_eq!(
            percent_decode("/tmp/%E6%97%A5%E6%9C%AC.txt"),
            "/tmp/日本.txt"
        );
    }

    #[test]
    fn percent_decode_utf8_roundtrip() {
        let original = "/home/user/Téléchargements/файл 日本.png";
        let encoded = percent_encode_path(original);
        assert_eq!(percent_decode(&encoded), original);
    }

    #[test]
    fn percent_encode_path_basic() {
        assert_eq!(
            percent_encode_path("/home/user/file.txt"),
            "/home/user/file.txt"
        );
    }

    #[test]
    fn percent_encode_path_spaces() {
        assert_eq!(
            percent_encode_path("/home/user/My Documents"),
            "/home/user/My%20Documents"
        );
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
        assert_eq!(
            uris,
            vec!["file:///home/user/doc.txt", "file:///tmp/test%20file.txt",]
        );
    }
}
