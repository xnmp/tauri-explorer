//! A destination the user edited after a durable move is user data (#795,
//! ADR 0023): Undo is refused before any effect, the settled record keeps a
//! Discard that preserves the edit, and every restoration position the old
//! flow could strand still offers an action that ends the record.
use super::fixtures::*;
use super::planning_budget::effect_revision;
use super::readonly_umask::tree;
use super::undo::{deep, grow_past_plan, history_undo, plannable_deep_move};
use super::*;
use crate::files::recovery::{
    checkpoint::{Phase, State},
    coordinator::HistoryPosition,
    resources::{Access, Request, Scope},
};

const EDIT: &[u8] = b"user edit";

fn state(f: &Fixture) -> State {
    f.coordinator.inventory().unwrap().entries[0]
        .state
        .clone()
        .unwrap()
}

/// Whether ordinary admission may claim `path` for writing.
fn admitted(f: &Fixture, path: &std::path::Path) -> bool {
    match f.coordinator.reserve(vec![Request {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]) {
        Ok(reservation) => {
            reservation.finish().unwrap();
            true
        }
        Err(_) => false,
    }
}

fn inspect(f: &Fixture) -> crate::files::recovery::model::RecoveryItem {
    service::inspect(&f.coordinator, &f.id)
        .unwrap()
        .items
        .remove(0)
}

fn resolve(f: &Fixture, choice: RecoveryChoice) -> Option<String> {
    let item = inspect(f);
    assert!(
        item.actions.contains(&choice),
        "{choice:?} not offered: {:?}: {}",
        item.actions,
        item.message
    );
    service::resolve(&f.coordinator, &f.id, item.generation, choice)
        .unwrap()
        .error
}

/// Edit a moved file in place, or add an entry to a moved directory.
fn edit(target: &std::path::Path) {
    if target.is_dir() {
        fs::write(target.join("added"), EDIT).unwrap();
    } else {
        fs::write(target, EDIT).unwrap();
    }
}

/// Every layout whose destination stays meaningful after an edit: a
/// cross-volume copy, with and without an overwrite, and a same-volume
/// overwrite (its displaced original is retained).
fn layouts() -> [(bool, bool, bool); 5] {
    [
        (true, false, false),
        (true, false, true),
        (true, true, false),
        (false, true, false),
        (false, true, true),
    ]
}

#[test]
fn undo_of_an_edited_destination_is_refused_before_any_effect() {
    for (cross, overwrite, directory) in layouts() {
        let label = format!("cross={cross} overwrite={overwrite} directory={directory}");
        let f = Fixture::new(cross, overwrite, directory);
        let revision = effect_revision(&f);
        edit(&f.target);
        let before = state(&f);
        let target = tree(&f.target);
        let roots: Vec<_> = f.roots.iter().map(|root| tree(root)).collect();

        let error = history_undo(&f, revision).expect_err(&label);

        // Unchanged, so the same Undo entry is kept rather than consumed.
        assert!(
            !matches!(error, AppError::MutationUncertain(_)),
            "{label}: {error}"
        );
        assert!(
            error.to_string().contains("Nothing was changed"),
            "{label}: {error}"
        );
        assert!(
            error.to_string().contains("changed after the move"),
            "{label}: {error}"
        );
        assert!(!f.source.exists(), "{label}: the source was returned");
        assert_eq!(tree(&f.target), target, "{label}");
        assert_eq!(
            f.roots.iter().map(|root| tree(root)).collect::<Vec<_>>(),
            roots,
            "{label}"
        );
        let after = state(&f);
        assert_eq!(after, before, "{label}: the record left its settled state");
        assert_ne!(after.phase, Phase::RestoreIntent, "{label}");
        assert!(f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .is_some());
        // A settled record never claims the destination the user now owns.
        assert!(admitted(&f, &f.target), "{label}");
    }
}

#[test]
fn file_recovery_restore_of_an_edited_destination_never_half_applies() {
    let f = Fixture::new(true, true, false);
    edit(&f.target);
    let before = state(&f);
    let generation = f.coordinator.inventory().unwrap().entries[0]
        .generation
        .unwrap();
    let reply =
        service::resolve(&f.coordinator, &f.id, generation, RecoveryChoice::Restore).unwrap();
    assert!(reply.error.is_some(), "an edited destination was restored");
    assert!(!f.source.exists());
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);
    assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
    assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    assert_eq!(state(&f), before);
}

