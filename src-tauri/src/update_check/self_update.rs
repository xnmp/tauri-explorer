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
use std::path::{Path, PathBuf};
use std::time::Duration;
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
            .updater_builder()
            // A stalled connection must not hold the job (and every other
            // window's check) for the rest of the session. A read timeout,
            // not a total one: an AppImage is over 100 MB.
            .configure_client(|client| {
                client
                    .connect_timeout(Duration::from_secs(30))
                    .read_timeout(Duration::from_secs(60))
            })
            // Windows installs exit the process directly (`exit(0)` after
            // starting the installer), skipping `RunEvent::Exit`; run the
            // same shutdown it would have run.
            .on_before_exit(crate::release_process_resources)
            .build()
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
        // Installing can block on an elevation prompt (UAC, AppleScript
        // admin), so keep it off the async runtime.
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
        #[cfg(target_os = "linux")]
        super::restart_fds::mark_all_cloexec();
        app.request_restart();
        Ok(())
    }
}

/// Inspect this running copy.
pub fn gather_install_facts() -> InstallFacts {
    let os = Os::current();
    let bundle = tauri::utils::platform::bundle_type()
        .as_ref()
        .map(Bundle::from);
    let exe = tauri::utils::platform::current_exe().ok();
    let env_path = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let replaceable_appimage = os == Os::Linux
        && exe.as_deref().is_some_and(|exe| {
            eligibility::is_replaceable_appimage(
                exe,
                env_path("APPDIR").as_deref(),
                env_path("APPIMAGE").as_deref(),
                dir_writable,
            )
        });
    InstallFacts {
        os,
        bundle,
        replaceable_appimage,
        macos_app: os == Os::Mac
            && exe
                .as_deref()
                .is_some_and(eligibility::is_installed_macos_app),
    }
}

/// Whether this process may create files in `dir` (`access(2)` with `W_OK`).
#[cfg(unix)]
fn dir_writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string for the call's duration.
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
fn dir_writable(_dir: &Path) -> bool {
    false
}

pub fn eligibility() -> Eligibility {
    eligibility::classify(&gather_install_facts())
}
