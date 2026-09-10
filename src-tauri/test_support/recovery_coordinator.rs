use super::super::model::{NativePath, OperationSpec, OperationState, ReplacementSpec};
use super::super::resources::{Access, Scope};
use super::*;
use crate::files::file_identity::from_metadata as object;

fn fixture() -> (tempfile::TempDir, Arc<Coordinator>, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let user_path = directory.path().join("user-file");
    fs::write(&user_path, b"original").unwrap();
    let coordinator = Coordinator::open(&directory.path().join("recovery")).unwrap();
    (directory, coordinator, user_path)
}

fn writing(path: &Path) -> Vec<Request> {
    vec![Request {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]
}

fn replacement_intent(directory: &Path, source: &Path, owner: &OperationLock) -> DurableIntent {
    let canonical_directory = fs::canonicalize(directory).unwrap();
    let directory = canonical_directory.as_path();
    let canonical_source = fs::canonicalize(source.parent().unwrap())
        .unwrap()
        .join(source.file_name().unwrap());
    let source = canonical_source.as_path();
    let target = directory.join("target");
    fs::write(&target, b"original destination").unwrap();
    let root = directory.join(".tauri-explorer-recovery-planned");
    let original = fs::symlink_metadata(&target).unwrap();
    DurableIntent {
        version: 1,
        id: owner.identity.name.trim_end_matches(".lock").into(),
        operation: OperationSpec::CopyReplacement(ReplacementSpec {
            artifact_token: "planned".into(),
            source_version: crate::files::file_identity::version_from_metadata(
                &fs::symlink_metadata(source).unwrap(),
            )
            .unwrap(),
            source: NativePath(source.to_owned()),
            target: NativePath(target.clone()),
            root: NativePath(root.clone()),
            parent: object(&fs::metadata(directory).unwrap()),
            original: crate::files::file_identity::version_from_metadata(&original).unwrap(),
        }),
        lock: owner.identity.clone(),
        resources: vec![
            resources::capture(source, Access::Read, Scope::Subtree).unwrap(),
            resources::capture(&target, Access::Write, Scope::Subtree).unwrap(),
            resources::capture(&root, Access::Write, Scope::Subtree).unwrap(),
        ],
    }
}

#[test]
fn malformed_intent_authority_fences_even_unrelated_mutation() {
    for case in [
        "owner-binding",
        "target-read",
        "target-entry",
        "root-read",
        "missing-target-identity",
        "wrong-parent",
        "invalid-version-time",
        "invalid-version-mode",
        "invalid-version-kind",
        "source-version-identity",
        "source-version-time",
        "root-entry",
        "wrong-target-object",
        "missing-ancestor",
        "invalid-kind",
        "source-target-alias",
        "root-occupied",
        "source-missing",
        "source-entry",
        "duplicate-path",
    ] {
        let (directory, coordinator, source) = fixture();
        coordinator
            .admitted(|inner| {
                let owner = OperationLock::create(&inner.locks)?;
                let mut intent = replacement_intent(directory.path(), &source, &owner);
                let OperationSpec::CopyReplacement(spec) = &mut intent.operation else {
                    panic!("expected copy replacement fixture");
                };
                match case {
                    "owner-binding" => {
                        let first = if intent.lock.name.starts_with('a') {
                            "b"
                        } else {
                            "a"
                        };
                        intent.lock.name.replace_range(..1, first);
                    }
                    "target-read" => intent.resources[1].access = Access::Read,
                    "target-entry" => intent.resources[1].scope = Scope::Entry,
                    "root-read" => intent.resources[2].access = Access::Read,
                    "missing-target-identity" => intent.resources[1].object = None,
                    "wrong-parent" => spec.parent = spec.original.object,
                    "invalid-version-time" => spec.original.modified_nanos = 1_000_000_000,
                    "invalid-version-mode" => spec.original.mode |= 1 << 31,
                    "invalid-version-kind" => spec.original.directory = true,
                    "source-version-identity" => spec.source_version.object = spec.original.object,
                    "source-version-time" => spec.source_version.modified_nanos = 1_000_000_000,
                    "root-entry" => intent.resources[2].scope = Scope::Entry,
                    "wrong-target-object" => {
                        intent.resources[1].object = intent.resources[0].object
                    }
                    "missing-ancestor" => {
                        intent.resources[1].ancestors.pop();
                    }
                    "invalid-kind" => {
                        spec.original.directory = true;
                        spec.original.symlink = true;
                    }
                    "source-target-alias" => spec.source = spec.target.clone(),
                    "root-occupied" => intent.resources[2].object = Some(spec.parent),
                    "source-missing" => intent.resources[0].object = None,
                    "source-entry" => intent.resources[0].scope = Scope::Entry,
                    _ => intent.resources.push(intent.resources[1].clone()),
                }
                inner
                    .catalog
                    .publish(&intent.id, &serde_json::to_vec(&intent).unwrap())?;
                Ok(())
            })
            .unwrap();
        assert!(
            coordinator
                .reserve(writing(&directory.path().join("unrelated")))
                .is_err(),
            "malformed recovery authority accepted: {case}"
        );
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original destination"
        );
    }
}

