use super::super::test_fixture::*;
use super::*;

fn promoted(
    reservation: Reservation,
    spec: super::super::super::model::OperationSpec,
) -> DurableOperation {
    reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error))
}

fn rows(coordinator: &Coordinator) -> Vec<super::super::super::journal::Record> {
    coordinator
        .admitted(|inner| inner.journal.records())
        .unwrap()
}

#[test]
fn claim_preserves_exact_authority_and_state_while_advancing_ownership_generation() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = promoted(reservation, spec);
    let expected_intent = operation.intent().clone();
    let expected_state = operation.state().clone();
    let generation = operation.generation;
    let initial = rows(&coordinator);
    let peer = Coordinator::open(&directory.path().join("recovery")).unwrap();
    assert!(peer
        .try_claim(&expected_intent.id, generation)
        .unwrap()
        .is_none());
    assert_eq!(rows(&coordinator), initial);
    drop(operation);
    coordinator
        .reserve(writing(&directory.path().join("unrelated")))
        .unwrap()
        .finish()
        .unwrap();

    let claimed = peer
        .try_claim(&expected_intent.id, generation)
        .unwrap()
        .unwrap();
    assert_eq!(claimed.intent(), &expected_intent);
    assert_eq!(claimed.state(), &expected_state);
    assert!(claimed.generation > generation);
    assert_eq!(rows(&coordinator)[0].payload, initial[0].payload);
    let current = claimed.generation;
    assert!(coordinator
        .try_claim(&expected_intent.id, current)
        .unwrap()
        .is_none());
    assert!(coordinator
        .try_claim(&expected_intent.id, generation)
        .is_err());
    assert_eq!(rows(&coordinator)[0].generation, current);
    drop(claimed);
    let again = coordinator
        .try_claim(&expected_intent.id, current)
        .unwrap()
        .unwrap();
    assert!(again.generation > current);
    assert_eq!(again.intent().lock, expected_intent.lock);
    assert_user_files_untouched(directory.path());
}

#[test]
fn independent_claimants_cannot_both_own_the_same_checkpoint() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = promoted(reservation, spec);
    let id = operation.intent().id.clone();
    let generation = operation.generation;
    drop(operation);
    let peer = Coordinator::open(&directory.path().join("recovery")).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = [coordinator, peer]
        .into_iter()
        .map(|coordinator| {
            let barrier = Arc::clone(&barrier);
            let id = id.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let result = coordinator.try_claim(&id, generation);
                barrier.wait(); // Keep the winner's owner alive through both attempts.
                result.is_ok_and(|claim| claim.is_some())
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>(),
        1
    );
    assert_user_files_untouched(directory.path());
}

#[test]
fn missing_or_changed_evidence_never_grants_recovery_ownership() {
    for damage in [
        "catalog-missing",
        "catalog-corrupt",
        "lock-missing",
        "lock-replaced",
        "checkpoint-digest",
        "checkpoint-missing",
    ] {
        let (directory, coordinator, reservation, spec) = fixture();
        let operation = promoted(reservation, spec);
        let id = operation.intent().id.clone();
        let generation = operation.generation;
        let lock = directory
            .path()
            .join("recovery/locks")
            .join(&operation.intent().lock.name);
        let catalog = directory
            .path()
            .join("recovery/catalog")
            .join(format!("{id}.intent"));
        drop(operation);
        match damage {
            "catalog-missing" => fs::remove_file(&catalog).unwrap(),
            "catalog-corrupt" => fs::write(&catalog, b"corrupt evidence").unwrap(),
            "lock-missing" => fs::remove_file(&lock).unwrap(),
            "lock-replaced" => {
                fs::rename(&lock, directory.path().join("held-lock")).unwrap();
                fs::write(&lock, [0u8; 32]).unwrap();
            }
            "checkpoint-digest" => coordinator
                .admitted(|inner| {
                    let mut checkpoint: OperationCheckpoint =
                        decode(&inner.journal.records()?[0].payload)?;
                    checkpoint.intent_digest = [0; 32];
                    inner.journal.replace(
                        &id,
                        generation,
                        &serde_json::to_vec(&checkpoint).unwrap(),
                    )?;
                    Ok(())
                })
                .unwrap(),
            "checkpoint-missing" => coordinator
                .admitted(|inner| inner.journal.remove(&id, generation).map(|_| ()))
                .unwrap(),
            _ => unreachable!(),
        }
        let before = rows(&coordinator);
        let request_generation = before.first().map_or(generation, |row| row.generation);
        assert!(
            coordinator.try_claim(&id, request_generation).is_err(),
            "{damage}"
        );
        assert_eq!(
            rows(&coordinator),
            before,
            "{damage} must not rewrite evidence"
        );
        assert_user_files_untouched(directory.path());
    }
}

