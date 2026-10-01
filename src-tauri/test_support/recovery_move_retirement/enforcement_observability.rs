//! Enforcement only claims what it can observe (PR #790 review N5): retries
//! for unresumable interruptions, and root/parent identity that cannot be
//! opened.
use super::fixtures::*;
use super::planning_budget::{effect_revision, generation, partially_retired};
use super::readonly_umask::{running_as_root, set_mode};
use super::*;

#[test]
fn an_automatic_retirement_that_cannot_start_is_reported_once_and_left_for_a_retry() {
    if running_as_root() {
        return;
    }
    let f = Fixture::new(true, false, false);
    f.restore();
    // Undo retained the published copy; its root no longer permits removal.
    let root = f.roots[1].clone();
    assert!(root.join("publication").exists());
    set_mode(&root, 0o500);
    retirement::enforce(&f.coordinator).unwrap();
    let after_first = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    let after_passes = generation(&f);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    set_mode(&root, 0o700);
    assert_eq!(
        after_passes, after_first,
        "enforcement re-claimed an automatic retirement that cannot start"
    );
    let item = &snapshot.items[0];
    assert!(item.message.contains("could not start"), "{}", item.message);
    assert!(
        item.message.contains("Permission denied"),
        "{}",
        item.message
    );
    assert_eq!(item.actions, vec![RecoveryChoice::Discard]);
    assert!(root.join("publication").exists());
    // The user's explicit retry, after the condition is fixed, finishes it.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
    assert_eq!(fs::read(&f.source).unwrap(), MOVED);
}

#[test]
fn forget_names_the_folders_that_still_hold_files() {
    // Stopped between roots: the source root is gone, the target root keeps
    // the displaced original.
    let f = Fixture::new(true, true, false);
    let stopped = f.retirement().retire_with(|label| match label {
        "source-completed" => Err(invalid("stopped between roots")),
        _ => Ok(()),
    });
    assert!(stopped.is_err());
    assert!(!f.roots[0].exists(), "the source root was removed");
    assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.actions.contains(&RecoveryChoice::Release));
    let target_root = f.roots[1].to_string_lossy().into_owned();
    assert_eq!(item.retained_paths, vec![target_root.clone()]);
    assert_eq!(
        item.retained_path.as_deref(),
        Some(target_root.as_str()),
        "Forget's confirmation names a folder that no longer exists"
    );
    assert!(
        item.message.contains("the listed folder"),
        "{}",
        item.message
    );
    // A root whose removal started but never completed may still hold any
    // of its files, so Forget names it alongside the root still awaiting it.
    let f = partially_retired(false);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.actions.contains(&RecoveryChoice::Release));
    let shown: Vec<_> = f
        .roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    assert_eq!(item.retained_paths, shown);
    assert!(f.roots.iter().all(|root| root.exists()));
    assert!(
        item.message.contains("each listed folder"),
        "{}",
        item.message
    );
}

#[test]
fn an_unobservable_retiring_record_is_never_claimed_by_enforcement() {
    let f = partially_retired(true);
    // The source root's volume directory is replaced by another object, as
    // when a different filesystem is mounted where the recorded one was.
    let parent = f.roots[0].parent().unwrap().to_path_buf();
    let away = parent.with_extension("away");
    fs::rename(&parent, &away).unwrap();
    fs::create_dir(&parent).unwrap();
    let before = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert_eq!(
        generation(&f),
        before,
        "enforcement claimed a retirement whose anchors it could not observe"
    );
    let parked = away.join(f.roots[0].file_name().unwrap()).join("parked");
    assert!(parked.is_dir(), "retained bytes were touched while away");
    // Once the recorded volume is back, the interrupted retirement resumes.
    fs::remove_dir(&parent).unwrap();
    fs::rename(&away, &parent).unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 0);
    f.assert_retired();
}

#[test]
fn a_root_that_drifts_from_its_plan_while_planning_keeps_undo() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("dir/sub")).unwrap();
        fs::write(source.join("dir/sub/planned"), MOVED).unwrap();
    });
    let revision = effect_revision(&f);
    // Deep inside the retained payload, so the payload's own version, which
    // proves the endpoint, is unchanged: only the captured plan can see it.
    let foreign = f.roots[0].join("parked/dir/sub/foreign");
    let result = f.retirement().retire_with(|label| {
        if label == "planned" {
            fs::write(&foreign, b"written while the discard was planned")?;
        }
        Ok(())
    });
    assert!(result.is_err(), "a drifted root was discarded");
    assert_eq!(
        fs::read(&foreign).unwrap(),
        b"written while the discard was planned"
    );
    assert_eq!(
        fs::read(f.roots[0].join("parked/dir/sub/planned")).unwrap(),
        MOVED
    );
    // No decision was journaled, so Undo returns the whole entry.
    let operation = f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap_or_else(|error| panic!("Undo was consumed: {error}"))
        .unwrap();
    MoveExecution::reopen(operation)
        .unwrap()
        .restore_move()
        .unwrap();
    assert_eq!(fs::read(f.source.join("dir/sub/planned")).unwrap(), MOVED);
    assert!(f.source.join("dir/sub/foreign").is_file());
    assert!(!f.target.exists());
}