#[test]
fn unsupported_nested_intent_fields_cannot_be_silently_downgraded() {
    for field in ["intent", "operation", "spec", "original", "object", "lock"] {
        let (directory, coordinator, source) = fixture();
        coordinator
            .admitted(|inner| {
                let owner = OperationLock::create(&inner.locks)?;
                let intent = replacement_intent(directory.path(), &source, &owner);
                let mut json = serde_json::to_value(&intent).unwrap();
                let target = match field {
                    "original" => &mut json["operation"]["spec"]["original"],
                    "object" => &mut json["operation"]["spec"]["original"]["object"],
                    "lock" => &mut json["lock"],
                    "operation" => &mut json["operation"],
                    "spec" => &mut json["operation"]["spec"],
                    _ => &mut json,
                };
                target["futureAuthority"] = serde_json::json!(true);
                inner
                    .catalog
                    .publish(&intent.id, &serde_json::to_vec(&json).unwrap())?;
                Ok(())
            })
            .unwrap();
        assert!(coordinator
            .reserve(writing(&directory.path().join("unrelated")))
            .is_err());
        assert!(Coordinator::discover_catalog(&directory.path().join("recovery")).is_err());
    }
}

#[test]
fn catalog_discovery_survives_index_loss_without_opening_user_volumes_or_repairing_storage() {
    for damaged_index in [false, true] {
        let (directory, coordinator, _) = fixture();
        let volume = directory.path().join("volume");
        fs::create_dir(&volume).unwrap();
        let source = volume.join("source");
        fs::write(&source, b"new payload").unwrap();
        let intent = coordinator
            .admitted(|inner| {
                let owner = OperationLock::create(&inner.locks)?;
                let intent = replacement_intent(&volume, &source, &owner);
                inner
                    .catalog
                    .publish(&intent.id, &serde_json::to_vec(&intent).unwrap())?;
                Ok(intent)
            })
            .unwrap();
        drop(coordinator);
        let storage = directory.path().join("recovery");
        let database = storage.join(DATABASE);
        if damaged_index {
            fs::write(&database, b"damaged SQLite evidence").unwrap();
        } else {
            fs::remove_file(&database).unwrap();
        }
        let catalog_path = storage.join(format!("catalog/{}.intent", intent.id));
        let original_catalog = fs::read(&catalog_path).unwrap();
        let offline = directory.path().join("offline-volume");
        fs::rename(&volume, &offline).unwrap();
        let found = Coordinator::discover_catalog(&storage).unwrap();
        assert_eq!(found, [intent]);
        assert!(
            !volume.exists(),
            "discovery must not recreate an unavailable user volume"
        );
        assert!(!offline.join(".tauri-explorer-recovery-planned").exists());
        assert_eq!(
            fs::read(offline.join("target")).unwrap(),
            b"original destination"
        );
        assert_eq!(fs::read(&catalog_path).unwrap(), original_catalog);
        if damaged_index {
            assert_eq!(fs::read(&database).unwrap(), b"damaged SQLite evidence");
        } else {
            assert!(!database.exists());
        }
        assert!(
            Coordinator::open(&storage).is_err(),
            "discovery does not silently repair or permit mutation"
        );
    }
}

