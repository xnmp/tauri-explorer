use super::*;
use crate::files::recovery::{model::RecoveryChoice, service};

struct Fixture {
    _directory: tempfile::TempDir,
    base: PathBuf,
    coordinator: Arc<Coordinator>,
    sources: Vec<PathBuf>,
    targets: Vec<PathBuf>,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        fs::create_dir(base.join("from")).unwrap();
        fs::create_dir(base.join("to")).unwrap();
        let sources: Vec<_> = (0..2).map(|i| base.join(format!("from/{i}"))).collect();
        let targets: Vec<_> = (0..2).map(|i| base.join(format!("to/{i}"))).collect();
        for (index, (source, target)) in sources.iter().zip(&targets).enumerate() {
            fs::write(source, format!("source {index}")).unwrap();
            fs::write(target, format!("original {index}")).unwrap();
        }
        let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
        Self {
            _directory: directory,
            base,
            coordinator,
            sources,
            targets,
        }
    }

    fn prepare(&self, progress: &mut impl CopyProgress) -> Result<Vec<PreparedCopy>, AppError> {
        let copies: Vec<_> = self
            .sources
            .iter()
            .zip(&self.targets)
            .map(|(source, target)| (source.as_path(), target.as_path()))
            .collect();
        prepare_batch(&self.coordinator, &copies, progress)
    }

    fn assert_no_effects(&self) {
        for (index, (source, target)) in self.sources.iter().zip(&self.targets).enumerate() {
            assert_eq!(
                fs::read(source).unwrap(),
                format!("source {index}").as_bytes()
            );
            assert_eq!(
                fs::read(target).unwrap(),
                format!("original {index}").as_bytes()
            );
        }
        assert!(service::list(&self.coordinator).unwrap().items.is_empty());
        assert_eq!(fs::read_dir(self.base.join("to")).unwrap().count(), 2);
    }

    fn assert_retired(&self) {
        // Inspect the persisted external result before another admission could
        // mask missing explicit cleanup by reclaiming abandoned owners.
        let journal =
            rusqlite::Connection::open(self.base.join("recovery/recovery.sqlite3")).unwrap();
        let count: i64 = journal
            .query_row("SELECT count(*) FROM recovery_records", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}

fn progress() -> crate::progress::ProgressTracker<'static> {
    crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None)
}

#[test]
fn prepared_children_execute_exact_destinations_and_restore_independent_originals() {
    let f = Fixture::new();
    let mut progress = progress();
    let prepared = f.prepare(&mut progress).unwrap();
    f.assert_no_effects();
    let receipts: Vec<_> = prepared
        .into_iter()
        .map(|copy| copy.execute(&mut progress).unwrap())
        .collect();
    assert_ne!(
        receipts[0].replacement.as_ref().unwrap().id,
        receipts[1].replacement.as_ref().unwrap().id
    );
    assert_eq!(service::list(&f.coordinator).unwrap().items.len(), 2);
    for (index, receipt) in receipts.iter().enumerate().rev() {
        assert_eq!(receipt.path, f.targets[index].to_string_lossy());
        assert_eq!(
            fs::read(&f.targets[index]).unwrap(),
            format!("source {index}").as_bytes()
        );
        let id = &receipt.replacement.as_ref().unwrap().id;
        let snapshot = service::inspect(&f.coordinator, id).unwrap();
        let generation = snapshot
            .items
            .iter()
            .find(|item| &item.id == id)
            .unwrap()
            .generation;
        service::resolve(&f.coordinator, id, generation, RecoveryChoice::Restore).unwrap();
        assert_eq!(
            fs::read(&f.targets[index]).unwrap(),
            format!("original {index}").as_bytes()
        );
        assert_eq!(
            fs::read(&f.sources[index]).unwrap(),
            format!("source {index}").as_bytes()
        );
    }
}

#[test]
fn an_invalid_final_intent_retires_the_entire_prepared_group_without_effects() {
    let mut f = Fixture::new();
    // Within-child write/read overlap is operation-specific validation. The
    // coordinator alone accepts it; plan validation must reject it before the
    // valid prefix can execute or publish durable catalog evidence.
    f.targets[1] = f.sources[1].clone();
    assert!(f.prepare(&mut progress()).is_err());
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"original 0");
    assert_eq!(fs::read(&f.sources[1]).unwrap(), b"source 1");
    assert!(service::list(&f.coordinator).unwrap().items.is_empty());
    assert_eq!(fs::read_dir(f.base.join("to")).unwrap().count(), 2);
    f.assert_retired();
}

#[test]
fn a_missing_final_original_retires_every_child_and_does_not_reinterpret_overwrite() {
    let f = Fixture::new();
    fs::remove_file(&f.targets[1]).unwrap();
    assert!(f.prepare(&mut progress()).is_err());
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"original 0");
    assert!(!f.targets[1].exists());
    assert!(service::list(&f.coordinator).unwrap().items.is_empty());
    f.assert_retired();
}

#[test]
fn later_source_changes_are_rejected_against_the_version_captured_for_the_whole_group() {
    let f = Fixture::new();
    let mut progress = progress();
    let mut prepared = f.prepare(&mut progress).unwrap().into_iter();
    let first = prepared.next().unwrap().execute(&mut progress).unwrap();
    fs::write(&f.sources[1], "source changed after group preparation").unwrap();
    let error = prepared.next().unwrap().execute(&mut progress).unwrap_err();
    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert_eq!(fs::read(&f.targets[1]).unwrap(), b"original 1");
    // The confirmed sibling's exact native inverse is still usable.
    let inverse = first.replacement.unwrap().history;
    crate::files::recovery::history::execute(
        &f.coordinator,
        inverse,
        crate::files::recovery::ReplacementDirection::Restore,
    )
    .unwrap();
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"original 0");
}

