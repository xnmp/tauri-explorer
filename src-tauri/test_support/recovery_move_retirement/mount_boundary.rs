//! Mount-boundary refusals: unmounted endpoints, bind mounts on one device,
//! payloads/mount points crossed by a move, and mounts inside retained
//! payloads (#760, PR #790 review N1).
use super::fixtures::*;
use super::planning_budget::{effect_revision, private_residue};
use super::undo::history_undo;
use super::*;

/// Run explicitly inside a new private mount namespace. The backing mount stays
/// reachable to the test so it can verify payloads while the public mount is gone.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn unmounted_endpoint_preserves_both_roots_until_same_volume_returns() {
    use std::{os::unix::fs::MetadataExt, process::Command};
    let parent_namespace = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent_namespace
    );
    let run = |program: &str, args: &[&std::ffi::OsStr]| {
        assert!(
            Command::new(program).args(args).status().unwrap().success(),
            "{program}"
        );
    };
    for source_on_mount in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let backing = base.path().join("backing");
        let visible = base.path().join("visible");
        fs::create_dir(&backing).unwrap();
        fs::create_dir(&visible).unwrap();
        run(
            "mount",
            &[
                "-t".as_ref(),
                "tmpfs".as_ref(),
                "tmpfs".as_ref(),
                backing.as_os_str(),
            ],
        );
        run(
            "mount",
            &["--bind".as_ref(), backing.as_os_str(), visible.as_os_str()],
        );
        assert_ne!(
            fs::metadata(&visible).unwrap().dev(),
            fs::metadata(base.path()).unwrap().dev()
        );
        let source = if source_on_mount {
            visible.join("source")
        } else {
            base.path().join("source")
        };
        let target = if source_on_mount {
            base.path().join("target")
        } else {
            visible.join("target")
        };
        fs::write(&source, MOVED).unwrap();
        fs::write(&target, OLD).unwrap();
        let coordinator = Coordinator::open(&base.path().join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        PreparedMove::prepare(&coordinator, &source, &target)
            .unwrap()
            .execute(&mut progress)
            .unwrap();
        let entry = coordinator.inventory().unwrap().entries.remove(0);
        let roots: Vec<_> = entry
            .intent
            .operation
            .move_spec()
            .unwrap()
            .roots()
            .map(|p| p.path.0.clone())
            .collect();
        assert_eq!(roots.len(), 2);
        let actual_path = |path: &std::path::Path| match path.strip_prefix(&visible) {
            Ok(relative) => backing.join(relative),
            Err(_) => path.to_owned(),
        };
        run("umount", &[visible.as_os_str()]);
        assert!(fs::read_dir(&visible).unwrap().next().is_none());
        let snapshot = service::inspect(&coordinator, &entry.intent.id).unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.items[0].actions.is_empty());
        let refused = service::resolve(
            &coordinator,
            &entry.intent.id,
            snapshot.items[0].generation,
            RecoveryChoice::Discard,
        )
        .unwrap();
        assert!(refused.error.is_some());
        assert_eq!(retirement::enforce(&coordinator).unwrap().records, 1);
        assert_eq!(
            fs::read(actual_path(&roots[0]).join("parked")).unwrap(),
            MOVED
        );
        assert_eq!(
            fs::read(actual_path(&roots[1]).join("original")).unwrap(),
            OLD
        );
        assert_eq!(fs::read(actual_path(&target)).unwrap(), MOVED);
        assert!(!actual_path(&source).exists());
        run(
            "mount",
            &["--bind".as_ref(), backing.as_os_str(), visible.as_os_str()],
        );
        let snapshot = service::inspect(&coordinator, &entry.intent.id).unwrap();
        assert!(snapshot.items[0].actions.contains(&RecoveryChoice::Discard));
        let result = service::resolve(
            &coordinator,
            &entry.intent.id,
            snapshot.items[0].generation,
            RecoveryChoice::Discard,
        )
        .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.items.is_empty());
        assert!(roots.iter().all(|root| !root.exists()));
        assert_eq!(fs::read(&target).unwrap(), MOVED);
        assert!(!source.exists());
        run("umount", &[visible.as_os_str()]);
        run("umount", &[backing.as_os_str()]);
    }
}

