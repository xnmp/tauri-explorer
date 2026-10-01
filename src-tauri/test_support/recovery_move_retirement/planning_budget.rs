//! Retirement planning and byte-budget refusal: unplannable trees, decision
//! withdrawal, journal headroom, and stranded/forgotten discards.
use super::fixtures::*;
use super::readonly_umask::tree;
use super::*;

/// A tree no retirement plan can record: deeper than any plan's depth
/// bound. (Plan byte and entry bounds are exercised directly in
/// `recovery_checkpoint.rs`; trees that exceed them take tens of thousands
/// of files.)
pub(super) fn unplannable_tree(root: &std::path::Path) {
    let mut deepest = root.to_owned();
    for _ in 0..=256 {
        deepest.push("d");
    }
    fs::create_dir_all(&deepest).unwrap();
    fs::write(deepest.join("leaf"), b"x").unwrap();
}

pub(super) fn private_residue(parent: &std::path::Path) -> Vec<std::ffi::OsString> {
    fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| {
            name.to_string_lossy()
                .starts_with(".tauri-explorer-recovery-")
        })
        .collect()
}

#[test]
fn a_payload_that_could_never_be_discarded_is_refused_before_any_record_or_effect() {
    for overwrite_only in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in("/dev/shm").unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        // Cross volume: the source would be parked. Same volume with an
        // overwrite: the displaced destination would be retained.
        let (source, target) = if overwrite_only {
            fs::write(base_path.join("source"), MOVED).unwrap();
            unplannable_tree(&base_path.join("target"));
            (base_path.join("source"), base_path.join("target"))
        } else {
            let shared_path = fs::canonicalize(shared.path()).unwrap();
            unplannable_tree(&shared_path.join("source"));
            (shared_path.join("source"), base_path.join("target"))
        };
        let coordinator = Coordinator::open(&base_path.join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        let result = PreparedMove::prepare(&coordinator, &source, &target)
            .and_then(|prepared| prepared.execute(&mut progress));
        let error = match result {
            Ok(_) => {
                // Admitted: it must then be discardable, or it is stuck forever.
                let entry = coordinator.inventory().unwrap().entries.remove(0);
                let operation = coordinator
                    .try_claim(&entry.intent.id, entry.generation.unwrap())
                    .unwrap()
                    .unwrap();
                let discard = Retirement::open(operation).unwrap().retire_with(|_| Ok(()));
                panic!("an unplannable payload was admitted; its discard returned {discard:?}");
            }
            Err(error) => error.to_string(),
        };
        assert!(error.contains("Nothing was moved"), "{error}");
        assert!(coordinator.inventory().unwrap().entries.is_empty());
        assert!(source.exists());
        assert_eq!(overwrite_only, target.exists());
        assert!(private_residue(source.parent().unwrap()).is_empty());
        assert!(private_residue(target.parent().unwrap()).is_empty());
    }
}

pub(super) fn effect_revision(f: &Fixture) -> u64 {
    f.coordinator.inventory().unwrap().entries[0]
        .state
        .as_ref()
        .unwrap()
        .effect_revision
}

#[test]
fn an_endpoint_change_after_the_discard_decision_withdraws_it_and_keeps_undo() {
    use crate::files::recovery::coordinator::HistoryPosition;
    // Both boundaries follow a journaled decision but precede every unlink.
    for boundary in ["intent", "source-intent"] {
        let f = Fixture::new(true, true, false);
        let revision = effect_revision(&f);
        let result = f.retirement().retire_with(|label| {
            if label == boundary {
                // A foreign entry now occupies the vacated source name.
                fs::write(&f.source, b"new entry at the source name")?;
            }
            Ok(())
        });
        let error = result.unwrap_err().to_string();
        assert!(error.contains("withdrawn"), "{boundary}: {error}");
        assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
        assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
        // The committed decision is gone: history can claim the record again.
        let claimed = f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap_or_else(|error| panic!("{boundary}: Undo was consumed: {error}"))
            .unwrap();
        drop(claimed);
        // Once the name is free again, the same Undo returns both entries.
        fs::remove_file(&f.source).unwrap();
        let operation = f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .unwrap();
        MoveExecution::reopen(operation)
            .unwrap()
            .restore_move()
            .unwrap();
        assert_eq!(fs::read(&f.source).unwrap(), MOVED, "{boundary}");
        assert_eq!(fs::read(&f.target).unwrap(), OLD, "{boundary}");
    }
}

