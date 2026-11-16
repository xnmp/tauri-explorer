//! Which installs may replace themselves (#1679).
//!
//! Pure policy over facts the caller gathers (`gather_install_facts`). The
//! bundle type the Tauri bundler patches into the binary is not enough on its
//! own: the AUR `-bin` package repacks the official `.deb`, so an Arch binary
//! still reports `Deb`, and a `--no-bundle` distro build reports nothing.
//! Self-update is therefore granted only when the install mechanism that the
//! updater would drive is demonstrably the one that owns this copy.

use std::path::Path;
use tauri::utils::config::BundleType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    Mac,
    Windows,
    Other,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "linux") {
            Os::Linux
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Other
        }
    }
}

/// The bundle kinds the policy distinguishes (a `Copy` view of Tauri's
/// `BundleType`, which the bundler patches into each packaged binary).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bundle {
    AppImage,
    Deb,
    Rpm,
    App,
    Msi,
    Nsis,
    Other,
}

impl From<&BundleType> for Bundle {
    fn from(bundle: &BundleType) -> Self {
        match bundle {
            BundleType::AppImage => Bundle::AppImage,
            BundleType::Deb => Bundle::Deb,
            BundleType::Rpm => Bundle::Rpm,
            BundleType::App => Bundle::App,
            BundleType::Msi => Bundle::Msi,
            BundleType::Nsis => Bundle::Nsis,
            _ => Bundle::Other,
        }
    }
}

/// Everything the policy needs to know about this running copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstallFacts {
    pub os: Os,
    /// Bundle type patched into the binary by the Tauri bundler; `None` for
    /// unbundled builds (macOS reports `App` even then, see `macos_app`).
    pub bundle: Option<Bundle>,
    /// Linux: `$APPIMAGE` is set, i.e. the AppImage runtime launched us.
    pub running_as_appimage: bool,
    /// Linux deb/rpm: `dpkg`/`rpm` own the running executable. Only queried
    /// for those bundle types; false otherwise.
    pub owned_by_bundle_package_db: bool,
    /// macOS: the executable sits in a writable `.app` bundle (not a mounted
    /// disk image or a translocated copy).
    pub macos_app: bool,
}

/// Why an install keeps the notify-only path instead of replacing itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyReason {
    /// Not produced by the Tauri bundler (dev build, `--no-bundle` package).
    Unbundled,
    /// A deb/rpm-built binary that the matching package database does not own
    /// (e.g. the AUR `-bin` repack, or files copied out of the package).
    ForeignPackageManager,
    /// macOS app run from a disk image, translocated, or outside a bundle.
    MacAppNotInstalled,
    /// A bundle type with no self-update path on this OS.
    UnsupportedBundle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eligibility {
    SelfUpdate,
    NotifyOnly(NotifyReason),
}

pub fn classify(facts: &InstallFacts) -> Eligibility {
    use Eligibility::*;
    use NotifyReason::*;
    match (facts.os, facts.bundle) {
        (_, None) => NotifyOnly(Unbundled),
        (Os::Windows, Some(Bundle::Nsis | Bundle::Msi)) => SelfUpdate,
        (Os::Mac, Some(Bundle::App)) if facts.macos_app => SelfUpdate,
        (Os::Mac, Some(Bundle::App)) => NotifyOnly(MacAppNotInstalled),
        (Os::Linux, Some(Bundle::AppImage)) if facts.running_as_appimage => SelfUpdate,
        (Os::Linux, Some(Bundle::AppImage)) => NotifyOnly(Unbundled),
        (Os::Linux, Some(Bundle::Deb | Bundle::Rpm)) if facts.owned_by_bundle_package_db => {
            SelfUpdate
        }
        (Os::Linux, Some(Bundle::Deb | Bundle::Rpm)) => NotifyOnly(ForeignPackageManager),
        _ => NotifyOnly(UnsupportedBundle),
    }
}