/// Two bind mounts of one filesystem share st_dev, yet rename(2) between them
/// fails with EXDEV. Requires the isolated namespace documented for
/// `unmounted_endpoint_preserves_both_roots_until_same_volume_returns`.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn bind_mounted_endpoints_on_one_device_are_refused_before_any_record() {
    use std::{os::unix::fs::MetadataExt, process::Command};
    let parent_namespace = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent_namespace
    );
    for overwrite in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        let (left, right) = (base_path.join("left"), base_path.join("right"));
        fs::create_dir(&left).unwrap();
        fs::create_dir(&right).unwrap();
        let alias = base_path.join("alias");
        fs::create_dir(&alias).unwrap();
        assert!(Command::new("mount")
            .args(["--bind".as_ref(), right.as_os_str(), alias.as_os_str()])
            .status()
            .unwrap()
            .success());
        assert_eq!(
            fs::metadata(&left).unwrap().dev(),
            fs::metadata(&alias).unwrap().dev(),
            "a bind mount keeps its device"
        );
        let (source, target) = (left.join("source"), alias.join("target"));
        fs::write(&source, MOVED).unwrap();
        if overwrite {
            fs::write(&target, OLD).unwrap();
        }
        // The kernel refuses the plain rename the Rename strategy would use.
        let scratch = left.join("scratch");
        fs::write(&scratch, b"").unwrap();
        let exdev = fs::rename(&scratch, alias.join("scratch")).unwrap_err();
        assert_eq!(exdev.raw_os_error(), Some(libc::EXDEV));
        fs::remove_file(&scratch).unwrap();
        let coordinator = Coordinator::open(&base_path.join("recovery")).unwrap();
        let error = PreparedMove::prepare(&coordinator, &source, &target)
            .err()
            .expect("a bind-mounted destination was admitted")
            .to_string();
        assert!(error.contains("Nothing was moved"), "{error}");
        assert!(coordinator.inventory().unwrap().entries.is_empty());
        assert_eq!(fs::read(&source).unwrap(), MOVED);
        assert!(private_residue(&left).is_empty() && private_residue(&alias).is_empty());
        assert!(Command::new("umount")
            .arg(&alias)
            .status()
            .unwrap()
            .success());
    }
}

/// `mount`/`umount` inside the documented isolated namespace only (see
/// `unmounted_endpoint_preserves_both_roots_until_same_volume_returns`).
fn isolated_mount(program: &str, args: &[&std::ffi::OsStr]) {
    let parent_namespace = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent_namespace
    );
    assert!(
        std::process::Command::new(program)
            .args(args)
            .status()
            .unwrap()
            .success(),
        "{program} {args:?}"
    );
}

