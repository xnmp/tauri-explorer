//! Update check (#185) and signed self-update (#1679).
//!
//! `prepare_update` runs on demand from the frontend (which throttles it to
//! once per day). When the user allows automatic updates and this install can
//! replace itself (`eligibility`), the signed updater manifest is checked and
//! the update downloaded in the background (`self_update`); the frontend then
//! offers a restart. Otherwise, or if that path fails, a single GET to the
//! GitHub releases API powers the notify-only notice.

mod eligibility;
#[cfg(target_os = "linux")]
mod restart_fds;
mod self_update;

pub use self_update::SelfUpdateJob;

use crate::error::AppError;
use eligibility::Eligibility;
use self_update::Prepared;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/xnmp/tauri-explorer/releases/latest";
const RELEASE_TAG_URL: &str = "https://github.com/xnmp/tauri-explorer/releases/tag/v";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    /// Latest version, without the leading `v`.
    pub version: String,
    /// Release page to open in the browser.
    pub url: String,
    /// Downloaded and verified: `install_update` applies it on restart.
    /// False means notify-only (view the release page).
    pub ready: bool,
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

/// True only for URLs on github.com itself (the release page we may open in
/// the user's browser). Also used by crash_report's "Report on GitHub" flow.
pub(crate) fn is_github_url(url: &str) -> bool {
    url.starts_with("https://github.com/")
}

/// Find a newer release. With `auto_install` and a self-updatable install,
/// download and verify it so the frontend can offer a restart; otherwise (or
/// if the signed path fails) report it as a notice.
#[tauri::command]
pub async fn prepare_update(
    app: AppHandle,
    job: State<'_, SelfUpdateJob>,
    auto_install: bool,
) -> Result<Option<UpdateOffer>, AppError> {
    if auto_install {
        let eligibility = tokio::task::spawn_blocking(self_update::eligibility)
            .await
            .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?;
        match eligibility {
            Eligibility::SelfUpdate => match job.prepare(&app).await {
                Ok(Prepared::Ready { version }) => {
                    return Ok(Some(UpdateOffer {
                        url: format!("{RELEASE_TAG_URL}{version}"),
                        version,
                        ready: true,
                    }));
                }
                Ok(Prepared::UpToDate) => return Ok(None),
                // A release without updater artifacts, a network failure, or
                // a bad signature: still tell the user a release exists.
                Err(e) => log::warn!("Update(self-update-unavailable): {e}"),
            },
            Eligibility::NotifyOnly(reason) => {
                log::info!("Update(notify-only): {reason:?}");
            }
        }
    }
    latest_release_notice().await
}

/// Apply the update `prepare_update` downloaded, then relaunch. On Windows
/// the installer takes over and this never returns.
#[tauri::command]
pub async fn install_update(app: AppHandle, job: State<'_, SelfUpdateJob>) -> Result<(), AppError> {
    job.install(&app).await
}

/// The notify-only path: the latest GitHub release, if newer.
async fn latest_release_notice() -> Result<Option<UpdateOffer>, AppError> {
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
        // The URL is opened in the user's browser; never trust the API
        // response to point anywhere but GitHub itself.
        if !is_github_url(&release.html_url) {
            return Err(AppError::Other(format!(
                "Update check returned a non-GitHub release URL: {}",
                release.html_url
            )));
        }
        if is_newer(&latest, env!("CARGO_PKG_VERSION")) {
            Ok(Some(UpdateOffer {
                version: latest,
                url: release.html_url,
                ready: false,
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

    #[test]
    fn release_url_pinned_to_github() {
        assert!(is_github_url(
            "https://github.com/xnmp/tauri-explorer/releases/tag/v1.0.1"
        ));
        assert!(!is_github_url("https://evil.example/phish"));
        assert!(!is_github_url("http://github.com/xnmp/tauri-explorer"));
        assert!(!is_github_url("https://github.com.evil.example/x"));
    }
}
