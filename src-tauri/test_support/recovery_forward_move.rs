//! Real-filesystem contracts for the durable move executor. Every assertion is
//! about observable bytes and namespace state, never about internal shapes.
use super::*;
use crate::files::recovery::{
    coordinator::{Coordinator, HistoryPosition},
    model::{ReplacementDirection, ReplacementHistory},
    move_execution::MoveExecution,
    move_model::Strategy,
};
use std::os::unix::fs::{MetadataExt, PermissionsExt};

struct Uninterrupted;
impl CopyProgress for Uninterrupted {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Ok(())
    }
    fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
        Ok(())
    }
}

struct Cancelled;
impl CopyProgress for Cancelled {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Err(AppError::Other("cancelled".into()))
    }
    fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
        Ok(())
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    _shared: Option<tempfile::TempDir>,
    from: PathBuf,
    to: PathBuf,
    coordinator: Arc<Coordinator>,
}

impl Fixture {
    fn same_volume() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(directory.path()).unwrap();
        fs::create_dir(base.join("from")).unwrap();
        fs::create_dir(base.join("to")).unwrap();
        let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
        Self {
            _directory: directory,
            _shared: None,
            from: base.join("from"),
            to: base.join("to"),
            coordinator,
        }
    }

    /// `/dev/shm` is a different filesystem from the ordinary temporary
    /// directory on a normal Linux host. When it is not — a container that
    /// mounts both from one device — the cross-filesystem contracts cannot be
    /// established here, so the test skips loudly rather than passing silently.
    fn cross_volume() -> Option<Self> {
        let shared_root = Path::new("/dev/shm");
        if !shared_root.is_dir() {
            eprintln!("SKIPPED cross-filesystem move test: /dev/shm is unavailable");
            return None;
        }
        let directory = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in(shared_root).unwrap();
        let base = fs::canonicalize(directory.path()).unwrap();
        let other = fs::canonicalize(shared.path()).unwrap();
        if fs::metadata(&base).unwrap().dev() == fs::metadata(&other).unwrap().dev() {
            eprintln!(
                "SKIPPED cross-filesystem move test: {} and {} share one device",
                base.display(),
                other.display()
            );
            return None;
        }
        fs::create_dir(other.join("from")).unwrap();
        fs::create_dir(base.join("to")).unwrap();
        let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
        Some(Self {
            _directory: directory,
            _shared: Some(shared),
            from: other.join("from"),
            to: base.join("to"),
            coordinator,
        })
    }

    fn prepare(&self, name: &str) -> PreparedMove {
        PreparedMove::prepare(
            &self.coordinator,
            &self.from.join(name),
            &self.to.join(name),
        )
        .unwrap()
    }

    fn move_entry(&self, name: &str) -> Result<FileMutationReceipt, AppError> {
        self.prepare(name).execute(&mut Uninterrupted)
    }

    fn undo(&self, history: ReplacementHistory) -> Result<(), AppError> {
        crate::files::recovery::history::execute(
            &self.coordinator,
            history,
            ReplacementDirection::Restore,
        )
        .map(|_| ())
    }

    /// No private artifact root may survive a completed operation's cleanup
    /// expectations here: the fast path must never create one at all.
    fn artifacts(&self, directory: &Path) -> Vec<String> {
        fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".tauri-explorer-recovery-"))
            .collect()
    }
}

fn history_of(receipt: &FileMutationReceipt) -> ReplacementHistory {
    receipt.relocation.as_ref().unwrap().history.clone()
}

#[test]
fn a_same_filesystem_move_relocates_the_exact_object_without_private_storage() {
    let f = Fixture::same_volume();
    fs::write(f.from.join("item.txt"), "payload").unwrap();
    let before = fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino();

    let receipt = f.move_entry("item.txt").unwrap();

    assert!(!f.from.join("item.txt").exists());
    assert_eq!(fs::read(f.to.join("item.txt")).unwrap(), b"payload");
    assert_eq!(
        fs::symlink_metadata(f.to.join("item.txt")).unwrap().ino(),
        before,
        "a rename must relocate the same object, not copy it"
    );
    assert_eq!(receipt.path, f.to.join("item.txt").to_string_lossy());
    assert!(f.artifacts(&f.from).is_empty());
    assert!(f.artifacts(&f.to).is_empty());
}

#[test]
fn undoing_a_same_filesystem_move_returns_the_exact_object_to_its_source() {
    let f = Fixture::same_volume();
    fs::write(f.from.join("item.txt"), "payload").unwrap();
    let before = fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino();

    let receipt = f.move_entry("item.txt").unwrap();
    f.undo(history_of(&receipt)).unwrap();

    assert!(!f.to.join("item.txt").exists());
    assert_eq!(fs::read(f.from.join("item.txt")).unwrap(), b"payload");
    assert_eq!(
        fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino(),
        before
    );
}