fn refused_move(
    source: &std::path::Path,
    target: &std::path::Path,
    base: &std::path::Path,
) -> String {
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let mut progress = crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
    let error = match PreparedMove::prepare(&coordinator, source, target)
        .and_then(|prepared| prepared.execute(&mut progress))
    {
        Ok(_) => panic!("the move was admitted"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("Nothing was moved"), "{error}");
    assert!(coordinator.inventory().unwrap().entries.is_empty());
    assert!(private_residue(source.parent().unwrap()).is_empty());
    assert!(private_residue(target.parent().unwrap()).is_empty());
    error
}

/// A payload with a submount inside it could be captured by admission's walk
/// and later never validated as a retirement plan. Requires the isolated
/// namespace documented in e2e-tauri/README.md.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn a_payload_that_crosses_into_another_mount_is_refused_before_any_record() {
    for overwrite_only in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in("/dev/shm").unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        // Cross volume: the source tree would be parked. Same volume with an
        // overwrite: the displaced destination tree would be retained.
        let (source, target) = if overwrite_only {
            (base_path.join("source"), base_path.join("target"))
        } else {
            let shared_path = fs::canonicalize(shared.path()).unwrap();
            (shared_path.join("source"), base_path.join("target"))
        };
        let tree = if overwrite_only { &target } else { &source };
        if overwrite_only {
            fs::write(&source, MOVED).unwrap();
        }
        fs::create_dir_all(tree.join("inner")).unwrap();
        fs::write(tree.join("entry"), OLD).unwrap();
        isolated_mount(
            "mount",
            &[
                "-t".as_ref(),
                "tmpfs".as_ref(),
                "tmpfs".as_ref(),
                tree.join("inner").as_os_str(),
            ],
        );
        fs::write(tree.join("inner/mounted"), OLD).unwrap();
        let error = refused_move(&source, &target, &base_path);
        assert!(error.contains("cannot cross mount point"), "{error}");
        assert_eq!(fs::read(tree.join("inner/mounted")).unwrap(), OLD);
        assert_eq!(fs::read(tree.join("entry")).unwrap(), OLD);
        isolated_mount("umount", &[tree.join("inner").as_os_str()]);
    }
}

/// rename(2) of a mount point is EBUSY; a bind mount point even keeps its
/// parent's device, so only its mount id reveals it.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn mount_point_endpoints_are_refused_before_any_record() {
    for destination in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        let (left, right, elsewhere) = (
            base_path.join("left"),
            base_path.join("right"),
            base_path.join("elsewhere"),
        );
        for directory in [&left, &right, &elsewhere] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(elsewhere.join("entry"), OLD).unwrap();
        let (source, target) = (left.join("source"), right.join("target"));
        let mounted = if destination { &target } else { &source };
        if destination {
            fs::write(&source, MOVED).unwrap();
        }
        fs::create_dir(mounted).unwrap();
        isolated_mount(
            "mount",
            &[
                "--bind".as_ref(),
                elsewhere.as_os_str(),
                mounted.as_os_str(),
            ],
        );
        let error = refused_move(&source, &target, &base_path);
        assert!(error.contains("is a mount point"), "{error}");
        assert_eq!(fs::read(mounted.join("entry")).unwrap(), OLD);
        if destination {
            assert_eq!(fs::read(&source).unwrap(), MOVED);
        } else {
            assert!(!target.exists());
        }
        isolated_mount("umount", &[mounted.as_os_str()]);
    }
}

// --- Mount boundaries inside retained payloads (#760, PR #790 review N1) ---

#[test]
fn cleanup_mount_identity_requires_matching_available_ids() {
    use crate::files::recovery::move_cleanup::mount_ids_match;
    assert!(mount_ids_match(Some(17), Some(17)));
    assert!(!mount_ids_match(Some(17), Some(23)));
    // A device match cannot prove containment when statx is unavailable:
    // same-device bind mounts are exactly the destructive case.
    assert!(!mount_ids_match(None, Some(23)));
    assert!(!mount_ids_match(Some(17), None));
    assert!(!mount_ids_match(None, None));
}

/// Discard the only record, as the File Recovery dialog would.
fn discard_only_record(coordinator: &Arc<Coordinator>) -> Option<String> {
    let id = coordinator.inventory().unwrap().entries[0]
        .intent
        .id
        .clone();
    let snapshot = service::inspect(coordinator, &id).unwrap();
    service::resolve(
        coordinator,
        &id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap()
    .error
}

fn device(path: &std::path::Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).unwrap().dev()
}

