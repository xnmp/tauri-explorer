//! Recoverable package upgrade: quiesce publishers, snapshot declared state, then activate.
use super::{backend, package};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_STATE: u64 = 512 * 1024 * 1024;
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Prepared,
    Committed,
    RolledBack,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedFile {
    name: String,
    content: Option<Content>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Content {
    size: u64,
    sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Upgrade {
    phase: Phase,
    package_id: String,
    previous: Vec<package::Installed>,
    files: Vec<SavedFile>,
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}
fn open_regular(path: &Path, limit: u64) -> Result<fs::File, AppError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(invalid("Plugin state must be a bounded regular file"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > limit {
        return Err(invalid("Plugin state must be a bounded regular file"));
    }
    Ok(file)
}
fn copy_state(source: &Path, target: &mut fs::File) -> Result<Content, AppError> {
    let mut input = open_regular(source, MAX_STATE)?.take(MAX_STATE + 1);
    let mut buffer = [0u8; 64 * 1024];
    let mut hash = Sha256::new();
    let mut size = 0;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_STATE {
            return Err(invalid("Plugin state exceeds snapshot limit"));
        }
        hash.update(&buffer[..count]);
        target.write_all(&buffer[..count])?;
    }
    target.flush()?;
    target.sync_all()?;
    Ok(Content {
        size,
        sha256: hex::encode(hash.finalize()),
    })
}
fn snapshot_file(source: &Path, target: &Path) -> Result<Content, AppError> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    copy_state(source, &mut options.open(target)?)
}
fn sync_directory(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
fn write_marker(snapshot: &Path, upgrade: &Upgrade) -> Result<(), AppError> {
    let mut stage = tempfile::NamedTempFile::new_in(snapshot)?;
    serde_json::to_writer(&mut stage, upgrade).map_err(|cause| invalid(cause.to_string()))?;
    stage.flush()?;
    stage.as_file().sync_all()?;
    stage
        .persist(snapshot.join("upgrade.json"))
        .map_err(|cause| AppError::from(cause.error))?;
    sync_directory(snapshot)
}
fn data_root(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    Ok(root
        .parent()
        .ok_or_else(|| invalid("Plugin profile has no parent"))?
        .join("plugin-data")
        .join(id))
}
fn validate(upgrade: &Upgrade) -> Result<(), AppError> {
    let valid_id = !upgrade.package_id.is_empty()
        && upgrade.package_id.len() <= 100
        && upgrade.package_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        });
    if !valid_id
        || upgrade.previous.len() > 64
        || !upgrade
            .previous
            .iter()
            .all(|entry| entry.manifest.validate().is_ok())
        || upgrade.files.len() > 128
        || upgrade.files.iter().any(|file| {
            file.name.is_empty()
                || file.name.len() > 200
                || file.name.contains(['/', '\\', ':', '\0'])
                || file.name == "."
                || file.name == ".."
                || file.content.as_ref().is_some_and(|content| {
                    content.size > MAX_STATE
                        || content.sha256.len() != 64
                        || !content.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        })
    {
        return Err(invalid("Invalid plugin upgrade journal"));
    }
    Ok(())
}
fn cleanup(snapshot: &Path) {
    if let Err(cause) = fs::remove_dir_all(snapshot) {
        log::warn!("Completed plugin upgrade snapshot cleanup pending: {cause}");
    }
}
fn restore(root: &Path, snapshot: &Path, upgrade: &mut Upgrade) -> Result<(), AppError> {
    validate(upgrade)?;
    let data = data_root(root, &upgrade.package_id)?;
    fs::create_dir_all(&data)?;
    for file in &upgrade.files {
        let target = data.join(&file.name);
        match &file.content {
            Some(expected) => {
                // A missing/corrupt backup is an error, never evidence that the original was absent.
                let mut staged = tempfile::NamedTempFile::new_in(&data)?;
                let actual = copy_state(
                    &snapshot.join("state").join(&file.name),
                    staged.as_file_mut(),
                )?;
                if actual.size != expected.size || actual.sha256 != expected.sha256 {
                    return Err(invalid(
                        "Plugin state snapshot changed; retain it for recovery",
                    ));
                }
                staged
                    .persist(target)
                    .map_err(|cause| AppError::from(cause.error))?;
            }
            None => match fs::remove_file(target) {
                Ok(()) => {}
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                Err(cause) => return Err(cause.into()),
            },
        }
    }
    sync_directory(&data)?;
    package::write_index(root, &upgrade.previous)?;
    upgrade.phase = Phase::RolledBack;
    write_marker(snapshot, upgrade)?;
    cleanup(snapshot);
    Ok(())
}
pub(super) fn recover(root: &Path) -> Result<(), AppError> {
    let snapshot = root.join("upgrade-pending");
    if !snapshot.exists() {
        return Ok(());
    }
    let marker = snapshot.join("upgrade.json");
    if !marker.exists() {
        cleanup(&snapshot);
        return Ok(());
    }
    let mut upgrade: Upgrade =
        serde_json::from_reader(open_regular(&marker, 1024 * 1024)?.take(1024 * 1024 + 1))
            .map_err(|cause| invalid(cause.to_string()))?;
    validate(&upgrade)?;
    if upgrade.phase == Phase::Prepared {
        restore(root, &snapshot, &mut upgrade)
    } else {
        cleanup(&snapshot);
        Ok(())
    }
}
pub(super) fn install(root: &Path, archive: &Path) -> Result<package::Installed, AppError> {
    recover(root)?;
    let next = package::prepare(root, archive)?;
    if backend::busy(&next.manifest.id) {
        return Err(invalid("Finish active plugin operations before upgrading"));
    }
    let previous = package::list(root)?;
    backend::retire(&next.manifest.id);
    let snapshot = root.join("upgrade-pending");
    fs::create_dir(&snapshot)?;
    fs::create_dir(snapshot.join("state"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&snapshot, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(snapshot.join("state"), fs::Permissions::from_mode(0o700))?;
    }
    let mut names = next.manifest.state_files.clone();
    if let Some(old) = previous
        .iter()
        .find(|entry| entry.manifest.id == next.manifest.id)
    {
        names.extend(old.manifest.state_files.clone());
    }
    for name in names.clone() {
        for suffix in ["-wal", "-shm", "-journal"] {
            names.push(format!("{name}{suffix}"));
        }
    }
    names.sort();
    names.dedup();
    let mut upgrade = Upgrade {
        phase: Phase::Prepared,
        package_id: next.manifest.id.clone(),
        previous,
        files: vec![],
    };
    let result = (|| {
        let data = data_root(root, &next.manifest.id)?;
        for name in names {
            let source = data.join(&name);
            let content = match fs::symlink_metadata(&source) {
                Ok(_) => Some(snapshot_file(&source, &snapshot.join("state").join(&name))?),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => None,
                Err(cause) => return Err(cause.into()),
            };
            upgrade.files.push(SavedFile { name, content });
        }
        write_marker(&snapshot, &upgrade)?;
        sync_directory(root)?;
        let installed = package::publish(root, next.clone())?;
        let candidate = backend::preflight(&installed.manifest.id)?;
        upgrade.phase = Phase::Committed;
        write_marker(&snapshot, &upgrade)?;
        // External journal reconciliation may collect publication proof. It is
        // safe only after the durable commit forbids database rollback.
        if let Err(cause) = candidate.call("lifecycle.activate", serde_json::json!({})) {
            backend::retire(&installed.manifest.id);
            log::warn!("Installed plugin activation will retry on next use: {cause}");
        }
        Ok(installed)
    })();
    match result {
        Ok(installed) => {
            cleanup(&snapshot);
            Ok(installed)
        }
        Err(cause) => {
            backend::retire(&next.manifest.id);
            if snapshot.join("upgrade.json").exists() {
                restore(root,&snapshot,&mut upgrade).map_err(|restore_error|invalid(format!("Plugin upgrade failed ({cause}); rollback requires recovery: {restore_error}")))?;
            } else {
                cleanup(&snapshot);
            }
            Err(cause)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(phase: Phase) -> (tempfile::TempDir, PathBuf, PathBuf, Upgrade) {
        let profile = tempfile::tempdir().unwrap();
        let root = profile.path().join("installed-plugins");
        let snapshot = root.join("upgrade-pending");
        fs::create_dir_all(snapshot.join("state")).unwrap();
        let data = data_root(&root, "example.plugin").unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("history.sqlite"), b"current history").unwrap();
        let upgrade = Upgrade {
            phase,
            package_id: "example.plugin".into(),
            previous: vec![],
            files: vec![SavedFile {
                name: "history.sqlite".into(),
                content: Some(Content {
                    size: 12,
                    sha256: hex::encode(Sha256::digest(b"old history!")),
                }),
            }],
        };
        (profile, root, data, upgrade)
    }
    #[test]
    fn completed_snapshot_cleanup_cannot_erase_current_history_after_restart() {
        for phase in [Phase::Committed, Phase::RolledBack] {
            let (_profile, root, data, upgrade) = fixture(phase);
            let snapshot = root.join("upgrade-pending");
            write_marker(&snapshot, &upgrade).unwrap();
            // The backup has already been collected, but process death left its journal.
            recover(&root).unwrap();
            recover(&root).unwrap();
            assert_eq!(
                fs::read(data.join("history.sqlite")).unwrap(),
                b"current history"
            );
        }
    }
    #[test]
    fn absent_or_corrupted_required_backup_refuses_recovery_without_erasing_history() {
        for corrupt in [false, true] {
            let (_profile, root, data, upgrade) = fixture(Phase::Prepared);
            let snapshot = root.join("upgrade-pending");
            if corrupt {
                fs::write(snapshot.join("state/history.sqlite"), b"invalid snapshot").unwrap();
            }
            write_marker(&snapshot, &upgrade).unwrap();
            assert!(recover(&root).is_err());
            assert_eq!(
                fs::read(data.join("history.sqlite")).unwrap(),
                b"current history"
            );
            assert!(snapshot.join("upgrade.json").exists());
        }
    }
    #[test]
    fn prepared_upgrade_restores_original_state_and_removes_only_originally_absent_files() {
        let (_profile, root, data, mut upgrade) = fixture(Phase::Prepared);
        let snapshot = root.join("upgrade-pending");
        fs::write(snapshot.join("state/history.sqlite"), b"old history!").unwrap();
        fs::write(data.join("new-state"), b"new schema").unwrap();
        fs::write(data.join("unlisted-output.png"), b"user image").unwrap();
        upgrade.files.push(SavedFile {
            name: "new-state".into(),
            content: None,
        });
        write_marker(&snapshot, &upgrade).unwrap();
        recover(&root).unwrap();
        recover(&root).unwrap();
        assert_eq!(
            fs::read(data.join("history.sqlite")).unwrap(),
            b"old history!"
        );
        assert!(!data.join("new-state").exists());
        assert_eq!(
            fs::read(data.join("unlisted-output.png")).unwrap(),
            b"user image"
        );
        assert!(package::list(&root).unwrap().is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn state_backup_remains_private() {
        use std::os::unix::fs::PermissionsExt;
        let profile = tempfile::tempdir().unwrap();
        let source = profile.path().join("state");
        let target = profile.path().join("backup");
        fs::write(&source, b"private history").unwrap();
        snapshot_file(&source, &target).unwrap();
        assert_eq!(
            fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
