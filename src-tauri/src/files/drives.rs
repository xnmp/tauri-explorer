//! Enumerate drives and volumes across platforms.
//!
//! Linux: scans `/run/media/$USER` and `/media/$USER` for user mounts, `/media` as fallback.
//! macOS: scans `/Volumes/`, skipping the root-mapped system volume.
//! Windows: iterates drive letters that exist; removable detection without winapi is
//! best-effort (we treat non-C: letters as potentially removable — improvable later).

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Drive {
    pub name: String,
    pub path: String,
    pub kind: DriveKind,
}

#[tauri::command]
pub async fn list_drives() -> Result<Vec<Drive>, AppError> {
    Ok(enumerate_drives())
}

#[cfg(target_os = "linux")]
fn enumerate_drives() -> Vec<Drive> {
    let user = std::env::var("USER").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut drives = Vec::new();

    let bases = [
        format!("/run/media/{}", user),
        format!("/media/{}", user),
        "/media".to_string(),
    ];

    for base in bases.iter() {
        let Ok(entries) = std::fs::read_dir(base) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // In /media, skip the user's own home-like subdir (which is /media/$USER itself).
            if !user.is_empty() && name == user {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if !seen.insert(path.clone()) {
                continue;
            }
            drives.push(Drive {
                name,
                path,
                kind: DriveKind::Removable,
            });
        }
    }

    drives
}

#[cfg(target_os = "macos")]
fn enumerate_drives() -> Vec<Drive> {
    let mut drives = Vec::new();
    let Ok(entries) = std::fs::read_dir("/Volumes") else {
        return drives;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        // On macOS the boot volume appears in /Volumes as a symlink to "/".
        let is_boot = std::fs::read_link(&path)
            .ok()
            .and_then(|p| p.to_str().map(|s| s == "/"))
            .unwrap_or(false);
        drives.push(Drive {
            name,
            path: path.to_string_lossy().to_string(),
            kind: if is_boot { DriveKind::Fixed } else { DriveKind::Removable },
        });
    }
    drives
}

#[cfg(target_os = "windows")]
fn enumerate_drives() -> Vec<Drive> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let letter = c as char;
        let path = format!("{}:\\", letter);
        if std::path::Path::new(&path).exists() {
            // Without winapi GetDriveType we can't distinguish removable reliably.
            // Heuristic: C: is conventionally the system/fixed drive; others may be removable.
            let kind = if letter == 'C' { DriveKind::Fixed } else { DriveKind::Unknown };
            drives.push(Drive {
                name: format!("{}:", letter),
                path,
                kind,
            });
        }
    }
    drives
}
