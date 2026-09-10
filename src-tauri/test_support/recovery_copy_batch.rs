use super::*;
use crate::files::recovery::{
    coordinator::Coordinator,
    forward_copy::plan::prepare_batch,
    history,
    resources::{Access, Request, Scope},
    service, ReplacementDirection,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

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
        let sources: Vec<_> = (0..3).map(|i| base.join(format!("source-{i}"))).collect();
        let targets: Vec<_> = (0..3).map(|i| base.join(format!("target-{i}"))).collect();
        for (i, (source, target)) in sources.iter().zip(&targets).enumerate() {
            fs::write(source, format!("new {i}")).unwrap();
            fs::write(target, format!("old {i}")).unwrap();
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

    fn prepare(&self, progress: &mut impl CopyProgress) -> Vec<PreparedCopy> {
        let paths: Vec<_> = self
            .sources
            .iter()
            .zip(&self.targets)
            .map(|(source, target)| (source.as_path(), target.as_path()))
            .collect();
        prepare_batch(&self.coordinator, &paths, progress).unwrap()
    }

    fn rows(&self) -> i64 {
        rusqlite::Connection::open(self.base.join("recovery/recovery.sqlite3"))
            .unwrap()
            .query_row("SELECT count(*) FROM recovery_records", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn restore_first(&self, items: Vec<CopyItem>) {
        let first = items.into_iter().next().unwrap();
        assert_eq!(first.target, self.targets[0].to_string_lossy());
        let ItemState::Succeeded(receipt) = first.state else {
            panic!("first receipt was lost")
        };
        history::execute(
            &self.coordinator,
            receipt.replacement.unwrap().history,
            ReplacementDirection::Restore,
        )
        .unwrap();
        assert_eq!(fs::read(&self.targets[0]).unwrap(), b"old 0");
    }

    fn assert_unstarted_target_free(&self) {
        self.coordinator
            .reserve(vec![Request {
                path: self.targets[2].clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            }])
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!(fs::read(&self.targets[2]).unwrap(), b"old 2");
    }
}

fn progress() -> crate::progress::ProgressTracker<'static> {
    crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None)
}

struct PanicAtSource(PathBuf);
impl CopyProgress for PanicAtSource {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Ok(())
    }
    fn advance(&mut self, _: u64, source: &Path) -> Result<(), AppError> {
        if source == self.0 {
            panic!("second child interrupted during staging");
        }
        Ok(())
    }
}

#[test]
fn a_later_staging_panic_retains_the_confirmed_prefix_and_retires_the_unstarted_suffix() {
    let f = Fixture::new();
    let mut progress = PanicAtSource(f.sources[1].clone());
    let result = execute_batch(f.prepare(&mut progress), &mut progress);
    assert!(
        matches!(&result.items[1].state, ItemState::Uncertain(AppError::WorkerFailed(message)) if message == "second child interrupted during staging")
    );
    assert!(matches!(&result.items[2].state, ItemState::Unstarted));
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"new 0");
    assert_eq!(fs::read(&f.targets[1]).unwrap(), b"old 1");
    assert_eq!(service::list(&f.coordinator).unwrap().items.len(), 2);
    assert_eq!(
        f.rows(),
        2,
        "the third child must retire before the result escapes"
    );
    f.assert_unstarted_target_free();
    f.restore_first(result.items);
}

struct AfterFirst {
    first: PathBuf,
    panic: bool,
}
impl CopyProgress for AfterFirst {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        if fs::read(&self.first).unwrap() == b"new 0" {
            if self.panic {
                panic!("interrupted before second promotion");
            }
            return Err(AppError::Other("Copy cancelled".into()));
        }
        Ok(())
    }
    fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
        Ok(())
    }
}

#[test]
fn a_pre_promotion_panic_preserves_receipts_without_inventing_durable_evidence() {
    let f = Fixture::new();
    let mut progress = AfterFirst {
        first: f.targets[0].clone(),
        panic: true,
    };
    let result = execute_batch(f.prepare(&mut progress), &mut progress);
    assert!(matches!(
        &result.items[1].state,
        ItemState::Uncertain(AppError::WorkerFailed(_))
    ));
    assert!(matches!(&result.items[2].state, ItemState::Unstarted));
    assert_eq!(service::list(&f.coordinator).unwrap().items.len(), 1);
    // The active unpromoted owner unwound and is reclaimable. Only the untouched
    // suffix receives explicit retirement; the current outcome remains uncertain.
    assert_eq!(f.rows(), 2);
    f.assert_unstarted_target_free();
    f.restore_first(result.items);
}