#[test]
fn a_decision_that_already_removed_a_planned_entry_is_never_withdrawn() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, true, true, |source| {
        fs::create_dir(source).unwrap();
        fs::write(source.join("a"), MOVED).unwrap();
        fs::write(source.join("b"), MOVED).unwrap();
    });
    let revision = effect_revision(&f);
    let mut removed = 0;
    let result = f.retirement().retire_with(|label| {
        if label == "entry-removed" {
            removed += 1;
            if removed == 1 {
                fs::write(&f.source, b"new entry at the source name")?;
                return Err(invalid("interrupted after the first unlink"));
            }
        }
        Ok(())
    });
    assert!(result.is_err());
    let parked = f.roots[0].join("parked");
    let survivors = ["a", "b"]
        .iter()
        .filter(|name| parked.join(name).exists())
        .count();
    assert_eq!(survivors, 1, "exactly one planned file was removed");
    // A resumed attempt observes the missing child and must not withdraw.
    assert!(f.retirement().retire_with(|_| Ok(())).is_err());
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .is_err());
    assert!(parked.is_dir());
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
}

#[test]
fn an_interrupted_decision_resumed_after_an_endpoint_change_withdraws_itself() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::new(true, true, false);
    let revision = effect_revision(&f);
    let interrupted = f.retirement().retire_with(|label| match label {
        "intent" => Err(invalid("interrupted after the decision")),
        _ => Ok(()),
    });
    assert!(interrupted.is_err());
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .is_err());
    fs::write(&f.target, b"edited while the decision was pending").unwrap();
    // The explicit retry proves the change and returns the decision.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    let error = reply.error.unwrap_or_default();
    assert!(error.contains("withdrawn"), "{error}");
    assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
    assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
}

pub(super) fn generation(f: &Fixture) -> u64 {
    f.coordinator.inventory().unwrap().entries[0]
        .generation
        .unwrap()
}

/// A cross-volume directory move whose discard removed one planned file and
/// then stopped, as a crash (`crash`) or as a reported failure.
pub(super) fn partially_retired(crash: bool) -> Fixture {
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir(source).unwrap();
        fs::write(source.join("a"), MOVED).unwrap();
        fs::write(source.join("b"), MOVED).unwrap();
    });
    if crash {
        crash_at(&f, "entry-removed", || {});
    } else {
        let stopped = f.retirement().retire_with(|label| match label {
            "entry-removed" => Err(invalid("stopped after the first unlink")),
            _ => Ok(()),
        });
        assert!(stopped.is_err());
    }
    let parked = f.roots[0].join("parked");
    assert_eq!(
        ["a", "b"]
            .iter()
            .filter(|name| parked.join(name).exists())
            .count(),
        1
    );
    f
}

#[test]
fn a_reported_retirement_failure_is_never_reclaimed_by_enforcement() {
    let f = partially_retired(false);
    let before = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
        assert!(
            !f.coordinator.inventory().unwrap().entries.is_empty(),
            "a reported failure was retried automatically"
        );
    }
    assert_eq!(
        generation(&f),
        before,
        "enforcement churned a reported failure"
    );
    assert!(f.roots[0].join("parked").is_dir());
    // Only the user's explicit retry finishes the committed decision.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert_eq!(
        snapshot.items[0].actions,
        vec![RecoveryChoice::Discard, RecoveryChoice::Release]
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}

