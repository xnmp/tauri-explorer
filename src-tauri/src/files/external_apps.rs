//! External application launching: open files, image viewers, terminals.

use std::fs;
use std::path::PathBuf;

use super::run_blocking;
use crate::error::AppError;

/// Reap a spawned child on a background thread so it doesn't linger as a
/// zombie process on Unix after it exits.
fn reap_in_background(child: std::process::Child) {
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
}

/// Known text editors and their line-number invocation format.
enum LineFormat {
    /// `code --goto path:line`
    GotoColon,
    /// `editor path:line`
    PathColon,
    /// `editor +line path`
    PlusLine,
    /// `editor -l line path`
    DashLLine,
}

struct EditorDef {
    /// Substrings to match against the default app name (lowercase)
    app_names: &'static [&'static str],
    /// CLI binary to invoke
    binary: &'static str,
    format: LineFormat,
}

const KNOWN_EDITORS: &[EditorDef] = &[
    EditorDef {
        app_names: &["visual studio code", "vscode", "code"],
        binary: "code",
        format: LineFormat::GotoColon,
    },
    EditorDef {
        app_names: &["zed"],
        binary: "zed",
        format: LineFormat::PathColon,
    },
    EditorDef {
        app_names: &["sublime text", "sublime"],
        binary: "subl",
        format: LineFormat::PathColon,
    },
    EditorDef {
        app_names: &["textmate"],
        binary: "mate",
        format: LineFormat::DashLLine,
    },
    EditorDef {
        app_names: &["neovim", "nvim"],
        binary: "nvim",
        format: LineFormat::PlusLine,
    },
    EditorDef {
        app_names: &["vim", "macvim"],
        binary: "vim",
        format: LineFormat::PlusLine,
    },
];

/// Detect the default application for a file (returns app name/path).
#[cfg(target_os = "macos")]
fn get_default_app(file_path: &std::path::Path) -> Option<String> {
    // The path is passed as an osascript argument (argv), never interpolated
    // into the script source, so filenames can't inject JXA code.
    const SCRIPT: &str = concat!(
        "ObjC.import('AppKit');",
        "function run(argv) {",
        "var ws = $.NSWorkspace.sharedWorkspace;",
        "var url = $.NSURL.fileURLWithPath(argv[0]);",
        "var appUrl = ws.URLForApplicationToOpenURL(url);",
        "return appUrl ? appUrl.lastPathComponent.js : '';",
        "}"
    );
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .arg(file_path)
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Detect the default application for a file via xdg-mime.
#[cfg(target_os = "linux")]
fn get_default_app(file_path: &std::path::Path) -> Option<String> {
    // Get MIME type
    let mime_output = std::process::Command::new("xdg-mime")
        .args(["query", "filetype"])
        .arg(file_path)
        .output()
        .ok()?;
    let mime = String::from_utf8_lossy(&mime_output.stdout)
        .trim()
        .to_string();
    if mime.is_empty() {
        return None;
    }

    // Get default handler for that MIME type
    let handler_output = std::process::Command::new("xdg-mime")
        .args(["query", "default", &mime])
        .output()
        .ok()?;
    let desktop = String::from_utf8_lossy(&handler_output.stdout)
        .trim()
        .to_string();
    if desktop.is_empty() {
        None
    } else {
        Some(desktop)
    }
}

#[cfg(target_os = "windows")]
fn get_default_app(_file_path: &std::path::Path) -> Option<String> {
    // Windows: no simple way to query default handler by name.
    // Fall back to checking PATH for known editors.
    None
}

fn find_editor_in_path(binary: &str) -> bool {
    use crate::process_ext::NoConsole;
    #[cfg(windows)]
    let cmd = std::process::Command::new("where.exe")
        .no_console()
        .arg(binary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    #[cfg(not(windows))]
    let cmd = std::process::Command::new("which")
        .no_console()
        .arg(binary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    cmd.map(|s| s.success()).unwrap_or(false)
}

fn match_editor_by_app_name(app_name: &str) -> Option<&'static EditorDef> {
    let lower = app_name.to_lowercase();
    KNOWN_EDITORS
        .iter()
        .find(|e| e.app_names.iter().any(|name| lower.contains(name)))
}

fn spawn_editor(
    editor: &EditorDef,
    file_path: &std::path::Path,
    line: u32,
) -> Result<(), std::io::Error> {
    match editor.format {
        LineFormat::GotoColon => std::process::Command::new(editor.binary)
            .arg("--goto")
            .arg(format!("{}:{}", file_path.display(), line))
            .spawn()
            .map(reap_in_background),
        LineFormat::PathColon => std::process::Command::new(editor.binary)
            .arg(format!("{}:{}", file_path.display(), line))
            .spawn()
            .map(reap_in_background),
        LineFormat::PlusLine => std::process::Command::new(editor.binary)
            .arg(format!("+{}", line))
            .arg(file_path)
            .spawn()
            .map(reap_in_background),
        LineFormat::DashLLine => std::process::Command::new(editor.binary)
            .arg("-l")
            .arg(line.to_string())
            .arg(file_path)
            .spawn()
            .map(reap_in_background),
    }
}

/// Open a file at a specific line number using the default app if it supports
/// line numbers, otherwise fall back to a plain open.
#[tauri::command]
pub async fn open_file_at_line(path: String, line: u32) -> Result<(), AppError> {
    run_blocking(move || open_file_at_line_blocking(path, line)).await
}

fn open_file_at_line_blocking(path: String, line: u32) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);
    if fs::symlink_metadata(&file_path).is_err() {
        return Err(AppError::NotFound(path));
    }

    // Try to detect the default app and match it against known editors
    if let Some(app_name) = get_default_app(&file_path) {
        if let Some(editor) = match_editor_by_app_name(&app_name) {
            if find_editor_in_path(editor.binary) && spawn_editor(editor, &file_path, line).is_ok()
            {
                return Ok(());
            }
        }
    }

    // On Windows (or when detection fails), try known editors in PATH as fallback
    #[cfg(target_os = "windows")]
    {
        for editor in KNOWN_EDITORS {
            if find_editor_in_path(editor.binary) {
                if spawn_editor(editor, &file_path, line).is_ok() {
                    return Ok(());
                }
            }
        }
    }

    // Default app doesn't support line numbers — open without them
    open_file_blocking(path)
}