#[test]
fn an_overwriting_move_retains_the_displaced_original_and_undo_republishes_it() {
    let f = Fixture::same_volume();
    fs::write(f.from.join("item.txt"), "incoming").unwrap();
    fs::write(f.to.join("item.txt"), "displaced").unwrap();
    let displaced = fs::symlink_metadata(f.to.join("item.txt")).unwrap().ino();

    let receipt = f.move_entry("item.txt").unwrap();
    assert_eq!(fs::read(f.to.join("item.txt")).unwrap(), b"incoming");
    assert!(!f.from.join("item.txt").exists());
    // The displaced original is retained, not destroyed.
    let root = f.artifacts(&f.to);
    assert_eq!(root.len(), 1, "the overwrite must retain private storage");
    assert_eq!(
        fs::read(f.to.join(&root[0]).join("original")).unwrap(),
        b"displaced"
    );

    f.undo(history_of(&receipt)).unwrap();
    assert_eq!(fs::read(f.from.join("item.txt")).unwrap(), b"incoming");
    assert_eq!(fs::read(f.to.join("item.txt")).unwrap(), b"displaced");
    assert_eq!(
        fs::symlink_metadata(f.to.join("item.txt")).unwrap().ino(),
        displaced,
        "the exact displaced object must return, not a copy of it"
    );
}

#[test]
fn a_moved_directory_keeps_its_whole_subtree_and_permissions() {
    let f = Fixture::same_volume();
    fs::create_dir(f.from.join("tree")).unwrap();
    fs::create_dir(f.from.join("tree/nested")).unwrap();
    fs::write(f.from.join("tree/nested/leaf.txt"), "deep").unwrap();

    f.move_entry("tree").unwrap();

    assert!(!f.from.join("tree").exists());
    assert_eq!(
        fs::read(f.to.join("tree/nested/leaf.txt")).unwrap(),
        b"deep"
    );
}

#[test]
fn a_moved_symlink_is_relocated_rather_than_its_referent() {
    let f = Fixture::same_volume();
    fs::write(f.from.join("referent.txt"), "referent").unwrap();
    std::os::unix::fs::symlink("referent.txt", f.from.join("link")).unwrap();

    f.move_entry("link").unwrap();

    assert!(fs::symlink_metadata(f.to.join("link"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read_link(f.to.join("link")).unwrap(),
        Path::new("referent.txt")
    );
    // The referent itself never moved.
    assert_eq!(fs::read(f.from.join("referent.txt")).unwrap(), b"referent");
}

#[test]
fn a_cancelled_move_leaves_the_source_exactly_where_it_was() {
    let f = Fixture::same_volume();
    fs::write(f.from.join("item.txt"), "payload").unwrap();

    let error = f.prepare("item.txt").execute(&mut Cancelled).unwrap_err();

    assert!(error.to_string().contains("cancelled"));
    assert_eq!(fs::read(f.from.join("item.txt")).unwrap(), b"payload");
    assert!(!f.to.join("item.txt").exists());
    assert!(f.artifacts(&f.to).is_empty());
}

#[test]
fn a_cross_filesystem_move_publishes_before_it_parks_the_source() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::write(f.from.join("item.txt"), "payload").unwrap();

    let receipt = f.move_entry("item.txt").unwrap();

    assert_eq!(fs::read(f.to.join("item.txt")).unwrap(), b"payload");
    assert!(
        !f.from.join("item.txt").exists(),
        "the source name must be vacated once the destination exists"
    );
    // The source bytes are parked, not destroyed: the exact original survives
    // for the record's own inverse.
    let root = f.artifacts(&f.from);
    assert_eq!(root.len(), 1);
    assert_eq!(
        fs::read(f.from.join(&root[0]).join("parked")).unwrap(),
        b"payload"
    );
    assert!(receipt.relocation.is_some());
}

#[test]
fn undoing_a_cross_filesystem_move_restores_the_parked_source_and_removes_the_copy() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::write(f.from.join("item.txt"), "payload").unwrap();
    let before = fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino();

    let receipt = f.move_entry("item.txt").unwrap();
    f.undo(history_of(&receipt)).unwrap();

    assert_eq!(fs::read(f.from.join("item.txt")).unwrap(), b"payload");
    assert_eq!(
        fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino(),
        before,
        "the parked original must come home, not a copy of it"
    );
    assert!(!f.to.join("item.txt").exists());
}

#[test]
fn a_cross_filesystem_directory_move_copies_its_whole_subtree_before_parking() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::create_dir(f.from.join("tree")).unwrap();
    fs::create_dir(f.from.join("tree/locked")).unwrap();
    fs::write(f.from.join("tree/locked/leaf.txt"), "deep").unwrap();
    // A read-only descendant proves the staged copy restores recorded modes.
    fs::set_permissions(
        f.from.join("tree/locked"),
        fs::Permissions::from_mode(0o500),
    )
    .unwrap();

    f.move_entry("tree").unwrap();

    assert_eq!(
        fs::read(f.to.join("tree/locked/leaf.txt")).unwrap(),
        b"deep"
    );
    assert_eq!(
        fs::symlink_metadata(f.to.join("tree/locked"))
            .unwrap()
            .mode()
            & 0o777,
        0o500,
        "a published subtree must regain its recorded modes"
    );
    assert!(!f.from.join("tree").exists());
}

