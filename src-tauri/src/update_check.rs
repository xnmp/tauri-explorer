//! Update check (#185).
//!
//! One small GET to the GitHub releases API, on demand from the frontend
//! (which throttles to once per day). This is a notification only — no
//! download, no auto-update — so users on v1.0 learn about fixes.

use crate::error::AppError;
use serde::{Deserialize, Serialize};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/xnmp/tauri-explorer/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    /// Latest version, without the leading `v`.
    pub version: String,
    /// Release page to open in the browser.
    pub url: String,
}

#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
    html_url: String,
}

/// Compare dotted-numeric versions (e.g. "1.0.0" vs "0.9.0").
/// Non-numeric segments compare as 0; missing segments compare as 0.
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .map(|s| {
                s.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let (a, b) = (
            l.get(i).copied().unwrap_or(0),
            c.get(i).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    false
}

/// Return the latest release if it is newer than the running version.
#[tauri::command]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, AppError> {
    tokio::task::spawn_blocking(|| {
        let release: LatestRelease = ureq::get(LATEST_RELEASE_URL)
            .header("User-Agent", "tauri-explorer-update-check")
            .header("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| AppError::Other(format!("Update check failed: {}", e)))?
            .body_mut()
            .read_json()
            .map_err(|e| AppError::Other(format!("Update check parse failed: {}", e)))?;

        let latest = release.tag_name.trim_start_matches('v').to_string();
        if is_newer(&latest, env!("CARGO_PKG_VERSION")) {
            Ok(Some(UpdateInfo {
                version: latest,
                url: release.html_url,
            }))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_detected() {
        assert!(is_newer("1.0.0", "0.9.0"));
        assert!(is_newer("0.9.1", "0.9.0"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("v1.0.0", "0.9.0"));
    }

    #[test]
    fn equal_or_older_not_newer() {
        assert!(!is_newer("0.9.0", "0.9.0"));
        assert!(!is_newer("0.8.9", "0.9.0"));
        assert!(!is_newer("0.9", "0.9.0"));
    }

    #[test]
    fn malformed_segments_compare_as_zero() {
        assert!(!is_newer("abc", "0.0.1"));
        assert!(is_newer("1.0.0-rc1", "0.9.9"));
    }
}
