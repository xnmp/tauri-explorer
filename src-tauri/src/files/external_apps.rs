//! External application launching: open files, image viewers, terminals.

use std::fs;
use std::path::PathBuf;

use crate::error::AppError;

/// Open a file with the system's default application.
#[tauri::command]
pub fn open_file(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()))
}

/// Open a file with a specified application.
#[tauri::command]
pub fn open_file_with(path: String, app: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    std::process::Command::new(&app)
        .arg(&file_path)
        .spawn()
        .map_err(|e| AppError::Io(e))?;

    Ok(())
}

/// Image extensions for sibling gathering.
const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif",
];

/// Open an image file, passing all sibling images in the same directory
/// so that viewers like imv can navigate between them with arrow keys.
#[tauri::command]
pub async fn open_image_with_siblings(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    let parent = file_path
        .parent()
        .ok_or_else(|| AppError::Other("Cannot determine parent directory".into()))?;

    // Collect all image files in the same directory, sorted by name
    let mut images: Vec<PathBuf> = fs::read_dir(parent)
        .map_err(AppError::Io)?
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

    // Try to detect the default image viewer via xdg-mime
    if let Ok(output) = std::process::Command::new("xdg-mime")
        .args(["query", "default", "image/png"])
        .output()
    {
        let desktop_file = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !desktop_file.is_empty() {
            let app_name = desktop_file.strip_suffix(".desktop").unwrap_or(&desktop_file);
            if MULTI_FILE_VIEWERS.contains(&app_name) {
                // Launch viewer with all sibling images
                return std::process::Command::new(app_name)
                    .args(&ordered)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| AppError::Io(e));
            }
        }
    }

    // Fallback: open just the single file with default handler
    opener::open(&file_path).map_err(|e| AppError::Other(e.to_string()))
}

/// Spawn a terminal emulator at the given directory, using the correct
/// arguments for each known terminal. Returns true on success.
fn try_spawn_terminal(term: &str, dir: &std::path::Path) -> bool {
    // Extract just the binary name for matching (handles full paths like /usr/bin/kitty)
    let bin = std::path::Path::new(term)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(term);

    let result = match bin {
        // ghostty and gnome-terminal use --working-directory=PATH (= syntax)
        "ghostty" | "gnome-terminal" => std::process::Command::new(term)
            .arg(format!("--working-directory={}", dir.display()))
            .spawn(),
        // kitty uses --directory
        "kitty" => std::process::Command::new(term)
            .arg("--directory")
            .arg(dir)
            .spawn(),
        // konsole uses --workdir
        "konsole" => std::process::Command::new(term)
            .arg("--workdir")
            .arg(dir)
            .spawn(),
        // alacritty uses --working-directory
        "alacritty" => std::process::Command::new(term)
            .arg("--working-directory")
            .arg(dir)
            .spawn(),
        // xterm and others: use current_dir as universal fallback
        _ => std::process::Command::new(term).current_dir(dir).spawn(),
    };

    result.is_ok()
}

/// Open a terminal at a directory path.
/// If `terminal` is non-empty, use that command; otherwise auto-detect.
#[tauri::command]
pub fn open_in_terminal(path: String, terminal: Option<String>) -> Result<(), AppError> {
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
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
        if !term.is_empty() {
            if try_spawn_terminal(term, &dir) {
                return Ok(());
            }
            // Fall through to auto-detect if configured terminal fails
        }
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
            .map_err(|e| AppError::Io(e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&dir)
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "cmd.exe"])
            .current_dir(&dir)
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }

    Ok(())
}
