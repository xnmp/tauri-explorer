use super::*;
use crate::files::recovery::{coordinator::Coordinator, forward_move::PreparedMove};
use std::{fs, path::PathBuf, sync::Arc};

struct Fixture {
    _directory: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    coordinator: Arc<Coordinator>,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let target = directory.path().join("target");
        fs::write(&source, b"source bytes").unwrap();
        fs::write(&target, b"original bytes").unwrap();
        let coordinator = Coordinator::open(&directory.path().join("recovery")).unwrap();
        Self {
            _directory: directory,
            source,
            target,
            coordinator,
        }
    }
    fn operation(&self) -> DurableOperation {
        PreparedMove::prepare(&self.coordinator, &self.source, &self.target)
            .unwrap()
            .into_operation()
    }
    fn unchanged(&self) {
        assert_eq!(fs::read(&self.source).unwrap(), b"source bytes");
        assert_eq!(fs::read(&self.target).unwrap(), b"original bytes");
    }
}

#[test]
fn real_rename_is_required_before_move_roots_and_leaves_no_probe_artifact() {
    let f = Fixture::new();
    let mut operation = f.operation();
    assert!(operation.advance_move(MoveTransition::BeginRoots).is_err());
    let probe_paths: Vec<_> = plans(operation.intent())
        .unwrap()
        .into_iter()
        .map(|p| p.root)
        .collect();
    let mut calls = 0;
    let operation = qualify_with(operation, None, |from, name, to, target| {
        assert!(from.entry_exists(name)?);
        assert!(!to.entry_exists(target)?);
        calls += 1;
        from.rename_to(name, to, target)
    })
    .unwrap();
    assert_eq!(
        calls, 1,
        "same-volume endpoints need exactly one actual probe"
    );
    for path in probe_paths {
        assert!(!path.exists());
    }
    let mut execution =
        super::super::move_execution::MoveExecution::prepare_with(operation, None).unwrap();
    execution.displace_target().unwrap();
    execution.publish_move().unwrap();
    assert!(!f.source.exists());
    assert_eq!(fs::read(&f.target).unwrap(), b"source bytes");
}

#[test]
fn unsupported_filesystem_cleans_probe_and_retires_record_before_any_move_effect() {
    for errno in [libc::EINVAL, libc::EOPNOTSUPP, libc::ENOSYS] {
        let f = Fixture::new();
        let operation = f.operation();
        let paths: Vec<_> = plans(operation.intent())
            .unwrap()
            .into_iter()
            .map(|p| p.root)
            .collect();
        let result = qualify_with(operation, None, |_, _, _, _| {
            Err(io::Error::from_raw_os_error(errno))
        });
        assert!(matches!(result, Err(Failure::Rejected(_))));
        f.unchanged();
        for path in paths {
            assert!(!path.exists());
        }
        assert!(f.coordinator.inventory().unwrap().entries.is_empty());
        // A new operation can acquire the same endpoints immediately.
        drop(f.operation());
    }
}

#[test]
fn old_catalog_bytes_round_trip_without_changing_the_manifest_digest() {
    // Captured from the real native acceptance binary at eb82ab6c, before the
    // probe fields existed. Do not regenerate with the new serializer.
    let bytes = include_bytes!("fixtures/pre-probe-move.intent");
    assert_eq!(&bytes[..8], b"TERCV001");
    let payload = &bytes[40..];
    use sha2::{Digest, Sha256};
    assert_eq!(Sha256::digest(payload).as_slice(), &bytes[8..40]);
    let intent: DurableIntent = serde_json::from_slice(payload).unwrap();
    intent.validate().unwrap();
    assert!(intent
        .operation
        .move_spec()
        .unwrap()
        .rename_probes
        .is_none());
    assert_eq!(serde_json::to_vec(&intent).unwrap(), payload);
}

