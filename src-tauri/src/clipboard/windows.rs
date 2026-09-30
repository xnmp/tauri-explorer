//! Windows clipboard via a short PowerShell shell-out per operation
//! (`System.Windows.Forms.Clipboard`): `CF_HDROP` file drop lists keep file
//! copy/paste interoperable with Explorer, and bitmaps are re-encoded as PNG.
//! WinForms clipboard APIs need STA; `powershell.exe` (Windows PowerShell
//! 5.1) is always present and runs STA. Data travels in environment
//! variables, never interpolated into the script, so filenames cannot break
//! or inject it.
//!
//! Cut ownership (#877): each file write also offers a registered private
//! format carrying the write's token, in the same data object. Right after
//! the write, the native `GetClipboardSequenceNumber` is read around a native
//! read-back of that token (`change_counter.rs`); the write owns the
//! clipboard while the sequence number is unchanged. Any later clipboard
//! change ends it. Where another process re-renders every clipboard change
//! (remote-desktop clipboard redirection, some clipboard managers), Cut
//! therefore fails closed and Copy keeps working.

use super::backend::{ClipboardBackend, ClipboardOperation, ClipboardReader, SelectionOwner};
use super::change_counter::CounterOwnership;
use crate::error::AppError;
use std::process::{Command, Output};

/// The registered clipboard format that carries a write's token. The
/// sequence number, not the format, proves ownership; the token proves that
/// the sequence number observed after the write names this write.
const TOKEN_FORMAT: &str = "TauriExplorer.FileClipboardToken";

pub(super) fn backend() -> Box<dyn ClipboardBackend> {
    Box::new(WindowsFileClipboard::default())
}

pub(super) fn reader() -> Box<dyn ClipboardReader> {
    Box::new(WindowsClipboard)
}

/// Stateless text and image reads.
struct WindowsClipboard;

/// The worker-owned file-list backend.
#[derive(Default)]
struct WindowsFileClipboard {
    ownership: CounterOwnership,
}

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