/// Open a file with the system's default application.
#[tauri::command]
pub async fn open_file(path: String) -> Result<(), AppError> {
    run_blocking(move || open_file_blocking(path)).await
}

fn open_file_blocking(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if fs::symlink_metadata(&file_path).is_err() {
        return Err(AppError::NotFound(path));
    }

    // On Linux, xdg-open detects MIME from content (not extension), which
    // often maps e.g. .md → text/plain instead of text/markdown. Work around
    // by resolving the MIME type from the extension and querying xdg-mime
    // for the correct handler.
    #[cfg(target_os = "linux")]
    if let Some(desktop_file) = resolve_xdg_desktop_by_extension(&file_path) {
        if launch_desktop_file(&desktop_file, &file_path) {
            return Ok(());
        }
        log::warn!(
            "Failed to launch desktop handler {} — falling back to opener",
            desktop_file
        );
    }

    opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()))
}

/// Open a file with a specified application.
#[tauri::command]
pub async fn open_file_with(path: String, app: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if fs::symlink_metadata(&file_path).is_err() {
        return Err(AppError::NotFound(path));
    }

    std::process::Command::new(&app)
        .arg(&file_path)
        .spawn()
        .map(reap_in_background)
        .map_err(AppError::Io)?;

    Ok(())
}

/// Image extensions for sibling gathering.
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif",
];

/// MIME type for an image file extension (lowercase, without the dot).
fn image_mime_for_extension(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/vnd.microsoft.icon",
        "tiff" | "tif" => "image/tiff",
        _ => "image/png",
    }
}

/// Open an image file, passing all sibling images in the same directory
/// so that viewers like imv can navigate between them with arrow keys.
#[tauri::command]
pub async fn open_image_with_siblings(path: String) -> Result<(), AppError> {
    run_blocking(move || open_image_with_siblings_blocking(path)).await
}