#[test]
fn rootless_publication_also_requires_a_real_probe() {
    let f = Fixture::new();
    fs::remove_file(&f.target).unwrap();
    let mut operation = f.operation();
    assert!(operation
        .advance_move(MoveTransition::BeginPublication)
        .is_err());
    let operation = qualify(operation, None).unwrap();
    let mut execution =
        super::super::move_execution::MoveExecution::prepare_with(operation, None).unwrap();
    execution.publish_move().unwrap();
    assert!(!f.source.exists());
    assert_eq!(fs::read(&f.target).unwrap(), b"source bytes");
    assert!(fs::read_dir(f.target.parent().unwrap())
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".tauri-explorer-recovery-")));
}

#[test]
fn operational_errors_are_retained_and_can_only_be_explicitly_cleaned() {
    for errno in [libc::EIO, libc::EPERM, libc::EROFS, libc::ENOSPC] {
        let f = Fixture::new();
        let operation = f.operation();
        let id = operation.intent().id.clone();
        let paths: Vec<_> = plans(operation.intent())
            .unwrap()
            .into_iter()
            .map(|p| p.root)
            .collect();
        assert!(matches!(
            qualify_with(operation, None, |_, _, _, _| Err(
                io::Error::from_raw_os_error(errno)
            )),
            Err(Failure::Retained(_))
        ));
        f.unchanged();
        assert!(paths.iter().all(|path| path.exists()));
        let after_reclaim = super::super::service::enforce(&f.coordinator).unwrap();
        assert_eq!(after_reclaim.items.len(), 1);
        let snapshot = super::super::service::inspect(&f.coordinator, &id).unwrap();
        assert!(snapshot.items[0]
            .actions
            .contains(&super::super::model::RecoveryChoice::Discard));
        let result = super::super::service::resolve(
            &f.coordinator,
            &id,
            snapshot.items[0].generation,
            super::super::model::RecoveryChoice::Discard,
        )
        .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.items.is_empty());
        assert!(paths.iter().all(|path| !path.exists()));
        f.unchanged();
    }
}

#[test]
fn changed_probe_never_turns_a_capability_errno_into_cleanup_authority() {
    let f = Fixture::new();
    let operation = f.operation();
    let id = operation.intent().id.clone();
    let paths: Vec<_> = plans(operation.intent())
        .unwrap()
        .into_iter()
        .map(|p| p.root)
        .collect();
    assert!(matches!(
        qualify_with(operation, None, |_, _, _, _| {
            fs::write(paths[0].join(BEFORE), b"external bytes")?;
            Err(io::Error::from_raw_os_error(libc::EINVAL))
        }),
        Err(Failure::Retained(_))
    ));
    let snapshot = super::super::service::inspect(&f.coordinator, &id).unwrap();
    assert!(snapshot.items[0].actions.is_empty());
    assert_eq!(fs::read(paths[0].join(BEFORE)).unwrap(), b"external bytes");
    f.unchanged();
}

#[test]
fn an_error_after_an_actual_rename_does_not_infer_unsupported_or_delete_evidence() {
    let f = Fixture::new();
    let operation = f.operation();
    let id = operation.intent().id.clone();
    let root = plans(operation.intent()).unwrap().remove(0).root;
    assert!(matches!(
        qualify_with(operation, None, |from, name, to, target| {
            from.rename_to(name, to, target)?;
            Err(io::Error::from_raw_os_error(libc::EINVAL))
        }),
        Err(Failure::Retained(_))
    ));
    assert!(root.join(AFTER).is_file());
    let snapshot = super::super::service::inspect(&f.coordinator, &id).unwrap();
    assert!(snapshot.items[0]
        .actions
        .contains(&super::super::model::RecoveryChoice::Discard));
    f.unchanged();
}