/// Decode `read_files`' base64 UTF-8, newline-separated path list.
fn decode_path_list(stdout: &[u8]) -> Result<Vec<String>, AppError> {
    use base64::Engine as _;
    let encoded = ps_lines(stdout).concat();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| AppError::Other(format!("Invalid clipboard file list: {error}")))?;
    let text = String::from_utf8(bytes)
        .map_err(|error| AppError::Other(format!("Invalid clipboard file list: {error}")))?;
    Ok(text
        .split('\n')
        .map(|path| path.trim_end_matches('\r'))
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

impl ClipboardBackend for WindowsFileClipboard {
    /// A clipboard held open by another process makes `GetFileDropList`
    /// throw; stop on it so that reads as a failure, not as "no files".
    /// Paths travel as base64 UTF-8: PowerShell writes redirected stdout in
    /// the console code page, which turned `é` into `?` (found by #877's
    /// real-clipboard test).
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files) { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($files -join "`n")) }
"#;
        match run_powershell(script, &[]) {
            Some(o) if o.status.success() => decode_path_list(&o.stdout),
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
    /// apps can paste it without moving the app's Cut, plus the token in
    /// `TOKEN_FORMAT`. WinForms stores a `MemoryStream` as its raw bytes, and
    /// `SetDataObject` with `copy = $true` renders every format onto the
    /// clipboard before PowerShell exits.
    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError> {
        if paths.is_empty() {
            return Err(AppError::InvalidPath("No paths to copy".to_string()));
        }
        let joined = paths.join("\n");
        let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$col = New-Object System.Collections.Specialized.StringCollection
foreach ($p in ($env:CLIP_PATHS -split "`n")) { if ($p) { [void]$col.Add($p) } }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($col)
$token = [System.IO.MemoryStream]::new([System.Text.Encoding]::ASCII.GetBytes($env:CLIP_TOKEN))
$data.SetData($env:CLIP_TOKEN_FORMAT, $token)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"#;
        let envs = [
            ("CLIP_PATHS", joined.as_str()),
            ("CLIP_TOKEN", token),
            ("CLIP_TOKEN_FORMAT", TOKEN_FORMAT),
        ];
        match run_powershell(script, &envs) {
            Some(o) if o.status.success() => {}
            Some(o) => {
                return Err(AppError::Other(format!(
                    "PowerShell clipboard write exited with {}",
                    o.status
                )))
            }
            None => {
                return Err(AppError::Other(
                    "Failed to start PowerShell for clipboard write".to_string(),
                ))
            }
        }
        let before = native::sequence_number();
        let read_back = native::read_format(TOKEN_FORMAT);
        let after = native::sequence_number();
        self.ownership
            .record_write(token, before, read_back.as_deref(), after);
        Ok(())
    }

    fn owner_token(&mut self) -> Option<String> {
        self.ownership.owner_token(native::sequence_number())
    }

    /// The sequence number identifies the clipboard's content, which is what
    /// a failed Copy mirror compares.
    fn selection_owner(&mut self) -> SelectionOwner {
        native::sequence_number().map_or(SelectionOwner::Unknown, |number| {
            SelectionOwner::Known(number.unsigned_abs())
        })
    }

    fn cut_unavailable_reason(&self) -> Option<&'static str> {
        None
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

/// The native clipboard calls that PowerShell cannot make cheaply.
mod native {
    use std::time::Duration;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// The window station's clipboard sequence number, or `None` when this
    /// process lacks clipboard access (the API then returns 0).
    pub(super) fn sequence_number() -> Option<i64> {
        // SAFETY: no arguments; reads the window station's counter.
        match unsafe { GetClipboardSequenceNumber() } {
            0 => None,
            number => Some(i64::from(number)),
        }
    }

    /// The bytes of registered format `name` on the clipboard, if offered.
    pub(super) fn read_format(name: &str) -> Option<Vec<u8>> {
        // SAFETY: a NUL-terminated wide string that outlives the call.
        let format = unsafe { RegisterClipboardFormatW(&HSTRING::from(name)) };
        if format == 0 {
            return None;
        }
        let _open = OpenedClipboard::open()?;
        // SAFETY: the clipboard is open. The clipboard keeps owning the
        // handle, which stays valid until the clipboard closes, after the copy.
        let handle = unsafe { GetClipboardData(format) }.ok()?;
        let memory = HGLOBAL(handle.0);
        // SAFETY: `memory` is the clipboard's global memory block. It stays
        // locked while its `size` bytes are copied.
        unsafe {
            let size = GlobalSize(memory);
            let data = GlobalLock(memory).cast::<u8>();
            if data.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(data, size).to_vec();
            let _ = GlobalUnlock(memory);
            Some(bytes)
        }
    }

    /// The clipboard, open for this thread until dropped.
    struct OpenedClipboard;

    impl OpenedClipboard {
        /// Another process may hold the clipboard open briefly; retry.
        fn open() -> Option<Self> {
            for _ in 0..10 {
                // SAFETY: no owner window; `Drop` closes it on this thread.
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return Some(Self);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            None
        }
    }

    impl Drop for OpenedClipboard {
        fn drop(&mut self) {
            // SAFETY: this thread opened the clipboard in `open`.
            let _ = unsafe { CloseClipboard() };
        }
    }
}

#[cfg(test)]
mod path_list_tests {
    use super::decode_path_list;
    use base64::Engine as _;

    fn encoded(text: &str) -> Vec<u8> {
        let mut stdout = base64::engine::general_purpose::STANDARD
            .encode(text)
            .into_bytes();
        stdout.extend_from_slice(b"\r\n");
        stdout
    }

    #[test]
    fn non_ascii_paths_survive_the_powershell_round_trip() {
        let paths = decode_path_list(&encoded("C:\\a\\cut me é.txt\nC:\\b\\日本.txt")).unwrap();
        assert_eq!(paths, vec!["C:\\a\\cut me é.txt", "C:\\b\\日本.txt"]);
    }

    #[test]
    fn an_empty_clipboard_is_no_files_and_garbage_is_an_error() {
        assert!(decode_path_list(b"").unwrap().is_empty());
        assert!(decode_path_list(b"\r\n").unwrap().is_empty());
        assert!(decode_path_list(b"not base64!\r\n").is_err());
        assert!(decode_path_list(&encoded_bytes(&[0xff, 0xfe])).is_err());
    }

    fn encoded_bytes(bytes: &[u8]) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .into_bytes()
    }
}

// Replaces the clipboard, so it is ignored by default; rust-platforms.yml runs
// it on the Windows runner:
// cargo test --lib native_clipboard_ownership -- --ignored
#[cfg(test)]
mod native_clipboard_tests {
    use super::*;

    #[test]
    #[ignore = "replaces the Windows clipboard"]
    fn native_clipboard_ownership_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("cut me é.txt");
        std::fs::write(&file, "payload").unwrap();
        let paths = vec![file.to_string_lossy().into_owned()];
        let mut backend = WindowsFileClipboard::default();
        assert_eq!(backend.cut_unavailable_reason(), None);

        let first = "a".repeat(32);
        backend
            .write_files(&paths, ClipboardOperation::Cut, &first)
            .unwrap();
        assert_eq!(
            backend.owner_token(),
            Some(first.clone()),
            "token read back: {:?}, sequence: {:?}",
            native::read_format(TOKEN_FORMAT),
            native::sequence_number()
        );
        assert_eq!(backend.read_files().unwrap(), paths, "Explorer's CF_HDROP");
        assert_eq!(backend.owner_token(), Some(first), "reads keep ownership");

        let second = "b".repeat(32);
        backend
            .write_files(&paths, ClipboardOperation::Cut, &second)
            .unwrap();
        assert_eq!(backend.owner_token(), Some(second));

        // Another process copies the identical file list: ownership ends.
        let owner_before = backend.selection_owner();
        let status = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                "Set-Clipboard -LiteralPath $env:CLIP_PATH",
            ])
            .env("CLIP_PATH", &paths[0])
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(backend.owner_token(), None);
        assert_ne!(backend.selection_owner(), owner_before);
        assert_eq!(backend.read_files().unwrap(), paths);
    }
}