/// A bind mount of the payload's own filesystem keeps its device, so only its
/// mount id shows that a walk would leave the payload. Admission once walked
/// into it, and Discard then unlinked the bind source's files, outside the
/// payload, before the final rmdir failed with EBUSY. Requires the isolated
/// namespace documented in e2e-tauri/README.md.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn a_bind_mount_inside_a_payload_is_refused_before_any_record() {
    for overwrite_only in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in("/dev/shm").unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        let shared_path = fs::canonicalize(shared.path()).unwrap();
        // Cross volume: the source tree would be parked. Same volume with an
        // overwrite: the displaced destination tree would be retained. The
        // bind source always lives on the retained tree's own filesystem.
        let home = if overwrite_only {
            &base_path
        } else {
            &shared_path
        };
        let data = home.join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("precious"), OLD).unwrap();
        let (source, target) = (home.join("source"), base_path.join("target"));
        let tree = if overwrite_only { &target } else { &source };
        if overwrite_only {
            fs::write(&source, MOVED).unwrap();
        }
        fs::create_dir_all(tree.join("inner")).unwrap();
        fs::write(tree.join("entry"), OLD).unwrap();
        let inner = tree.join("inner");
        isolated_mount(
            "mount",
            &["--bind".as_ref(), data.as_os_str(), inner.as_os_str()],
        );
        assert_eq!(
            device(&inner),
            device(tree),
            "a bind mount keeps its device"
        );
        let coordinator = Coordinator::open(&base_path.join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        match PreparedMove::prepare(&coordinator, &source, &target)
            .and_then(|prepared| prepared.execute(&mut progress))
        {
            Ok(_) => {
                let discard = discard_only_record(&coordinator);
                panic!(
                    "overwrite_only={overwrite_only}: a payload holding a bind mount was \
                     admitted; after Discard ({discard:?}) the bind source still holds its \
                     file: {}",
                    data.join("precious").exists()
                );
            }
            Err(error) => {
                let error = error.to_string();
                assert!(error.contains("Nothing was moved"), "{error}");
                assert!(error.contains("'inner'"), "{error}");
                assert!(error.contains("mount point"), "{error}");
            }
        }
        assert!(coordinator.inventory().unwrap().entries.is_empty());
        assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
        assert_eq!(fs::read(inner.join("precious")).unwrap(), OLD);
        assert_eq!(fs::read(tree.join("entry")).unwrap(), OLD);
        assert!(private_residue(source.parent().unwrap()).is_empty());
        assert!(private_residue(target.parent().unwrap()).is_empty());
        isolated_mount("umount", &[inner.as_os_str()]);
    }
}

/// A cross-volume move whose destination is bind-mounted into after the move.
/// Undo would park the destination, bind mount and all, as `publication`.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn undo_refuses_a_destination_that_holds_a_bind_mount() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("inner")).unwrap();
        fs::write(source.join("entry"), MOVED).unwrap();
    });
    let data = f.target.parent().unwrap().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("precious"), OLD).unwrap();
    let inner = f.target.join("inner");
    isolated_mount(
        "mount",
        &["--bind".as_ref(), data.as_os_str(), inner.as_os_str()],
    );
    assert_eq!(device(&inner), device(&f.target));
    let revision = effect_revision(&f);
    match history_undo(&f, revision) {
        Ok(()) => {
            let discard = discard_only_record(&f.coordinator);
            panic!(
                "Undo parked a destination holding a bind mount; after Discard \
                 ({discard:?}) the bind source still holds its file: {}",
                data.join("precious").exists()
            );
        }
        Err(error) => {
            assert!(!matches!(error, AppError::MutationUncertain(_)), "{error}");
            let error = error.to_string();
            assert!(error.contains("Nothing was changed"), "{error}");
            assert!(error.contains("'inner'"), "{error}");
            assert!(error.contains("mount point"), "{error}");
            assert!(!error.contains("too large"), "{error}");
        }
    }
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
    assert_eq!(fs::read(inner.join("precious")).unwrap(), OLD);
    assert_eq!(fs::read(f.target.join("entry")).unwrap(), MOVED);
    assert!(!f.source.exists(), "the source stayed parked");
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
    // Unmounted, the same Undo succeeds.
    isolated_mount("umount", &[inner.as_os_str()]);
    history_undo(&f, revision).unwrap();
    assert_eq!(fs::read(f.source.join("entry")).unwrap(), MOVED);
    assert!(!f.target.exists());
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
}