#[test]
fn both_volumes_must_pass_and_second_volume_rejection_leaves_no_private_roots() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    let other = tempfile::tempdir_in("/dev/shm").unwrap();
    if fs::metadata(other.path()).unwrap().dev() == fs::metadata(&f.source).unwrap().dev() {
        eprintln!("SKIPPED capability cross-filesystem test: shared device");
        return;
    }
    let target = other.path().join("target");
    fs::write(&target, b"other original").unwrap();
    let operation = PreparedMove::prepare(&f.coordinator, &f.source, &target)
        .unwrap()
        .into_operation();
    let probes = plans(operation.intent()).unwrap();
    assert_eq!(probes.len(), 2);
    let mut calls = 0;
    let result = qualify_with(operation, None, |from, name, to, target| {
        calls += 1;
        if calls == 2 {
            Err(io::Error::from_raw_os_error(libc::EOPNOTSUPP))
        } else {
            from.rename_to(name, to, target)
        }
    });
    assert!(matches!(result, Err(Failure::Rejected(_))));
    assert_eq!(calls, 2);
    assert!(probes.iter().all(|plan| !plan.root.exists()));
    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    f.unchanged();
    assert_eq!(fs::read(target).unwrap(), b"other original");
}

const PROBE_BOUNDARIES: &[&str] = &[
    "probe-root-intent",
    "probe-root-created",
    "probe-file-intent",
    "probe-file-created",
    "probe-rename-intent",
    "probe-rename-returned",
    "probe-cleanup-intent",
    "probe-file-removed",
    "probe-root-removed",
    "probe-removed",
];

#[test]
#[ignore = "subprocess helper for capability crash contracts"]
fn probe_crash_child() {
    let base = PathBuf::from(std::env::var_os("EXPLORER_PROBE_CRASH_DIR").unwrap());
    let boundary = std::env::var("EXPLORER_PROBE_CRASH_BOUNDARY").unwrap();
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let target = PathBuf::from(std::env::var_os("EXPLORER_PROBE_CRASH_TARGET").unwrap());
    let occurrence: usize = std::env::var("EXPLORER_PROBE_CRASH_OCCURRENCE")
        .unwrap()
        .parse()
        .unwrap();
    let reject: usize = std::env::var("EXPLORER_PROBE_CRASH_REJECT")
        .unwrap()
        .parse()
        .unwrap();
    let operation = PreparedMove::prepare(&coordinator, &base.join("source"), &target)
        .unwrap()
        .into_operation();
    let seen = std::cell::Cell::new(0);
    let hook: Boundary = Box::new(move |label| {
        if label == boundary {
            seen.set(seen.get() + 1);
            if seen.get() == occurrence {
                fs::write(base.join("ready"), label).unwrap();
                loop {
                    std::thread::park();
                }
            }
        }
        Ok(())
    });
    let mut calls = 0;
    let _ = qualify_with(operation, Some(&hook), |from, name, to, target| {
        calls += 1;
        if calls == reject {
            Err(io::Error::from_raw_os_error(libc::EOPNOTSUPP))
        } else {
            from.rename_to(name, to, target)
        }
    });
    panic!("probe did not reach requested crash boundary");
}

