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
#[cfg(any(not(windows), test))]
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
#[cfg(any(not(windows), test))]
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
#[cfg(all(not(windows), not(target_os = "macos")))]
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

#[cfg(target_os = "macos")]
fn read_clipboard_file_paths() -> Result<Vec<String>, AppError> {
    use clipboard_rs::Clipboard;
    let context = clipboard_rs::ClipboardContext::new()
        .map_err(|error| AppError::Other(format!("Mac clipboard unavailable: {error}")))?;
    // clipboard-rs reports an empty clipboard as "no files".
    Ok(context.get_files().unwrap_or_default())
}

#[cfg(target_os = "macos")]
fn write_clipboard_file_paths(paths: &[String]) -> Result<(), AppError> {
    use clipboard_rs::Clipboard;
    if paths.is_empty() {
        return Err(AppError::InvalidPath("No paths to copy".into()));
    }
    let context = clipboard_rs::ClipboardContext::new()
        .map_err(|error| AppError::Other(format!("Mac clipboard unavailable: {error}")))?;
    context
        .set_files(paths.to_vec())
        .map_err(|error| AppError::Other(format!("Mac clipboard write failed: {error}")))
}

/// Read plain text without relying on WebKit's Clipboard API permission.
/// That permission is unavailable in some packaged WebKitGTK sessions even
/// when the terminal owns focus and the desktop clipboard has text (#732).
#[cfg(all(not(windows), not(target_os = "macos")))]
fn read_clipboard_text_sync() -> Result<String, AppError> {
    let (tool, package, args): (&str, &str, &[&str]) = if is_wayland() {
        (
            "wl-paste",
            "wl-clipboard",
            &["--no-newline", "--type", "text"],
        )
    } else {
        ("xclip", "xclip", &["-o", "-selection", "clipboard"])
    };
    let output = Command::new(tool)
        .args(args)
        .output()
        .map_err(|error| tool_error(tool, package, error))?;
    if !output.status.success() {
        return Err(AppError::Other(format!(
            "{tool} exited with {}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "macos")]
fn read_clipboard_text_sync() -> Result<String, AppError> {
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

#[cfg(windows)]
fn read_clipboard_text_sync() -> Result<String, AppError> {
    use base64::Engine as _;
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Windows.Forms.Clipboard]::GetText()
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
"#;
    let output = run_powershell(script, &[])
        .ok_or_else(|| AppError::Other("Failed to start PowerShell for clipboard text".into()))?;
    if !output.status.success() {
        return Err(AppError::Other(format!(
            "PowerShell clipboard text read exited with {}",
            output.status
        )));
    }
    let encoded = ps_lines(&output.stdout).concat();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AppError::Other(format!("Invalid clipboard text encoding: {error}")))?;
    String::from_utf8(bytes)
        .map_err(|error| AppError::Other(format!("Invalid clipboard UTF-8: {error}")))
}

#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, AppError> {
    tokio::task::spawn_blocking(read_clipboard_text_sync)
        .await
        .map_err(|error| AppError::Other(format!("Clipboard task failed: {error}")))?
}

/// Percent-encode a file path for use in `file://` URIs.
#[cfg(any(not(windows), test))]
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
#[cfg(any(not(windows), test))]
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
#[cfg(all(not(windows), not(target_os = "macos")))]
fn write_clipboard_file_paths(paths: &[String]) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::InvalidPath("No paths to copy".to_string()));
    }

    let uris = paths_to_uris(paths);

    // x-special/gnome-copied-files: "copy\nfile:///path1\nfile:///path2"
    let gnome_data = format!("copy\n{}", uris.join("\n"));
    write_mime("x-special/gnome-copied-files", gnome_data.as_bytes())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn read_clipboard_image_type(media_type: &str) -> Option<Vec<u8>> {
    let output = if is_wayland() {
        Command::new("wl-paste")
            .args(["--no-newline", "--type", media_type])
            .output()
            .ok()?
    } else {
        Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", media_type])
            .output()
            .ok()?
    };

    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    if crate::user_report::report_image_media_type(&output.stdout) != Some(media_type) {
        return None;
    }
    Some(output.stdout)
}

/// Read raw PNG image data from the OS clipboard for the existing paste-to-file
/// command, whose output filename is always `.png`.
#[cfg(all(not(windows), not(target_os = "macos")))]
fn read_clipboard_image() -> Option<Vec<u8>> {
    read_clipboard_image_type("image/png")
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn read_clipboard_report_image() -> Option<(Vec<u8>, &'static str)> {
    for media_type in ["image/png", "image/jpeg"] {
        if let Some(bytes) = read_clipboard_image_type(media_type) {
            return Some((bytes, media_type));
        }
    }
    None
}

#[cfg(any(windows, target_os = "macos"))]
fn read_clipboard_report_image() -> Option<(Vec<u8>, &'static str)> {
    read_clipboard_image().map(|bytes| (bytes, "image/png"))
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
    let (bytes, media_type) = tokio::task::spawn_blocking(read_clipboard_report_image)
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
    let extension = if media_type == "image/jpeg" {
        "jpg"
    } else {
        "png"
    };
    crate::user_report::attachment_from_image_bytes(
        format!("Clipboard screenshot.{extension}"),
        media_type,
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

// Process-wide file clipboard protocol. Commands enqueue before awaiting, so a
// cancelled renderer request cannot cancel or overtake an accepted OS write.
#[cfg(target_os = "linux")]
const FILE_CLIPBOARD_TOKEN: &str = "application/x-tauri-explorer-file-token";

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileClipboardSnapshot {
    revision: u64,
    entries: Option<Vec<serde_json::Value>>,
    paths: Vec<String>,
    operation: Option<String>,
    mirror_error: Option<String>,
}

enum FileClipboardJob {
    Publish {
        entries: Vec<serde_json::Value>,
        operation: String,
        reply: tokio::sync::oneshot::Sender<Result<FileClipboardSnapshot, AppError>>,
    },
    Snapshot {
        reply: tokio::sync::oneshot::Sender<Result<FileClipboardSnapshot, AppError>>,
    },
    Clear {
        revision: u64,
        reply: tokio::sync::oneshot::Sender<Result<bool, AppError>>,
    },
    Rekey {
        revision: u64,
        old_path: String,
        entry: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<Option<FileClipboardSnapshot>, AppError>>,
    },
    ClaimCut {
        revision: u64,
        reply: tokio::sync::oneshot::Sender<Result<bool, AppError>>,
    },
    ReleaseCut {
        revision: u64,
        reply: tokio::sync::oneshot::Sender<bool>,
    },
}

/// Which clipboard revision's Cut a paste currently holds (#871). Every window
/// shares the one worker, so claims are ordered with every publish; only the
/// claimant moves the files. A lease on an older revision is simply stale.
#[derive(Default)]
struct CutLease {
    leased: Option<u64>,
}

impl CutLease {
    fn claim(&mut self, current: u64, requested: u64, is_cut: bool) -> bool {
        if !is_cut || current != requested || self.leased == Some(current) {
            return false;
        }
        self.leased = Some(current);
        true
    }

    /// Return an unfinished paste's Cut so it stays pasteable.
    fn release(&mut self, current: u64, requested: u64) -> bool {
        if current != requested || self.leased != Some(requested) {
            return false;
        }
        self.leased = None;
        true
    }
}

struct FileClipboardCoordinator {
    revision: u64,
    entries: Option<Vec<serde_json::Value>>,
    paths: Vec<String>,
    operation: Option<String>,
    token: Option<String>,
    mirror_error: Option<String>,
    failed_mirror_baseline_paths: Option<Vec<String>>,
    cut_lease: CutLease,
    #[cfg(target_os = "linux")]
    failed_mirror_baseline_owner: Option<u32>,
    #[cfg(target_os = "linux")]
    x11: Option<clipboard_rs::ClipboardContext>,
}

impl FileClipboardCoordinator {
    fn new() -> Self {
        Self {
            revision: 0,
            entries: None,
            paths: Vec::new(),
            operation: None,
            token: None,
            mirror_error: None,
            failed_mirror_baseline_paths: None,
            cut_lease: CutLease::default(),
            #[cfg(target_os = "linux")]
            failed_mirror_baseline_owner: None,
            #[cfg(target_os = "linux")]
            x11: if is_wayland() {
                None
            } else {
                clipboard_rs::ClipboardContext::new().ok()
            },
        }
    }

    fn snapshot(&mut self) -> Result<FileClipboardSnapshot, AppError> {
        let paths = match read_clipboard_file_paths() {
            Ok(paths) => paths,
            Err(_) if self.mirror_error.is_some() && self.operation.as_deref() == Some("copy") => {
                return Ok(self.cached_snapshot());
            }
            Err(error) => return Err(error),
        };
        if self.mirror_error.is_some()
            && self.operation.as_deref() == Some("copy")
            && Some(&paths) == self.failed_mirror_baseline_paths.as_ref()
            && self.failed_mirror_owner_unchanged()
        {
            return Ok(self.cached_snapshot());
        }
        let native_token = self.native_token();
        if native_token != self.token || paths != self.paths {
            self.revision = self.revision.wrapping_add(1);
            self.entries = None;
            self.operation = None;
            self.token = native_token;
            self.paths = paths.clone();
            self.mirror_error = None;
            self.failed_mirror_baseline_paths = None;
            #[cfg(target_os = "linux")]
            {
                self.failed_mirror_baseline_owner = None;
            }
        }
        Ok(FileClipboardSnapshot {
            revision: self.revision,
            entries: self.entries.clone(),
            paths,
            operation: self.operation.clone(),
            mirror_error: self.mirror_error.clone(),
        })
    }

    fn failed_mirror_owner_unchanged(&self) -> bool {
        #[cfg(target_os = "linux")]
        if !is_wayland() {
            return self
                .failed_mirror_baseline_owner
                .is_some_and(|owner| x11_clipboard_owner() == Some(owner));
        }
        true
    }

    fn cached_snapshot(&self) -> FileClipboardSnapshot {
        FileClipboardSnapshot {
            revision: self.revision,
            entries: self.entries.clone(),
            paths: self.paths.clone(),
            operation: self.operation.clone(),
            mirror_error: self.mirror_error.clone(),
        }
    }

    fn native_token(&self) -> Option<String> {
        #[cfg(target_os = "linux")]
        if let Some(x11) = &self.x11 {
            use clipboard_rs::Clipboard;
            return x11
                .get_buffer(FILE_CLIPBOARD_TOKEN)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok());
        }
        None
    }

    fn write(&mut self, paths: &[String], _token: &str) -> Result<bool, AppError> {
        #[cfg(target_os = "linux")]
        if let Some(x11) = &self.x11 {
            use clipboard_rs::{Clipboard, ClipboardContent};
            let uris = paths_to_uris(paths);
            let data = vec![
                ClipboardContent::Files(uris.clone()),
                ClipboardContent::Other(
                    "x-special/gnome-copied-files".into(),
                    format!("copy\n{}", uris.join("\n")).into_bytes(),
                ),
                ClipboardContent::Other(FILE_CLIPBOARD_TOKEN.into(), _token.as_bytes().to_vec()),
            ];
            x11.set(data)
                .map_err(|error| AppError::Other(format!("X11 clipboard write failed: {error}")))?;
            return Ok(self.native_token().as_deref() == Some(_token));
        }
        write_clipboard_file_paths(paths)?;
        Ok(false)
    }

    fn publish(
        &mut self,
        entries: Vec<serde_json::Value>,
        operation: String,
    ) -> Result<FileClipboardSnapshot, AppError> {
        if operation != "copy" && operation != "cut" {
            return Err(AppError::Other("Invalid clipboard operation".into()));
        }
        let paths: Vec<String> = entries
            .iter()
            .map(|entry| {
                entry
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| AppError::InvalidPath("Clipboard entry has no path".into()))
            })
            .collect::<Result<_, _>>()?;
        if paths.is_empty() {
            return Err(AppError::InvalidPath("No paths to copy".into()));
        }
        #[cfg(target_os = "linux")]
        if operation == "cut" && self.x11.is_none() {
            return Err(AppError::Other(
                "Cut requires X11 clipboard ownership; Copy is available here".into(),
            ));
        }
        #[cfg(not(target_os = "linux"))]
        if operation == "cut" {
            return Err(AppError::Other(
                "Cut requires native clipboard ownership; Copy is available here".into(),
            ));
        }
        let next_revision = self.revision.wrapping_add(1);
        let token = new_clipboard_token()?;
        let baseline = if operation == "copy" {
            read_clipboard_file_paths().ok()
        } else {
            None
        };
        #[cfg(target_os = "linux")]
        let baseline_owner = if operation == "copy" {
            x11_clipboard_owner()
        } else {
            None
        };
        let write = self.write(&paths, &token);
        if operation == "cut" && !matches!(write, Ok(true)) {
            return Err(AppError::Other(
                "Could not verify native Cut clipboard ownership".into(),
            ));
        }
        self.revision = next_revision;
        self.entries = Some(entries);
        self.paths = paths;
        self.operation = Some(operation);
        self.token = if matches!(write, Ok(true)) {
            Some(token)
        } else {
            None
        };
        self.mirror_error = write.err().map(|error| error.to_string());
        self.failed_mirror_baseline_paths = self.mirror_error.as_ref().and(baseline);
        #[cfg(target_os = "linux")]
        {
            self.failed_mirror_baseline_owner = self.mirror_error.as_ref().and(baseline_owner);
        }
        Ok(FileClipboardSnapshot {
            revision: self.revision,
            entries: self.entries.clone(),
            paths: self.paths.clone(),
            operation: self.operation.clone(),
            mirror_error: self.mirror_error.clone(),
        })
    }

    fn clear(&mut self, revision: u64) -> Result<bool, AppError> {
        let current = self.snapshot()?;
        if current.revision != revision || self.entries.is_none() {
            return Ok(false);
        }
        self.revision = self.revision.wrapping_add(1);
        self.entries = None;
        self.operation = None;
        // The OS clipboard keeps the paths for subsequent Copy paste.
        Ok(true)
    }

    /// Claim the Cut at `revision` for one paste. Fails when another paste
    /// holds it, when it was consumed or replaced, or when it is a Copy.
    fn claim_cut(&mut self, revision: u64) -> Result<bool, AppError> {
        let current = self.snapshot()?;
        let is_cut = current.entries.is_some() && current.operation.as_deref() == Some("cut");
        Ok(self.cut_lease.claim(current.revision, revision, is_cut))
    }

    fn release_cut(&mut self, revision: u64) -> bool {
        self.cut_lease.release(self.revision, revision)
    }

    fn rekey(
        &mut self,
        revision: u64,
        old_path: &str,
        entry: serde_json::Value,
    ) -> Result<Option<FileClipboardSnapshot>, AppError> {
        let current = self.snapshot()?;
        if current.revision != revision {
            return Ok(None);
        }
        let Some(entries) = self.entries.as_ref() else {
            return Ok(None);
        };
        let Some(index) = entries.iter().position(|candidate| {
            candidate.get("path").and_then(serde_json::Value::as_str) == Some(old_path)
        }) else {
            return Ok(None);
        };
        let new_path = entry
            .get("path")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| AppError::InvalidPath("Clipboard entry has no path".into()))?
            .to_owned();
        let Some(path_index) = self.paths.iter().position(|path| path == old_path) else {
            return Ok(None);
        };
        let mut paths = self.paths.clone();
        paths[path_index] = new_path;
        let token = new_clipboard_token()?;
        let baseline = if self.operation.as_deref() == Some("copy") {
            read_clipboard_file_paths().ok()
        } else {
            None
        };
        #[cfg(target_os = "linux")]
        let baseline_owner = if self.operation.as_deref() == Some("copy") {
            x11_clipboard_owner()
        } else {
            None
        };
        let write = self.write(&paths, &token);
        if self.operation.as_deref() == Some("cut") && !matches!(write, Ok(true)) {
            return Err(AppError::Other(
                "Could not verify native Cut after rename".into(),
            ));
        }
        let verified = matches!(write, Ok(true));
        self.mirror_error = write.err().map(|error| error.to_string());
        self.failed_mirror_baseline_paths = self.mirror_error.as_ref().and(baseline);
        #[cfg(target_os = "linux")]
        {
            self.failed_mirror_baseline_owner = self.mirror_error.as_ref().and(baseline_owner);
        }
        self.entries.as_mut().expect("entries checked above")[index] = entry;
        self.paths = paths;
        self.token = verified.then_some(token);
        self.revision = self.revision.wrapping_add(1);
        Ok(Some(FileClipboardSnapshot {
            revision: self.revision,
            entries: self.entries.clone(),
            paths: self.paths.clone(),
            operation: self.operation.clone(),
            mirror_error: self.mirror_error.clone(),
        }))
    }
}

#[cfg(target_os = "linux")]
fn x11_clipboard_owner() -> Option<u32> {
    if is_wayland() {
        return None;
    }
    use x11rb::protocol::xproto::ConnectionExt;
    let (connection, _) = x11rb::connect(None).ok()?;
    let atom = connection
        .intern_atom(false, b"CLIPBOARD")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let owner = connection
        .get_selection_owner(atom)
        .ok()?
        .reply()
        .ok()?
        .owner;
    Some(owner)
}

fn new_clipboard_token() -> Result<String, AppError> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|error| AppError::Other(format!("Clipboard token unavailable: {error}")))?;
    Ok(nonce.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn clipboard_queue() -> &'static std::sync::mpsc::Sender<FileClipboardJob> {
    static QUEUE: std::sync::OnceLock<std::sync::mpsc::Sender<FileClipboardJob>> =
        std::sync::OnceLock::new();
    QUEUE.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("file-clipboard".into())
            .spawn(move || {
                let mut coordinator = FileClipboardCoordinator::new();
                while let Ok(job) = receiver.recv() {
                    match job {
                        FileClipboardJob::Publish {
                            entries,
                            operation,
                            reply,
                        } => {
                            let _ = reply.send(coordinator.publish(entries, operation));
                        }
                        FileClipboardJob::Snapshot { reply } => {
                            let _ = reply.send(coordinator.snapshot());
                        }
                        FileClipboardJob::Clear { revision, reply } => {
                            let _ = reply.send(coordinator.clear(revision));
                        }
                        FileClipboardJob::Rekey {
                            revision,
                            old_path,
                            entry,
                            reply,
                        } => {
                            let _ = reply.send(coordinator.rekey(revision, &old_path, entry));
                        }
                        FileClipboardJob::ClaimCut { revision, reply } => {
                            let _ = reply.send(coordinator.claim_cut(revision));
                        }
                        FileClipboardJob::ReleaseCut { revision, reply } => {
                            let _ = reply.send(coordinator.release_cut(revision));
                        }
                    }
                }
            })
            .expect("clipboard worker must start");
        sender
    })
}

