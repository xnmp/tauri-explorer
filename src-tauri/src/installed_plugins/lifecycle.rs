//! Recoverable package upgrade: quiesce publishers, snapshot declared state, then activate.
//! Explicit lifecycle intent is independent of AI phase: retire publishers,
//! then preserve compatible custody or finish removal from a durable journal.
use super::{backend, package, service_graph};
use crate::{error::AppError, service_state::Store};
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
#[cfg(test)]
thread_local! {
    static CRASH_BOUNDARY: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(super) fn crash_at_boundary(name: &'static str) {
    CRASH_BOUNDARY.with(|boundary| boundary.set(Some(name)));
}
fn checkpoint(name: &str) -> Result<(), AppError> {
    #[cfg(test)]
    if CRASH_BOUNDARY.with(|boundary| {
        if boundary.get() == Some(name) {
            boundary.set(None);
            true
        } else {
            false
        }
    }) {
        return Err(invalid("injected lifecycle crash"));
    }
    let _ = name;
    Ok(())
}
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
    #[cfg(test)]
    let oracle = test_fs_at(target);
    #[cfg(test)]
    if let Some(oracle) = &oracle {
        oracle.before_mutation(target);
    }
    let content = copy_state(source, &mut options.open(target)?)?;
    #[cfg(test)]
    if let Some(oracle) = &oracle {
        oracle.file_synced(target);
    }
    Ok(content)
}
#[cfg(test)]
pub(super) fn test_fs_at(
    path: &Path,
) -> Option<std::sync::Arc<crate::service_state::test_fs::TestFs>> {
    let root = path
        .ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "installed-plugins"))?;
    let service = dunce::canonicalize(root.parent()?.join("service-state")).ok()?;
    Some(crate::service_state::test_fs::for_root(&service))
}
fn sync_directory(path: &Path) -> Result<(), AppError> {
    #[cfg(test)]
    if let Some(oracle) = test_fs_at(path) {
        oracle.sync_lifecycle(path)?;
        return Ok(());
    }
    crate::durable_dir::sync(path)?;
    Ok(())
}
fn write_marker(snapshot: &Path, upgrade: &Upgrade) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(upgrade).map_err(|cause| invalid(cause.to_string()))?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err(invalid("Plugin upgrade journal exceeds size limit"));
    }
    let mut stage = tempfile::NamedTempFile::new_in(snapshot)?;
    #[cfg(test)]
    let oracle = test_fs_at(snapshot);
    #[cfg(test)]
    if let Some(oracle) = &oracle {
        oracle.created(stage.path());
    }
    stage.write_all(&bytes)?;
    stage.flush()?;
    stage.as_file().sync_all()?;
    #[cfg(test)]
    if let Some(oracle) = &oracle {
        oracle.file_synced(stage.path());
        oracle.before_rename(stage.path(), &snapshot.join("upgrade.json"));
    }
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
        let candidate = index
            .iter()
            .find(|p| p.manifest.id == upgrade.package_id)
            .ok_or_else(|| invalid("Plugin replacement journal is missing its package"))?;
        let disabled = service_graph::replacement_dependents(&upgrade.previous, candidate);
        for entry in before {
            let other = after
                .iter()
                .find(|other| other.manifest.id == entry.manifest.id)
                .ok_or_else(|| invalid("Plugin upgrade journal changes unrelated packages"))?;
            let mut expected = entry.clone();
            if disabled.contains(&entry.manifest.id) {
                expected.enabled = false;
            }
            if serde_json::to_value(&expected).map_err(|cause| invalid(cause.to_string()))?
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
    recover_consumer_removals(root)?;
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
                service_graph::validate_enabled(index)?;
                package::write_index(root, index)?;
                upgrade.phase = Phase::Published;
                write_marker(&snapshot, &upgrade)?;
            }
        }
        if matches!(upgrade.phase, Phase::Committed | Phase::Published) {
            if let Some(candidate) = upgrade
                .committed_index
                .as_ref()
                .and_then(|index| index.iter().find(|p| p.manifest.id == upgrade.package_id))
            {
                let store = Store::open(
                    root.parent()
                        .ok_or_else(|| invalid("Plugin profile is unavailable"))?
                        .join("service-state"),
                    crate::service_state::model::Limits::default(),
                )?;
                reconcile_replacement(
                    &store,
                    candidate,
                    upgrade
                        .previous
                        .iter()
                        .find(|p| p.manifest.id == upgrade.package_id)
                        .map(|p| &p.manifest),
                )?;
                for id in service_graph::replacement_dependents(&upgrade.previous, candidate) {
                    super::service_bridge::signal_removal_cancellations(&store, &id, |_| false)?;
                    report_consumer_removal(&store, &id)?;
                    backend::release_recovered_fence(&id)?;
                }
            }
        }
        cleanup(&snapshot);
        backend::release_recovered_fence(&upgrade.package_id)?;
        Ok(())
    }
}
/// One profile's durable package state: its installed index and the claim
/// ledger that every mutation consults. Production passes the host profile;
/// tests pass a private one with the same layout.
pub(super) struct Profile<'a> {
    /// `<profile>/installed-plugins`; its parent also holds `service-state`.
    pub root: &'a Path,
    pub store: &'a Store,
}
/// Validation-only startup of a candidate. Production uses the real broker.
pub(super) type Preflight<'a> =
    &'a dyn Fn(&package::Installed, PathBuf, &backend::DrainGuard) -> Result<(), AppError>;