#[test]
fn process_death_at_every_probe_boundary_preserves_user_bytes_and_exact_cleanup_authority() {
    use std::os::unix::fs::MetadataExt;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for (cross_volume, reject) in [(false, false), (true, false), (false, true), (true, true)] {
        let boundaries: Vec<_> = if reject {
            [
                "probe-cleanup-intent",
                "probe-file-removed",
                "probe-root-removed",
                "probe-removed",
                "probe-aborted",
            ]
            .to_vec()
        } else {
            PROBE_BOUNDARIES.to_vec()
        };
        for boundary in boundaries {
            let f = Fixture::new();
            let other = tempfile::tempdir_in("/dev/shm").unwrap();
            if cross_volume {
                assert_ne!(
                    fs::metadata(other.path()).unwrap().dev(),
                    fs::metadata(&f.source).unwrap().dev(),
                    "crash contract requires two distinct filesystems"
                );
            }
            let target = if cross_volume {
                other.path().join("target")
            } else {
                f.target.clone()
            };
            fs::write(&target, b"original bytes").unwrap();
            let probe_index = usize::from(cross_volume);
            let occurrence = if boundary == "probe-aborted" {
                1
            } else {
                probe_index + 1
            };
            let base = f.source.parent().unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "files::recovery::move_capability::tests::probe_crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("EXPLORER_PROBE_CRASH_DIR", base)
                .env("EXPLORER_PROBE_CRASH_BOUNDARY", boundary)
                .env("EXPLORER_PROBE_CRASH_TARGET", &target)
                .env("EXPLORER_PROBE_CRASH_OCCURRENCE", occurrence.to_string())
                .env(
                    "EXPLORER_PROBE_CRASH_REJECT",
                    if reject { probe_index + 1 } else { 0 }.to_string(),
                )
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !base.join("ready").exists() {
                if child.try_wait().unwrap().is_some() || Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("probe child did not reach {boundary}");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            child.kill().unwrap();
            child.wait().unwrap();
            f.unchanged();
            let inventory = f.coordinator.inventory().unwrap();
            assert_eq!(inventory.entries.len(), 1, "{boundary}");
            let entry = &inventory.entries[0];
            assert_eq!(
                entry.state.as_ref().unwrap().move_state().unwrap().phase,
                if boundary == "probe-aborted" {
                    MovePhase::Aborted
                } else {
                    MovePhase::Planned
                }
            );
            let roots: Vec<_> = plans(&entry.intent)
                .unwrap()
                .into_iter()
                .map(|p| p.root)
                .collect();
            let snapshot =
                super::super::service::inspect(&f.coordinator, &entry.intent.id).unwrap();
            let item = &snapshot.items[0];
            if matches!(boundary, "probe-root-created" | "probe-file-created") {
                assert!(
                    item.actions.is_empty(),
                    "unobserved creation was adopted at {boundary}"
                );
                assert!(roots[probe_index].exists());
            } else {
                assert!(
                    item.actions
                        .contains(&super::super::model::RecoveryChoice::Discard),
                    "{boundary}: {}",
                    item.message
                );
                let resolved = super::super::service::resolve(
                    &f.coordinator,
                    &item.id,
                    item.generation,
                    super::super::model::RecoveryChoice::Discard,
                )
                .unwrap();
                assert!(resolved.error.is_none(), "{boundary}: {:?}", resolved.error);
                assert!(resolved.items.is_empty());
                assert!(roots.iter().all(|path| !path.exists()), "{boundary}");
            }
            f.unchanged();
            assert_eq!(fs::read(&target).unwrap(), b"original bytes");
        }
    }
}

#[test]
fn old_native_manifest_bytes_still_match_the_reencoded_intent_and_root() {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("fixtures/pre-probe-move-manifest.intent");
    assert_eq!(&bytes[..8], b"TERCV001");
    assert_eq!(Sha256::digest(&bytes[40..]).as_slice(), &bytes[8..40]);
    let manifest: super::super::model::LocalManifest =
        serde_json::from_slice(&bytes[40..]).unwrap();
    manifest.intent.validate().unwrap();
    assert_eq!(serde_json::to_vec(&manifest).unwrap(), &bytes[40..]);
    // The manifest contains exactly the old catalog bytes, with no new null
    // probe field introduced while decoding and re-encoding either authority.
    assert_eq!(
        serde_json::to_vec(&manifest.intent).unwrap(),
        &include_bytes!("fixtures/pre-probe-move.intent")[40..]
    );
}

#[test]
fn version_two_cannot_omit_probes_or_supply_duplicate_volume_coverage() {
    let f = Fixture::new();
    let operation = f.operation();
    assert_eq!(operation.intent().version, 2);
    let mut intent = operation.intent().clone();
    if let super::super::model::OperationSpec::Move(spec) = &mut intent.operation {
        spec.rename_probes = None;
    }
    assert!(intent.validate().is_err());
    let mut intent = operation.intent().clone();
    if let super::super::model::OperationSpec::Move(spec) = &mut intent.operation {
        let probes = spec.rename_probes.as_mut().unwrap();
        probes.target = Some(probes.source.clone());
    }
    assert!(intent.validate().is_err());
    let mut old = operation.intent().clone();
    old.version = 1;
    assert!(
        old.validate().is_err(),
        "v1 cannot silently acquire a v2 capability policy"
    );
}

#[test]
fn cleaned_checkpoint_requires_the_actual_probe_identity_and_file_evidence() {
    let f = Fixture::new();
    let operation = qualify(f.operation(), None).unwrap();
    let mut state = operation.state().clone();
    let progress = state
        .move_state_mut()
        .unwrap()
        .rename_probe
        .as_mut()
        .unwrap();
    let Step::Removed { file, .. } = &mut progress.steps[0] else {
        panic!("not cleaned");
    };
    *file = None;
    assert!(state.validate(operation.intent()).is_err());
    let mut state = operation.state().clone();
    let progress = state
        .move_state_mut()
        .unwrap()
        .rename_probe
        .as_mut()
        .unwrap();
    let Step::Removed { root, .. } = &mut progress.steps[0] else {
        panic!("not cleaned");
    };
    *root = operation
        .intent()
        .operation
        .move_spec()
        .unwrap()
        .source_version
        .object;
    assert!(state.validate(operation.intent()).is_err());
}

#[test]
fn stale_probe_discard_cannot_consume_a_new_inspection_generation() {
    let f = Fixture::new();
    let operation = f.operation();
    let id = operation.intent().id.clone();
    let hook: Boundary = Box::new(|label| {
        if label == "probe-rename-intent" {
            Err(invalid("test stop"))
        } else {
            Ok(())
        }
    });
    assert!(qualify(operation, Some(&hook)).is_err());
    let previous = super::super::service::inspect(&f.coordinator, &id).unwrap();
    let current = super::super::service::inspect(&f.coordinator, &id).unwrap();
    assert_ne!(previous.items[0].generation, current.items[0].generation);
    let refused = super::super::service::resolve(
        &f.coordinator,
        &id,
        previous.items[0].generation,
        super::super::model::RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(refused.error.is_some());
    assert_eq!(refused.items.len(), 1);
    f.unchanged();
}

#[test]
fn substituted_roots_files_and_foreign_children_are_preserved_during_probe_cleanup() {
    for attack in ["root", "file", "child"] {
        let f = Fixture::new();
        let operation = f.operation();
        let id = operation.intent().id.clone();
        let root = plans(operation.intent()).unwrap().remove(0).root;
        let moved_root = root.with_extension("external-moved");
        let attack_root = root.clone();
        let saved_root = moved_root.clone();
        let hook: Boundary = Box::new(move |label| {
            match (attack, label) {
                ("root", "probe-file-removed") => {
                    fs::rename(&attack_root, &saved_root)?;
                    fs::create_dir(&attack_root)?;
                }
                ("file", "probe-cleanup-intent") => {
                    fs::rename(attack_root.join(AFTER), &saved_root)?;
                    fs::write(attack_root.join(AFTER), b"external replacement")?;
                }
                ("child", "probe-file-removed") => {
                    fs::write(attack_root.join("external-child"), b"external child")?;
                }
                _ => {}
            }
            Ok(())
        });
        assert!(qualify(operation, Some(&hook)).is_err(), "{attack}");
        let snapshot = super::super::service::inspect(&f.coordinator, &id).unwrap();
        let item = &snapshot.items[0];
        assert!(item.actions.is_empty(), "{attack}: {}", item.message);
        // Even a forged direct request cannot bypass the read-only inspection.
        let result = super::super::service::resolve(
            &f.coordinator,
            &id,
            item.generation,
            super::super::model::RecoveryChoice::Discard,
        )
        .unwrap();
        assert!(result.error.is_some(), "{attack}");
        assert!(root.is_dir());
        match attack {
            "root" => assert!(moved_root.is_dir()),
            "file" => {
                assert_eq!(fs::read(root.join(AFTER)).unwrap(), b"external replacement");
                assert_eq!(fs::read(&moved_root).unwrap(), b"");
            }
            "child" => assert_eq!(
                fs::read(root.join("external-child")).unwrap(),
                b"external child"
            ),
            _ => unreachable!(),
        }
        f.unchanged();
    }
}