#[test]
fn catalog_discovery_does_not_initialize_missing_storage() {
    let directory = tempfile::tempdir().unwrap();
    let storage = directory.path().join("not-created");
    assert!(Coordinator::discover_catalog(&storage).unwrap().is_empty());
    assert!(!storage.exists());
}

#[test]
fn catalog_discovery_accepts_parent_aliases_but_never_a_replaced_root_symlink() {
    let (directory, coordinator, _) = fixture();
    drop(coordinator);
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("parent-alias");
    std::os::unix::fs::symlink(directory.path(), &alias).unwrap();
    assert!(Coordinator::discover_catalog(&alias.join("recovery"))
        .unwrap()
        .is_empty());
    let replacement = directory.path().join("root-link");
    std::os::unix::fs::symlink(directory.path().join("recovery"), &replacement).unwrap();
    assert!(Coordinator::discover_catalog(&replacement).is_err());
}

#[test]
fn manifest_authority_requires_the_exact_opened_private_root() {
    use super::super::model::LocalManifest;
    let (directory, coordinator, source) = fixture();
    coordinator
        .admitted(|inner| {
            let owner = OperationLock::create(&inner.locks)?;
            let intent = replacement_intent(directory.path(), &source, &owner);
            let OperationSpec::CopyReplacement(spec) = &intent.operation else {
                panic!("expected copy replacement fixture");
            };
            fs::create_dir(&spec.root.0)?;
            let root = object(&fs::metadata(&spec.root.0)?);
            let parent = spec.parent;
            let original = spec.original.object;
            let manifest = LocalManifest { intent, root };
            manifest.validate(root)?;
            assert!(manifest.validate(parent).is_err());
            let mut forged = manifest.clone();
            forged.root = original;
            assert!(forged.validate(forged.root).is_err());
            let mut json = serde_json::to_value(&manifest).unwrap();
            json["futureRootAuthority"] = serde_json::json!(true);
            assert!(serde_json::from_value::<LocalManifest>(json).is_err());
            Ok(())
        })
        .unwrap();
}

