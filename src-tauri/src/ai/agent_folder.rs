//! The folder a folder-agent job runs in (#1884). It becomes the CLI's working
//! directory, the only place its file tools may read, so it must be a real,
//! existing local directory and never a location whose contents the user did
//! not choose to share: virtual (plugin) folders, trash folders, the
//! filesystem root or the home directory itself.
use super::domain::{Result, ServiceError};
use std::path::{Component, Path, PathBuf};

fn refused(message: &str) -> ServiceError {
    ServiceError::invalid(message)
}

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

/// Trash storage on every platform: freedesktop home trash
/// (`$XDG_DATA_HOME/Trash`) and per-volume `.Trash`/`.Trash-<uid>`, macOS
/// `~/.Trash`, and the Windows `$Recycle.Bin`.
fn is_trash(path: &Path, data_dir: Option<&Path>) -> bool {
    let in_trash_component = path.components().any(|c| match c {
        Component::Normal(name) => name.to_str().is_some_and(|name| {
            name == ".Trash"
                || name.starts_with(".Trash-")
                || name.eq_ignore_ascii_case("$Recycle.Bin")
        }),
        _ => false,
    });
    in_trash_component || data_dir.is_some_and(|data| path.starts_with(data.join("Trash")))
}

/// Resolves a wire-form folder path to its canonical directory, or refuses it.
/// `home` and `data_dir` are injected so tests control them.
pub(super) fn resolve(
    folder: &str,
    home: Option<&Path>,
    data_dir: Option<&Path>,
) -> Result<PathBuf> {
    if is_virtual(folder) {
        return Err(refused(
            "Agent jobs run only in local folders, not virtual or trash locations",
        ));
    }
    let path = crate::wire_path::decode(folder)
        .map_err(|_| refused("Agent folder path has an invalid encoding"))?;
    if !path.is_absolute() {
        return Err(refused("Agent folder must be an absolute path"));
    }
    let canonical = dunce::canonicalize(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            ServiceError::new("not_found", "Agent folder does not exist")
        }
        _ => refused("Agent folder cannot be opened"),
    })?;
    if !std::fs::metadata(&canonical).is_ok_and(|m| m.is_dir()) {
        return Err(refused("Agent folder must be a directory"));
    }
    let canonical_home = home.and_then(|h| dunce::canonicalize(h).ok());
    let canonical_data = data_dir.and_then(|d| dunce::canonicalize(d).ok());
    if is_trash(&canonical, canonical_data.as_deref().or(data_dir)) || is_trash(&path, data_dir) {
        return Err(refused(
            "Agent jobs run only in local folders, not virtual or trash locations",
        ));
    }
    if canonical.parent().is_none() || canonical_home.as_deref() == Some(canonical.as_path()) {
        return Err(refused(
            "Agent jobs cannot run in the filesystem root or the home folder itself; choose a subfolder",
        ));
    }
    Ok(canonical)
}

/// [`resolve`] with the user's real home and data directories.
pub(super) fn resolve_local(folder: &str) -> Result<PathBuf> {
    resolve(
        folder,
        dirs::home_dir().as_deref(),
        dirs::data_dir().as_deref(),
    )
}