#[test]
fn alias_retargeting_after_preparation_never_replans_a_later_destination() {
    let mut f = Fixture::new();
    let physical = f.targets.clone();
    let alias = f.base.join("alias");
    std::os::unix::fs::symlink(f.base.join("to"), &alias).unwrap();
    f.targets = (0..2).map(|i| alias.join(i.to_string())).collect();
    let mut progress = progress();
    let prepared = f.prepare(&mut progress).unwrap();
    let other = f.base.join("other");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("0"), "unrelated").unwrap();
    fs::write(other.join("1"), "unrelated").unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    for (index, copy) in prepared.into_iter().enumerate() {
        let receipt = copy.execute(&mut progress).unwrap();
        assert_eq!(receipt.path, physical[index].to_string_lossy());
        assert_eq!(
            fs::read(&physical[index]).unwrap(),
            format!("source {index}").as_bytes()
        );
        assert_eq!(
            fs::read(other.join(index.to_string())).unwrap(),
            b"unrelated"
        );
    }
}

#[test]
fn cancelling_an_unstarted_sibling_preserves_the_completed_childs_inverse() {
    let f = Fixture::new();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let mut progress = crate::progress::ProgressTracker::new(
        None,
        "copy-progress",
        "Copy cancelled",
        0,
        0,
        Some(&cancelled),
    );
    let mut prepared = f.prepare(&mut progress).unwrap().into_iter();
    let first = prepared.next().unwrap().execute(&mut progress).unwrap();
    cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
    let error = prepared.next().unwrap().execute(&mut progress).unwrap_err();
    assert!(matches!(error, AppError::Other(ref message) if message == "Copy cancelled"));
    assert_eq!(service::list(&f.coordinator).unwrap().items.len(), 1);
    assert_eq!(fs::read(&f.targets[1]).unwrap(), b"original 1");
    crate::files::recovery::history::execute(
        &f.coordinator,
        first.replacement.unwrap().history,
        crate::files::recovery::ReplacementDirection::Restore,
    )
    .unwrap();
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"original 0");
}

#[test]
fn invalid_group_sizes_fail_before_ownership_or_file_effects() {
    let f = Fixture::new();
    assert!(prepare_batch(&f.coordinator, &[], &mut progress()).is_err());
    assert!(prepare_batch(
        &f.coordinator,
        &vec![(f.sources[0].as_path(), f.targets[0].as_path()); MAX_RECORDS + 1],
        &mut progress()
    )
    .is_err());
    f.assert_no_effects();
    f.assert_retired();
}

#[test]
fn cancellation_during_binding_retires_every_admitted_child() {
    let f = Fixture::new();
    struct CancelWhenAdmitted(rusqlite::Connection);
    impl CopyProgress for CancelWhenAdmitted {
        fn check_cancelled(&mut self) -> Result<(), AppError> {
            let count: i64 = self
                .0
                .query_row("SELECT count(*) FROM recovery_records", [], |row| {
                    row.get(0)
                })
                .unwrap();
            if count > 0 {
                Err(AppError::Other("Copy cancelled".into()))
            } else {
                Ok(())
            }
        }
        fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
            panic!("preparing a group must not copy any bytes")
        }
    }
    let mut progress = CancelWhenAdmitted(
        rusqlite::Connection::open(f.base.join("recovery/recovery.sqlite3")).unwrap(),
    );
    assert!(
        matches!(f.prepare(&mut progress), Err(AppError::Other(ref message)) if message == "Copy cancelled")
    );
    f.assert_no_effects();
    f.assert_retired();
}

#[test]
fn one_failed_retirement_does_not_skip_healthy_siblings_or_hide_cleanup_failure() {
    let f = Fixture::new();
    let prepared = f.prepare(&mut progress()).unwrap();
    let journal = rusqlite::Connection::open(f.base.join("recovery/recovery.sqlite3")).unwrap();
    // Remove the earliest admitted row behind its live owner's back. Its exact
    // settlement must fail; the later child's valid ownership can still retire.
    journal.execute("DELETE FROM recovery_records WHERE generation = (SELECT min(generation) FROM recovery_records)", []).unwrap();
    let error = finish_unstarted(
        prepared.into_iter().map(|copy| copy.reservation).collect(),
        AppError::Other("Copy cancelled".into()),
    );
    let message = error.to_string();
    assert!(message.contains("Copy cancelled"));
    assert!(message.contains("Could not retire 1 unstarted copy ownership record(s)"));
    f.assert_no_effects();
    f.assert_retired();
}

#[test]
fn preflight_rejects_object_substitution_between_reservation_and_binding() {
    let f = Fixture::new();
    let mut pending = PendingCopy::new(&f.sources[0], &f.targets[0]).unwrap();
    let reservation = f
        .coordinator
        .reserve(std::mem::take(&mut pending.requests))
        .unwrap();
    // Keep the admitted object alive at another name to exclude inode reuse.
    fs::rename(&f.targets[0], f.base.join("old-original")).unwrap();
    fs::write(&f.targets[0], "external substitute").unwrap();
    assert!(pending.bind(&reservation).is_err());
    reservation.finish().unwrap();
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"external substitute");
    assert_eq!(
        fs::read(f.base.join("old-original")).unwrap(),
        b"original 0"
    );
    assert!(service::list(&f.coordinator).unwrap().items.is_empty());
    f.assert_retired();
}