fn send_clipboard_job(job: FileClipboardJob) -> Result<(), AppError> {
    clipboard_queue()
        .send(job)
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))
}

#[tauri::command]
pub async fn clipboard_publish(
    entries: Vec<serde_json::Value>,
    operation: String,
) -> Result<FileClipboardSnapshot, AppError> {
    let (reply, received) = tokio::sync::oneshot::channel();
    send_clipboard_job(FileClipboardJob::Publish {
        entries,
        operation,
        reply,
    })?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))?
}

#[tauri::command]
pub async fn clipboard_snapshot() -> Result<FileClipboardSnapshot, AppError> {
    let (reply, received) = tokio::sync::oneshot::channel();
    send_clipboard_job(FileClipboardJob::Snapshot { reply })?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))?
}

#[tauri::command]
pub async fn clipboard_compare_and_clear(revision: u64) -> Result<bool, AppError> {
    let (reply, received) = tokio::sync::oneshot::channel();
    send_clipboard_job(FileClipboardJob::Clear { revision, reply })?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))?
}

#[tauri::command]
pub async fn clipboard_rekey(
    revision: u64,
    old_path: String,
    entry: serde_json::Value,
) -> Result<Option<FileClipboardSnapshot>, AppError> {
    let (reply, received) = tokio::sync::oneshot::channel();
    send_clipboard_job(FileClipboardJob::Rekey {
        revision,
        old_path,
        entry,
        reply,
    })?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))?
}

