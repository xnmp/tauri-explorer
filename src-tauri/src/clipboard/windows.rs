//! Windows clipboard.
//!
//! File lists use the Win32 clipboard directly: `CF_HDROP` keeps file
//! copy/paste interoperable with Explorer. They sit on every Copy, Cut and
//! Paste path, which the ordered worker serializes, so they must not start a
//! process: a PowerShell shell-out per read and write made Paste wait for
//! several serial PowerShell starts, which a loaded machine stretched past
//! 15 s (#912).
//!
//! Text and image reads, which are off that path, shell out to PowerShell
//! (`System.Windows.Forms.Clipboard`); bitmaps are re-encoded as PNG.
//! WinForms clipboard APIs need STA; `powershell.exe` (Windows PowerShell
//! 5.1) is always present and runs STA.
//!
//! Cut ownership (#877): each file write also offers a registered private
//! format carrying the write's token, in the same clipboard session. Right after
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

/// The `CF_HDROP` payload for `paths`: a `DROPFILES` header (`pFiles` = 20,
/// no point, `fWide` set) followed by each path as NUL-terminated UTF-16LE
/// and a final NUL that ends the list.
fn drop_files(paths: &[String]) -> Result<Vec<u8>, AppError> {
    const HEADER_LEN: u32 = 20;
    if paths.is_empty() {
        return Err(AppError::InvalidPath("No paths to copy".to_string()));
    }
    if let Some(path) = paths
        .iter()
        .find(|path| path.is_empty() || path.contains('\0'))
    {
        return Err(AppError::InvalidPath(format!(
            "Cannot put {path:?} on the clipboard"
        )));
    }
    let mut bytes = Vec::new();
    for field in [HEADER_LEN, 0, 0, 0, 1] {
        bytes.extend_from_slice(&field.to_le_bytes());
    }
    let units = paths
        .iter()
        .flat_map(|path| path.encode_utf16().chain([0]))
        .chain([0]);
    for unit in units {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    Ok(bytes)
}

impl ClipboardBackend for WindowsFileClipboard {
    /// A clipboard that another process keeps open is a failed read, not
    /// "no files"; a clipboard without `CF_HDROP` offers no files.
    fn read_files(&mut self) -> Result<Vec<String>, AppError> {
        native::read_file_list()
    }

    /// A `CF_HDROP` file drop list with Copy semantics, so Explorer and other
    /// apps can paste it without moving the app's Cut, plus the token in
    /// `TOKEN_FORMAT`, both set in one clipboard session.
    fn write_files(
        &mut self,
        paths: &[String],
        _operation: ClipboardOperation,
        token: &str,
    ) -> Result<(), AppError> {
        native::write_file_list(&drop_files(paths)?, TOKEN_FORMAT, token.as_bytes())?;
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

/// The native clipboard calls. They take milliseconds, so the ordered worker
/// never waits on a process start.
mod native {
    use crate::error::AppError;
    use std::time::Duration;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GHND};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// `CF_HDROP` (winuser.h). The `windows` crate binds it only behind the
    /// `Win32_System_Ole` feature, which nothing else here needs.
    const CF_HDROP: u32 = 15;

    /// The window station's clipboard sequence number, or `None` when this
    /// process lacks clipboard access (the API then returns 0).
    pub(super) fn sequence_number() -> Option<i64> {
        // SAFETY: no arguments; reads the window station's counter.
        match unsafe { GetClipboardSequenceNumber() } {
            0 => None,
            number => Some(i64::from(number)),
        }
    }

    fn register_format(name: &str) -> Option<u32> {
        // SAFETY: a NUL-terminated wide string that outlives the call.
        match unsafe { RegisterClipboardFormatW(&HSTRING::from(name)) } {
            0 => None,
            format => Some(format),
        }
    }

    /// The bytes of registered format `name` on the clipboard, if offered.
    pub(super) fn read_format(name: &str) -> Option<Vec<u8>> {
        let format = register_format(name)?;
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

    /// The paths of the clipboard's `CF_HDROP` list. Another program's
    /// delayed rendering (Explorer's Copy) renders the list on request.
    pub(super) fn read_file_list() -> Result<Vec<String>, AppError> {
        let _open = OpenedClipboard::open().ok_or_else(clipboard_busy)?;
        // SAFETY: the clipboard is open on this thread.
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) }.is_err() {
            return Ok(Vec::new());
        }
        // SAFETY: the clipboard is open. It keeps owning the handle, which
        // stays valid until the clipboard closes, after the paths are copied.
        let handle = unsafe { GetClipboardData(CF_HDROP) }.map_err(|error| {
            AppError::Other(format!("Reading the clipboard file list failed: {error}"))
        })?;
        let list = HDROP(handle.0);
        // SAFETY: `list` is the clipboard's `CF_HDROP` block; index
        // `u32::MAX` asks for the number of paths.
        let count = unsafe { DragQueryFileW(list, u32::MAX, None) };
        (0..count)
            .map(|index| {
                // SAFETY: as above; no buffer asks for the length without NUL.
                let length = unsafe { DragQueryFileW(list, index, None) };
                let mut path = vec![0u16; length as usize + 1];
                // SAFETY: `path` holds the name and its terminating NUL.
                let copied = unsafe { DragQueryFileW(list, index, Some(&mut path)) };
                if length == 0 || copied != length {
                    return Err(AppError::Other("Invalid clipboard file list".into()));
                }
                Ok(String::from_utf16_lossy(&path[..length as usize]))
            })
            .collect()
    }

    /// Replace the clipboard with `drop_files` as `CF_HDROP` and `token` in
    /// the registered `token_format`, in one clipboard session. Both blocks
    /// are fully rendered, so they outlive this process. They are prepared
    /// before the clipboard is emptied, so an allocation failure leaves the
    /// previous content in place.
    pub(super) fn write_file_list(
        drop_files: &[u8],
        token_format: &str,
        token: &[u8],
    ) -> Result<(), AppError> {
        let format = register_format(token_format).ok_or_else(|| {
            AppError::Other("Registering the clipboard token format failed".into())
        })?;
        let files = GlobalBlock::copy_of(drop_files)?;
        let token = GlobalBlock::copy_of(token)?;
        let _open = OpenedClipboard::open().ok_or_else(clipboard_busy)?;
        // SAFETY: the clipboard is open on this thread.
        unsafe { EmptyClipboard() }.map_err(write_failed)?;
        files.hand_to_clipboard(CF_HDROP)?;
        token.hand_to_clipboard(format)
    }

    /// A movable global memory block that this process owns until the
    /// clipboard takes it; freed on drop otherwise.
    struct GlobalBlock(HGLOBAL);

    impl GlobalBlock {
        fn copy_of(bytes: &[u8]) -> Result<Self, AppError> {
            // SAFETY: allocates a movable block. `GHND` zero-fills it, so a
            // block larger than requested reads as NUL padding after `bytes`.
            let block = Self(unsafe { GlobalAlloc(GHND, bytes.len()) }.map_err(write_failed)?);
            // SAFETY: the block holds at least `bytes.len()` bytes while locked.
            unsafe {
                let data = GlobalLock(block.0).cast::<u8>();
                if data.is_null() {
                    return Err(AppError::Other("Locking clipboard memory failed".into()));
                }
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data, bytes.len());
                let _ = GlobalUnlock(block.0);
            }
            Ok(block)
        }

        /// Set the block as `format` on the open clipboard, which then owns it.
        fn hand_to_clipboard(self, format: u32) -> Result<(), AppError> {
            // SAFETY: the clipboard is open; on success it owns the block.
            unsafe { SetClipboardData(format, Some(HANDLE(self.0 .0))) }.map_err(write_failed)?;
            std::mem::forget(self);
            Ok(())
        }
    }

    impl Drop for GlobalBlock {
        fn drop(&mut self) {
            // SAFETY: the clipboard has not taken the block, and nothing else
            // refers to it.
            let _ = unsafe { GlobalFree(Some(self.0)) };
        }
    }

    fn clipboard_busy() -> AppError {
        AppError::Other("The clipboard is in use by another program".into())
    }

    fn write_failed(error: windows::core::Error) -> AppError {
        AppError::Other(format!("Writing the clipboard failed: {error}"))
    }

    /// The clipboard, open for this thread until dropped.
    struct OpenedClipboard;

    impl OpenedClipboard {
        /// Another process may hold the clipboard open briefly (a clipboard
        /// history service reads every change); retry for about a second.
        fn open() -> Option<Self> {
            for _ in 0..100 {
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
mod drop_files_tests {
    use super::drop_files;

    fn utf16(bytes: &[u8]) -> Vec<u16> {
        let (units, odd) = bytes.as_chunks::<2>();
        assert!(odd.is_empty(), "UTF-16 is whole code units");
        units.iter().map(|unit| u16::from_le_bytes(*unit)).collect()
    }

    #[test]
    fn wide_paths_follow_the_dropfiles_header_and_end_with_an_empty_name() {
        let paths = [
            "C:\\a\\cut me é.txt".to_string(),
            "C:\\b\\日本.txt".to_string(),
        ];
        let bytes = drop_files(&paths).unwrap();
        let (fields, _) = bytes[..20].as_chunks::<4>();
        let header: Vec<u32> = fields
            .iter()
            .map(|field| u32::from_le_bytes(*field))
            .collect();
        // pFiles, pt.x, pt.y, fNC, fWide
        assert_eq!(header, vec![20, 0, 0, 0, 1]);
        let names = String::from_utf16(&utf16(&bytes[20..])).unwrap();
        assert_eq!(names, "C:\\a\\cut me é.txt\0C:\\b\\日本.txt\0\0");
    }

    #[test]
    fn an_empty_list_or_unrepresentable_path_is_refused() {
        assert!(drop_files(&[]).is_err());
        assert!(drop_files(&[String::new()]).is_err());
        assert!(drop_files(&["C:\\a\0b.txt".to_string()]).is_err());
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