#[test]
fn cancellation_between_children_returns_a_typed_unchanged_failure_and_keeps_prior_undo() {
    let f = Fixture::new();
    let mut progress = AfterFirst {
        first: f.targets[0].clone(),
        panic: false,
    };
    let result = execute_batch(f.prepare(&mut progress), &mut progress);
    assert!(
        matches!(&result.items[1].state, ItemState::Failed(AppError::Other(message)) if message == "Copy cancelled")
    );
    assert!(matches!(&result.items[2].state, ItemState::Unstarted));
    assert_eq!(f.rows(), 1);
    f.assert_unstarted_target_free();
    f.restore_first(result.items);
}

#[test]
fn source_changed_after_preparation_keeps_prior_receipt_and_stops_the_suffix() {
    let f = Fixture::new();
    let mut progress = progress();
    let prepared = f.prepare(&mut progress);
    fs::write(&f.sources[1], "external new version").unwrap();
    let result = execute_batch(prepared, &mut progress);
    assert!(matches!(
        &result.items[1].state,
        ItemState::Uncertain(AppError::MutationUncertain(_))
    ));
    assert!(matches!(&result.items[2].state, ItemState::Unstarted));
    assert_eq!(fs::read(&f.targets[1]).unwrap(), b"old 1");
    assert_eq!(f.rows(), 2);
    f.assert_unstarted_target_free();
    f.restore_first(result.items);
}

#[test]
fn all_children_commit_in_order_with_one_cumulative_progress_source() {
    let f = Fixture::new();
    #[derive(Default)]
    struct Bytes {
        done: u64,
        observations: Vec<u64>,
    }
    impl CopyProgress for Bytes {
        fn check_cancelled(&mut self) -> Result<(), AppError> {
            Ok(())
        }
        fn advance(&mut self, bytes: u64, _: &Path) -> Result<(), AppError> {
            self.done += bytes;
            self.observations.push(self.done);
            Ok(())
        }
    }
    let mut progress = Bytes::default();
    let result = execute_batch(f.prepare(&mut progress), &mut progress);
    assert_eq!(progress.done, 15);
    assert!(progress
        .observations
        .windows(2)
        .all(|pair| pair[0] <= pair[1]));
    for (i, item) in result.items.into_iter().enumerate() {
        let ItemState::Succeeded(receipt) = item.state else {
            panic!("copy failed")
        };
        assert_eq!(receipt.path, f.targets[i].to_string_lossy());
        assert_eq!(
            fs::read(&f.targets[i]).unwrap(),
            format!("new {i}").as_bytes()
        );
    }
}

#[test]
fn aliases_keep_one_physical_refresh_projection_after_later_panic() {
    let mut f = Fixture::new();
    let alias = f.base.join("alias");
    std::os::unix::fs::symlink(&f.base, &alias).unwrap();
    f.targets = (0..3).map(|i| alias.join(format!("target-{i}"))).collect();
    let mut progress = PanicAtSource(f.sources[1].clone());
    let result = execute_batch(f.prepare(&mut progress), &mut progress);
    assert_eq!(
        result.physical_refresh,
        vec![f.base.to_string_lossy().into_owned()]
    );
    assert!(matches!(&result.items[2].state, ItemState::Unstarted));
    f.restore_first(result.items);
}

#[test]
fn suffix_retirement_failure_is_a_warning_and_preserves_both_receipt_and_cancel_classification() {
    let f = Fixture::new();
    let mut cancelled = AfterFirst {
        first: f.targets[0].clone(),
        panic: false,
    };
    let prepared = f.prepare(&mut cancelled);
    // Corrupt only the final child's exact ownership before execution. Its
    // cleanup fails after the second child cancels; neither may erase receipt 0.
    let journal = rusqlite::Connection::open(f.base.join("recovery/recovery.sqlite3")).unwrap();
    journal.execute("DELETE FROM recovery_records WHERE generation = (SELECT max(generation) FROM recovery_records)", []).unwrap();
    let result = execute_batch(prepared, &mut cancelled);
    assert!(result
        .warnings
        .into_vec()
        .join("\n")
        .contains("Could not retire 1 unstarted copy ownership record(s)"));
    assert!(
        matches!(&result.items[1].state, ItemState::Failed(AppError::Other(message)) if message == "Copy cancelled")
    );
    assert!(matches!(&result.items[2].state, ItemState::Unstarted));
    assert_eq!(fs::read(&f.targets[0]).unwrap(), b"new 0");
    assert_eq!(f.rows(), 1);
    f.restore_first(result.items);
}