#[test]
fn indexed_phase_evidence_is_validated_before_admission() {
    use super::super::model::Phase;
    for case in [
        "wrong-digest",
        "unknown-state-field",
        "unknown-operation-state",
        "missing-root",
        "missing-publication",
        "premature-publication",
        "invalid-publication",
        "oversized-error",
        "unknown-phase-field",
        "valid-planned",
        "valid-publish-intent",
        "root-parent-alias",
        "root-original-alias",
        "published-original-alias",
        "published-source-alias",
        "root-source-alias",
        "root-other-device",
        "published-root-alias",
        "published-parent-alias",
        "published-other-device",
    ] {
        let (directory, coordinator, source) = fixture();
        coordinator
            .admitted(|inner| {
                let owner = OperationLock::create(&inner.locks)?;
                let intent = replacement_intent(directory.path(), &source, &owner);
                let evidence = inner
                    .catalog
                    .publish(&intent.id, &serde_json::to_vec(&intent).unwrap())?;
                let OperationSpec::CopyReplacement(spec) = &intent.operation else {
                    panic!("expected copy replacement fixture");
                };
                fs::create_dir(&spec.root.0)?;
                let root_identity = object(&fs::metadata(&spec.root.0)?);
                let publication = spec.root.0.join("publication");
                fs::copy(&source, &publication)?;
                let new_metadata = fs::symlink_metadata(publication)?;
                let published = crate::files::file_identity::version_from_metadata(&new_metadata)?;
                let mut record = OperationRecord::planned(intent);
                let OperationSpec::CopyReplacement(spec) = &record.intent.operation else {
                    panic!("expected copy replacement fixture");
                };
                let OperationState::Replacement(state) = &mut record.state else {
                    panic!("expected copy replacement fixture");
                };
                match case {
                    "missing-root" => state.phase = Phase::Displaced,
                    "missing-publication" => {
                        state.phase = Phase::PublishIntent;
                        state.root = Some(root_identity);
                    }
                    "premature-publication" => {
                        state.published = Some(crate::files::recovery::model::StagedPayload {
                            version: spec.original.clone(),
                            final_mode: None,
                        })
                    }
                    "invalid-publication" => {
                        state.phase = Phase::Published;
                        state.root = Some(root_identity);
                        let mut published = published.clone();
                        published.modified_nanos = 1_000_000_000;
                        state.published = Some(crate::files::recovery::model::StagedPayload {
                            version: published,
                            final_mode: None,
                        });
                    }
                    "oversized-error" => state.error = Some("x".repeat(16 * 1024 + 1)),
                    "valid-publish-intent" => {
                        state.phase = Phase::PublishIntent;
                        state.root = Some(root_identity);
                        state.published = Some(crate::files::recovery::model::StagedPayload {
                            version: published.clone(),
                            final_mode: None,
                        });
                    }
                    "root-parent-alias" => {
                        state.phase = Phase::Rooted;
                        state.root = Some(spec.parent);
                    }
                    "root-original-alias" => {
                        state.phase = Phase::Rooted;
                        state.root = Some(spec.original.object);
                    }
                    "published-original-alias" => {
                        state.phase = Phase::PublishIntent;
                        state.root = Some(root_identity);
                        state.published = Some(crate::files::recovery::model::StagedPayload {
                            version: spec.original.clone(),
                            final_mode: None,
                        });
                    }
                    "root-source-alias" => {
                        state.phase = Phase::Rooted;
                        state.root = Some(spec.source_version.object);
                    }
                    "root-other-device" => {
                        state.phase = Phase::Rooted;
                        state.root = Some(other_volume(root_identity));
                    }
                    "published-root-alias"
                    | "published-source-alias"
                    | "published-parent-alias"
                    | "published-other-device" => {
                        state.phase = Phase::PublishIntent;
                        state.root = Some(root_identity);
                        let mut published = published.clone();
                        published.object = match case {
                            "published-root-alias" => root_identity,
                            "published-source-alias" => spec.source_version.object,
                            "published-parent-alias" => spec.parent,
                            _ => other_volume(published.object),
                        };
                        state.published = Some(crate::files::recovery::model::StagedPayload {
                            version: published,
                            final_mode: None,
                        });
                    }
                    _ => {}
                }
                let checkpoint = OperationCheckpoint {
                    intent_digest: evidence.digest(),
                    state: record.state.clone(),
                };
                let mut json = serde_json::to_value(&checkpoint).unwrap();
                if case == "wrong-digest" {
                    json["intent_digest"][0] =
                        serde_json::json!((checkpoint.intent_digest[0] as u16 + 1) % 256);
                }
                if case == "unknown-state-field" {
                    json["state"]["state"]["futureStateAuthority"] = serde_json::json!(true);
                }
                if case == "unknown-operation-state" {
                    json["state"]["kind"] = serde_json::json!("futureOperation");
                }
                if case == "unknown-phase-field" {
                    json["futurePhaseAuthority"] = serde_json::json!(true);
                }
                inner.journal.insert(
                    &record.intent.id,
                    RecordKind::Operation,
                    &serde_json::to_vec(&json).unwrap(),
                )?;
                Ok(())
            })
            .unwrap();
        let admitted = coordinator.reserve(writing(&directory.path().join("unrelated")));
        assert_eq!(
            admitted.is_ok(),
            case.starts_with("valid-"),
            "invalid phase admission: {case}"
        );
        if let Ok(reservation) = admitted {
            reservation.finish().unwrap();
        }
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original destination"
        );
    }
}