#[test]
fn undo_is_refused_when_another_entry_took_the_source_name() {
    for cross in [true, false] {
        let f = Fixture::new(cross, false, false);
        let revision = effect_revision(&f);
        fs::write(&f.source, b"new entry at the source name").unwrap();
        let before = state(&f);
        let error = history_undo(&f, revision).unwrap_err().to_string();
        assert!(error.contains("Nothing was changed"), "{error}");
        assert_eq!(
            fs::read(&f.source).unwrap(),
            b"new entry at the source name"
        );
        assert_eq!(fs::read(&f.target).unwrap(), MOVED);
        assert_eq!(state(&f), before);
    }
}

#[test]
fn an_edited_destination_offers_discard_which_keeps_the_edit_and_releases_claims() {
    for (cross, overwrite, directory) in layouts() {
        let label = format!("cross={cross} overwrite={overwrite} directory={directory}");
        let f = Fixture::new(cross, overwrite, directory);
        edit(&f.target);
        let target = tree(&f.target);

        let item = inspect(&f);
        assert_eq!(
            item.actions,
            vec![RecoveryChoice::Discard],
            "{label}: {}",
            item.message
        );
        assert!(
            item.message.contains("changed after the move"),
            "{label}: {}",
            item.message
        );
        let error = resolve(&f, RecoveryChoice::Discard);

        assert!(error.is_none(), "{label}: {error:?}");
        f.assert_retired();
        assert_eq!(
            tree(&f.target),
            target,
            "{label}: the edit was not preserved"
        );
        assert!(!f.source.exists(), "{label}");
        assert!(admitted(&f, &f.target), "{label}");
        assert!(admitted(&f, &f.source), "{label}");
    }
}

#[test]
fn an_unedited_destination_still_offers_restore_and_discard() {
    for (cross, overwrite, directory) in layouts() {
        let label = format!("cross={cross} overwrite={overwrite} directory={directory}");
        let f = Fixture::new(cross, overwrite, directory);
        let item = inspect(&f);
        assert_eq!(
            item.actions,
            vec![RecoveryChoice::Restore, RecoveryChoice::Discard],
            "{label}: {}",
            item.message
        );
        let revision = effect_revision(&f);
        history_undo(&f, revision).unwrap_or_else(|error| panic!("{label}: {error}"));
        if directory {
            assert_eq!(fs::read(f.source.join("entry")).unwrap(), MOVED, "{label}");
        } else {
            assert_eq!(fs::read(&f.source).unwrap(), MOVED, "{label}");
        }
    }
}

/// The user deleted the destination: Undo returns the source, and the restored
/// record, which retains no publication, can still be forgotten.
#[test]
fn a_deleted_destination_restores_and_the_record_can_then_be_forgotten() {
    let f = Fixture::new(true, false, false);
    let revision = effect_revision(&f);
    fs::remove_file(&f.target).unwrap();
    history_undo(&f, revision).unwrap();
    assert_eq!(fs::read(&f.source).unwrap(), MOVED);
    assert_eq!(state(&f).phase, Phase::Restored);

    let item = inspect(&f);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Release],
        "{}",
        item.message
    );
    assert!(item.message.contains("Forget"), "{}", item.message);
    assert!(resolve(&f, RecoveryChoice::Release).is_none());

    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(fs::read(&f.source).unwrap(), MOVED);
    assert!(!f.target.exists());
    assert!(admitted(&f, &f.source));
    assert!(admitted(&f, &f.target));
}

