//! Read-only payload discard refusal, restrictive umask cleanup, and
//! rootless-move forgetting.
use super::fixtures::*;
use super::*;

pub(super) fn set_mode(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// Root bypasses directory write permission, so the refusal is unobservable.
pub(super) fn running_as_root() -> bool {
    // SAFETY: geteuid has no preconditions and does not mutate memory.
    unsafe { libc::geteuid() == 0 }
}

/// A moved tree whose `pkg` subdirectory is read-only, as a Go module cache or
/// read-only checkout is. Returns the fixture and its parked payload.
fn read_only_payload(read_only: bool) -> (Fixture, PathBuf) {
    let f = Fixture::build(true, false, true, |source| {
        fs::create_dir_all(source.join("pkg")).unwrap();
        fs::write(source.join("pkg/a"), MOVED).unwrap();
        fs::write(source.join("pkg/b"), MOVED).unwrap();
        if read_only {
            set_mode(&source.join("pkg"), 0o555);
        }
    });
    let parked = f
        .roots
        .iter()
        .map(|root| root.join("parked"))
        .find(|path| path.exists())
        .expect("a cross-volume move parks its source");
    (f, parked)
}

fn release_read_only(f: &Fixture, parked: &std::path::Path) {
    for path in [parked.join("pkg"), f.target.join("pkg")] {
        if path.exists() {
            set_mode(&path, 0o755);
        }
    }
}

#[test]
fn read_only_payload_directory_refuses_discard_before_consuming_undo() {
    if running_as_root() {
        return;
    }
    let (f, parked) = read_only_payload(true);
    let error = f.retirement().retire_with(|_| Ok(())).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("Nothing was removed"), "{message}");
    assert!(message.contains("pkg"), "{message}");
    // Nothing was removed, the decision was not journaled, and Undo survives.
    assert_eq!(fs::read(parked.join("pkg/a")).unwrap(), MOVED);
    assert_eq!(fs::read(parked.join("pkg/b")).unwrap(), MOVED);
    assert_eq!(f.retirement().eligibility(), &Eligibility::Discardable);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(snapshot.items[0].actions.contains(&RecoveryChoice::Restore));
    let refused = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(refused.error.is_some());
    assert_eq!(fs::read(parked.join("pkg/a")).unwrap(), MOVED);
    // The user's permission fix, never ours, makes the same Discard succeed.
    set_mode(&parked.join("pkg"), 0o755);
    f.retirement().retire_with(|_| Ok(())).unwrap();
    f.assert_retired();
    assert_eq!(fs::read(f.target.join("pkg/a")).unwrap(), MOVED);
    release_read_only(&f, &parked);
}

#[test]
fn read_only_payload_refusal_leaves_restoration_available() {
    if running_as_root() {
        return;
    }
    let (f, parked) = read_only_payload(true);
    assert!(f.retirement().retire_with(|_| Ok(())).is_err());
    f.restore();
    assert_eq!(fs::read(f.source.join("pkg/a")).unwrap(), MOVED);
    set_mode(&f.source.join("pkg"), 0o755);
    release_read_only(&f, &parked);
}

#[test]
fn persistent_failure_after_discard_intent_is_reported_for_attention_and_retryable() {
    let (f, parked) = read_only_payload(false);
    let pkg = parked.join("pkg");
    let result = f.retirement().retire_with(|label| {
        if label == "intent" {
            // Changed after the preflight: the committed cleanup must stop.
            set_mode(&pkg, 0o555);
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(pkg.join("a")).unwrap(), MOVED);
    // While the committed plan cannot be proven, only forgetting is offered.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert_eq!(item.status, "attention", "{}", item.message);
    assert!(item.message.contains("Discard stopped"), "{}", item.message);
    assert_eq!(item.actions, vec![RecoveryChoice::Release]);
    // Once the user restores it, the failure is still called out, with a retry.
    set_mode(&pkg, 0o755);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert_eq!(item.status, "attention", "{}", item.message);
    assert!(item.message.contains("Discard stopped"), "{}", item.message);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Discard, RecoveryChoice::Release]
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
    assert_eq!(fs::read(f.target.join("pkg/a")).unwrap(), MOVED);
}

pub(super) fn tree(path: &std::path::Path) -> Vec<(PathBuf, Option<Vec<u8>>, u32)> {
    use std::os::unix::fs::PermissionsExt;
    let mut entries = vec![];
    let mut pending = vec![path.to_owned()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).unwrap();
        let bytes = if metadata.is_dir() {
            pending.extend(fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
            None
        } else {
            Some(fs::read(&path).unwrap())
        };
        entries.push((path, bytes, metadata.permissions().mode()));
    }
    entries.sort();
    entries
}

#[test]
fn rootless_move_can_be_forgotten_after_user_edits_without_deleting_anything() {
    for directory in [false, true] {
        for edit in ["content", "mode", "source-reused"] {
            let f = Fixture::new(false, false, directory);
            assert!(f.roots.is_empty(), "a same-volume rename retains nothing");
            match (edit, directory) {
                ("content", false) => fs::write(&f.target, b"user edit").unwrap(),
                ("content", true) => fs::write(f.target.join("added"), b"user").unwrap(),
                ("mode", _) => set_mode(&f.target, 0o700),
                ("source-reused", _) => fs::write(&f.source, b"new source").unwrap(),
                _ => unreachable!(),
            }
            let target_before = tree(&f.target);
            let source_before = f.source.exists().then(|| tree(&f.source));
            let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
            let item = &snapshot.items[0];
            assert!(
                item.actions.contains(&RecoveryChoice::Discard),
                "{edit}: {}",
                item.message
            );
            let reply = service::resolve(
                &f.coordinator,
                &f.id,
                item.generation,
                RecoveryChoice::Discard,
            )
            .unwrap();
            assert!(reply.error.is_none(), "{edit}: {:?}", reply.error);
            assert!(f.coordinator.inventory().unwrap().entries.is_empty());
            assert_eq!(tree(&f.target), target_before, "{edit}");
            assert_eq!(f.source.exists().then(|| tree(&f.source)), source_before);
        }
    }
}

#[test]
fn restored_rootless_move_is_reclaimed_after_the_restored_entry_is_edited() {
    let f = Fixture::new(false, false, false);
    f.restore();
    fs::write(&f.source, b"edited after undo").unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 0);
    assert_eq!(fs::read(&f.source).unwrap(), b"edited after undo");
    assert!(!f.target.exists());
}

