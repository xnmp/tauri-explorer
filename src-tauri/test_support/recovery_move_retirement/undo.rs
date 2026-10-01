//! Undo refusal for a destination grown past its retirement plan, and undo
//! naming why it can't keep a destination (PR #790 review N6).
use super::fixtures::*;
use super::planning_budget::effect_revision;
use super::readonly_umask::{running_as_root, set_mode};
use super::*;

/// Eight nested 200-byte directory names: each recorded path below this costs
/// several KiB of a retirement plan's byte budget, so ~2k entries exhaust it.
fn deep(root: &std::path::Path) -> PathBuf {
    let mut deepest = root.to_owned();
    for level in 0..8 {
        deepest.push(format!("{level}{}", "d".repeat(200)));
    }
    deepest
}

fn populate_deep(deepest: &std::path::Path, files: std::ops::Range<usize>) {
    for index in files {
        fs::write(deepest.join(format!("{index:05}{}", "f".repeat(200))), b"x").unwrap();
    }
}

fn trim_deep(deepest: &std::path::Path, files: std::ops::Range<usize>) {
    for index in files {
        fs::remove_file(deepest.join(format!("{index:05}{}", "f".repeat(200)))).unwrap();
    }
}

/// A cross-volume move of a tree that fits its retirement plans at admission.
fn plannable_deep_move() -> Fixture {
    Fixture::build(true, false, false, |source| {
        let deepest = deep(source);
        fs::create_dir_all(&deepest).unwrap();
        populate_deep(&deepest, 0..1_200);
    })
}

pub(super) fn history_undo(f: &Fixture, revision: u64) -> Result<(), AppError> {
    use crate::files::recovery::model::{ReplacementDirection, ReplacementHistory};
    crate::files::recovery::history::execute(
        &f.coordinator,
        ReplacementHistory {
            id: f.id.clone(),
            revision,
            refresh_dirs: vec![],
        },
        ReplacementDirection::Restore,
    )
    .map(drop)
}

#[test]
fn undo_refuses_a_destination_grown_past_any_retirement_plan_and_keeps_it() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = plannable_deep_move();
    let revision = effect_revision(&f);
    // The user keeps working deep inside the moved destination.
    populate_deep(&deep(&f.target), 1_200..2_600);
    let error = history_undo(&f, revision)
        .expect_err("Undo retained a destination no discard could ever remove");
    // A refusal before any durable effect keeps the Undo entry itself.
    assert!(!matches!(error, AppError::MutationUncertain(_)), "{error}");
    assert!(error.to_string().contains("Nothing was changed"), "{error}");
    assert_eq!(fs::read_dir(deep(&f.target)).unwrap().count(), 2_600);
    assert!(!f.source.exists(), "the source stayed parked");
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
    // Once the destination fits again, the same Undo succeeds, and the
    // publication it retains can still be discarded.
    trim_deep(&deep(&f.target), 1_200..2_600);
    history_undo(&f, revision).unwrap();
    assert_eq!(fs::read_dir(deep(&f.source)).unwrap().count(), 1_200);
    assert!(!f.target.exists());
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

#[test]
fn a_refused_undo_leaves_discard_able_to_keep_the_grown_destination() {
    let f = plannable_deep_move();
    let revision = effect_revision(&f);
    populate_deep(&deep(&f.target), 1_200..2_600);
    assert!(history_undo(&f, revision).is_err());
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(
        snapshot.items[0].actions.contains(&RecoveryChoice::Discard),
        "{:?}",
        snapshot.items[0].actions
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
    assert_eq!(fs::read_dir(deep(&f.target)).unwrap().count(), 2_600);
    assert!(!f.source.exists());
}

#[test]
fn a_destination_grown_while_undo_runs_is_kept_public_and_retryable() {
    let f = plannable_deep_move();
    let deepest = deep(&f.target);
    let grown = deepest.clone();
    // Grows after Undo admitted the destination but before it is parked.
    let result = MoveExecution::reopen(f.claim())
        .unwrap()
        .with_boundary(Box::new(move |label| {
            if label == "restore-intent" {
                populate_deep(&grown, 1_200..2_600);
            }
            Ok(())
        }))
        .restore_move();
    assert!(result.is_err(), "a grown destination was parked");
    assert_eq!(fs::read_dir(&deepest).unwrap().count(), 2_600);
    // The retry File Recovery offers succeeds once the destination fits.
    trim_deep(&deepest, 1_200..2_600);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(
        snapshot.items[0].actions.contains(&RecoveryChoice::Restore),
        "{:?}: {}",
        snapshot.items[0].actions,
        snapshot.items[0].message
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Restore,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(fs::read_dir(deep(&f.source)).unwrap().count(), 1_200);
    assert!(!f.target.exists());
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

// --- Undo names why it cannot keep a destination (PR #790 review N6) ---

#[test]
fn undo_says_why_it_cannot_keep_the_destination() {
    if running_as_root() {
        return;
    }
    // Unreadable: a directory inside the destination this user cannot list.
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("locked")).unwrap();
        fs::write(source.join("locked/entry"), MOVED).unwrap();
    });
    let revision = effect_revision(&f);
    set_mode(&f.target.join("locked"), 0o000);
    let unreadable = history_undo(&f, revision).unwrap_err().to_string();
    set_mode(&f.target.join("locked"), 0o700);
    assert!(unreadable.contains("'locked'"), "{unreadable}");
    assert!(unreadable.contains("cannot be read"), "{unreadable}");
    assert!(unreadable.contains("Permission denied"), "{unreadable}");
    assert!(unreadable.contains("Nothing was changed"), "{unreadable}");
    assert!(!unreadable.contains("too large"), "{unreadable}");
    // Grown past any retirement plan.
    let f = plannable_deep_move();
    let revision = effect_revision(&f);
    populate_deep(&deep(&f.target), 1_200..2_600);
    let grown = history_undo(&f, revision).unwrap_err().to_string();
    assert!(grown.contains("grown too large"), "{grown}");
    assert!(grown.contains("Nothing was changed"), "{grown}");
}

/// A mount inside a planned payload is never entered by cleanup, whether it
/// exposes a foreign directory or re-exposes the planned directory itself
/// (same device and inode, so only mount identity differs) (#875).
#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn move_cleanup_never_descends_into_a_mount_inside_its_payload() {
    use crate::files::{
        mount_namespace::{require_private_namespace, BindMount},
        recovery::move_cleanup::Plan,
    };
    require_private_namespace();
    for foreign in [true, false] {
        let base = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(base.path()).unwrap().join("root");
        let planned = root.join("payload/nested");
        fs::create_dir_all(&planned).unwrap();
        fs::write(planned.join("retained"), OLD).unwrap();
        let outside = root.with_file_name("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("foreign"), b"foreign bytes").unwrap();
        let directory = Directory::open(&root).unwrap();
        let plan = Plan::capture(&directory, &root, Some("payload")).unwrap();
        let source = if foreign { &outside } else { &planned };
        let mount = BindMount::new(source, &planned);

        let result = plan.remove(&directory, &root, &mut |_| Ok(()));

        assert!(
            result.is_err(),
            "cleanup crossed a mount (foreign={foreign})"
        );
        assert_eq!(fs::read(outside.join("foreign")).unwrap(), b"foreign bytes");
        drop(mount);
        assert_eq!(fs::read(planned.join("retained")).unwrap(), OLD);
    }
}