fn open_image_with_siblings_blocking(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);
    if fs::symlink_metadata(&file_path).is_err() {
        return Err(AppError::NotFound(path));
    }

    // Windows: open with the default viewer via the shell. Photos' in-folder
    // arrow-key navigation only works when launched from Explorer itself; a
    // programmatic launch (whether ShellExecute or Shell.Application InvokeVerb)
    // doesn't carry that context, and InvokeVerb added noticeable latency for no
    // benefit — so we use the plain, fast default-handler open.
    // (The sibling-list passing below is for Linux viewers like imv.)
    #[cfg(windows)]
    {
        return opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()));
    }

    #[cfg(not(windows))]
    {
        let parent = file_path
            .parent()
            .ok_or_else(|| AppError::Other("Cannot determine parent directory".into()))?;

        // Collect all image files in the same directory, sorted by name
        let mut images: Vec<PathBuf> = fs::read_dir(parent)
            .map_err(AppError::from)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
                    .unwrap_or(false)
            })
            .collect();
        images.sort();

        if images.is_empty() {
            // Fallback: just open the single file
            return opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()));
        }

        // Put the selected image first, followed by the rest in order
        let target_idx = images.iter().position(|p| p == &file_path).unwrap_or(0);
        let mut ordered = Vec::with_capacity(images.len());
        ordered.extend_from_slice(&images[target_idx..]);
        ordered.extend_from_slice(&images[..target_idx]);

        // Known image viewers that accept multiple file arguments for navigation
        const MULTI_FILE_VIEWERS: &[&str] = &[
            "imv",
            "imv-wayland",
            "imv-x11",
            "feh",
            "eog",
            "eom",
            "sxiv",
            "nsxiv",
            "qimgv",
            "nomacs",
            "gpicview",
        ];

        // Resolve the MIME type from the actual file's extension so the default
        // viewer lookup matches the file being opened (not hardcoded image/png).
        let mime = file_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| image_mime_for_extension(&ext.to_lowercase()))
            .unwrap_or("image/png");

        // Try to detect the default image viewer via xdg-mime
        if let Ok(output) = std::process::Command::new("xdg-mime")
            .args(["query", "default", mime])
            .output()
        {
            let desktop_file = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !desktop_file.is_empty() {
                let app_name = desktop_file
                    .strip_suffix(".desktop")
                    .unwrap_or(&desktop_file);
                if MULTI_FILE_VIEWERS.contains(&app_name) {
                    // Launch viewer with all sibling images
                    return std::process::Command::new(app_name)
                        .args(&ordered)
                        .spawn()
                        .map(reap_in_background)
                        .map_err(AppError::Io);
                }
            }
        }

        // Fallback: open just the single file with default handler
        opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()))
    }
}

/// Spawn a terminal emulator at the given directory, using the correct
/// arguments for each known terminal. Returns true on success.
fn try_spawn_terminal(term: &str, dir: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", term])
            .arg(dir)
            .spawn()
            .map(reap_in_background)
            .is_ok()
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut cmd = std::process::Command::new(term);
        cmd.current_dir(dir);

        // Several terminals open the *new* window at their own default directory
        // and ignore the spawned process cwd (notably wezterm and Windows
        // Terminal). Pass an explicit working-directory argument for those.
        let base = std::path::Path::new(term)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(term)
            .to_lowercase();
        let dir_str = dir.to_string_lossy();
        match base.as_str() {
            "wezterm" | "wezterm-gui" => {
                cmd.args(["start", "--cwd"]).arg(dir);
            }
            "wt" | "windowsterminal" => {
                cmd.arg("-d").arg(dir);
            }
            "alacritty" => {
                cmd.arg("--working-directory").arg(dir);
            }
            "kitty" => {
                cmd.arg("--directory").arg(dir);
            }
            "konsole" => {
                cmd.arg("--workdir").arg(dir);
            }
            "gnome-terminal" | "xfce4-terminal" | "tilix" | "terminator" | "ghostty" => {
                cmd.arg(format!("--working-directory={}", dir_str));
            }
            _ => {}
        }

        cmd.spawn().map(reap_in_background).is_ok()
    }
}

