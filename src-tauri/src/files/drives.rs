//! Enumerate drives and volumes across platforms.
//!
//! Linux: scans `/run/media/$USER` and `/media/$USER` for user mounts, `/media` as fallback.
//! macOS: scans `/Volumes/`, skipping the root-mapped system volume.
//! Windows: iterates drive letters that exist; the volume label is read via
//! PowerShell `Get-Volume` (no winapi dependency), and Google Drive / WSL
//! mounts are surfaced as their own `Cloud` kind so the sidebar can group them.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    /// Cloud / remote mounts (Google Drive, WSL home, …) — grouped separately
    /// in the sidebar with a provider-specific icon.
    Cloud,
    Unknown,
}

/// Which cloud/remote provider a `Cloud` drive belongs to, so the frontend can
/// pick the right icon (Google "G", Tux penguin, …). `None` for ordinary drives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CloudProvider {
    GoogleDrive,
    Wsl,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Drive {
    /// Display name. For removable drives this is the volume label when one is
    /// available, falling back to the drive letter / mount name.
    pub name: String,
    pub path: String,
    pub kind: DriveKind,
    /// Secondary/dimmed label — e.g. the drive letter ("E:") when `name` is the
    /// volume label. `None` when there's nothing useful to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Set for `Cloud` drives only; tells the frontend which icon to render.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<CloudProvider>,
}

impl Drive {
    fn simple(name: String, path: String, kind: DriveKind) -> Self {
        Drive {
            name,
            path,
            kind,
            detail: None,
            provider: None,
        }
    }
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
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
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
            drives.push(Drive::simple(name, path, DriveKind::Removable));
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
        let kind = if is_boot {
            DriveKind::Fixed
        } else {
            DriveKind::Removable
        };
        drives.push(Drive::simple(
            name,
            path.to_string_lossy().to_string(),
            kind,
        ));
    }
    drives
}

#[cfg(target_os = "windows")]
fn enumerate_drives() -> Vec<Drive> {
    let labels = windows_volume_labels();
    let mut drives = Vec::new();

    for c in b'A'..=b'Z' {
        let letter = c as char;
        let path = format!("{}:\\", letter);
        if !std::path::Path::new(&path).exists() {
            continue;
        }

        let letter_label = format!("{}:", letter);
        let volume_label = labels.get(&letter).filter(|l| !l.is_empty()).cloned();

        // Google Drive (File Stream) mounts as a removable/fixed volume whose
        // label contains "Google Drive". Surface it in the Cloud section.
        if volume_label
            .as_deref()
            .map(is_google_drive_label)
            .unwrap_or(false)
        {
            drives.push(Drive {
                name: volume_label
                    .clone()
                    .unwrap_or_else(|| "Google Drive".into()),
                path,
                kind: DriveKind::Cloud,
                detail: Some(letter_label),
                provider: Some(CloudProvider::GoogleDrive),
            });
            continue;
        }

        let kind = if letter == 'C' {
            DriveKind::Fixed
        } else {
            DriveKind::Unknown
        };

        // Prefer the volume label, keep the letter as the dimmed detail.
        let (name, detail) = match volume_label {
            Some(label) => (label, Some(letter_label)),
            None => (letter_label, None),
        };

        drives.push(Drive {
            name,
            path,
            kind,
            detail,
            provider: None,
        });
    }

    drives.extend(windows_wsl_drives());
    drives
}

/// Detect a Google Drive volume by its label.
#[cfg(target_os = "windows")]
fn is_google_drive_label(label: &str) -> bool {
    label.to_lowercase().contains("google drive")
}

/// Read drive-letter → volume-label via PowerShell `Get-Volume`. We avoid a
/// winapi dependency; PowerShell ships with every supported Windows. Failures
/// (no PowerShell, locked-down host) just yield an empty map and we fall back
/// to drive letters.
#[cfg(target_os = "windows")]
fn windows_volume_labels() -> std::collections::HashMap<char, String> {
    use std::collections::HashMap;
    use std::process::Command;

    let mut map = HashMap::new();

    // CSV is easy to parse and stable across PowerShell versions.
    let script = "Get-Volume | Where-Object { $_.DriveLetter } | \
         Select-Object DriveLetter,FileSystemLabel | ConvertTo-Csv -NoTypeInformation";

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output();

    let Ok(output) = output else {
        return map;
    };
    if !output.status.success() {
        return map;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines().skip(1) {
        // Lines look like: "E","Google Drive"  (fields are quoted)
        let fields: Vec<String> = line
            .split(',')
            .map(|f| f.trim().trim_matches('"').to_string())
            .collect();
        if fields.len() < 2 {
            continue;
        }
        if let Some(letter) = fields[0].chars().next() {
            map.insert(letter.to_ascii_uppercase(), fields[1].clone());
        }
    }

    map
}

/// Enumerate installed WSL distros and expose each one's home directory via its
/// `\\wsl$\<distro>` UNC path as a `Cloud` drive. Uses `wsl -l -q`; on hosts
/// without WSL this returns empty.
#[cfg(target_os = "windows")]
fn windows_wsl_drives() -> Vec<Drive> {
    use std::process::Command;

    let mut drives = Vec::new();

    let output = Command::new("wsl").args(["-l", "-q"]).output();
    let Ok(output) = output else {
        return drives;
    };
    if !output.status.success() {
        return drives;
    }

    // `wsl -l -q` emits UTF-16LE. Decode lossily into UTF-8.
    let bytes = output.stdout;
    let text: String = if bytes.len() >= 2 && bytes.len() % 2 == 0 {
        let utf16: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    for raw in text.lines() {
        // Strip BOM / NUL / whitespace that the UTF-16 decode can leave behind.
        let distro = raw
            .trim()
            .trim_matches(|c: char| c == '\u{feff}' || c == '\0');
        if distro.is_empty() {
            continue;
        }
        let path = format!("\\\\wsl$\\{}\\home", distro);
        drives.push(Drive {
            name: distro.to_string(),
            path,
            kind: DriveKind::Cloud,
            detail: Some("WSL".into()),
            provider: Some(CloudProvider::Wsl),
        });
    }

    drives
}