/// A directory its owner cannot write cannot be relinked into another parent:
/// POSIX rename must update its `..` entry. The move therefore publishes and
/// then fails to park. That is uncertain, not destructive: both copies exist,
/// the record is retained, and its inverse is still exact.
#[test]
fn a_source_directory_that_cannot_be_relinked_publishes_without_losing_data() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::create_dir(f.from.join("tree")).unwrap();
    fs::write(f.from.join("tree/leaf.txt"), "deep").unwrap();
    fs::set_permissions(f.from.join("tree"), fs::Permissions::from_mode(0o500)).unwrap();

    let receipt = f.prepare("tree").execute(&mut Uninterrupted);

    assert!(matches!(receipt, Err(AppError::MutationUncertain(_))));
    assert_eq!(fs::read(f.from.join("tree/leaf.txt")).unwrap(), b"deep");
    assert_eq!(fs::read(f.to.join("tree/leaf.txt")).unwrap(), b"deep");
    fs::set_permissions(f.from.join("tree"), fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn a_cancelled_cross_filesystem_move_never_touches_either_public_endpoint() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::write(f.from.join("item.txt"), "payload").unwrap();

    let error = f.prepare("item.txt").execute(&mut Cancelled).unwrap_err();

    assert!(error.to_string().contains("cancelled"));
    assert_eq!(fs::read(f.from.join("item.txt")).unwrap(), b"payload");
    assert!(!f.to.join("item.txt").exists());
}

#[test]
fn the_planned_strategy_follows_the_actual_devices_of_both_parents() {
    let f = Fixture::same_volume();
    fs::write(f.from.join("item.txt"), "payload").unwrap();
    assert_eq!(f.prepare("item.txt").strategy(), Strategy::Rename);

    if let Some(f) = Fixture::cross_volume() {
        fs::write(f.from.join("item.txt"), "payload").unwrap();
        assert_eq!(f.prepare("item.txt").strategy(), Strategy::CopyParked);
    }
}

/// Regression for the adversarial review's REFUTED (d): a restoration that
/// fails after committing its intent must remain retryable. Deriving the
/// restoration origin from the current phase forgot that a cross-filesystem
/// source was parked, and every later retry then refused forever.
#[test]
fn an_interrupted_restoration_can_still_bring_the_parked_source_home() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::write(f.from.join("item.txt"), "payload").unwrap();
    let before = fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino();
    let receipt = f.move_entry("item.txt").unwrap();
    let history = history_of(&receipt);
    let id = history.id.clone();

    // Fail after the restoration intent is durable but before any rename.
    let claimed = f
        .coordinator
        .try_claim_history(&history.id, history.revision, HistoryPosition::Published)
        .unwrap()
        .unwrap();
    let interrupted = MoveExecution::reopen(claimed)
        .unwrap()
        .with_boundary(Box::new(|label| {
            if label == "restore-intent" {
                Err(AppError::Other("injected restoration interruption".into()))
            } else {
                Ok(())
            }
        }))
        .restore_move();
    assert!(interrupted.is_err());
    // The intent is durable, but no rename ran: the source is still parked.
    assert!(!f.from.join("item.txt").exists());
    assert_eq!(fs::read(f.to.join("item.txt")).unwrap(), b"payload");

    // History cannot re-consume a record that is no longer at a stable
    // position, so the interrupted inverse becomes an explicit File Recovery
    // item — and that surface must still be able to bring the source home.
    assert!(f.undo(history).is_err());
    let inspected = crate::files::recovery::service::inspect(&f.coordinator, &id).unwrap();
    let offer = inspected.items.iter().find(|item| item.id == id).unwrap();
    assert_eq!(offer.status, "ready", "{}", offer.message);
    crate::files::recovery::service::resolve(
        &f.coordinator,
        &id,
        offer.generation,
        crate::files::recovery::model::RecoveryChoice::Restore,
    )
    .unwrap();
    assert_eq!(fs::read(f.from.join("item.txt")).unwrap(), b"payload");
    assert_eq!(
        fs::symlink_metadata(f.from.join("item.txt")).unwrap().ino(),
        before
    );
    assert!(!f.to.join("item.txt").exists());
}

/// Restoration must not delete: the published copy returns to private storage,
/// so a destination edited after publication is preserved rather than destroyed.
#[test]
fn restoration_retains_the_published_copy_instead_of_deleting_it() {
    let Some(f) = Fixture::cross_volume() else {
        return;
    };
    fs::write(f.from.join("item.txt"), "payload").unwrap();
    let receipt = f.move_entry("item.txt").unwrap();
    f.undo(history_of(&receipt)).unwrap();

    assert!(!f.to.join("item.txt").exists());
    let root = f.artifacts(&f.to);
    assert_eq!(root.len(), 1, "the published copy must be retained");
    assert_eq!(
        fs::read(f.to.join(&root[0]).join("publication")).unwrap(),
        b"payload"
    );
}