/// Open a terminal at a directory path.
/// If `terminal` is non-empty, use that command; otherwise auto-detect.
#[tauri::command]
pub async fn open_in_terminal(path: String, terminal: Option<String>) -> Result<(), AppError> {
    run_blocking(move || open_in_terminal_blocking(path, terminal)).await
}

fn open_in_terminal_blocking(path: String, terminal: Option<String>) -> Result<(), AppError> {
    let dir_path = PathBuf::from(&path);

    if fs::symlink_metadata(&dir_path).is_err() {
        return Err(AppError::NotFound(path));
    }

    // Use the directory itself or its parent for files
    let dir = if dir_path.is_dir() {
        dir_path
    } else {
        dir_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or(dir_path)
    };

    // Try user-configured terminal first
    if let Some(ref term) = terminal {
        if !term.is_empty() && try_spawn_terminal(term, &dir) {
            return Ok(());
        }
        // Fall through to auto-detect if configured terminal fails
    }

    #[cfg(target_os = "linux")]
    {
        // Try common Linux terminal emulators with their correct arguments
        let terminals = [
            "ghostty",
            "kitty",
            "alacritty",
            "gnome-terminal",
            "konsole",
            "xterm",
        ];
        for term in &terminals {
            if try_spawn_terminal(term, &dir) {
                return Ok(());
            }
        }
        // Fallback: use x-terminal-emulator
        std::process::Command::new("x-terminal-emulator")
            .current_dir(&dir)
            .spawn()
            .map(reap_in_background)
            .map_err(AppError::Io)?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&dir)
            .spawn()
            .map(reap_in_background)
            .map_err(|e| AppError::Io(e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd.exe"])
            .current_dir(&dir)
            .spawn()
            .map(reap_in_background)
            .map_err(|e| AppError::Io(e))?;
    }

    Ok(())
}

/// Known terminal emulator commands per platform, in preference order.
/// Used both for auto-detect ordering and for the settings dropdown.
#[cfg(target_os = "linux")]
const KNOWN_TERMINALS: &[&str] = &[
    "ghostty",
    "kitty",
    "alacritty",
    "wezterm",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "tilix",
    "terminator",
    "xterm",
];
#[cfg(target_os = "macos")]
const KNOWN_TERMINALS: &[&str] = &[
    "iTerm",
    "Ghostty",
    "Alacritty",
    "kitty",
    "WezTerm",
    "Terminal",
];
#[cfg(target_os = "windows")]
const KNOWN_TERMINALS: &[&str] = &["wt", "pwsh", "powershell", "alacritty", "wezterm", "cmd"];

/// Return the subset of known terminal emulators that are actually installed
/// on this machine, so the settings UI can present a dropdown instead of a
/// free-text command field. On macOS the entries are app names (looked up via
/// the Applications dirs); elsewhere they are PATH binaries.
#[tauri::command]
pub async fn list_installed_terminals() -> Result<Vec<String>, AppError> {
    run_blocking(|| {
        let mut found: Vec<String> = Vec::new();
        for term in KNOWN_TERMINALS {
            #[cfg(target_os = "macos")]
            let installed = {
                let app = format!("/Applications/{term}.app");
                std::path::Path::new(&app).exists()
                    || std::path::Path::new(&format!(
                        "{}/Applications/{term}.app",
                        std::env::var("HOME").unwrap_or_default()
                    ))
                    .exists()
                    || *term == "Terminal" // always present on macOS
            };
            #[cfg(not(target_os = "macos"))]
            let installed = find_editor_in_path(term);

            if installed {
                found.push((*term).to_string());
            }
        }
        Ok(found)
    })
    .await
}

/// Map file extension to MIME type for cases where content-based detection
/// (used by `xdg-open`) gives the wrong result. Only includes types where
/// extension-based lookup is more reliable than content sniffing.
#[cfg(target_os = "linux")]
fn mime_type_from_extension(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => Some("text/markdown"),
        "rs" => Some("text/x-rust"),
        "ts" | "mts" | "cts" => Some("text/x-typescript"),
        "tsx" => Some("text/x-typescript"),
        "jsx" => Some("text/javascript"),
        "svelte" => Some("text/x-svelte"),
        "vue" => Some("text/x-vue"),
        "go" => Some("text/x-go"),
        "rb" => Some("text/x-ruby"),
        "lua" => Some("text/x-lua"),
        "toml" => Some("application/toml"),
        "yaml" | "yml" => Some("application/x-yaml"),
        "json" | "jsonc" => Some("application/json"),
        _ => None,
    }
}

