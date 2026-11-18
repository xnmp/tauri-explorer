//! Update check (#185) and signed self-update (#1679).
//!
//! `prepare_update` runs on demand from the frontend (which throttles it to
//! once per day). When the user allows automatic updates and this install can
//! replace itself (`eligibility`), the signed updater manifest is checked and
//! the update downloaded in the background (`self_update`); the frontend then
//! offers a restart. Otherwise, or if that path fails, a single GET of the
//! update channel's manifest powers the notify-only notice.
//!
//! Both read the `update-channel` release's `latest-alpha.json`, never
//! `releases/latest`: GitHub's "Latest" stays on the highest plain version
//! (v1.28.2) so 1.x installs, which compare plain versions, still find the
//! bridge release after the reset to the 0.28 alpha line (#1783).

mod eligibility;
mod release_order;
#[cfg(target_os = "linux")]
mod restart_fds;
mod self_update;

pub use self_update::SelfUpdateJob;

use crate::error::AppError;
use eligibility::Eligibility;
use release_order::is_newer;
use self_update::Prepared;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// The newest release's signed updater manifest; also
/// `plugins.updater.endpoints` in tauri.conf.json.
const CHANNEL_MANIFEST_URL: &str =
    "https://github.com/xnmp/tauri-explorer/releases/download/update-channel/latest-alpha.json";
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
struct ChannelManifest {
    version: String,
}

/// The notice for the channel's `version`, if it was released after
/// `current`. The version becomes part of a URL opened in the browser, so
/// anything but a plain SemVer string is rejected.
fn channel_notice(version: &str, current: &str) -> Result<Option<UpdateOffer>, AppError> {
    let version = version.trim_start_matches('v');
    let plain = !version.is_empty()
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !plain {
        return Err(AppError::Other(format!(
            "Update channel reported an invalid version: {version:?}"
        )));
    }
    Ok(is_newer(version, current).then(|| UpdateOffer {
        version: version.to_string(),
        url: format!("{RELEASE_TAG_URL}{version}"),
        ready: false,
    }))
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

/// The notify-only path: the update channel's release, if newer.
async fn latest_release_notice() -> Result<Option<UpdateOffer>, AppError> {
    tokio::task::spawn_blocking(|| {
        let manifest =
            fetch_manifest(&crate::http_timeouts::bounded_agent(), CHANNEL_MANIFEST_URL)?;
        channel_notice(&manifest.version, env!("CARGO_PKG_VERSION"))
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn fetch_manifest(agent: &ureq::Agent, url: &str) -> Result<ChannelManifest, AppError> {
    agent
        .get(url)
        .header("User-Agent", "tauri-explorer-update-check")
        .call()
        .map_err(|e| AppError::Other(format!("Update check failed: {}", e)))?
        .body_mut()
        .read_json()
        .map_err(|e| AppError::Other(format!("Update check parse failed: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stalled_manifest_server_fails_within_the_timeout() {
        let server = crate::http_timeouts::test_support::stalled_server();
        let agent = crate::http_timeouts::bounded_agent_with(
            std::time::Duration::from_millis(500),
            std::time::Duration::from_millis(800),
        );
        let started = std::time::Instant::now();
        let result = fetch_manifest(&agent, &format!("http://{}/m.json", server.addr));
        assert!(result.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn channel_notice_offers_only_a_later_release() {
        let offer = channel_notice("0.28.0", "1.28.2").unwrap().unwrap();
        assert_eq!(offer.version, "0.28.0");
        assert_eq!(
            offer.url,
            "https://github.com/xnmp/tauri-explorer/releases/tag/v0.28.0"
        );
        assert!(!offer.ready);
        assert!(channel_notice("1.28.2", "1.28.2").unwrap().is_none());
        assert!(channel_notice("1.28.2", "0.28.0").unwrap().is_none());
        assert!(channel_notice("v0.28.1", "0.28.0").unwrap().is_some());
    }

    #[test]
    fn channel_notice_rejects_versions_unsafe_in_a_url() {
        for bad in [
            "",
            "v",
            "../../evil",
            "1.0.0/../x",
            "1.0.0?x=1",
            "1.0 0",
            "latest",
        ] {
            assert!(channel_notice(bad, "0.0.1").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn channel_url_is_the_updater_endpoint() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["endpoints"],
            serde_json::json!([CHANNEL_MANIFEST_URL])
        );
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
