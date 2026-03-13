//! Set desktop wallpaper across different Linux desktop environments.
//! Issue: tauri-explorer-mj32

use crate::error::AppError;
use std::path::PathBuf;
use std::process::Command;

/// Image extensions supported for wallpaper setting.
const WALLPAPER_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif",
];

/// Check if a file is a supported wallpaper image.
fn is_wallpaper_image(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| WALLPAPER_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Detect the current desktop environment / wallpaper tool.
fn detect_wallpaper_backend() -> WallpaperBackend {
    // Check for Hyprland first (hyprpaper)
    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
        return WallpaperBackend::Hyprpaper;
    }

    // Check for Sway
    if std::env::var("SWAYSOCK").is_ok() {
        return WallpaperBackend::Swaybg;
    }

    // Check XDG_CURRENT_DESKTOP for common DEs
    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        let desktop = desktop.to_lowercase();
        if desktop.contains("gnome") || desktop.contains("unity") || desktop.contains("cinnamon") {
            return WallpaperBackend::Gnome;
        }
        if desktop.contains("kde") || desktop.contains("plasma") {
            return WallpaperBackend::Kde;
        }
        if desktop.contains("xfce") {
            return WallpaperBackend::Xfce;
        }
    }

    // Fallback: try feh (common for X11 WMs like i3, bspwm)
    if Command::new("which").arg("feh").output().map(|o| o.status.success()).unwrap_or(false) {
        return WallpaperBackend::Feh;
    }

    WallpaperBackend::Unknown
}

enum WallpaperBackend {
    Hyprpaper,
    Swaybg,
    Gnome,
    Kde,
    Xfce,
    Feh,
    Unknown,
}

