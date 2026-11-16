//! Which installs may replace themselves (#1679).
//!
//! Pure policy over facts the caller gathers (`gather_install_facts`). The
//! bundle type the Tauri bundler patches into the binary is not enough on its
//! own: the AUR `-bin` package repacks the official `.deb`, so an Arch binary
//! still reports `Deb`, and a `--no-bundle` distro build reports nothing.
//!
//! Self-update is granted only to installs the app owns end to end: Windows
//! installers, an installed macOS `.app`, and an AppImage replacing its own
//! file. Linux deb/rpm installs stay notify-only even though the plugin can
//! drive `pkexec dpkg -i`/`rpm -U`: the system package manager owns them,
//! `dpkg -i` cannot resolve new dependencies, and the plugin's fallbacks end
//! in a terminal `sudo` that can block forever when launched from a shell.

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
    /// Linux: running inside the AppImage named by `$APPIMAGE`, whose
    /// directory we can write (see `is_replaceable_appimage`).
    pub replaceable_appimage: bool,
    /// macOS: the executable sits in a writable `.app` bundle (not a mounted
    /// disk image or a translocated copy).
    pub macos_app: bool,
}

/// Why an install keeps the notify-only path instead of replacing itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyReason {
    /// Not produced by the Tauri bundler (dev build, `--no-bundle` package).
    Unbundled,
    /// A deb/rpm-built binary: the system package manager owns the files.
    PackageManaged,
    /// An AppImage binary not running from a writable AppImage of its own.
    AppImageNotReplaceable,
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
        (Os::Linux, Some(Bundle::AppImage)) if facts.replaceable_appimage => SelfUpdate,
        (Os::Linux, Some(Bundle::AppImage)) => NotifyOnly(AppImageNotReplaceable),
        (Os::Linux, Some(Bundle::Deb | Bundle::Rpm)) => NotifyOnly(PackageManaged),
        _ => NotifyOnly(UnsupportedBundle),
    }
}

/// True when this process runs from the AppImage that `$APPIMAGE` names and
/// that file can be replaced. `$APPIMAGE` is inherited by child processes, so
/// it alone could point at another application's AppImage; the executable
/// must also lie inside the runtime's mount (`$APPDIR`). The updater writes
/// the new image beside the old one, so its directory must be writable.
pub fn is_replaceable_appimage(
    exe: &Path,
    appdir: Option<&Path>,
    appimage: Option<&Path>,
    dir_writable: impl Fn(&Path) -> bool,
) -> bool {
    let (Some(appdir), Some(appimage)) = (appdir, appimage) else {
        return false;
    };
    appdir.is_absolute()
        && appimage.is_absolute()
        && exe.starts_with(appdir)
        && appimage.parent().is_some_and(dir_writable)
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
            replaceable_appimage: false,
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
        f.replaceable_appimage = true;
        assert_eq!(classify(&f), Eligibility::SelfUpdate);
    }

    #[test]
    fn deb_and_rpm_stay_notify_only() {
        // The AUR -bin package repacks the .deb, and even a genuine dpkg/rpm
        // install belongs to the system package manager.
        for bundle in [Bundle::Deb, Bundle::Rpm] {
            let mut f = facts(Os::Linux, Some(bundle));
            f.replaceable_appimage = true;
            assert_eq!(
                classify(&f),
                Eligibility::NotifyOnly(NotifyReason::PackageManaged)
            );
        }
    }

    #[test]
    fn appimage_must_run_from_its_own_writable_image() {
        let exe = Path::new("/tmp/.mount_tauri-abc/usr/bin/tauri-explorer");
        let appdir = Some(Path::new("/tmp/.mount_tauri-abc"));
        let image = Some(Path::new("/home/a/Apps/tauri-explorer.AppImage"));
        let writable = |_: &Path| true;
        assert!(is_replaceable_appimage(exe, appdir, image, writable));
        // Read-only directory: the replacement would fail every day.
        assert!(!is_replaceable_appimage(exe, appdir, image, |_| false));
        // $APPIMAGE inherited from another AppImage, binary run elsewhere.
        let extracted = Path::new("/home/a/squashfs-root/usr/bin/tauri-explorer");
        assert!(!is_replaceable_appimage(extracted, appdir, image, writable));
        // Missing or relative environment.
        assert!(!is_replaceable_appimage(exe, None, image, writable));
        assert!(!is_replaceable_appimage(exe, appdir, None, writable));
        let relative = Some(Path::new("tauri-explorer.AppImage"));
        assert!(!is_replaceable_appimage(exe, appdir, relative, writable));
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