/// A mount inside a payload already retained in a private root: at Discard,
/// planning must refuse it; once the decision is journaled, removal must stop
/// before deleting anything beneath it.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn discard_never_removes_files_through_a_mount_inside_a_retained_payload() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("inner")).unwrap();
        fs::write(source.join("inner/planned"), MOVED).unwrap();
    });
    let parked = f.roots[0].join("parked");
    let inner = parked.join("inner");
    // The bind source shares the parked payload's filesystem.
    let data = f.source.parent().unwrap().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("precious"), OLD).unwrap();
    isolated_mount(
        "mount",
        &["--bind".as_ref(), data.as_os_str(), inner.as_os_str()],
    );
    assert_eq!(device(&inner), device(&parked));
    let revision = effect_revision(&f);
    let refused = discard_only_record(&f.coordinator);
    let survived = data.join("precious").exists();
    isolated_mount("umount", &[inner.as_os_str()]);
    assert!(
        survived,
        "Discard deleted the bind source's file ({refused:?})"
    );
    let refused = refused.expect("a payload holding a mount was discarded");
    assert!(refused.contains("mount point"), "{refused}");
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
    assert_eq!(fs::read(inner.join("planned")).unwrap(), MOVED);
    assert!(
        f.coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .is_some(),
        "Discard consumed Undo although it removed nothing"
    );
    // A mount that appears after the decision, before this root's removal:
    // here the planned directory bound onto itself, so every recorded
    // identity still matches and only its mount shows the crossing.
    let result = f.retirement().retire_with(|label| {
        if label == "source-intent" {
            isolated_mount(
                "mount",
                &["--bind".as_ref(), inner.as_os_str(), inner.as_os_str()],
            );
        }
        Ok(())
    });
    let beneath = fs::read(inner.join("planned")).ok();
    isolated_mount("umount", &[inner.as_os_str()]);
    assert!(result.is_err(), "removal crossed a mount");
    assert_eq!(
        beneath.as_deref(),
        Some(MOVED),
        "removal deleted files beneath a mount point"
    );
    // Unmounted, the reported discard can be retried to completion.
    assert_eq!(discard_only_record(&f.coordinator), None);
    f.assert_retired();
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
}

/// A same-object bind mount over the payload root must not become the baseline
/// for a new cleanup walk. The retained parent is the immutable boundary.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn discard_refuses_relocated_payload_bound_over_its_recorded_root() {
    use crate::files::recovery::coordinator::HistoryPosition;
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/precious"), OLD).unwrap();
    });
    let parked = f.roots[0].join("parked");
    let outside = tempfile::tempdir_in(f.source.parent().unwrap()).unwrap();
    let relocated = outside.path().join("relocated");
    fs::rename(&parked, &relocated).unwrap();
    fs::create_dir(&parked).unwrap();
    isolated_mount(
        "mount",
        &["--bind".as_ref(), relocated.as_os_str(), parked.as_os_str()],
    );
    assert_eq!(
        fs::metadata(&parked).unwrap().ino(),
        fs::metadata(&relocated).unwrap().ino()
    );
    let revision = effect_revision(&f);
    let refused = discard_only_record(&f.coordinator);
    let survived = relocated.join("nested/precious").exists();
    isolated_mount("umount", &[parked.as_os_str()]);
    assert!(
        survived,
        "Discard traversed the payload-root bind mount ({refused:?})"
    );
    let refused = refused.expect("Discard accepted a bind mount over the retained payload root");
    assert!(
        refused.contains("mount point") || refused.contains("changed"),
        "{refused}"
    );
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
}