#[test]
fn lost_claim_commit_reply_requires_a_fresh_generation_without_losing_evidence() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = promoted(reservation, spec);
    let id = operation.intent().id.clone();
    let generation = operation.generation;
    let expected = operation.intent().clone();
    drop(operation);
    assert!(coordinator
        .try_claim_with(&id, generation, injected)
        .is_err());
    let current = rows(&coordinator)[0].generation;
    assert!(current > generation);
    assert!(coordinator.try_claim(&id, generation).is_err());
    let claimed = coordinator.try_claim(&id, current).unwrap().unwrap();
    assert_eq!(claimed.intent(), &expected);
    assert!(claimed.generation > current);
    assert_user_files_untouched(directory.path());
}

#[test]
fn corrupt_unrelated_journal_rows_fence_claims_without_changing_the_selected_checkpoint() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = promoted(reservation, spec);
    let id = operation.intent().id.clone();
    let generation = operation.generation;
    drop(operation);
    coordinator
        .admitted(|inner| {
            inner
                .journal
                .insert("malformed", RecordKind::Reservation, b"{}")?;
            Ok(())
        })
        .unwrap();
    let before = rows(&coordinator);
    assert!(coordinator.try_claim(&id, generation).is_err());
    assert_eq!(rows(&coordinator), before);
    assert_user_files_untouched(directory.path());
}

#[test]
fn ownership_claim_does_not_require_available_user_files_or_invent_an_artifact_root() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = promoted(reservation, spec);
    let id = operation.intent().id.clone();
    let generation = operation.generation;
    drop(operation);
    fs::remove_file(directory.path().join("source")).unwrap();
    fs::remove_file(directory.path().join("target")).unwrap();
    let claimed = coordinator.try_claim(&id, generation).unwrap().unwrap();
    assert!(
        super::super::super::replacement_execution::ReplacementExecution::reopen(claimed).is_err()
    );
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts")
        .exists());
    assert!(!directory.path().join("source").exists());
    assert!(!directory.path().join("target").exists());
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn overlapping_catalog_authority_blocks_claim_without_rewriting_either_intent() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = promoted(reservation, spec);
    let id = operation.intent().id.clone();
    let generation = operation.generation;
    let mut competing = operation.intent().clone();
    drop(operation);
    let other_owner = coordinator
        .admitted(|inner| {
            let owner = OperationLock::create(&inner.locks)?;
            competing.id = owner.identity.name.trim_end_matches(".lock").to_owned();
            competing.lock = owner.identity.clone();
            competing.validate()?;
            inner
                .catalog
                .ensure_exact(&competing.id, &serde_json::to_vec(&competing).unwrap())?;
            Ok(owner)
        })
        .unwrap();
    let before = rows(&coordinator);
    let catalog = Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap();
    assert!(coordinator.try_claim(&id, generation).is_err());
    assert_eq!(rows(&coordinator), before);
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap(),
        catalog
    );
    assert_user_files_untouched(directory.path());
    drop(other_owner);
}