#[test]
fn a_deferral_recorded_before_its_measurement_still_waits_for_a_retry() {
    let f = Fixture::new(true, false, false);
    f.restore();
    // Deferral and measurement are separate journal writes; this process
    // stopped between them, so nothing records the retained size.
    let mut operation = f.claim();
    operation
        .advance(Event::DeferRetirement(
            "Permission denied (os error 13)".into(),
        ))
        .unwrap();
    drop(operation);
    let before = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert!(
        !f.coordinator.inventory().unwrap().entries.is_empty(),
        "enforcement retried a deferred cleanup without being asked"
    );
    assert_eq!(
        generation(&f),
        before,
        "enforcement claimed a deferred cleanup"
    );
    assert!(f.roots[1].join("publication").exists());
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
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

// --- Enforcement only claims what it can observe (PR #790 review N5) ---

/// Rename an artifact root's parent away, so its recorded identity can no
/// longer be opened. Returns the path to rename it back from.
fn hide_parent(root: &std::path::Path) -> PathBuf {
    let parent = root.parent().unwrap().to_path_buf();
    let away = parent.with_extension("away");
    fs::rename(&parent, &away).unwrap();
    fs::create_dir(&parent).unwrap();
    away
}

fn restore_parent(root: &std::path::Path, away: &std::path::Path) {
    let parent = root.parent().unwrap();
    fs::remove_dir(parent).unwrap();
    fs::rename(away, parent).unwrap();
}

#[test]
fn enforcement_claims_an_unmeasured_settled_move_only_once_it_can_observe_it() {
    if running_as_root() {
        return;
    }
    for restored in [false, true] {
        let f = Fixture::new(true, false, false);
        if restored {
            f.restore();
        }
        let unmeasured = || {
            f.coordinator.inventory().unwrap().entries[0]
                .state
                .as_ref()
                .unwrap()
                .retained_bytes
                .is_none()
        };
        assert!(unmeasured());
        let before = generation(&f);
        // An artifact root this user cannot open: nothing can be measured or
        // removed, so claiming it would only advance its generation.
        let root = f.roots[1].clone();
        set_mode(&root, 0o000);
        for _ in 0..3 {
            retirement::enforce(&f.coordinator).unwrap();
        }
        let after_unreadable = generation(&f);
        set_mode(&root, 0o700);
        // An artifact parent whose recorded identity is away.
        let away = hide_parent(&f.roots[0]);
        for _ in 0..3 {
            retirement::enforce(&f.coordinator).unwrap();
        }
        let after_away = generation(&f);
        restore_parent(&f.roots[0], &away);
        assert_eq!(
            (after_unreadable, after_away),
            (before, before),
            "restored={restored}: enforcement claimed a record it could not observe"
        );
        assert!(unmeasured());
        // Observable again, it is claimed once: an automatic discard reclaims
        // it, and an explicit-only record is measured and then left alone.
        retirement::enforce(&f.coordinator).unwrap();
        if restored {
            f.assert_retired();
            assert_eq!(fs::read(&f.source).unwrap(), MOVED);
        } else {
            assert!(!unmeasured());
            let measured = generation(&f);
            for _ in 0..3 {
                retirement::enforce(&f.coordinator).unwrap();
            }
            assert_eq!(generation(&f), measured);
        }
    }
}

#[test]
fn a_claimed_automatic_discard_whose_root_cannot_be_opened_waits_for_a_retry() {
    if running_as_root() {
        return;
    }
    let f = Fixture::new(true, false, false);
    f.restore();
    let root = f.roots[1].clone();
    assert!(root.join("publication").exists());
    // The root became unopenable after enforcement chose to claim it.
    set_mode(&root, 0o000);
    let _ = retirement::settle(&f.coordinator, &f.id, generation(&f));
    set_mode(&root, 0o700);
    let claimed = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert!(
        !f.coordinator.inventory().unwrap().entries.is_empty(),
        "a discard that could not start was retried without being asked"
    );
    assert_eq!(generation(&f), claimed, "enforcement claimed it again");
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.message.contains("could not start"), "{}", item.message);
    assert!(
        item.message.contains("Permission denied"),
        "{}",
        item.message
    );
    assert_eq!(item.actions, vec![RecoveryChoice::Discard]);
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}
