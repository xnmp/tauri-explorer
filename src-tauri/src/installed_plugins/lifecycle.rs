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
// Two bounded installed indexes plus snapshot metadata and future-safe slack.
const MAX_JOURNAL: u64 = 4 * 1024 * 1024;
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Prepared,
    Committed,
    Published,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    committed_index: Option<Vec<package::Installed>>,
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
    let bytes = serde_json::to_vec(upgrade).map_err(|cause| invalid(cause.to_string()))?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err(invalid("Plugin upgrade journal exceeds size limit"));
    }
    let mut stage = tempfile::NamedTempFile::new_in(snapshot)?;
    stage.write_all(&bytes)?;
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
    package::validate_index(&upgrade.previous)?;
    if let Some(index) = &upgrade.committed_index {
        package::validate_index(index)?;
        let before: Vec<_> = upgrade
            .previous
            .iter()
            .filter(|entry| entry.manifest.id != upgrade.package_id)
            .collect();
        let after: Vec<_> = index
            .iter()
            .filter(|entry| entry.manifest.id != upgrade.package_id)
            .collect();
        if index
            .iter()
            .filter(|entry| entry.manifest.id == upgrade.package_id)
            .count()
            != 1
            || before.len() != after.len()
        {
            return Err(invalid("Plugin upgrade journal changes unrelated packages"));
        }
        for entry in before {
            let other = after
                .iter()
                .find(|other| other.manifest.id == entry.manifest.id)
                .ok_or_else(|| invalid("Plugin upgrade journal changes unrelated packages"))?;
            if serde_json::to_value(entry).map_err(|cause| invalid(cause.to_string()))?
                != serde_json::to_value(other).map_err(|cause| invalid(cause.to_string()))?
            {
                return Err(invalid("Plugin upgrade journal changes unrelated packages"));
            }
        }
    }
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
        || upgrade.committed_index.as_ref().is_some_and(|index| {
            index.len() > 64 || index.iter().any(|entry| entry.manifest.validate().is_err())
        })
        || upgrade
            .files
            .iter()
            .map(|file| &file.name)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != upgrade.files.len()
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
        serde_json::from_reader(open_regular(&marker, MAX_JOURNAL)?.take(MAX_JOURNAL + 1))
            .map_err(|cause| invalid(cause.to_string()))?;
    validate(&upgrade)?;
    if upgrade.phase == Phase::Prepared {
        restore(root, &snapshot, &mut upgrade)?;
        backend::release_recovered_fence(&upgrade.package_id)
    } else {
        if upgrade.phase == Phase::Committed {
            if let Some(index) = &upgrade.committed_index {
                // Commit may have been durable before installed.json changed.
                // Complete that decision; never roll a committed package back.
                super::service_graph::validate_enabled(index)?;
                package::write_index(root, index)?;
                upgrade.phase = Phase::Published;
                write_marker(&snapshot, &upgrade)?;
            }
        }
        cleanup(&snapshot);
        backend::release_recovered_fence(&upgrade.package_id)?;
        Ok(())
    }
}
pub(super) fn install(
    root: &Path,
    next: package::Installed,
    fence: &backend::DrainGuard,
) -> Result<package::Installed, AppError> {
    recover(root)?;
    super::service_host::candidate_state_allowed_at(
        root.parent()
            .ok_or_else(|| invalid("Plugin profile root is unavailable"))?,
        &next,
    )?;
    if backend::busy(&next.manifest.id) {
        return Err(invalid("Finish active plugin operations before upgrading"));
    }
    let previous = package::list(root)?;
    let (proposed, installed) = package::planned_index(&previous, next.clone())?;
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
        committed_index: None,
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
        let validation = snapshot.join("validation");
        fs::create_dir(&validation)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&validation, fs::Permissions::from_mode(0o700))?;
        }
        // Copy all declared state, including SQLite companions. Legacy
        // deferRecovery may migrate this private DB but cannot publish/recover.
        for saved in &upgrade.files {
            if saved.content.is_some() {
                snapshot_file(
                    &snapshot.join("state").join(&saved.name),
                    &validation.join(&saved.name),
                )?;
            }
        }
        for name in &next.manifest.initial_data_files {
            let destination = validation.join(name);
            let source = root
                .parent()
                .ok_or_else(|| invalid("Plugin profile has no parent"))?
                .join(name);
            if !destination.exists() && source.exists() {
                snapshot_file(&source, &destination)?;
            }
        }
        backend::preflight_candidate(&next, validation, fence)?;
        // Persist the irrevocable decision before exposing the new index.
        // Recovery completes publication if the host dies between the two.
        upgrade.phase = Phase::Committed;
        upgrade.committed_index = Some(proposed.clone());
        write_marker(&snapshot, &upgrade)?;
        {
            let _gate = super::LIFECYCLE
                .write()
                .map_err(|_| invalid("Plugin lifecycle lock is unavailable"))?;
            package::write_index(root, &proposed)?;
        }
        upgrade.phase = Phase::Published;
        write_marker(&snapshot, &upgrade)?;
        // External journal reconciliation may collect publication proof. It is
        // safe only after the durable commit forbids database rollback.
        // The caller activates after releasing the lifecycle/startup gates.
        Ok(installed)
    })();
    match result {
        Ok(installed) => {
            cleanup(&snapshot);
            Ok(installed)
        }
        Err(cause) => {
            if matches!(upgrade.phase, Phase::Committed | Phase::Published) {
                // The marker replacement/flush may have succeeded. Retain its
                // decision and close admission until forward recovery settles.
                fence.retain_for_recovery();
                return Err(invalid(format!("Plugin commit requires recovery: {cause}")));
            }
            backend::retire(&next.manifest.id);
            if snapshot.join("upgrade.json").exists() {
                if let Err(restore_error) = restore(root, &snapshot, &mut upgrade) {
                    fence.retain_for_recovery();
                    return Err(invalid(format!("Plugin upgrade failed ({cause}); rollback requires recovery: {restore_error}")));
                }
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
            committed_index: None,
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
        for phase in [Phase::Committed, Phase::Published, Phase::RolledBack] {
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
    fn installed_fixture() -> package::Installed {
        let target_suffix = match std::env::consts::OS {
            "linux" => "unknown-linux-gnu",
            "macos" => "apple-darwin",
            "windows" => "pc-windows-msvc",
            other => other,
        };
        let target = format!("{}-{target_suffix}", std::env::consts::ARCH);
        let payload = serde_json::json!({"size": 1, "sha256": "a".repeat(64)});
        serde_json::from_value(serde_json::json!({
            "enabled": true, "digest": "b".repeat(64), "manifest": {
            "formatVersion": 1, "id": "example.plugin", "name": "fixture",
            "description": "fixture", "version": "2.0.0", "sdkVersion": 3,
            "svelteVersion": "5.56.3", "target": target, "frontend": "index.js",
            "styles": "index.css", "backend": "worker", "contributions": ["example"],
            "files": {"index.js": payload, "index.css": payload, "worker": payload}
            }
        }))
        .unwrap()
    }
    #[test]
    fn committed_decision_finishes_index_publication_without_rolling_back_current_state() {
        let (_profile, root, data, mut upgrade) = fixture(Phase::Committed);
        let installed = installed_fixture();
        upgrade.committed_index = Some(vec![installed.clone()]);
        package::write_index(&root, &[]).unwrap();
        write_marker(&root.join("upgrade-pending"), &upgrade).unwrap();
        // Process died after committing, before publishing the index. A
        // collected/missing old-state backup is irrelevant to forward recovery.
        recover(&root).unwrap();
        recover(&root).unwrap();
        let actual = package::list(&root).unwrap();
        assert_eq!(actual.len(), 1);
        assert_eq!(actual[0].digest, installed.digest);
        assert_eq!(actual[0].manifest.version, "2.0.0");
        assert_eq!(
            fs::read(data.join("history.sqlite")).unwrap(),
            b"current history"
        );
        assert!(!root.join("upgrade-pending").exists());
    }

    #[test]
    fn an_uncleaned_published_snapshot_cannot_resurrect_a_later_disabled_or_removed_package() {
        for removed in [false, true] {
            let (_profile, root, data, mut upgrade) = fixture(Phase::Published);
            let installed = installed_fixture();
            upgrade.committed_index = Some(vec![installed.clone()]);
            write_marker(&root.join("upgrade-pending"), &upgrade).unwrap();
            let mut disabled = installed.clone();
            disabled.enabled = false;
            let current = if removed { vec![] } else { vec![disabled] };
            package::write_index(&root, &current).unwrap();
            // A previous cleanup failed; another successful mutation followed.
            recover(&root).unwrap();
            let actual = package::list(&root).unwrap();
            assert_eq!(actual.len(), usize::from(!removed));
            if !removed {
                assert!(!actual[0].enabled);
            }
            assert_eq!(
                fs::read(data.join("history.sqlite")).unwrap(),
                b"current history"
            );
        }
    }

    #[test]
    fn a_valid_large_dual_index_journal_is_readable_through_forward_recovery() {
        let (_profile, root, data, mut upgrade) = fixture(Phase::Committed);
        let mut previous = Vec::new();
        for i in 0..64 {
            let mut entry = installed_fixture();
            if i != 0 {
                entry.manifest.id = format!("example.package{i}");
            }
            entry.manifest.name = "N".repeat(200);
            entry.manifest.description = "D".repeat(2000);
            entry.manifest.version = "1.0.0".into();
            entry.manifest.contributions = (0..16)
                .map(|j| format!("p{i}.c{j}.{}", "a".repeat(85)))
                .collect();
            entry.manifest.state_files = (0..16)
                .map(|j| format!("s{j}.{}", "a".repeat(170)))
                .collect();
            entry.manifest.initial_data_files = (0..16)
                .map(|j| format!("i{j}.{}", "b".repeat(170)))
                .collect();
            entry.manifest.validate().unwrap();
            previous.push(entry);
        }
        let mut committed = previous.clone();
        committed[0].manifest.version = "2.0.0".into();
        package::write_index(&root, &previous).unwrap();
        upgrade.previous = previous;
        upgrade.committed_index = Some(committed);
        let snapshot = root.join("upgrade-pending");
        write_marker(&snapshot, &upgrade).unwrap();
        assert!(fs::metadata(snapshot.join("upgrade.json")).unwrap().len() > 1024 * 1024);
        recover(&root).unwrap();
        let actual = package::list(&root).unwrap();
        assert_eq!(actual.len(), 64);
        assert_eq!(actual[0].manifest.version, "2.0.0");
        assert!(actual
            .iter()
            .skip(1)
            .all(|entry| entry.manifest.version == "1.0.0"));
        assert_eq!(
            fs::read(data.join("history.sqlite")).unwrap(),
            b"current history"
        );
    }

    #[test]
    fn malformed_committed_index_is_rejected_before_changing_the_healthy_index() {
        for duplicate in [false, true] {
            let (_profile, root, data, mut upgrade) = fixture(Phase::Committed);
            let healthy = installed_fixture();
            package::write_index(&root, std::slice::from_ref(&healthy)).unwrap();
            let original = fs::read(root.join("installed.json")).unwrap();
            let mut malformed = healthy.clone();
            if duplicate {
                upgrade.committed_index = Some(vec![malformed.clone(), malformed]);
            } else {
                malformed.digest = "not-a-sha".into();
                upgrade.committed_index = Some(vec![malformed]);
            }
            write_marker(&root.join("upgrade-pending"), &upgrade).unwrap();
            assert!(recover(&root).is_err());
            assert_eq!(fs::read(root.join("installed.json")).unwrap(), original);
            assert_eq!(
                fs::read(data.join("history.sqlite")).unwrap(),
                b"current history"
            );
            assert!(root.join("upgrade-pending/upgrade.json").exists());
        }
    }

    #[test]
    fn duplicate_restore_targets_cannot_restore_then_delete_original_history() {
        let (_profile, root, data, mut upgrade) = fixture(Phase::Prepared);
        let snapshot = root.join("upgrade-pending");
        fs::write(snapshot.join("state/history.sqlite"), b"old history!").unwrap();
        upgrade.files.push(SavedFile {
            name: "history.sqlite".into(),
            content: None,
        });
        write_marker(&snapshot, &upgrade).unwrap();
        assert!(recover(&root).is_err());
        assert_eq!(
            fs::read(data.join("history.sqlite")).unwrap(),
            b"current history"
        );
        assert!(snapshot.join("upgrade.json").exists());
    }

    #[test]
    fn a_commit_journal_cannot_replace_an_unrelated_package() {
        let (_profile, root, _data, mut upgrade) = fixture(Phase::Committed);
        let next = installed_fixture();
        let mut other = next.clone();
        other.manifest.id = "example.unrelated".into();
        other.manifest.contributions = vec!["unrelated".into()];
        upgrade.previous = vec![other.clone()];
        let mut altered = other.clone();
        altered.enabled = false;
        upgrade.committed_index = Some(vec![next, altered]);
        package::write_index(&root, &[other]).unwrap();
        let original = fs::read(root.join("installed.json")).unwrap();
        write_marker(&root.join("upgrade-pending"), &upgrade).unwrap();
        assert!(recover(&root).is_err());
        assert_eq!(fs::read(root.join("installed.json")).unwrap(), original);
        assert!(root.join("upgrade-pending/upgrade.json").exists());
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