/// Runs one real move and its discard after the parent prepared every fixture
/// directory, so only recovery-owned creation sees the restrictive umask.
#[test]
#[ignore = "spawned by the restrictive umask test"]
fn subprocess_restrictive_umask() {
    let Ok(base) = std::env::var("EXPLORER_MOVE_UMASK_BASE") else {
        return;
    };
    let base = PathBuf::from(base);
    let shared = PathBuf::from(std::env::var("EXPLORER_MOVE_UMASK_SHARED").unwrap());
    let run =
        |coordinator: &Arc<Coordinator>, source: &std::path::Path, target: &std::path::Path| {
            let mut progress =
                crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
            PreparedMove::prepare(coordinator, source, target)
                .unwrap()
                .execute(&mut progress)
                .unwrap();
            let entry = coordinator.inventory().unwrap().entries.remove(0);
            let snapshot = service::inspect(coordinator, &entry.intent.id).unwrap();
            let reply = service::resolve(
                coordinator,
                &entry.intent.id,
                snapshot.items[0].generation,
                RecoveryChoice::Discard,
            )
            .unwrap();
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert!(coordinator.inventory().unwrap().entries.is_empty());
        };
    // Existing storage first: probes, move roots, manifests and copies are
    // created on the user volumes while the umask removes owner access.
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    // SAFETY: umask only replaces this child's creation mask.
    unsafe { libc::umask(0o277) };
    run(&coordinator, &shared.join("source"), &base.join("target"));
    run(
        &coordinator,
        &base.join("renamed"),
        &base.join("rename-target"),
    );
    // New recovery storage is itself created under the same mask.
    let fresh = Coordinator::open(&base.join("fresh-recovery")).unwrap();
    run(&fresh, &shared.join("second"), &base.join("second-target"));
}

#[test]
fn restrictive_umask_cannot_break_probes_roots_or_retirement() {
    use std::process::Command;
    let base = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir_in("/dev/shm").unwrap();
    let base_path = fs::canonicalize(base.path()).unwrap();
    let shared_path = fs::canonicalize(shared.path()).unwrap();
    fs::create_dir(shared_path.join("source")).unwrap();
    fs::write(shared_path.join("source/entry"), MOVED).unwrap();
    fs::write(base_path.join("target"), OLD).unwrap();
    fs::write(base_path.join("renamed"), MOVED).unwrap();
    fs::write(shared_path.join("second"), MOVED).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::recovery::move_retirement::tests::readonly_umask::subprocess_restrictive_umask",
            "--ignored",
            "--nocapture",
        ])
        .env("EXPLORER_MOVE_UMASK_BASE", &base_path)
        .env("EXPLORER_MOVE_UMASK_SHARED", &shared_path)
        .status()
        .unwrap();
    assert!(status.success(), "restrictive umask move failed: {status}");
    assert_eq!(fs::read(base_path.join("target/entry")).unwrap(), MOVED);
    assert_eq!(fs::read(base_path.join("rename-target")).unwrap(), MOVED);
    assert_eq!(fs::read(base_path.join("second-target")).unwrap(), MOVED);
    for parent in [&base_path, &shared_path] {
        let residue: Vec<_> = fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| {
                name.to_string_lossy()
                    .starts_with(".tauri-explorer-recovery-")
            })
            .collect();
        assert!(residue.is_empty(), "{residue:?}");
    }
}