/// Claim the Cut at `revision` so exactly one paste moves it. A complete move
/// then clears it with `clipboard_compare_and_clear`; an unfinished one
/// returns it with `clipboard_release_cut`.
#[tauri::command]
pub async fn clipboard_claim_cut(revision: u64) -> Result<bool, AppError> {
    let (reply, received) = tokio::sync::oneshot::channel();
    send_clipboard_job(FileClipboardJob::ClaimCut { revision, reply })?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))?
}

#[tauri::command]
pub async fn clipboard_release_cut(revision: u64) -> Result<bool, AppError> {
    let (reply, received) = tokio::sync::oneshot::channel();
    send_clipboard_job(FileClipboardJob::ReleaseCut { revision, reply })?;
    received
        .await
        .map_err(|_| AppError::WorkerFailed("Clipboard worker exited".into()))
}

#[cfg(test)]
mod cut_lease_tests {
    use super::CutLease;

    #[test]
    fn only_one_paste_claims_a_cut_revision() {
        let mut lease = CutLease::default();
        assert!(lease.claim(7, 7, true));
        assert!(
            !lease.claim(7, 7, true),
            "a second window must not move the same Cut"
        );
    }

    #[test]
    fn released_cut_can_be_claimed_again() {
        let mut lease = CutLease::default();
        assert!(lease.claim(7, 7, true));
        assert!(lease.release(7, 7));
        assert!(lease.claim(7, 7, true));
    }

