use super::*;
use crate::files::recovery::{
    context::MutationAdmission,
    resources::{Access, Scope},
};

use super::super::test_fixture::*;

#[test]
fn claiming_catalog_before_checkpoint_never_fabricates_a_planned_operation() {
    let (directory, coordinator, reservation, spec) = fixture();
    let id = reservation.id.clone();
    let generation = reservation.generation;
    let failure = reservation
        .promote_with(spec, injected, || Ok(()))
        .err()
        .unwrap();
    drop(failure);
    let before = coordinator
        .admitted(|inner| inner.journal.records())
        .unwrap();
    let catalog = Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap();
    assert_eq!(before[0].kind, RecordKind::Reservation);
    assert!(coordinator.try_claim(&id, generation).is_err());
    assert_eq!(
        coordinator
            .admitted(|inner| inner.journal.records())
            .unwrap(),
        before
    );
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap(),
        catalog
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn promotion_retains_authority_after_drop_and_catalog_survives_index_loss() {
    let (directory, coordinator, reservation, spec) = fixture();
    let owner = reservation.owner.identity.clone();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    assert_eq!(operation.record.intent.lock, owner);
    assert_eq!(operation.evidence.id, operation.record.intent.id);
    let expected = operation.record.intent.clone();
    let storage = directory.path().join("recovery");
    let competitor = Coordinator::open(&storage).unwrap();
    assert!(competitor
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    drop(operation);
    assert!(competitor
        .reserve(writing(&directory.path().join("source")))
        .is_err());
    competitor
        .reserve(writing(&directory.path().join("unrelated")))
        .unwrap()
        .finish()
        .unwrap();
    assert_user_files_untouched(directory.path());
    drop(competitor);
    drop(coordinator);
    fs::remove_file(storage.join(DATABASE)).unwrap();
    assert_eq!(Coordinator::discover_catalog(&storage).unwrap(), [expected]);
    assert_user_files_untouched(directory.path());
}

#[test]
fn catalog_only_interruption_is_retryable_without_replacing_evidence() {
    let (directory, coordinator, reservation, spec) = fixture();
    let failure = reservation
        .promote_with(spec.clone(), injected, || Ok(()))
        .err()
        .unwrap();
    let before = coordinator
        .admitted(|inner| {
            assert_eq!(inner.journal.records()?[0].kind, RecordKind::Reservation);
            Ok(inner.catalog.records()?)
        })
        .unwrap();
    assert_eq!(before.len(), 1);
    let operation = failure
        .reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    assert_eq!(operation.evidence, before[0]);
    assert_user_files_untouched(directory.path());
}

#[test]
fn catalog_only_abandonment_fences_sources_and_preserves_owner_evidence() {
    let (directory, coordinator, reservation, spec) = fixture();
    let lock_name = reservation.owner.identity.name.clone();
    let failure = reservation
        .promote_with(spec, injected, || Ok(()))
        .err()
        .unwrap();
    drop(failure);
    drop(coordinator);
    let competitor = Coordinator::open(&directory.path().join("recovery")).unwrap();
    competitor
        .reserve(writing(&directory.path().join("unrelated")))
        .unwrap()
        .finish()
        .unwrap();
    assert!(competitor
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    assert!(directory
        .path()
        .join("recovery/locks")
        .join(lock_name)
        .exists());
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn lost_commit_reply_adopts_only_the_exact_initial_record_without_a_new_revision() {
    let (directory, coordinator, reservation, spec) = fixture();
    let failure = reservation
        .promote_with(spec.clone(), || Ok(()), injected)
        .err()
        .unwrap();
    let before = coordinator
        .admitted(|inner| inner.journal.revision())
        .unwrap();
    let operation = failure
        .reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    assert_eq!(operation.generation, before);
    assert_eq!(
        coordinator
            .admitted(|inner| inner.journal.revision())
            .unwrap(),
        before
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn changed_retry_keeps_committed_evidence_and_rejects_the_new_spec() {
    let (directory, coordinator, reservation, mut spec) = fixture();
    let failure = reservation
        .promote_with(spec.clone(), || Ok(()), injected)
        .err()
        .unwrap();
    let before = coordinator
        .admitted(|inner| Ok((inner.catalog.records()?, inner.journal.records()?)))
        .unwrap();
    let OperationSpec::CopyReplacement(replacement) = &mut spec else {
        panic!("expected copy replacement fixture");
    };
    replacement.original.modified_seconds += 1;
    assert!(failure.reservation.promote(spec).is_err());
    let after = coordinator
        .admitted(|inner| Ok((inner.catalog.records()?, inner.journal.records()?)))
        .unwrap();
    assert_eq!(before, after);
    assert_user_files_untouched(directory.path());
}

#[test]
fn changed_reservation_rejects_before_any_catalog_publication() {
    for case in ["generation", "missing", "owner", "resources"] {
        let (directory, coordinator, reservation, spec) = fixture();
        coordinator
            .admitted(|inner| {
                let row = inner.journal.records()?.remove(0);
                match case {
                    "generation" => {
                        inner
                            .journal
                            .replace(&row.id, row.generation, &row.payload)?;
                    }
                    "missing" => {
                        inner.journal.remove(&row.id, row.generation)?;
                    }
                    _ => {
                        let mut record: ReservationRecord = decode(&row.payload)?;
                        if case == "owner" {
                            record.lock.nonce = "a".repeat(64);
                        } else {
                            record.resources[0].access = Access::Write;
                        }
                        // Deliberately corrupt authority without advancing the
                        // generation, so this exercises more than the CAS check.
                        let connection =
                            rusqlite::Connection::open(inner.root_path.join(DATABASE)).unwrap();
                        connection
                            .execute(
                                "UPDATE recovery_records SET payload = ?1 WHERE id = ?2",
                                rusqlite::params![serde_json::to_vec(&record).unwrap(), row.id],
                            )
                            .unwrap();
                    }
                }
                Ok(())
            })
            .unwrap();
        assert!(reservation.promote(spec).is_err(), "{case}");
        assert!(
            coordinator
                .admitted(|inner| Ok(inner.catalog.records()?))
                .unwrap()
                .is_empty(),
            "{case}"
        );
        assert_user_files_untouched(directory.path());
    }
}

#[test]
fn active_worker_context_prevents_promotion_without_publishing_evidence() {
    let (directory, coordinator, reservation, spec) = fixture();
    let admission = MutationAdmission::new(reservation);
    let context = admission.context();
    assert!(admission.promote(spec).is_err());
    assert!(coordinator
        .admitted(|inner| Ok(inner.catalog.records()?))
        .unwrap()
        .is_empty());
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    drop(context);
    coordinator
        .reserve(writing(&directory.path().join("target")))
        .unwrap()
        .finish()
        .unwrap();
    assert_user_files_untouched(directory.path());
}

#[test]
fn ordinary_finish_after_catalog_interruption_cannot_retire_durable_evidence() {
    let (directory, coordinator, reservation, spec) = fixture();
    let failure = reservation
        .promote_with(spec, injected, || Ok(()))
        .err()
        .unwrap();
    failure.reservation.finish().unwrap();
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn dropping_the_async_waiter_keeps_publication_owned_and_leaves_durable_evidence() {
    use std::{
        future::Future,
        sync::mpsc,
        task::{Context, Waker},
        time::Duration,
    };
    const DEADLINE: Duration = Duration::from_secs(30);
    struct Unobserved {
        operation: Option<DurableOperation>,
        dropped: mpsc::SyncSender<()>,
    }
    impl Drop for Unobserved {
        fn drop(&mut self) {
            drop(self.operation.take());
            self.dropped.send(()).unwrap();
        }
    }
    let (directory, coordinator, reservation, spec) = fixture();
    let owner = reservation.owner.identity.clone();
    let locks = Directory::open(&directory.path().join("recovery/locks")).unwrap();
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (dropped_tx, dropped_rx) = mpsc::sync_channel(1);
    let mut future = Box::pin(crate::files::run_blocking(move || {
        let operation = reservation
            .promote_with(
                spec,
                move || {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(DEADLINE).unwrap();
                    Ok(())
                },
                || Ok(()),
            )
            .map_err(|failure| failure.error)?;
        Ok(Unobserved {
            operation: Some(operation),
            dropped: dropped_tx,
        })
    }));
    assert!(future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending());
    started_rx.recv_timeout(DEADLINE).unwrap();
    drop(future);
    let held = matches!(
        OperationLock::acquire(&locks, &owner).unwrap(),
        LockAttempt::Busy
    );
    // Release before asserting so a failed observation cannot strand a worker.
    release_tx.send(()).unwrap();
    dropped_rx.recv_timeout(DEADLINE).unwrap();
    assert!(
        held,
        "cancellation released the owner while catalog publication was active"
    );
    assert!(matches!(
        OperationLock::acquire(&locks, &owner).unwrap(),
        LockAttempt::Acquired(_)
    ));
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    assert_user_files_untouched(directory.path());
}

#[test]
fn rejected_context_promotion_returns_the_admission_for_an_exclusive_retry() {
    let (directory, coordinator, reservation, spec) = fixture();
    let admission = MutationAdmission::new(reservation);
    let context = admission.context();
    let failure = admission.promote(spec.clone()).err().unwrap();
    assert!(matches!(failure.error, AppError::MutationUncertain(_)));
    drop(context);
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    let operation = failure
        .admission
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    drop(operation);
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn killing_the_native_promoter_preserves_catalog_claims_on_both_sides_of_commit() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for boundary in ["catalog", "commit"] {
        let (directory, coordinator, reservation, spec) = fixture();
        reservation.finish().unwrap();
        drop(coordinator);
        fs::write(
            directory.path().join("operation.json"),
            serde_json::to_vec(&spec).unwrap(),
        )
        .unwrap();
        let ready = directory.path().join("promoter-ready");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "files::recovery::coordinator::promotion::tests::subprocess_promoter",
                "--ignored",
                "--nocapture",
            ])
            .env("EXPLORER_RECOVERY_PROMOTION_TEST", directory.path())
            .env("EXPLORER_RECOVERY_PROMOTION_BOUNDARY", boundary)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("promoter did not reach {boundary} boundary");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let storage = directory.path().join("recovery");
        assert_eq!(Coordinator::discover_catalog(&storage).unwrap().len(), 1);
        let reopened = Coordinator::open(&storage).unwrap();
        assert!(reopened
            .reserve(writing(&directory.path().join("target")))
            .is_err());
        reopened
            .reserve(writing(&directory.path().join("unrelated")))
            .unwrap()
            .finish()
            .unwrap();
        assert!(reopened
            .reserve(writing(&directory.path().join("source")))
            .is_err());
        assert_eq!(Coordinator::discover_catalog(&storage).unwrap().len(), 1);
        assert_user_files_untouched(directory.path());
    }
}

#[test]
#[ignore = "controlled helper for killing_the_native_promoter_preserves_catalog_claims_on_both_sides_of_commit"]
fn subprocess_promoter() {
    let directory = PathBuf::from(
        std::env::var_os("EXPLORER_RECOVERY_PROMOTION_TEST").expect("parent fixture"),
    );
    let boundary = std::env::var("EXPLORER_RECOVERY_PROMOTION_BOUNDARY").expect("parent boundary");
    let operation: OperationSpec =
        serde_json::from_slice(&fs::read(directory.join("operation.json")).unwrap()).unwrap();
    let OperationSpec::CopyReplacement(spec) = &operation else {
        panic!("expected copy replacement fixture");
    };
    let coordinator = Coordinator::open(&directory.join("recovery")).unwrap();
    let reservation = coordinator
        .reserve(vec![
            Request {
                path: spec.source.0.clone(),
                access: Access::Read,
                scope: Scope::Subtree,
            },
            Request {
                path: spec.target.0.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
            Request {
                path: spec.root.0.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
        ])
        .unwrap();
    let stop = || -> Result<(), AppError> {
        fs::write(directory.join("promoter-ready"), b"publication boundary")?;
        loop {
            std::thread::park();
        }
    };
    let _held = reservation
        .promote_with(
            operation,
            || {
                if boundary == "catalog" {
                    stop()
                } else {
                    Ok(())
                }
            },
            || if boundary == "commit" { stop() } else { Ok(()) },
        )
        .unwrap_or_else(|failure| panic!("{}", failure.error));
}

#[test]
fn large_immutable_intents_produce_small_phase_checkpoints() {
    use crate::files::recovery::replacement_transition::ReplacementTransition;
    let (directory, coordinator, reservation, spec) = fixture();
    let mut requests: Vec<_> = reservation
        .resources
        .iter()
        .map(|resource| Request {
            path: resource.path.0.clone(),
            access: resource.access,
            scope: resource.scope,
        })
        .collect();
    reservation.finish().unwrap();
    for index in 0..1024 {
        requests.push(Request {
            path: directory.path().join(format!("dependency-{index:04}")),
            access: Access::Read,
            scope: Scope::Entry,
        });
    }
    let reservation = coordinator.reserve(requests).unwrap();
    let mut operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let evidence = fs::read(
        directory
            .path()
            .join("recovery/catalog")
            .join(format!("{}.intent", operation.intent().id)),
    )
    .unwrap();
    assert!(evidence.len() > 64 * 1024);
    let initial = coordinator
        .admitted(|inner| Ok(inner.journal.records()?.remove(0)))
        .unwrap();
    assert!(
        initial.payload.len() < 512,
        "initial checkpoint includes the immutable plan"
    );
    operation.advance(ReplacementTransition::BeginRoot).unwrap();
    let advanced = coordinator
        .admitted(|inner| Ok(inner.journal.records()?.remove(0)))
        .unwrap();
    assert!(
        advanced.payload.len() < 512,
        "phase update rewrites the immutable plan"
    );
    assert!(advanced.generation > initial.generation);
    assert_eq!(
        fs::read(
            directory
                .path()
                .join("recovery/catalog")
                .join(format!("{}.intent", operation.intent().id))
        )
        .unwrap(),
        evidence
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn lost_phase_commit_reply_can_be_adopted_without_rewriting_the_checkpoint() {
    use crate::files::recovery::replacement_transition::ReplacementTransition;
    let (directory, coordinator, reservation, spec) = fixture();
    let mut operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    assert!(operation
        .advance_with(ReplacementTransition::BeginRoot, injected)
        .is_err());
    let before = coordinator
        .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
        .unwrap();
    operation.advance(ReplacementTransition::BeginRoot).unwrap();
    let after = coordinator
        .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(operation.generation, before.0);
    assert_user_files_untouched(directory.path());
}

#[test]
fn phase_writes_reject_missing_changed_or_substituted_catalog_evidence() {
    use crate::files::recovery::replacement_transition::ReplacementTransition;
    for case in ["missing", "corrupt", "substituted"] {
        let (directory, coordinator, reservation, spec) = fixture();
        let mut operation = reservation
            .promote(spec)
            .unwrap_or_else(|failure| panic!("{}", failure.error));
        let path = directory
            .path()
            .join("recovery/catalog")
            .join(format!("{}.intent", operation.intent().id));
        let before = coordinator
            .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
            .unwrap();
        match case {
            "missing" => fs::remove_file(&path).unwrap(),
            "corrupt" => fs::write(&path, b"corrupt framing").unwrap(),
            _ => {
                let retained = directory.path().join("original-catalog-file");
                fs::rename(&path, &retained).unwrap();
                fs::copy(&retained, &path).unwrap();
            }
        }
        assert!(
            operation.advance(ReplacementTransition::BeginRoot).is_err(),
            "{case}"
        );
        let after = coordinator
            .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(
            path.exists(),
            case != "missing",
            "phase write recreated missing evidence"
        );
        assert_user_files_untouched(directory.path());
    }
}

#[test]
fn phase_writes_require_the_exact_named_native_owner() {
    use crate::files::recovery::replacement_transition::ReplacementTransition;
    for case in ["missing", "changed-nonce", "substituted"] {
        let (directory, coordinator, reservation, spec) = fixture();
        let mut operation = reservation
            .promote(spec)
            .unwrap_or_else(|failure| panic!("{}", failure.error));
        let path = directory
            .path()
            .join("recovery/locks")
            .join(&operation.intent().lock.name);
        let before = coordinator
            .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
            .unwrap();
        match case {
            "missing" => fs::remove_file(&path).unwrap(),
            "changed-nonce" => fs::write(&path, [0; 32]).unwrap(),
            _ => {
                let retained = directory.path().join("original-owner-file");
                fs::rename(&path, &retained).unwrap();
                fs::copy(&retained, &path).unwrap();
            }
        }
        assert!(
            operation.advance(ReplacementTransition::BeginRoot).is_err(),
            "{case}"
        );
        let after = coordinator
            .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
            .unwrap();
        assert_eq!(before, after);
        assert_user_files_untouched(directory.path());
    }
}

#[test]
fn a_checkpoint_changed_without_its_generation_cannot_be_adopted_as_a_retry() {
    use crate::files::recovery::replacement_transition::{transition, ReplacementTransition};
    let (directory, coordinator, reservation, spec) = fixture();
    let mut operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let modified = OperationCheckpoint {
        intent_digest: operation.evidence.digest(),
        state: transition(
            operation.intent(),
            operation.state(),
            ReplacementTransition::BeginRoot,
        )
        .unwrap(),
    };
    let connection =
        rusqlite::Connection::open(directory.path().join("recovery").join(DATABASE)).unwrap();
    connection
        .execute(
            "UPDATE recovery_records SET payload = ?1 WHERE id = ?2",
            rusqlite::params![
                serde_json::to_vec(&modified).unwrap(),
                operation.intent().id
            ],
        )
        .unwrap();
    let before = coordinator
        .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
        .unwrap();
    assert!(operation.advance(ReplacementTransition::BeginRoot).is_err());
    assert_eq!(
        coordinator
            .admitted(|inner| Ok((inner.journal.revision()?, inner.journal.records()?)))
            .unwrap(),
        before
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn promotion_reserves_manifest_encoding_space_before_publishing_any_evidence() {
    let (directory, coordinator, reservation, spec) = fixture();
    let failure = reservation
        .promote_bounded(
            spec,
            || panic!("must not publish"),
            || panic!("must not commit"),
            1,
            crate::files::recovery::retention::Budget::default(),
        )
        .err()
        .unwrap();
    assert!(failure.error.to_string().contains("manifest storage limit"));
    assert!(coordinator
        .admitted(|inner| Ok(inner.catalog.records()?))
        .unwrap()
        .is_empty());
    failure.reservation.finish().unwrap();
    coordinator
        .reserve(writing(&directory.path().join("target")))
        .unwrap()
        .finish()
        .unwrap();
    assert_user_files_untouched(directory.path());
}
