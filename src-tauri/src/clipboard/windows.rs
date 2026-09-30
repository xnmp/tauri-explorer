//! Windows clipboard via a short PowerShell shell-out per operation
//! (`System.Windows.Forms.Clipboard`): `CF_HDROP` file drop lists keep file
//! copy/paste interoperable with Explorer, and bitmaps are re-encoded as PNG.
//! WinForms clipboard APIs need STA; `powershell.exe` (Windows PowerShell
//! 5.1) is always present and runs STA. Data travels in environment
//! variables, never interpolated into the script, so filenames cannot break
//! or inject it.
//!
//! No ownership proof yet, so Cut fails closed. #877 plans a registered
//! private clipboard format that carries the token plus the
//! `GetClipboardSequenceNumber` captured after the write, which only requires
//! overriding `owner_token` and `cut_unavailable_reason`.

use super::backend::{ClipboardBackend, ClipboardOperation, ClipboardReader};
use crate::error::AppError;
use std::process::{Command, Output};

pub(super) fn backend() -> Box<dyn ClipboardBackend> {
    Box::new(WindowsClipboard)
}

pub(super) fn reader() -> Box<dyn ClipboardReader> {
    Box::new(WindowsClipboard)
}

struct WindowsClipboard;

/// Run a PowerShell script and return its output, or `None` if it failed to
/// launch. `envs` carries data into the script via environment variables.
fn run_powershell(script: &str, envs: &[(&str, &str)]) -> Option<Output> {
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
fn ps_lines(stdout: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(|l| l.trim_end_matches('\r').to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

impl ClipboardBackend for WindowsClipboard {
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
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

    /// A `CF_HDROP` file drop list with Copy semantics, so Explorer and other
    /// apps can paste it without moving the app's Cut.
    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        _token: &str,
    ) -> Result<(), AppError> {
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
}

impl ClipboardReader for WindowsClipboard {
    fn read_text(&self) -> Result<String, AppError> {
        use base64::Engine as _;
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Windows.Forms.Clipboard]::GetText()
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
"#;
        let output = run_powershell(script, &[]).ok_or_else(|| {
            AppError::Other("Failed to start PowerShell for clipboard text".into())
        })?;
        if !output.status.success() {
            return Err(AppError::Other(format!(
                "PowerShell clipboard text read exited with {}",
                output.status
            )));
        }
        let encoded = ps_lines(&output.stdout).concat();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| {
                AppError::Other(format!("Invalid clipboard text encoding: {error}"))
            })?;
        String::from_utf8(bytes)
            .map_err(|error| AppError::Other(format!("Invalid clipboard UTF-8: {error}")))
    }

    fn has_image(&self) -> bool {
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
if ([System.Windows.Forms.Clipboard]::ContainsImage()) { 'yes' } else { 'no' }
"#;
        run_powershell(script, &[])
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("yes"))
            .unwrap_or(false)
    }

    /// PNG only: the clipboard bitmap is re-encoded as PNG.
    fn read_image(&self, media_type: &str) -> Option<Vec<u8>> {
        use base64::Engine as _;
        if media_type != "image/png" {
            return None;
        }
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
}