    #[test]
    fn copies_stale_revisions_and_foreign_releases_are_refused() {
        let mut lease = CutLease::default();
        assert!(!lease.claim(7, 7, false), "a Copy is never claimed");
        assert!(!lease.claim(8, 7, true), "a replaced Cut cannot be claimed");
        assert!(!lease.release(7, 7), "nothing is leased");
        assert!(lease.claim(7, 7, true));
        assert!(!lease.release(7, 6));
        assert!(
            !lease.claim(7, 7, true),
            "a mismatched release keeps the lease"
        );
    }

    #[test]
    fn a_new_revision_is_claimable_despite_an_older_lease() {
        let mut lease = CutLease::default();
        assert!(lease.claim(7, 7, true));
        // The clipboard moved on (new Cut, rekey, external replacement): the
        // old lease is stale and neither blocks nor can release the new one.
        assert!(!lease.release(8, 7));
        assert!(lease.claim(8, 8, true));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod clipboard_coordinator_x11_tests {
    use super::*;

    // Run on a private Xvfb display: xvfb-run -a cargo test x11_cut_identity -- --ignored
    #[test]
    #[ignore = "requires a private X11 display and xclip"]
    fn x11_cut_identity_and_external_file_formats() {
        use clipboard_rs::{Clipboard, ClipboardContent, ClipboardContext};
        assert!(!is_wayland());
        let mut coordinator = FileClipboardCoordinator::new();
        assert!(coordinator.x11.is_some());
        let entry = serde_json::json!({"name":"same.txt","path":"/tmp/same.txt"});
        let cut = coordinator
            .publish(vec![entry.clone()], "cut".into())
            .unwrap();
        assert_eq!(cut.operation.as_deref(), Some("cut"));
        assert_eq!(
            coordinator.snapshot().unwrap().operation.as_deref(),
            Some("cut")
        );
        let targets = Command::new("xclip")
            .args(["-o", "-selection", "clipboard", "-t", "TARGETS"])
            .output()
            .unwrap();
        let formats = String::from_utf8_lossy(&targets.stdout);
        assert!(
            formats.contains("x-special/gnome-copied-files"),
            "{formats}"
        );
        assert!(formats.contains("text/uri-list"), "{formats}");
        assert!(formats.contains(FILE_CLIPBOARD_TOKEN), "{formats}");

        let renamed = coordinator
            .rekey(
                cut.revision,
                "/tmp/same.txt",
                serde_json::json!({
                    "name": "renamed.txt", "path": "/tmp/renamed.txt"
                }),
            )
            .unwrap()
            .unwrap();
        assert_eq!(renamed.paths, vec!["/tmp/renamed.txt"]);
        assert_eq!(
            coordinator.snapshot().unwrap().operation.as_deref(),
            Some("cut")
        );
        assert!(
            !coordinator.claim_cut(cut.revision).unwrap(),
            "rekey replaced the revision"
        );
        assert!(coordinator.claim_cut(renamed.revision).unwrap());
        assert!(!coordinator.claim_cut(renamed.revision).unwrap());
        assert!(coordinator.release_cut(renamed.revision));

        // A different owner advertises the identical renamed file list,
        // without our private token. Cut must become external Copy.
        let external = ClipboardContext::new().unwrap();
        external
            .set(vec![ClipboardContent::Files(vec![
                "file:///tmp/renamed.txt".into(),
            ])])
            .unwrap();
        let observed = coordinator.snapshot().unwrap();
        assert_eq!(observed.paths, vec!["/tmp/renamed.txt"]);
        assert!(observed.entries.is_none());
        assert!(observed.operation.is_none());
        assert!(!coordinator.clear(renamed.revision).unwrap());
        assert!(coordinator
            .rekey(renamed.revision, "/tmp/renamed.txt", entry)
            .unwrap()
            .is_none());

        // Dropping the command reply models renderer cancellation after the
        // worker accepted the job. The subsequent snapshot must observe it.
        let (reply, received) = tokio::sync::oneshot::channel();
        send_clipboard_job(FileClipboardJob::Publish {
            entries: vec![serde_json::json!({"name":"survives.txt","path":"/tmp/survives.txt"})],
            operation: "copy".into(),
            reply,
        })
        .unwrap();
        drop(received);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let after_cancel = runtime.block_on(clipboard_snapshot()).unwrap();
        assert_eq!(after_cancel.paths, vec!["/tmp/survives.txt"]);
        assert_eq!(after_cancel.operation.as_deref(), Some("copy"));

        // Model a write-only mirror failure while OS reads still work. The
        // accepted in-app Copy remains usable until the OS owner changes.
        external
            .set_files(vec!["file:///tmp/baseline.txt".into()])
            .unwrap();
        coordinator.revision += 1;
        coordinator.entries = Some(vec![
            serde_json::json!({"name":"failed.txt","path":"/tmp/failed.txt"}),
        ]);
        coordinator.paths = vec!["/tmp/failed.txt".into()];
        coordinator.operation = Some("copy".into());
        coordinator.token = None;
        coordinator.mirror_error = Some("simulated write-only failure".into());
        coordinator.failed_mirror_baseline_paths = Some(vec!["/tmp/baseline.txt".into()]);
        coordinator.failed_mirror_baseline_owner = x11_clipboard_owner();
        assert_eq!(
            coordinator.snapshot().unwrap().paths,
            vec!["/tmp/failed.txt"]
        );

        let same_paths_new_owner = ClipboardContext::new().unwrap();
        same_paths_new_owner
            .set_files(vec!["file:///tmp/baseline.txt".into()])
            .unwrap();
        let same = coordinator.snapshot().unwrap();
        assert_eq!(same.paths, vec!["/tmp/baseline.txt"]);
        assert!(same.entries.is_none());
        assert!(same.operation.is_none());

        coordinator.revision += 1;
        coordinator.entries = Some(vec![
            serde_json::json!({"name":"failed-again.txt","path":"/tmp/failed-again.txt"}),
        ]);
        coordinator.paths = vec!["/tmp/failed-again.txt".into()];
        coordinator.operation = Some("copy".into());
        coordinator.mirror_error = Some("simulated write-only failure".into());
        coordinator.failed_mirror_baseline_paths = Some(vec!["/tmp/baseline.txt".into()]);
        coordinator.failed_mirror_baseline_owner = x11_clipboard_owner();
        let changed_owner = ClipboardContext::new().unwrap();
        changed_owner
            .set_files(vec!["file:///tmp/external.txt".into()])
            .unwrap();
        let changed = coordinator.snapshot().unwrap();
        assert_eq!(changed.paths, vec!["/tmp/external.txt"]);
        assert!(changed.entries.is_none());
        assert!(changed.operation.is_none());
    }
}