#[test]
fn an_interrupted_retirement_that_cannot_resume_is_claimed_at_most_once() {
    let f = partially_retired(true);
    // The public endpoint no longer proves the committed plan.
    fs::write(&f.source, b"foreign entry at the vacated source").unwrap();
    retirement::enforce(&f.coordinator).unwrap();
    let after_first = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert_eq!(
        generation(&f),
        after_first,
        "enforcement re-claims every pass"
    );
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(
        snapshot.items[0].message.contains("Discard stopped"),
        "{}",
        snapshot.items[0].message
    );
    assert!(f.roots[0].join("parked").is_dir());
}

#[test]
fn a_decision_the_journal_cannot_hold_with_headroom_is_refused_before_consuming_undo() {
    use crate::files::recovery::{coordinator::HistoryPosition, journal::MAX_TOTAL_BYTES};
    let f = Fixture::new(true, true, true);
    let revision = effect_revision(&f);
    let before = generation(&f);
    // No journal can grow a record while leaving all of itself free.
    let error = f
        .retirement()
        .leaving(MAX_TOTAL_BYTES)
        .retire_with(|_| Ok(()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("too many unfinished discards"), "{error}");
    assert!(error.contains("Undo is kept"), "{error}");
    assert_eq!(fs::read(f.roots[0].join("parked/entry")).unwrap(), MOVED);
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
    // Only the claim itself advanced the generation; no decision was journaled.
    assert_eq!(generation(&f), before + 1);
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
}

fn write_claim(f: &Fixture) -> Result<(), AppError> {
    use crate::files::recovery::resources::{Access, Request, Scope};
    f.coordinator
        .reserve(vec![Request {
            path: f.target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])?
        .finish()
}

#[test]
fn a_stranded_discard_can_be_forgotten_without_touching_any_file() {
    let f = partially_retired(false);
    // The vacated source is reused, so the committed plan can never finish.
    fs::write(&f.source, b"foreign entry at the vacated source").unwrap();
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = snapshot.items[0].clone();
    assert!(
        item.actions.contains(&RecoveryChoice::Release),
        "{:?}: {}",
        item.actions,
        item.message
    );
    assert!(
        write_claim(&f).is_err(),
        "the stranded record locks the moved entry"
    );
    let before = tree(&f.roots[0]);
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Release,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(
        tree(&f.roots[0]),
        before,
        "forgetting removed or changed a file"
    );
    assert_eq!(
        fs::read(&f.source).unwrap(),
        b"foreign entry at the vacated source"
    );
    write_claim(&f).expect("forgetting released the record's locks");
}

#[test]
fn a_discard_whose_volume_changed_identity_can_still_be_forgotten() {
    let f = partially_retired(true);
    // The source volume's parent is replaced: nothing can be observed there.
    let parent = f.roots[0].parent().unwrap().to_owned();
    let away = parent.with_extension("away");
    fs::rename(&parent, &away).unwrap();
    fs::create_dir(&parent).unwrap();
    let before = tree(&away);
    retirement::enforce(&f.coordinator).unwrap();
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = snapshot.items[0].clone();
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Release],
        "{}",
        item.message
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Release,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(tree(&away), before);
    fs::remove_dir(&parent).unwrap();
    fs::rename(&away, &parent).unwrap();
}

#[test]
fn only_a_stopped_discard_can_be_forgotten() {
    use crate::files::recovery::coordinator::HistoryPosition;
    for cross in [false, true] {
        let f = Fixture::new(cross, true, false);
        let revision = effect_revision(&f);
        let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
        assert!(!snapshot.items[0].actions.contains(&RecoveryChoice::Release));
        let reply = service::resolve(
            &f.coordinator,
            &f.id,
            snapshot.items[0].generation,
            RecoveryChoice::Release,
        )
        .unwrap();
        assert!(reply.error.is_some(), "a settled move was forgotten");
        assert!(f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .is_some());
    }
    // A resumable interruption offers only the retry that finishes it.
    let f = Fixture::new(true, true, false);
    crash_at(&f, "source-completed", || {});
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert_eq!(snapshot.items[0].actions, vec![RecoveryChoice::Discard]);
}