/// A restoration interrupted after the source came home, by a destination
/// the user changed or grew while Undo ran, is never left with only a Restore
/// that cannot succeed: Forget ends it and releases both endpoints.
#[test]
fn a_restoration_stranded_by_its_destination_can_be_forgotten() {
    for growth in [false, true] {
        let f = if growth {
            plannable_deep_move()
        } else {
            Fixture::new(true, false, false)
        };
        let target = f.target.clone();
        let result = MoveExecution::reopen(f.claim())
            .unwrap()
            .with_boundary(Box::new(move |label| {
                if label == "restore-intent" {
                    if growth {
                        grow_past_plan(&deep(&target));
                    } else {
                        fs::write(&target, EDIT).unwrap();
                    }
                }
                Ok(())
            }))
            .restore_move();
        assert!(result.is_err(), "growth={growth}");
        assert_eq!(state(&f).phase, Phase::RestoreIntent);
        assert!(f.source.exists(), "growth={growth}: the source is home");
        let destination = tree(&f.target);
        assert!(
            !admitted(&f, &f.target),
            "an unresolved record owns its endpoints"
        );

        let item = inspect(&f);
        assert_eq!(
            item.actions,
            vec![RecoveryChoice::Release],
            "{}",
            item.message
        );
        // Restore is refused up front and changes nothing.
        let generation = item.generation;
        let reply =
            service::resolve(&f.coordinator, &f.id, generation, RecoveryChoice::Restore).unwrap();
        assert!(reply.error.is_some(), "growth={growth}");
        assert_eq!(tree(&f.target), destination);
        assert!(
            resolve(&f, RecoveryChoice::Release).is_none(),
            "growth={growth}"
        );

        assert!(f.coordinator.inventory().unwrap().entries.is_empty());
        assert_eq!(tree(&f.target), destination, "growth={growth}");
        assert!(f.source.exists());
        assert!(admitted(&f, &f.target), "growth={growth}");
        assert!(admitted(&f, &f.source), "growth={growth}");
    }
}

/// Forget is offered only where nothing else can resolve the record.
#[test]
fn forget_is_refused_for_a_record_restore_or_discard_can_resolve() {
    let f = Fixture::new(true, false, false);
    let generation = inspect(&f).generation;
    let reply =
        service::resolve(&f.coordinator, &f.id, generation, RecoveryChoice::Release).unwrap();
    assert!(reply.error.is_some());
    assert_eq!(f.coordinator.inventory().unwrap().entries.len(), 1);
    assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
}

/// A discard interrupted after its decision and withdrawn on resumption (the
/// destination was gone, so the parked source was its only copy) returns to a
/// settled record. Once the user puts an edited destination back, that record
/// offers exactly a Discard which ends it and keeps the edit.
#[test]
fn a_withdrawn_discard_with_an_edited_destination_keeps_a_working_exit() {
    let f = Fixture::new(true, true, false);
    crash_at(&f, "intent", || {});
    fs::remove_file(&f.target).unwrap();
    let withdrawn = resolve(&f, RecoveryChoice::Discard).expect("discard was not withdrawn");
    assert!(withdrawn.contains("withdrawn"), "{withdrawn}");
    assert!(state(&f).retirement.is_none());
    fs::write(&f.target, EDIT).unwrap();

    let item = inspect(&f);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Discard],
        "{}",
        item.message
    );
    assert!(resolve(&f, RecoveryChoice::Discard).is_none());

    f.assert_retired();
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);
    assert!(admitted(&f, &f.target));
}

/// A refusal the user can resolve is not stranding: a new entry at the source
/// name offers no Forget, and Forget is refused, until the name is free again.
#[test]
fn a_reused_source_name_is_not_forgettable() {
    let f = Fixture::new(true, false, false);
    edit(&f.target);
    fs::write(&f.source, b"new entry at the source name").unwrap();
    let item = inspect(&f);
    assert!(
        item.actions.is_empty(),
        "{:?}: {}",
        item.actions,
        item.message
    );
    assert!(
        item.message.contains("Move or rename it"),
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
    assert!(reply.error.is_some());
    assert_eq!(f.coordinator.inventory().unwrap().entries.len(), 1);
    // Freeing the name restores the edited destination's Discard.
    fs::remove_file(&f.source).unwrap();
    assert!(resolve(&f, RecoveryChoice::Discard).is_none());
    f.assert_retired();
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);
}

