//! The folder a folder-agent job runs in (#1884). It becomes the CLI's working
//! directory, the only place its file tools may read, so it must be an
//! existing directory whose contents the user can reasonably mean to share.
//!
//! [`FolderPolicy::refusal`] is the pure rule set, applied to the canonical
//! path (symlinks resolved), so a link cannot smuggle in a refused location:
//!
//! - the filesystem root, the home folder and every ancestor of it;
//! - any folder inside home with a component starting with `.` (dot-folders
//!   hold credentials and configuration: `.ssh`, `.aws`, `.codex`, …);
//! - OS system trees (`/proc`, `/etc`, `/usr`, …; `/System`, `/private`, …;
//!   `%SystemRoot%`, Program Files, ProgramData, `%APPDATA%`, `%LOCALAPPDATA%`);
//! - trash storage;
//! - Windows network shares (UNC paths).
//!
//! Unix network mounts are not detected; a hung mount is bounded by the
//! resolution timeout in `Service::run_agent`.
use super::domain::{Result, ServiceError};
use std::path::{Component, Path, PathBuf};

fn refused(message: &str) -> ServiceError {
    ServiceError::invalid(message)
}

const VIRTUAL_OR_TRASH: &str =
    "Agent jobs run only in real folders, not virtual or trash locations";

/// `<scheme>://…` with a scheme of two or more characters, as the frontend's
/// `isVirtualPath` (`domain/virtual-path.ts`) defines it; `trash://` is one.
fn is_virtual(path: &str) -> bool {
    path.split_once("://").is_some_and(|(scheme, _)| {
        let mut chars = scheme.chars();
        scheme.len() >= 2
            && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    })
}

fn named(component: Component<'_>) -> Option<&str> {
    match component {
        Component::Normal(name) => name.to_str(),
        _ => None,
    }
}

/// Unix system trees refused as agent folders. `lib*` (lib, lib32, lib64,
/// libx32, …) is matched by prefix in [`FolderPolicy::refusal`].
#[cfg(unix)]
const UNIX_SYSTEM_TREES: &[&str] = &[
    "/proc", "/sys", "/dev", "/etc", "/run", "/boot", "/usr", "/bin", "/sbin", "/var", "/opt",
    "/snap", "/nix",
];
#[cfg(target_os = "macos")]
const MACOS_SYSTEM_TREES: &[&str] = &["/System", "/Library", "/private", "/Applications"];

/// Everything the rules need besides the path itself, so the rules stay pure.
#[derive(Clone, Debug, Default)]
pub(super) struct FolderPolicy {
    pub home: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    /// Refused with everything beneath them.
    pub system_trees: Vec<PathBuf>,
    /// Refuse top-level `lib*` directories (Unix).
    pub unix_lib_roots: bool,
}

impl FolderPolicy {
    /// The policy for this machine: its home and data directories and the
    /// platform's system trees (canonicalized where they exist, so macOS's
    /// `/etc` → `/private/etc` links are matched by their targets too).
    pub(super) fn local() -> Self {
        let canonical = |p: PathBuf| dunce::canonicalize(&p).unwrap_or(p);
        #[allow(unused_mut)]
        let mut system_trees: Vec<PathBuf> = Vec::new();
        #[cfg(unix)]
        system_trees.extend(UNIX_SYSTEM_TREES.iter().map(PathBuf::from));
        #[cfg(target_os = "macos")]
        system_trees.extend(MACOS_SYSTEM_TREES.iter().map(PathBuf::from));
        #[cfg(windows)]
        for key in [
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
            "ProgramData",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Some(path) = std::env::var_os(key).map(PathBuf::from) {
                system_trees.push(path);
            }
        }
        Self {
            home: dirs::home_dir().map(canonical),
            data_dir: dirs::data_dir().map(canonical),
            system_trees: system_trees.into_iter().map(canonical).collect(),
            unix_lib_roots: cfg!(unix),
        }
    }

    /// Why `canonical` may not be an agent folder (or a CLI runtime grant), or
    /// `None` when it may. Pure: no filesystem access.
    pub(super) fn refusal(&self, canonical: &Path) -> Option<&'static str> {
        let network_share = canonical.components().any(|c| {
            matches!(c, Component::Prefix(prefix) if matches!(
                prefix.kind(),
                std::path::Prefix::UNC(..)
                    | std::path::Prefix::VerbatimUNC(..)
                    | std::path::Prefix::DeviceNS(..)
            ))
        });
        if network_share {
            return Some("Agent jobs cannot run on network shares (UNC paths)");
        }
        let in_trash = canonical.components().filter_map(named).any(|name| {
            name == ".Trash"
                || name.starts_with(".Trash-")
                || name.eq_ignore_ascii_case("$Recycle.Bin")
        }) || self
            .data_dir
            .as_ref()
            .is_some_and(|data| canonical.starts_with(data.join("Trash")));
        if in_trash {
            return Some(VIRTUAL_OR_TRASH);
        }
        if canonical.parent().is_none() {
            return Some("Agent jobs cannot run in the filesystem root; choose a project folder");
        }
        if let Some(home) = &self.home {
            if home.starts_with(canonical) {
                return Some(
                    "Agent jobs cannot run in the home folder or a folder that contains it; choose a project folder",
                );
            }
            if let Ok(inside) = canonical.strip_prefix(home) {
                if inside
                    .components()
                    .filter_map(named)
                    .any(|name| name.starts_with('.'))
                {
                    return Some(
                        "Agent jobs cannot run in hidden folders inside home, which hold credentials and settings",
                    );
                }
            }
        }
        // A tree that contains home (Fedora Atomic's `/var/home`) does not
        // refuse folders inside home; trees inside home (`%APPDATA%`) do.
        let in_home = self
            .home
            .as_ref()
            .is_some_and(|home| canonical.starts_with(home));
        let system = self.system_trees.iter().any(|tree| {
            canonical.starts_with(tree)
                && !(in_home && self.home.as_ref().is_some_and(|h| h.starts_with(tree)))
        }) || (!in_home
            && self.unix_lib_roots
            && canonical
                .components()
                .nth(1)
                .and_then(named)
                .is_some_and(|first| first.starts_with("lib")));
        if system {
            return Some("Agent jobs cannot run in operating-system folders");
        }
        None
    }

    /// Resolves a wire-form folder path to its canonical directory, or
    /// refuses it. Touches the filesystem (canonicalize, metadata), so callers
    /// bound it in time.
    pub(super) fn resolve(&self, folder: &str) -> Result<PathBuf> {
        if is_virtual(folder) {
            return Err(refused(VIRTUAL_OR_TRASH));
        }
        let path = crate::wire_path::decode(folder)
            .map_err(|_| refused("Agent folder path has an invalid encoding"))?;
        if !path.is_absolute() {
            return Err(refused("Agent folder must be an absolute path"));
        }
        // The literal path too: a share or trash reached through a link is
        // refused even before the canonical check below.
        if let Some(reason) = self
            .refusal(&path)
            .filter(|r| *r == VIRTUAL_OR_TRASH || r.contains("network shares"))
        {
            return Err(refused(reason));
        }
        let canonical = dunce::canonicalize(&path).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => {
                ServiceError::new("not_found", "Agent folder does not exist")
            }
            _ => refused("Agent folder cannot be opened"),
        })?;
        if let Some(reason) = self.refusal(&canonical) {
            return Err(refused(reason));
        }
        if !std::fs::metadata(&canonical).is_ok_and(|m| m.is_dir()) {
            return Err(refused("Agent folder must be a directory"));
        }
        Ok(canonical)
    }
}
