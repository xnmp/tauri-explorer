//! Configuration file persistence module.
//! Issue: tauri-ti0l
//!
//! Provides Tauri commands for reading/writing JSON config files
//! in the app's config directory (~/.config/tauri-explorer/ on Linux).

use crate::error::AppError;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

/// Serializes concurrent config writes so they can't interleave.
static WRITE_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn write_lock() -> &'static AsyncMutex<()> {
    WRITE_LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// Get the app config directory, creating it if needed.
pub(crate) fn config_dir() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Other("Could not determine config directory".into()))?;
    let dir = base.join("tauri-explorer");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Other(format!("Failed to create config dir: {}", e)))?;
    }
    Ok(dir)
}

/// Validate that a config filename is a plain file name (no path separators,
/// no parent-dir components, not absolute) so it cannot escape the config dir.
fn validate_filename(filename: &str) -> Result<(), AppError> {
    let path = Path::new(filename);
    let is_plain_name = !filename.is_empty()
        && !filename.contains('/')
        && !filename.contains('\\')
        && !path.is_absolute()
        && path.components().all(|c| matches!(c, Component::Normal(_)))
        && filename != "..";
    if !is_plain_name {
        return Err(AppError::InvalidPath(format!(
            "Invalid config filename: {}",
            filename
        )));
    }
    Ok(())
}

/// Resolve a validated filename inside the config directory.
fn resolve_config_path(filename: &str) -> Result<PathBuf, AppError> {
    validate_filename(filename)?;
    let dir = config_dir()?;
    let path = dir.join(filename);
    // Defense in depth: the resolved path must stay inside the config dir.
    if !path.starts_with(&dir) {
        return Err(AppError::InvalidPath(format!(
            "Config path escapes config directory: {}",
            filename
        )));
    }
    Ok(path)
}

/// Follow a config-file symlink chain without requiring the final target to
/// exist. `canonicalize` cannot resolve a dangling final link, which is a
/// valid dotfile-manager setup that a first app save should populate.
fn resolve_write_target(path: &Path) -> std::io::Result<PathBuf> {
    const MAX_SYMLINKS: usize = 40;
    let mut target = path.to_path_buf();
    let mut followed = 0;

    loop {
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if followed == MAX_SYMLINKS {
                    return Err(std::io::Error::other(format!(
                        "Config symlink chain exceeds {MAX_SYMLINKS} links"
                    )));
                }
                let next = fs::read_link(&target)?;
                followed += 1;
                target = if next.is_absolute() {
                    next
                } else {
                    target
                        .parent()
                        .ok_or_else(|| std::io::Error::other("Symlink has no parent directory"))?
                        .join(next)
                };
            }
            Ok(_) => return Ok(target),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(target),
            Err(error) => return Err(error),
        }
    }
}