/// Standard directories that contain `.desktop` application entries.
#[cfg(target_os = "linux")]
fn desktop_file_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();
    match std::env::var("XDG_DATA_HOME") {
        Ok(home) if !home.is_empty() => {
            dirs_out.push(PathBuf::from(home).join("applications"));
        }
        _ => {
            if let Some(home) = dirs::home_dir() {
                dirs_out.push(home.join(".local/share/applications"));
            }
        }
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    for dir in data_dirs.split(':').filter(|s| !s.is_empty()) {
        dirs_out.push(PathBuf::from(dir).join("applications"));
    }
    dirs_out
}

/// Launch a `.desktop` handler for a file via `gio launch` (preferred) or
/// `gtk-launch`. Running the desktop-file basename directly as a binary
/// fails for handlers like `org.gnome.Evince.desktop`, so go through the
/// desktop-entry machinery instead. Returns true when launched successfully.
#[cfg(target_os = "linux")]
fn launch_desktop_file(desktop_file: &str, file_path: &std::path::Path) -> bool {
    use std::process::{Command, Stdio};

    // `gio launch` requires the full path to the .desktop file.
    if let Some(desktop_path) = desktop_file_dirs()
        .iter()
        .map(|dir| dir.join(desktop_file))
        .find(|candidate| candidate.exists())
    {
        let status = Command::new("gio")
            .arg("launch")
            .arg(&desktop_path)
            .arg(file_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if matches!(status, Ok(s) if s.success()) {
            return true;
        }
    }

    // `gtk-launch` resolves the desktop file by name from standard dirs.
    let status = Command::new("gtk-launch")
        .arg(desktop_file)
        .arg(file_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    matches!(status, Ok(s) if s.success())
}

/// Query xdg-mime for the default handler's desktop file for a MIME type
/// resolved from the file extension. Returns `None` if no override is needed
/// (i.e., content-based detection would pick the same handler).
#[cfg(target_os = "linux")]
fn resolve_xdg_desktop_by_extension(path: &std::path::Path) -> Option<String> {
    let mime = mime_type_from_extension(path)?;

    let output = std::process::Command::new("xdg-mime")
        .args(["query", "default", mime])
        .output()
        .ok()?;

    let desktop_file = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if desktop_file.is_empty() {
        return None;
    }

    // Check what xdg-open would use (content-based MIME) — if the same
    // desktop file, no override needed.
    if let Ok(content_output) = std::process::Command::new("xdg-mime")
        .args(["query", "filetype"])
        .arg(path)
        .output()
    {
        let content_mime = String::from_utf8_lossy(&content_output.stdout)
            .trim()
            .to_string();
        if let Ok(default_output) = std::process::Command::new("xdg-mime")
            .args(["query", "default", &content_mime])
            .output()
        {
            let default_desktop = String::from_utf8_lossy(&default_output.stdout)
                .trim()
                .to_string();
            if default_desktop == desktop_file {
                return None;
            }
        }
    }

    Some(desktop_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_image_mime_for_extension() {
        assert_eq!(image_mime_for_extension("jpg"), "image/jpeg");
        assert_eq!(image_mime_for_extension("jpeg"), "image/jpeg");
        assert_eq!(image_mime_for_extension("webp"), "image/webp");
        assert_eq!(image_mime_for_extension("svg"), "image/svg+xml");
        assert_eq!(image_mime_for_extension("tif"), "image/tiff");
        // Unknown extensions fall back to image/png
        assert_eq!(image_mime_for_extension("xyz"), "image/png");
    }
}