/// True when a macOS executable path lies inside an installed `.app` bundle.
/// Disk-image mounts (`/Volumes/…`) are read-only and App Translocation runs
/// a randomised read-only copy; replacing either fails or is lost.
pub fn is_installed_macos_app(exe: &Path) -> bool {
    let parts: Vec<&std::ffi::OsStr> = exe.components().map(|c| c.as_os_str()).collect();
    let in_bundle = parts.windows(3).any(|w| {
        Path::new(w[0]).extension().is_some_and(|ext| ext == "app")
            && w[1] == "Contents"
            && w[2] == "MacOS"
    });
    let on_disk_image = exe.starts_with("/Volumes");
    let translocated = parts.iter().any(|part| *part == "AppTranslocation");
    in_bundle && !on_disk_image && !translocated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(os: Os, bundle: Option<Bundle>) -> InstallFacts {
        InstallFacts {
            os,
            bundle,
            running_as_appimage: false,
            owned_by_bundle_package_db: false,
            macos_app: false,
        }
    }

    #[test]
    fn unbundled_builds_never_self_update() {
        for os in [Os::Linux, Os::Windows, Os::Mac, Os::Other] {
            assert_eq!(
                classify(&facts(os, None)),
                Eligibility::NotifyOnly(NotifyReason::Unbundled)
            );
        }
    }

    #[test]
    fn windows_installers_self_update() {
        for bundle in [Bundle::Nsis, Bundle::Msi] {
            assert_eq!(
                classify(&facts(Os::Windows, Some(bundle))),
                Eligibility::SelfUpdate
            );
        }
    }

    #[test]
    fn appimage_requires_the_appimage_runtime() {
        let mut f = facts(Os::Linux, Some(Bundle::AppImage));
        assert_ne!(classify(&f), Eligibility::SelfUpdate);
        f.running_as_appimage = true;
        assert_eq!(classify(&f), Eligibility::SelfUpdate);
    }

    #[test]
    fn deb_and_rpm_require_package_db_ownership() {
        // The AUR -bin package repacks the .deb: the binary says Deb but
        // pacman owns it, so dpkg must not be asked to install over it.
        for bundle in [Bundle::Deb, Bundle::Rpm] {
            let mut f = facts(Os::Linux, Some(bundle));
            assert_eq!(
                classify(&f),
                Eligibility::NotifyOnly(NotifyReason::ForeignPackageManager)
            );
            f.owned_by_bundle_package_db = true;
            assert_eq!(classify(&f), Eligibility::SelfUpdate);
        }
    }

    #[test]
    fn appimage_env_does_not_promote_a_deb_binary() {
        let mut f = facts(Os::Linux, Some(Bundle::Deb));
        f.running_as_appimage = true;
        assert_ne!(classify(&f), Eligibility::SelfUpdate);
    }

    #[test]
    fn macos_requires_an_installed_app_bundle() {
        let mut f = facts(Os::Mac, Some(Bundle::App));
        assert_eq!(
            classify(&f),
            Eligibility::NotifyOnly(NotifyReason::MacAppNotInstalled)
        );
        f.macos_app = true;
        assert_eq!(classify(&f), Eligibility::SelfUpdate);
    }

    #[test]
    fn mismatched_os_and_bundle_is_unsupported() {
        assert_eq!(
            classify(&facts(Os::Linux, Some(Bundle::Nsis))),
            Eligibility::NotifyOnly(NotifyReason::UnsupportedBundle)
        );
        assert_eq!(
            classify(&facts(Os::Windows, Some(Bundle::Deb))),
            Eligibility::NotifyOnly(NotifyReason::UnsupportedBundle)
        );
    }

    #[test]
    fn macos_app_path_detection() {
        let ok = Path::new("/Applications/tauri-explorer.app/Contents/MacOS/tauri-explorer");
        assert!(is_installed_macos_app(ok));
        let user =
            Path::new("/Users/a/Applications/tauri-explorer.app/Contents/MacOS/tauri-explorer");
        assert!(is_installed_macos_app(user));
        let dmg =
            Path::new("/Volumes/tauri-explorer/tauri-explorer.app/Contents/MacOS/tauri-explorer");
        assert!(!is_installed_macos_app(dmg));
        let translocated = Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/tauri-explorer.app/Contents/MacOS/tauri-explorer",
        );
        assert!(!is_installed_macos_app(translocated));
        let dev = Path::new("/Users/a/src/tauri-explorer/src-tauri/target/release/tauri-explorer");
        assert!(!is_installed_macos_app(dev));
    }
}