/// Write `data` atomically through any config-file symlink: resolve the final
/// target once, write a temp file beside it, then rename over that target.
fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    // Resolving once is the operation's linearization point: a concurrent
    // retarget of the config symlink affects the next write, not this one.
    let path = resolve_write_target(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Config path has no parent directory"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("Config path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let (tmp, mut file) = loop {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{}.tmp-{}-{}",
            file_name,
            std::process::id(),
            sequence
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    // Config files can hold secrets (plugin API keys) — owner-only on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    }
    if let Err(e) = file.write_all(data.as_bytes()).and_then(|_| file.flush()) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(file);
    fs::rename(&tmp, &path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Read a JSON config file. Returns the raw JSON string.
/// Returns empty string if file doesn't exist (not an error).
#[tauri::command]
pub async fn read_config_file(filename: String) -> Result<String, AppError> {
    let path = resolve_config_path(&filename)?;
    tokio::task::spawn_blocking(move || {
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| {
            AppError::Other(format!("Failed to read config file '{}': {}", filename, e))
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Write a user theme CSS file into `<config>/themes/` atomically (#203).
/// Same single-component filename validation as config files, plus a .css
/// extension requirement — theme generation must not become a file-write
/// primitive.
#[tauri::command]
pub async fn write_theme_file(filename: String, data: String) -> Result<(), AppError> {
    validate_filename(&filename)?;
    if !filename.ends_with(".css") {
        return Err(AppError::InvalidPath(format!(
            "Theme file must end in .css: {filename}"
        )));
    }
    let dir = config_dir()?.join("themes");
    tokio::task::spawn_blocking(move || {
        let _guard = write_lock().blocking_lock();
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Other(format!("Failed to create themes dir: {e}")))?;
        write_atomic(&dir.join(&filename), &data)
            .map_err(|e| AppError::Other(format!("Failed to write theme '{filename}': {e}")))
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

/// Write a JSON config file. Creates or overwrites the file atomically.
#[tauri::command]
pub async fn write_config_file(filename: String, data: String) -> Result<(), AppError> {
    let path = resolve_config_path(&filename)?;
    // Serialize concurrent writes so two writers can't interleave.
    let _guard = write_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        log::debug!("Writing config file: {}", filename);
        write_atomic(&path, &data).map_err(|e| {
            AppError::Other(format!("Failed to write config file '{}': {}", filename, e))
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Get the app config directory path.
#[tauri::command]
pub async fn get_config_dir() -> Result<String, AppError> {
    tokio::task::spawn_blocking(|| config_dir().map(|p| p.to_string_lossy().into_owned()))
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

/// Read all CSS files from ~/.config/tauri-explorer/themes/.
/// Returns a vec of (filename, css_content) pairs.
/// Returns empty vec if directory doesn't exist.
#[tauri::command]
pub async fn list_user_themes() -> Result<Vec<(String, String)>, AppError> {
    tokio::task::spawn_blocking(list_user_themes_sync)
        .await
        .map_err(|e| AppError::Other(format!("Task join error: {}", e)))?
}

fn list_user_themes_sync() -> Result<Vec<(String, String)>, AppError> {
    let themes_dir = config_dir()?.join("themes");
    if !themes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut themes = Vec::new();
    let entries = fs::read_dir(&themes_dir)
        .map_err(|e| AppError::Other(format!("Failed to read themes dir: {}", e)))?;

    for entry in entries {
        let entry =
            entry.map_err(|e| AppError::Other(format!("Failed to read dir entry: {}", e)))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) == Some("css") {
            let filename = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let content = fs::read_to_string(&path).map_err(|e| {
                AppError::Other(format!("Failed to read theme '{}': {}", filename, e))
            })?;
            themes.push((filename, content));
        }
    }

    Ok(themes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_path_traversal_filenames() {
        assert!(validate_filename("../escape.json").is_err());
        assert!(validate_filename("..").is_err());
        assert!(validate_filename("a/../b.json").is_err());
        assert!(validate_filename("/etc/passwd").is_err());
        assert!(validate_filename("subdir/settings.json").is_err());
        assert!(validate_filename("subdir\\settings.json").is_err());
        assert!(validate_filename("").is_err());
    }

    #[test]
    fn accepts_plain_filenames() {
        assert!(validate_filename("settings.json").is_ok());
        assert!(validate_filename("window-state.json").is_ok());
        assert!(validate_filename(".hidden.json").is_ok());
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_temp_files() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");

        write_atomic(&path, "{\"a\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");

        write_atomic(&path, "{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":2}");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_updates_symlink_target_without_replacing_link() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let link = dir.path().join("settings.json");
        fs::write(&target, "old").unwrap();
        symlink(&target, &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_follows_relative_symlink_chains() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let middle = dir.path().join("current-settings.json");
        let link = dir.path().join("settings.json");
        fs::write(&target, "old").unwrap();
        symlink("managed-settings.json", &middle).unwrap();
        symlink("current-settings.json", &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::symlink_metadata(&middle)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_creates_dangling_symlink_target_without_replacing_link() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let link = dir.path().join("settings.json");
        symlink("managed-settings.json", &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_keeps_owner_only_permissions_through_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let dir = tempdir().unwrap();
        let target = dir.path().join("managed-settings.json");
        let link = dir.path().join("settings.json");
        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&target, &link).unwrap();

        write_atomic(&link, "new").unwrap();

        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_accepts_exactly_the_supported_symlink_depth() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("target.json");
        fs::write(&target, "old").unwrap();
        for index in (0..40).rev() {
            let destination = if index == 39 {
                "target.json".to_string()
            } else {
                format!("link-{}.json", index + 1)
            };
            symlink(destination, dir.path().join(format!("link-{index}.json"))).unwrap();
        }

        write_atomic(&dir.path().join("link-0.json"), "new").unwrap();

        assert_eq!(fs::read_to_string(target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_does_not_follow_a_precreated_staging_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let victim = dir.path().join("unrelated.json");
        fs::write(&victim, "keep").unwrap();
        let predictable = dir
            .path()
            .join(format!(".settings.json.tmp-{}", std::process::id()));
        symlink(&victim, &predictable).unwrap();

        let result = write_atomic(&path, "new");

        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        assert!(
            result.is_ok(),
            "a planted staging symlink must not block a safe write: {result:?}"
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "new");
    }
}
