//! Enumerate drives and volumes across platforms.
//!
//! Linux: scans `/run/media/$USER` and `/media/$USER` for user mounts, `/media` as fallback.
//! macOS: scans `/Volumes/`, skipping the root-mapped system volume.
//! Windows: iterates drive letters that exist; volume label + provider + type
//! are read via PowerShell `Win32_LogicalDisk` (no winapi dependency, and unlike
//! `Get-Volume` it includes Google Drive File Stream), and Google Drive / WSL
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
    let info = windows_volume_info();
    let mut drives = Vec::new();

    for c in b'A'..=b'Z' {
        let letter = c as char;
        let path = format!("{}:\\", letter);
        if !std::path::Path::new(&path).exists() {
            continue;
        }

        let letter_label = format!("{}:", letter);
        let vol = info.get(&letter).cloned().unwrap_or_default();
        let volume_label = (!vol.label.is_empty()).then(|| vol.label.clone());

        // Google Drive (File Stream) mounts as a virtual/network drive. Detect it
        // by its volume label OR its provider name (it may have no label but a
        // Google provider). Surface it in the Cloud section with the Google icon.
        if is_google_drive_label(&vol.label) || is_google_drive_label(&vol.provider) {
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

        let kind = classify_windows_drive(vol.drive_type, &vol.bus_type, letter);

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

/// External USB hard drives report `DriveType == 3` (fixed) even though they are
/// ejectable removable media — only flash/SD media report `DriveType == 2`.
/// The backing disk's bus type is what distinguishes them.
#[cfg(target_os = "windows")]
fn is_usb_bus(bus_type: &str) -> bool {
    bus_type.eq_ignore_ascii_case("USB")
}

/// Map a Win32 `DriveType` (plus the backing disk's bus type) to a `DriveKind`.
///
/// USB hard drives enumerate as `DriveType == 3` (local disk), identical to the
/// internal system disk, so classifying by `DriveType` alone files an external
/// USB HDD (e.g. a TOURO) under Fixed. Promote USB-backed fixed disks to
/// Removable. Falls back to C:=fixed / everything-else=unknown when the type is
/// unavailable.
#[cfg(target_os = "windows")]
fn classify_windows_drive(drive_type: u32, bus_type: &str, letter: char) -> DriveKind {
    match drive_type {
        2 => DriveKind::Removable,
        3 if is_usb_bus(bus_type) => DriveKind::Removable,
        3 => DriveKind::Fixed,
        4 => DriveKind::Network,
        _ if letter == 'C' => DriveKind::Fixed,
        _ => DriveKind::Unknown,
    }
}

/// Per-drive volume metadata read from `Win32_LogicalDisk`.
#[cfg(target_os = "windows")]
#[derive(Default, Clone)]
struct WindowsVolInfo {
    /// Volume label (e.g. "Google Drive", "USB Backup"). May be empty.
    label: String,
    /// Network/redirector provider name. Google Drive File Stream surfaces here
    /// (e.g. a Google path) when it mounts as a network/virtual drive.
    provider: String,
    /// Win32 DriveType: 2=removable, 3=local disk, 4=network, 6=RAM.
    drive_type: u32,
    /// Physical bus the backing disk sits on ("USB", "SATA", "NVMe", …). Empty
    /// when unknown or for virtual/network volumes with no backing partition.
    /// Used to promote USB hard drives (which report `DriveType == 3`) to
    /// Removable.
    bus_type: String,
}

/// Read drive-letter → volume metadata via PowerShell `Win32_LogicalDisk`.
///
/// We use `Win32_LogicalDisk` (not `Get-Volume`) deliberately: Google Drive
/// File Stream and other virtual/network drives are **absent from
/// `Get-Volume`** but present here, complete with `VolumeName`/`ProviderName`.
/// That's what previously left Google Drive showing as a bare "G:". No winapi
/// dependency — PowerShell ships with every supported Windows; failures yield an
/// empty map and we fall back to drive letters.
#[cfg(target_os = "windows")]
fn windows_volume_info() -> std::collections::HashMap<char, WindowsVolInfo> {
    use crate::process_ext::NoConsole;
    use std::collections::HashMap;
    use std::process::Command;

    let mut map = HashMap::new();

    // Build a drive-letter → bus-type map from the Storage cmdlets (Get-Partition
    // / Get-Disk) so external USB hard drives — which report DriveType 3 (fixed)
    // — can be told apart from internal disks. Virtual/network volumes have no
    // backing partition and simply get an empty bus type. `|` separator avoids
    // the comma-in-label ambiguity of CSV.
    let script = "$bus = @{}; \
         Get-Partition | Where-Object DriveLetter | ForEach-Object { \
             try { $bus[\"$($_.DriveLetter):\"] = (Get-Disk -Number $_.DiskNumber).BusType } catch {} }; \
         Get-CimInstance Win32_LogicalDisk | ForEach-Object { \
             \"$($_.DeviceID)|$($_.VolumeName)|$($_.ProviderName)|$($_.DriveType)|$($bus[$_.DeviceID])\" }";

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .no_console()
        .output();

    let Ok(output) = output else {
        return map;
    };
    if !output.status.success() {
        return map;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        // Lines look like: "G:|Google Drive||3|USB" (bus type may be empty).
        let fields: Vec<&str> = line.trim().split('|').collect();
        if fields.len() < 4 {
            continue;
        }
        let Some(letter) = fields[0].chars().next() else {
            continue;
        };
        map.insert(
            letter.to_ascii_uppercase(),
            WindowsVolInfo {
                label: fields[1].trim().to_string(),
                provider: fields[2].trim().to_string(),
                drive_type: fields[3].trim().parse().unwrap_or(0),
                bus_type: fields.get(4).map(|s| s.trim().to_string()).unwrap_or_default(),
            },
        );
    }

    map
}

/// Enumerate installed WSL distros and expose each one's home directory via its
/// `\\wsl$\<distro>` UNC path as a `Cloud` drive. Uses `wsl -l -q`; on hosts
/// without WSL this returns empty.
#[cfg(target_os = "windows")]
fn windows_wsl_drives() -> Vec<Drive> {
    use crate::process_ext::NoConsole;
    use std::process::Command;

    let mut drives = Vec::new();

    let output = Command::new("wsl").args(["-l", "-q"]).no_console().output();
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn usb_hard_drive_reporting_fixed_is_removable() {
        // External USB HDD (e.g. TOURO): DriveType 3 but on the USB bus.
        assert!(matches!(
            classify_windows_drive(3, "USB", 'E'),
            DriveKind::Removable
        ));
    }

    #[test]
    fn internal_disk_stays_fixed() {
        assert!(matches!(
            classify_windows_drive(3, "SATA", 'D'),
            DriveKind::Fixed
        ));
        assert!(matches!(
            classify_windows_drive(3, "NVMe", 'C'),
            DriveKind::Fixed
        ));
    }

    #[test]
    fn flash_media_is_removable_regardless_of_bus() {
        assert!(matches!(
            classify_windows_drive(2, "", 'F'),
            DriveKind::Removable
        ));
    }

    #[test]
    fn network_and_unknown_are_unaffected_by_bus() {
        assert!(matches!(
            classify_windows_drive(4, "USB", 'Z'),
            DriveKind::Network
        ));
        // No bus info, non-C letter, unknown type → Unknown.
        assert!(matches!(
            classify_windows_drive(0, "", 'X'),
            DriveKind::Unknown
        ));
        // No bus info on C: still falls back to Fixed.
        assert!(matches!(
            classify_windows_drive(0, "", 'C'),
            DriveKind::Fixed
        ));
    }

    #[test]
    fn bus_type_match_is_case_insensitive() {
        assert!(is_usb_bus("usb"));
        assert!(is_usb_bus("USB"));
        assert!(!is_usb_bus("SATA"));
    }
}