/// The single lifecycle admission boundary: AI claims, jobs and calls never
/// veto a user's exit or repair. Fence new calls, then retire existing work.
pub(super) fn drain_idle(store: &Store, id: &str) -> Result<backend::DrainGuard, AppError> {
    let _guard = super::write_lifecycle()?;
    let drain = backend::begin_change(id)?;
    if let Err(cause) = store.retire_package_generations(id, drain.generation().as_ref()) {
        drain.retain_for_recovery();
        return Err(cause);
    }
    Ok(drain)
}
/// Install or upgrade from an archive. The caller activates after return,
/// once the mutation and lifecycle gates are released.
pub(super) fn upgrade(
    profile: &Profile,
    archive: &Path,
    preflight: Preflight,
) -> Result<package::Installed, AppError> {
    let _action = super::ai_operations::action_guard()?;
    let _mutation = super::mutation_lock()?;
    recover(profile.root)?;
    let candidate = package::prepare(profile.root, archive)?;
    let drain = drain_idle(profile.store, &candidate.manifest.id)?;
    // A broken or working AI participant cannot veto repair. A graceful
    // checkpoint is preferred; native retirement cancels remaining work.
    let _ = drain.quiesce();
    backend::retire(&candidate.manifest.id);
    // The package fence, not a global lock, owns snapshot/preflight/rollback.
    // Reader threads may need lifecycle admission while retirement joins them.
    install_with(profile.root, candidate, &drain, preflight)
}
pub(super) fn uninstall(profile: &Profile, id: &str) -> Result<(), AppError> {
    let _action = super::ai_operations::action_guard()?;
    let _mutation = super::mutation_lock()?;
    recover(profile.root)?;
    remove_or_disable(profile, id, true)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Removal {
    entries: Vec<package::Installed>,
    packages: Vec<String>,
}
fn write_removal(root: &Path, removal: &Removal) -> Result<(), AppError> {
    package::validate_index(&removal.entries)?;
    service_graph::validate_enabled(&removal.entries)?;
    let bytes = serde_json::to_vec(removal).map_err(|e| invalid(e.to_string()))?;
    if bytes.len() as u64 > MAX_JOURNAL {
        return Err(invalid("Plugin removal journal exceeds size limit"));
    }
    let mut stage = tempfile::NamedTempFile::new_in(root)?;
    stage.write_all(&bytes)?;
    crate::durable_dir::sync_file(stage.path())?;
    stage
        .persist(root.join("removal-pending.json"))
        .map_err(|e| AppError::from(e.error))?;
    crate::durable_dir::sync(root)?;
    Ok(())
}
fn finish_removal(root: &Path, store: &Store, removal: &Removal) -> Result<(), AppError> {
    package::validate_index(&removal.entries)?;
    service_graph::validate_enabled(&removal.entries)?;
    let mut drains = Vec::new();
    let result: Result<(), AppError> = (|| {
        // Repeat native retirement during both restart and same-session replay;
        // a failed earlier sweep may have left an admitted/live publisher.
        for id in &removal.packages {
            drains.push(drain_idle(store, id)?);
        }
        for id in &removal.packages {
            super::service_bridge::signal_removal_cancellations(store, id, |_| false)?;
        }
        for id in &removal.packages {
            backend::retire(id);
        }
        let _lifecycle = super::write_lifecycle()?;
        package::write_index(root, &removal.entries)?;
        checkpoint("removal-index")?;
        for id in &removal.packages {
            report_consumer_removal(store, id)?;
        }
        fs::remove_file(root.join("removal-pending.json"))?;
        crate::durable_dir::sync(root)?;
        Ok(())
    })();
    if result.is_err() {
        for drain in &drains {
            drain.retain_for_recovery();
        }
    }
    result
}
/// Journal the complete user decision before cancellation, index publication
/// or custody release. Restart always finishes it, even before index commit.
fn remove_or_disable(profile: &Profile, id: &str, uninstall: bool) -> Result<(), AppError> {
    let mut entries = package::list(profile.root)?;
    let ids = service_graph::removal_packages(&entries, id);
    for entry in &mut entries {
        if ids.contains(&entry.manifest.id) {
            entry.enabled = false;
        }
    }
    if uninstall {
        entries.retain(|entry| entry.manifest.id != id);
    }
    let removal = Removal {
        entries,
        packages: ids,
    };
    write_removal(profile.root, &removal)?;
    checkpoint("removal-intent")?;
    finish_removal(profile.root, profile.store, &removal)
}
fn reconcile_replacement(
    store: &Store,
    candidate: &package::Installed,
    previous: Option<&package::Manifest>,
) -> Result<(), AppError> {
    let compatible = previous.is_some_and(|old| {
        service_graph::replacement_preserves_contracts(old, &candidate.manifest)
    });
    super::service_bridge::signal_removal_cancellations(store, &candidate.manifest.id, |a| {
        super::ai_operations::replacement_recovers(&candidate.manifest, a)
    })?;
    super::ai_operations::reset_replacement_reconciliation(store, &candidate.manifest.id)?;
    for job in store.abandon_package_work_deferred(
        &candidate.manifest.id,
        |a| super::ai_operations::replacement_recovers(&candidate.manifest, a),
        |owner, _| {
            (compatible && owner.package_id == candidate.manifest.id)
                .then(|| candidate.digest.clone())
        },
    )? {
        backend::release_job(&job.owner, job.job_id);
        backend::emit_job_event(serde_json::json!({"type":"updated","job":job}));
    }
    checkpoint("replacement-abandoned")?;
    store.gc()?;
    store.sweep_host_spools(|_| true)?;
    if !compatible {
        // A package may have successful custody-less replies without a single
        // admission. Incompatible replacement always collects that custody;
        // only independently compatible admitted originals are exempt.
        store.release_unretained_package_spools(&candidate.manifest.id)?;
    }
    Ok(())
}
fn report_consumer_removal(store: &Store, id: &str) -> Result<(), AppError> {
    for job in store.abandon_package_operations_deferred(id, |_| false)? {
        backend::release_job(&job.owner, job.job_id);
        backend::emit_job_event(serde_json::json!({"type":"updated","job":job}));
    }
    checkpoint("removal-abandoned")?;
    store.gc()?;
    store.sweep_host_spools(|_| true)?;
    store.release_package_spools(id)?;
    checkpoint("removal-cleanup")?;
    store.finish_consumer_removal(id)?;
    Ok(())
}
fn recover_consumer_removals(root: &Path) -> Result<(), AppError> {
    let ledger = root
        .parent()
        .ok_or_else(|| invalid("Plugin profile is unavailable"))?
        .join("service-state");
    if !ledger.exists() {
        return Ok(());
    }
    let store = Store::open(ledger, crate::service_state::model::Limits::default())?;
    let journal = root.join("removal-pending.json");
    if journal.exists() {
        let removal: Removal = serde_json::from_reader(open_regular(&journal, MAX_JOURNAL)?)
            .map_err(|e| invalid(e.to_string()))?;
        finish_removal(root, &store, &removal)?;
        for id in &removal.packages {
            backend::release_recovered_fence(id)?;
        }
    }
    let entries = package::list(root)?;
    for id in store.pending_consumer_removals()? {
        if entries.iter().any(|p| p.manifest.id == id && p.enabled) {
            // Crash before the package-index commit: there was no removal.
            store.finish_consumer_removal(&id)?;
        } else {
            report_consumer_removal(&store, &id)?;
        }
    }
    Ok(())
}
pub(super) fn set_enabled(profile: &Profile, id: &str, enabled: bool) -> Result<(), AppError> {
    let _action = super::ai_operations::action_guard()?;
    let _mutation = super::mutation_lock()?;
    recover(profile.root)?;
    let _guard = super::read_lifecycle()?;
    let mut entries = package::list(profile.root)?;
    let current = entries
        .iter()
        .find(|p| p.manifest.id == id)
        .ok_or_else(|| invalid("Plugin package is not installed"))?;
    if enabled && current.enabled {
        return Ok(());
    }
    if !enabled {
        drop(_guard);
        return remove_or_disable(profile, id, false);
    }
    drop(_guard);
    let _guard = super::write_lifecycle()?;
    entries
        .iter_mut()
        .find(|p| p.manifest.id == id)
        .unwrap()
        .enabled = true;
    service_graph::validate_enabled(&entries)?;
    package::write_index(profile.root, &entries)
}

/// The broker-preflight entry used by the native candidate fixture.
#[cfg(all(test, target_os = "linux"))]
pub(super) fn install(
    root: &Path,
    next: package::Installed,
    fence: &backend::DrainGuard,
) -> Result<package::Installed, AppError> {
    install_with(root, next, fence, &backend::preflight_candidate)
}
fn install_with(
    root: &Path,
    next: package::Installed,
    fence: &backend::DrainGuard,
    preflight: Preflight,
) -> Result<package::Installed, AppError> {
    recover(root)?;
    let store = Store::open(
        root.parent()
            .ok_or_else(|| invalid("Plugin profile is unavailable"))?
            .join("service-state"),
        crate::service_state::model::Limits::default(),
    )?;
    let previous = package::list(root)?;
    let disabled = service_graph::replacement_dependents(&previous, &next);
    let mut compatible_index = previous.clone();
    for p in &mut compatible_index {
        if disabled.contains(&p.manifest.id) {
            p.enabled = false;
        }
    }
    let (proposed, installed) = package::planned_index(&compatible_index, next.clone())?;
    let dependent_drains = disabled
        .iter()
        .map(|id| drain_idle(&store, id))
        .collect::<Result<Vec<_>, _>>()?;
    for id in &disabled {
        backend::retire(id);
    }
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
    let result: Result<package::Installed, AppError> = (|| {
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
        checkpoint("upgrade-prepared")?;
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
        preflight(&next, validation, fence)?;
        // Persist the irrevocable decision before exposing the new index.
        // Recovery completes publication if the host dies between the two.
        upgrade.phase = Phase::Committed;
        upgrade.committed_index = Some(proposed.clone());
        write_marker(&snapshot, &upgrade)?;
        checkpoint("upgrade-committed")?;
        {
            let _gate = super::LIFECYCLE
                .write()
                .map_err(|_| invalid("Plugin lifecycle lock is unavailable"))?;
            package::write_index(root, &proposed)?;
        }
        upgrade.phase = Phase::Published;
        write_marker(&snapshot, &upgrade)?;
        checkpoint("upgrade-published")?;
        reconcile_replacement(
            &store,
            &installed,
            upgrade
                .previous
                .iter()
                .find(|p| p.manifest.id == upgrade.package_id)
                .map(|p| &p.manifest),
        )?;
        for id in &disabled {
            super::service_bridge::signal_removal_cancellations(&store, id, |_| false)?;
            report_consumer_removal(&store, id)?;
        }
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
            #[cfg(test)]
            if cause.to_string().contains("injected lifecycle crash") {
                fence.retain_for_recovery();
                for drain in &dependent_drains {
                    drain.retain_for_recovery();
                }
                return Err(cause);
            }
            if matches!(upgrade.phase, Phase::Committed | Phase::Published) {
                // The marker replacement/flush may have succeeded. Retain its
                // decision and close admission until forward recovery settles.
                fence.retain_for_recovery();
                for drain in &dependent_drains {
                    drain.retain_for_recovery();
                }
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
#[path = "mutation_matrix_tests.rs"]
mod mutation_matrix_tests;
#[cfg(all(test, target_os = "linux"))]
#[path = "mutation_native_tests.rs"]
pub(super) mod mutation_native_tests;
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