/// Set wallpaper using hyprpaper IPC + update config file.
fn set_hyprpaper(path: &str) -> Result<(), AppError> {
    let abs_path = std::fs::canonicalize(path)
        .map_err(|e| AppError::Other(format!("Failed to resolve path: {}", e)))?
        .to_string_lossy()
        .to_string();

    // Step 1: Preload the new wallpaper
    let output = Command::new("hyprctl")
        .args(["hyprpaper", "preload", &abs_path])
        .output()
        .map_err(|e| AppError::Other(format!("Failed to run hyprctl: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "already loaded" is not an error
        if !stderr.contains("already loaded") && !output.stdout.windows(14).any(|w| w == b"already loaded") {
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(AppError::Other(format!("hyprpaper preload failed: {} {}", stdout, stderr)));
        }
    }

    // Step 2: Get monitor names and set wallpaper on each
    let monitors = get_hyprland_monitors()?;
    for monitor in &monitors {
        let wallpaper_arg = format!("{},{}", monitor, abs_path);
        let output = Command::new("hyprctl")
            .args(["hyprpaper", "wallpaper", &wallpaper_arg])
            .output()
            .map_err(|e| AppError::Other(format!("Failed to set wallpaper on {}: {}", monitor, e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            eprintln!("[wallpaper] Warning: failed to set on {}: {} {}", monitor, stdout, stderr);
        }
    }

    // Step 3: Unload unused wallpapers
    let _ = Command::new("hyprctl")
        .args(["hyprpaper", "unload", "unused"])
        .output();

    // Step 4: Update hyprpaper.conf for persistence
    update_hyprpaper_conf(&abs_path, &monitors)?;

    Ok(())
}

/// Get list of monitor names from Hyprland.
fn get_hyprland_monitors() -> Result<Vec<String>, AppError> {
    let output = Command::new("hyprctl")
        .args(["monitors", "-j"])
        .output()
        .map_err(|e| AppError::Other(format!("Failed to query monitors: {}", e)))?;

    let json_str = String::from_utf8_lossy(&output.stdout);
    // Parse JSON array of monitors, extracting "name" field
    let monitors: Vec<serde_json::Value> = serde_json::from_str(&json_str)
        .map_err(|e| AppError::Other(format!("Failed to parse monitor info: {}", e)))?;

    let names: Vec<String> = monitors
        .iter()
        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();

    if names.is_empty() {
        return Err(AppError::Other("No monitors found".to_string()));
    }

    Ok(names)
}

/// Update ~/.config/hypr/hyprpaper.conf with the new wallpaper.
fn update_hyprpaper_conf(image_path: &str, monitors: &[String]) -> Result<(), AppError> {
    let config_path = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("hypr")
        .join("hyprpaper.conf");

    let mut content = String::new();
    content.push_str(&format!("preload = {}\n\n", image_path));

    for monitor in monitors {
        content.push_str(&format!(
            "wallpaper {{\nmonitor = {}\npath = {}\nfit_mode = cover\n}}\n\n",
            monitor, image_path
        ));
    }

    content.push_str("splash = false\n");

    std::fs::write(&config_path, content)
        .map_err(|e| AppError::Other(format!("Failed to update hyprpaper.conf: {}", e)))?;

    Ok(())
}

/// Set wallpaper using swaybg (kill existing, spawn new).
fn set_swaybg(path: &str) -> Result<(), AppError> {
    let _ = Command::new("pkill").arg("swaybg").output();
    Command::new("swaybg")
        .args(["-o", "*", "-i", path, "-m", "fill"])
        .spawn()
        .map_err(|e| AppError::Other(format!("Failed to start swaybg: {}", e)))?;
    Ok(())
}

/// Set wallpaper using gsettings (GNOME).
fn set_gnome(path: &str) -> Result<(), AppError> {
    let uri = format!("file://{}", path);
    for key in &["picture-uri", "picture-uri-dark"] {
        Command::new("gsettings")
            .args(["set", "org.gnome.desktop.background", key, &uri])
            .output()
            .map_err(|e| AppError::Other(format!("gsettings failed: {}", e)))?;
    }
    Ok(())
}

/// Set wallpaper using plasma-apply-wallpaperimage (KDE).
fn set_kde(path: &str) -> Result<(), AppError> {
    let output = Command::new("plasma-apply-wallpaperimage")
        .arg(path)
        .output()
        .map_err(|e| AppError::Other(format!("plasma-apply-wallpaperimage failed: {}", e)))?;

    if !output.status.success() {
        return Err(AppError::Other(format!(
            "KDE wallpaper failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
}

/// Set wallpaper using xfconf-query (XFCE).
fn set_xfce(path: &str) -> Result<(), AppError> {
    // Discover monitor property paths
    let output = Command::new("xfconf-query")
        .args(["-c", "xfce4-desktop", "-l"])
        .output()
        .map_err(|e| AppError::Other(format!("xfconf-query failed: {}", e)))?;

    let props = String::from_utf8_lossy(&output.stdout);
    for line in props.lines() {
        if line.contains("last-image") {
            let _ = Command::new("xfconf-query")
                .args(["-c", "xfce4-desktop", "-p", line.trim(), "-s", path])
                .output();
        }
    }
    Ok(())
}

/// Set wallpaper using feh (generic X11 WMs).
fn set_feh(path: &str) -> Result<(), AppError> {
    Command::new("feh")
        .args(["--bg-fill", path])
        .output()
        .map_err(|e| AppError::Other(format!("feh failed: {}", e)))?;
    Ok(())
}

/// Set the given image as desktop wallpaper.
/// Auto-detects the desktop environment and uses the appropriate tool.
#[tauri::command]
pub fn set_as_wallpaper(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);

    if !file_path.exists() {
        return Err(AppError::NotFound(path));
    }

    if !is_wallpaper_image(&file_path) {
        return Err(AppError::Other("File is not a supported image format".to_string()));
    }

    let abs_path = std::fs::canonicalize(&file_path)
        .map_err(|e| AppError::Other(format!("Failed to resolve path: {}", e)))?
        .to_string_lossy()
        .to_string();

    match detect_wallpaper_backend() {
        WallpaperBackend::Hyprpaper => set_hyprpaper(&abs_path),
        WallpaperBackend::Swaybg => set_swaybg(&abs_path),
        WallpaperBackend::Gnome => set_gnome(&abs_path),
        WallpaperBackend::Kde => set_kde(&abs_path),
        WallpaperBackend::Xfce => set_xfce(&abs_path),
        WallpaperBackend::Feh => set_feh(&abs_path),
        WallpaperBackend::Unknown => Err(AppError::Other(
            "Could not detect desktop environment. Supported: Hyprland (hyprpaper), Sway, GNOME, KDE, XFCE, feh".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_wallpaper_image() {
        let test_cases = vec![
            ("photo.jpg", true),
            ("photo.JPG", true),
            ("image.png", true),
            ("pic.webp", true),
            ("doc.pdf", false),
            ("script.sh", false),
            ("video.mp4", false),
        ];

        for (name, expected) in test_cases {
            let path = std::path::Path::new(name);
            assert_eq!(is_wallpaper_image(path), expected, "Failed for: {}", name);
        }
    }
}