#[test]
fn a_catalog_record_cannot_authorize_mutation_of_recovery_storage() {
    let (directory, coordinator, _) = fixture();
    let storage = directory.path().join("recovery");
    let source = storage.join("source");
    fs::write(&source, b"source inside protected storage").unwrap();
    coordinator
        .admitted(|inner| {
            let owner = OperationLock::create(&inner.locks)?;
            let intent = replacement_intent(&storage, &source, &owner);
            inner
                .catalog
                .publish(&intent.id, &serde_json::to_vec(&intent).unwrap())?;
            Ok(())
        })
        .unwrap();
    assert!(coordinator
        .reserve(writing(&directory.path().join("unrelated")))
        .is_err());
    assert!(Coordinator::discover_catalog(&storage).is_err());
    assert_eq!(
        fs::read(&source).unwrap(),
        b"source inside protected storage"
    );
}

#[test]
fn separate_connections_reject_overlap_but_allow_sibling_work() {
    let (directory, first, path) = fixture();
    let second = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let active = first.reserve(writing(&path)).unwrap();
    assert!(second.reserve(writing(&path)).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"original");
    let sibling = second
        .reserve(writing(&directory.path().join("sibling")))
        .unwrap();
    sibling.finish().unwrap();
    active.finish().unwrap();
    second.reserve(writing(&path)).unwrap().finish().unwrap();
}

#[test]
fn prepared_requests_cannot_keep_an_obsolete_identity_after_another_operation() {
    let (directory, coordinator, path) = fixture();
    let replacement = directory.path().join("replacement");
    let alias = directory.path().join("replacement-alias");
    fs::write(&replacement, b"replacement").unwrap();
    fs::hard_link(&replacement, &alias).unwrap();
    let prepared = writing(&path);
    let mutation = coordinator
        .reserve([writing(&path), writing(&replacement)].concat())
        .unwrap();
    fs::rename(&replacement, &path).unwrap();
    mutation.finish().unwrap();
    let reader = coordinator
        .reserve(vec![Request {
            path: alias,
            access: Access::Read,
            scope: Scope::Subtree,
        }])
        .unwrap();
    assert!(
        coordinator.reserve(prepared).is_err(),
        "current hardlink ownership must win over an obsolete prepared identity"
    );
    reader.finish().unwrap();
}

#[test]
fn a_commit_during_capture_retries_before_granting_physical_ownership() {
    let (directory, coordinator, path) = fixture();
    let replacement = directory.path().join("replacement");
    let alias = directory.path().join("replacement-alias");
    fs::write(&replacement, b"replacement").unwrap();
    fs::hard_link(&replacement, &alias).unwrap();
    let mut reader = None;
    let result = coordinator.reserve_with(writing(&path), || {
        if reader.is_some() {
            return;
        }
        let mutation = coordinator
            .reserve([writing(&path), writing(&replacement)].concat())
            .unwrap();
        fs::rename(&replacement, &path).unwrap();
        mutation.finish().unwrap();
        reader = Some(
            coordinator
                .reserve(vec![Request {
                    path: alias.clone(),
                    access: Access::Read,
                    scope: Scope::Subtree,
                }])
                .unwrap(),
        );
    });
    assert!(
        result.is_err(),
        "the replacement is now owned through its hardlink"
    );
    reader.unwrap().finish().unwrap();
}