/// Unverifiable recovery roots are never proof that a record is stranded: it
/// is preserved, with no Forget, rather than released, whether it is settled
/// or restored without a publication.
#[test]
fn unverifiable_roots_are_never_forgettable() {
    for restored in [false, true] {
        for attack in ["manifest", "missing-root"] {
            let label = format!("{attack} restored={restored}");
            let f = Fixture::new(true, true, false);
            if restored {
                fs::remove_file(&f.target).unwrap();
                history_undo(&f, effect_revision(&f)).unwrap();
                assert_eq!(state(&f).phase, Phase::Restored, "{label}");
            }
            match attack {
                "manifest" => fs::write(f.roots[0].join("manifest.intent"), b"corrupt").unwrap(),
                "missing-root" => {
                    fs::rename(&f.roots[1], f.roots[1].with_extension("saved")).unwrap()
                }
                _ => unreachable!(),
            }
            let item = inspect(&f);
            assert!(
                !item.actions.contains(&RecoveryChoice::Release),
                "{label}: {:?}: {}",
                item.actions,
                item.message
            );
            let reply = service::resolve(
                &f.coordinator,
                &f.id,
                item.generation,
                RecoveryChoice::Release,
            )
            .unwrap();
            assert!(reply.error.is_some(), "{label}");
            assert_eq!(
                f.coordinator.inventory().unwrap().entries.len(),
                1,
                "{label}"
            );
        }
    }
}

/// A stranded restoration whose returned source the user has since edited
/// can never verify that source again: Forget, not Restore, ends it, and the
/// edit is kept.
#[test]
fn a_stranded_restoration_with_an_edited_returned_source_can_be_forgotten() {
    let f = Fixture::new(true, false, false);
    let target = f.target.clone();
    let result = MoveExecution::reopen(f.claim())
        .unwrap()
        .with_boundary(Box::new(move |label| {
            if label == "restore-intent" {
                fs::write(&target, EDIT).unwrap();
            }
            Ok(())
        }))
        .restore_move();
    assert!(result.is_err());
    assert_eq!(state(&f).phase, Phase::RestoreIntent);
    fs::write(&f.source, b"edited after its return").unwrap();

    let item = inspect(&f);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Release],
        "{}",
        item.message
    );
    assert!(resolve(&f, RecoveryChoice::Release).is_none());

    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(fs::read(&f.source).unwrap(), b"edited after its return");
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);
    assert!(admitted(&f, &f.source));
    assert!(admitted(&f, &f.target));
}

/// An interrupted discard resumed after the destination was edited finishes
/// and keeps the edit.
#[test]
fn an_interrupted_discard_finishes_after_the_destination_is_edited() {
    let f = Fixture::new(true, false, false);
    crash_at(&f, "intent", || {});
    edit(&f.target);
    assert!(resolve(&f, RecoveryChoice::Discard).is_none());
    f.assert_retired();
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);
}

/// A park interrupted after the source was hidden is not settled: with an
/// edited destination, Restore first brings the original home (keeping the
/// edit public) and only then can Forget end the record (#795 review).
#[test]
fn an_interrupted_park_with_an_edited_destination_returns_the_source_first() {
    let f = Fixture::interrupted_at("park");
    assert_eq!(state(&f).phase, Phase::ParkIntent);
    assert!(!f.source.exists(), "the source was parked");
    edit(&f.target);

    let item = inspect(&f);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Restore],
        "{}",
        item.message
    );
    let generation = item.generation;
    let reply =
        service::resolve(&f.coordinator, &f.id, generation, RecoveryChoice::Restore).unwrap();
    assert!(
        reply.error.is_some(),
        "the edited destination cannot be parked"
    );
    assert_eq!(
        fs::read(&f.source).unwrap(),
        MOVED,
        "the original came home"
    );
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);

    let item = inspect(&f);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Release],
        "{}",
        item.message
    );
    assert!(item.message.contains("Forget"), "{}", item.message);
    assert!(!item.message.contains("discard"), "{}", item.message);
    assert!(resolve(&f, RecoveryChoice::Release).is_none());
    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(fs::read(&f.source).unwrap(), MOVED);
    assert_eq!(fs::read(&f.target).unwrap(), EDIT);
    assert!(admitted(&f, &f.target));
}
