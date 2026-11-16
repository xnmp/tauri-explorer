//! Signed self-update (#1679): one process-wide job shared by every window.
//!
//! `prepare` checks the signed `latest.json` (tauri.conf.json
//! `plugins.updater`), downloads and verifies the payload, and keeps it in
//! memory until the user chooses to restart. The job lock is held across the
//! download, so a second window asking at the same time waits and then sees
//! the same ready update instead of downloading it again.
//!
//! `install` cannot be deferred to a later launch: on Windows the plugin
//! starts the installer and exits the process, so installing *is* the
//! restart. On Linux and macOS the files are replaced in place and the app
//! relaunches through the normal exit path (`request_restart`).

use super::eligibility::{self, Bundle, Eligibility, InstallFacts, Os};
use crate::error::AppError;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

/// Managed state: the verified update waiting for a restart, if any.
#[derive(Default)]
pub struct SelfUpdateJob(Mutex<Option<Ready>>);

/// What `prepare` produced.
pub enum Prepared {
    /// Downloaded and verified; `install` will apply it.
    Ready { version: String },
    /// The signed manifest reports nothing newer for this install.
    UpToDate,
}

impl SelfUpdateJob {
    pub async fn prepare(&self, app: &AppHandle) -> Result<Prepared, AppError> {
        let mut slot = self.0.lock().await;
        if let Some(ready) = slot.as_ref() {
            return Ok(Prepared::Ready {
                version: ready.update.version.clone(),
            });
        }
        let updater = app
            .updater()
            .map_err(|e| AppError::Other(format!("Updater unavailable: {e}")))?;
        let Some(update) = updater
            .check()
            .await
            .map_err(|e| AppError::Other(format!("Update check failed: {e}")))?
        else {
            return Ok(Prepared::UpToDate);
        };
        // `download` verifies the minisign signature against the embedded
        // public key before returning the bytes.
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|e| AppError::Other(format!("Update download failed: {e}")))?;
        let version = update.version.clone();
        *slot = Some(Ready { update, bytes });
        Ok(Prepared::Ready { version })
    }

    /// Apply the prepared update and relaunch. Errors leave the prepared
    /// update in place, so a declined elevation prompt can be retried.
    pub async fn install(&self, app: &AppHandle) -> Result<(), AppError> {
        let mut slot = self.0.lock().await;
        let Some(ready) = slot.take() else {
            return Err(AppError::Other("No update is ready to install".into()));
        };
        // Installing can block on an elevation prompt (pkexec, UAC,
        // AppleScript admin), so keep it off the async runtime.
        let (result, ready) = tokio::task::spawn_blocking(move || {
            let result = ready.update.install(&ready.bytes);
            (result, ready)
        })
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {e}")))?;
        if let Err(e) = result {
            *slot = Some(ready);
            return Err(AppError::Other(format!("Update install failed: {e}")));
        }
        drop(slot);
        // The relaunched process inherits this working directory, and AppRun
        // starts the app inside the old image's FUSE mount: the new process
        // would keep that mount (and the old image's runtime) alive for its
        // whole lifetime. Leave the image before relaunching.
        if std::env::var_os("APPIMAGE").is_some() {
            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
            if let Err(e) = std::env::set_current_dir(&home) {
                log::warn!("Update(restart-cwd): {e}");
            }
        }
        app.request_restart();
        Ok(())
    }
}

/// Inspect this running copy. Only spawns a package-database query when the
/// binary claims to come from a deb/rpm, since that is the only case it
/// can change the answer.
pub fn gather_install_facts() -> InstallFacts {
    let os = Os::current();
    let bundle = tauri::utils::platform::bundle_type()
        .as_ref()
        .map(Bundle::from);
    let exe = tauri::utils::platform::current_exe().ok();
    let owned_by_bundle_package_db = match (os, bundle, exe.as_deref()) {
        (Os::Linux, Some(Bundle::Deb), Some(exe)) => package_db_owns("dpkg-query", "-S", exe),
        (Os::Linux, Some(Bundle::Rpm), Some(exe)) => package_db_owns("rpm", "-qf", exe),
        _ => false,
    };
    InstallFacts {
        os,
        bundle,
        running_as_appimage: std::env::var_os("APPIMAGE").is_some_and(|v| !v.is_empty()),
        owned_by_bundle_package_db,
        macos_app: os == Os::Mac
            && exe
                .as_deref()
                .is_some_and(eligibility::is_installed_macos_app),
    }
}

/// True when `tool flag <exe>` succeeds, i.e. the package database records
/// the running executable. A missing tool or any failure means "not owned".
fn package_db_owns(tool: &str, flag: &str, exe: &std::path::Path) -> bool {
    std::process::Command::new(tool)
        .arg(flag)
        .arg(exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

pub fn eligibility() -> Eligibility {
    eligibility::classify(&gather_install_facts())
}