#[test]
fn repeated_capture_invalidation_fails_without_leaking_ownership() {
    let (directory, coordinator, path) = fixture();
    let sibling = directory.path().join("sibling");
    let result = coordinator.reserve_with(writing(&path), || {
        coordinator
            .reserve(writing(&sibling))
            .unwrap()
            .finish()
            .unwrap();
    });
    assert!(result.is_err());
    coordinator
        .reserve(writing(&path))
        .unwrap()
        .finish()
        .unwrap();
    assert!(fs::read_dir(directory.path().join("recovery/locks"))
        .unwrap()
        .next()
        .is_none());
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
fn dropped_worker_reservations_are_reclaimed_using_their_exact_os_lock() {
    let (directory, coordinator, path) = fixture();
    let abandoned = coordinator.reserve(writing(&path)).unwrap();
    drop(abandoned);
    drop(coordinator);
    let restarted = Coordinator::open(&directory.path().join("recovery")).unwrap();
    restarted.reserve(writing(&path)).unwrap().finish().unwrap();
    assert!(fs::read_dir(directory.path().join("recovery/locks"))
        .unwrap()
        .next()
        .is_none());
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
fn completed_reservations_do_not_accumulate_rows_or_owner_files() {
    let (directory, coordinator, path) = fixture();
    for _ in 0..(MAX_RECORDS + 1) {
        coordinator
            .reserve(writing(&path))
            .unwrap()
            .finish()
            .unwrap();
    }
    let inner = coordinator.inner.lock().unwrap();
    assert!(inner.journal.records().unwrap().is_empty());
    assert!(fs::read_dir(directory.path().join("recovery/locks"))
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn a_missing_owner_is_uncertain_not_abandoned() {
    let (directory, coordinator, path) = fixture();
    let active = coordinator.reserve(writing(&path)).unwrap();
    let name = active.owner.identity.name.clone();
    fs::remove_file(directory.path().join("recovery/locks").join(name)).unwrap();
    drop(active);
    assert!(coordinator.reserve(writing(&path)).is_err());
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
fn replaced_storage_poisoning_never_switches_to_the_new_namespace() {
    let (directory, coordinator, path) = fixture();
    let original = directory.path().join("recovery");
    fs::rename(&original, directory.path().join("retained-storage")).unwrap();
    let replacement = Coordinator::open(&original).unwrap();
    assert!(coordinator.reserve(writing(&path)).is_err());
    // Even restoring the original name does not clear an unknown journal outcome.
    drop(replacement);
    fs::rename(&original, directory.path().join("replacement-storage")).unwrap();
    fs::rename(directory.path().join("retained-storage"), &original).unwrap();
    assert!(coordinator.reserve(writing(&path)).is_err());
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
fn missing_or_replaced_gate_fences_the_connection_even_after_the_original_returns() {
    for replacement in [false, true] {
        let (directory, coordinator, path) = fixture();
        let gate = directory.path().join("recovery/admission.lock");
        let retained = directory.path().join("held-gate");
        fs::rename(&gate, &retained).unwrap();
        if replacement {
            fs::write(&gate, b"").unwrap();
            fs::set_permissions(&gate, std::os::unix::fs::PermissionsExt::from_mode(0o600))
                .unwrap();
        }
        assert!(coordinator.reserve(writing(&path)).is_err());
        if replacement {
            fs::remove_file(&gate).unwrap();
        }
        fs::rename(retained, gate).unwrap();
        assert!(
            coordinator.reserve(writing(&path)).is_err(),
            "restoring gate spelling must not clear detected authority loss"
        );
        assert_eq!(fs::read(path).unwrap(), b"original");
    }
}

#[test]
fn unknown_catalog_data_fences_even_unrelated_mutations() {
    let (directory, coordinator, path) = fixture();
    coordinator
        .admitted(|inner| {
            inner
                .catalog
                .publish("unknown", b"undecodable affected resources")?;
            Ok(())
        })
        .unwrap();
    assert!(coordinator.reserve(writing(&path)).is_err());
    assert!(coordinator
        .reserve(writing(&directory.path().join("unrelated")))
        .is_err());
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
fn missing_admission_lock_does_not_recreate_authority_over_existing_evidence() {
    let (directory, coordinator, _path) = fixture();
    drop(coordinator);
    fs::remove_file(directory.path().join("recovery/admission.lock")).unwrap();
    assert!(Coordinator::open(&directory.path().join("recovery")).is_err());
    assert!(!directory.path().join("recovery/admission.lock").exists());
    assert!(directory.path().join("recovery/recovery.sqlite3").is_file());
}

#[test]
fn managed_mutations_cannot_modify_storage_or_its_ancestors() {
    let (directory, coordinator, _path) = fixture();
    let storage = directory.path().join("recovery");
    assert!(coordinator.reserve(writing(&storage)).is_err());
    assert!(coordinator
        .reserve(writing(&storage.join("recovery.sqlite3")))
        .is_err());
    assert!(coordinator.reserve(writing(directory.path())).is_err());
    coordinator
        .reserve(vec![Request {
            path: storage,
            access: Access::Read,
            scope: Scope::Subtree,
        }])
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn catalog_intent_fences_its_resources_before_a_database_operation_row_exists() {
    let (directory, coordinator, source) = fixture();
    let target = directory.path().join("target");
    let root = directory.path().join(".tauri-explorer-recovery-planned");
    coordinator
        .admitted(|inner| {
            let owner = OperationLock::create(&inner.locks)?;
            let intent = replacement_intent(directory.path(), &source, &owner);
            inner
                .catalog
                .publish(&intent.id, &serde_json::to_vec(&intent).unwrap())?;
            Ok(())
        })
        .unwrap();
    assert!(coordinator.reserve(writing(&target)).is_err());
    assert!(coordinator.reserve(writing(&root)).is_err());
    coordinator
        .reserve(writing(&directory.path().join("unrelated")))
        .unwrap()
        .finish()
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"original destination");
    assert!(
        !root.exists(),
        "discovery must not create or probe an artifact root"
    );
}

#[test]
fn native_process_death_releases_conflicts_without_blocking_unrelated_work() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let (directory, coordinator, path) = fixture();
    let ready = directory.path().join("child-owned");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::recovery::coordinator::tests::subprocess_reservation_holder",
            "--ignored",
            "--nocapture",
        ])
        .env("EXPLORER_RECOVERY_COORDINATOR_TEST", directory.path())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready.exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not acquire its filesystem resource");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let overlap = coordinator.reserve(writing(&path));
    let unrelated = coordinator.reserve(writing(&directory.path().join("sibling")));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(overlap.is_err());
    unrelated.unwrap().finish().unwrap();
    let reclaimed = coordinator.reserve(writing(&path)).unwrap();
    fs::write(&path, b"operation after dead owner").unwrap();
    reclaimed.finish().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"operation after dead owner");
}

#[test]
#[ignore = "controlled helper for native_process_death_releases_conflicts_without_blocking_unrelated_work"]
fn subprocess_reservation_holder() {
    let directory = PathBuf::from(
        std::env::var_os("EXPLORER_RECOVERY_COORDINATOR_TEST").expect("parent fixture"),
    );
    let coordinator = Coordinator::open(&directory.join("recovery")).unwrap();
    let _held = coordinator
        .reserve(writing(&directory.join("user-file")))
        .unwrap();
    fs::write(directory.join("child-owned"), b"resources owned").unwrap();
    loop {
        std::thread::park();
    }
}

// Construct a valid native identity on a different synthetic volume, preserving
// the payload ID so record validation must reject the volume itself.
fn other_volume(identity: ObjectId) -> ObjectId {
    let mut value = serde_json::to_value(identity).unwrap();
    value["device"] = value["device"].as_u64().unwrap().wrapping_add(1).into();
    serde_json::from_value(value).unwrap()
}
