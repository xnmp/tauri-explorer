//! Shared fixture used by every move-retirement test submodule: a completed
//! move, ready to claim, retire, restore or crash mid-cleanup.
use super::*;

pub(super) const MOVED: &[u8] = b"moved payload";
pub(super) const OLD: &[u8] = b"overwritten payload";

pub(super) struct Fixture {
    pub(super) _base: tempfile::TempDir,
    _shared: Option<tempfile::TempDir>,
    pub(super) coordinator: Arc<Coordinator>,
    pub(super) source: PathBuf,
    pub(super) target: PathBuf,
    pub(super) roots: Vec<PathBuf>,
    pub(super) id: String,
}
impl Fixture {
    pub(super) fn new(cross: bool, overwrite: bool, directory: bool) -> Self {
        Self::build(cross, overwrite, directory, |source| {
            if directory {
                fs::create_dir(source).unwrap();
                fs::write(source.join("entry"), MOVED).unwrap();
            } else {
                fs::write(source, MOVED).unwrap();
            }
        })
    }
    /// `populate` creates the moved source entry; `directory` only shapes an overwritten target.
    pub(super) fn build(
        cross: bool,
        overwrite: bool,
        directory: bool,
        populate: impl FnOnce(&std::path::Path),
    ) -> Self {
        let base = tempfile::tempdir().unwrap();
        let shared = cross.then(|| tempfile::tempdir_in("/dev/shm").unwrap());
        let source = fs::canonicalize(shared.as_ref().unwrap_or(&base).path())
            .unwrap()
            .join("source");
        let target = fs::canonicalize(base.path()).unwrap().join("target");
        populate(&source);
        if overwrite {
            if directory {
                fs::create_dir(&target).unwrap();
                fs::write(target.join("entry"), OLD).unwrap();
                fs::create_dir(target.join("nested")).unwrap();
            } else {
                fs::write(&target, OLD).unwrap();
            }
        }
        let coordinator =
            Coordinator::open(&fs::canonicalize(base.path()).unwrap().join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        PreparedMove::prepare(&coordinator, &source, &target)
            .unwrap()
            .execute(&mut progress)
            .unwrap();
        let entry = coordinator.inventory().unwrap().entries.remove(0);
        let kind = entry.intent.operation.kind();
        let roots = [Side::Source, Side::Target]
            .into_iter()
            .filter_map(|side| kind.root(side))
            .map(|root| root.path.0.clone())
            .collect();
        Self {
            _base: base,
            _shared: shared,
            coordinator,
            source,
            target,
            roots,
            id: entry.intent.id,
        }
    }
    pub(super) fn claim(&self) -> DurableOperation {
        let entry = self.coordinator.inventory().unwrap().entries.remove(0);
        self.coordinator
            .try_claim(&self.id, entry.generation.unwrap())
            .unwrap()
            .unwrap()
    }
    pub(super) fn retirement(&self) -> Retirement {
        Retirement::open(self.claim()).unwrap()
    }
    pub(super) fn restore(&self) {
        MoveExecution::reopen(self.claim())
            .unwrap()
            .restore_move()
            .unwrap();
    }
    pub(super) fn assert_retired(&self) {
        assert!(self.coordinator.inventory().unwrap().entries.is_empty());
        assert!(self.roots.iter().all(|root| !root.exists()));
    }
}

/// A process killed at the first `boundary` of a discard: unlike a returned
/// error, nothing reports the failure, so enforcement may resume it.
pub(super) fn crash_at(f: &Fixture, boundary: &str, mut before: impl FnMut()) {
    let retirement = f.retirement();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        retirement.retire_with(|label| {
            if label == boundary {
                before();
                panic!("process killed at {boundary}");
            }
            Ok(())
        })
    }));
    assert!(outcome.is_err(), "cleanup never reached {boundary}");
}
