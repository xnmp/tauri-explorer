use super::*;
use crate::files::{
    file_ops,
    recovery::{
        coordinator::Coordinator,
        model::RecoveryChoice,
        resources::{Access, Request, Scope},
        Runtime,
    },
};

struct Fixture {
    _directory: tempfile::TempDir,
    source: std::path::PathBuf,
    target: std::path::PathBuf,
    storage: std::path::PathBuf,
    runtime: Runtime,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(directory.path()).unwrap();
        fs::create_dir(base.join("from")).unwrap();
        fs::create_dir(base.join("to")).unwrap();
        let source = base.join("from/item.txt");
        let target = base.join("to/item.txt");
        fs::write(&source, "copied bytes").unwrap();
        fs::write(&target, "original bytes").unwrap();
        Self {
            _directory: directory,
            source,
            target,
            storage: base.join("app/recovery"),
            runtime: Runtime::default(),
        }
    }
    fn copy(&self, overwrite: bool) -> Result<FileMutationReceipt, AppError> {
        file_ops::copy_entry_with(
            None,
            self.source.to_string_lossy().into_owned(),
            self.target.parent().unwrap().to_string_lossy().into_owned(),
            Some(overwrite),
            None,
            |source, _, target, progress| {
                self.runtime
                    .replace_copy(self.storage.clone(), source, target, progress)
            },
        )
    }
    fn inventory(&self) -> super::super::model::RecoverySnapshot {
        tauri::async_runtime::block_on(self.runtime.list(self.storage.clone())).unwrap()
    }
}

#[test]
fn production_copy_retains_the_original_and_can_restore_it_through_the_recovery_service() {
    let f = Fixture::new();
    let receipt = f.copy(true).unwrap();
    let id = receipt.replacement.unwrap().id;
    assert_eq!(receipt.path, f.target.to_string_lossy());
    assert_eq!(fs::read(&f.source).unwrap(), b"copied bytes");
    assert_eq!(fs::read(&f.target).unwrap(), b"copied bytes");
    assert_eq!(f.inventory().items[0].id, id);
    let inspected =
        tauri::async_runtime::block_on(f.runtime.inspect(f.storage.clone(), id.clone())).unwrap();
    let generation = inspected
        .items
        .iter()
        .find(|item| item.id == id)
        .unwrap()
        .generation;
    tauri::async_runtime::block_on(f.runtime.resolve(
        f.storage.clone(),
        id,
        generation,
        RecoveryChoice::Restore,
    ))
    .unwrap();
    assert_eq!(fs::read(&f.target).unwrap(), b"original bytes");
    assert_eq!(fs::read(&f.source).unwrap(), b"copied bytes");
    let root = fs::read_dir(f.target.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".tauri-explorer-recovery-")
        })
        .unwrap();
    assert_eq!(fs::read(root.join("publication")).unwrap(), b"copied bytes");
}

#[test]
fn ordinary_copy_keeps_copy_naming_and_does_not_initialize_durable_storage() {
    let f = Fixture::new();
    let receipt = f.copy(false).unwrap();
    assert!(receipt.replacement.is_none());
    assert!(receipt.path.ends_with("item - Copy.txt"));
    assert_eq!(fs::read(receipt.path).unwrap(), b"copied bytes");
    assert_eq!(fs::read(f.target).unwrap(), b"original bytes");
    assert!(!f.storage.exists());
}

#[test]
fn production_copy_respects_a_competing_target_reservation_without_touching_payloads() {
    let f = Fixture::new();
    fs::create_dir_all(f.storage.parent().unwrap()).unwrap();
    let coordinator = Coordinator::open(&f.storage).unwrap();
    let owner = coordinator
        .reserve(vec![Request {
            path: f.target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])
        .unwrap();
    assert!(f.copy(true).is_err());
    assert_eq!(fs::read(&f.target).unwrap(), b"original bytes");
    assert_eq!(fs::read(&f.source).unwrap(), b"copied bytes");
    assert!(f.inventory().items.is_empty());
    owner.finish().unwrap();
    assert!(f.copy(true).unwrap().replacement.is_some());
}

#[test]
fn production_copy_preserves_the_alias_spelling_and_uses_the_captured_native_directory() {
    let mut f = Fixture::new();
    let alias = f.target.parent().unwrap().with_file_name("alias");
    std::os::unix::fs::symlink(f.target.parent().unwrap(), &alias).unwrap();
    f.target = alias.join("item.txt");
    let receipt = f.copy(true).unwrap();
    assert_eq!(receipt.path, f.target.to_string_lossy());
    assert_eq!(receipt.entry.unwrap().path, receipt.path);
    assert!(receipt.replacement.is_some());
    assert_eq!(fs::read(f.target).unwrap(), b"copied bytes");
}

struct Cancel {
    started: bool,
}

#[test]
fn cancellation_of_a_prepared_copy_does_not_create_durable_recovery_work() {
    let f = Fixture::new();
    fs::create_dir_all(f.storage.parent().unwrap()).unwrap();
    let coordinator = Coordinator::open(&f.storage).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let mut progress = crate::progress::ProgressTracker::new(
        None,
        "copy-progress",
        "Copy cancelled",
        0,
        0,
        Some(&cancelled),
    );
    let prepared = prepare(&coordinator, &f.source, &f.target, &mut progress).unwrap();
    cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
    let error = prepared.execute(&mut progress).unwrap_err();
    assert!(matches!(error, AppError::Other(ref message) if message == "Copy cancelled"));
    assert!(f.inventory().items.is_empty());
    assert_eq!(fs::read(&f.target).unwrap(), b"original bytes");
    assert_eq!(fs::read(&f.source).unwrap(), b"copied bytes");
    let owner = coordinator
        .reserve(vec![Request {
            path: f.target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])
        .unwrap();
    owner.finish().unwrap();
}
impl CopyProgress for Cancel {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Ok(())
    }
    fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
        self.started = true;
        Err(AppError::Other("Copy cancelled".into()))
    }
}

#[test]
fn cancelled_durable_copy_retains_evidence_and_never_reports_ordinary_cleanup() {
    let f = Fixture::new();
    let mut cancel = Cancel { started: false };
    let error = f
        .runtime
        .replace_copy(f.storage.clone(), &f.source, &f.target, &mut cancel)
        .unwrap_err();
    assert!(cancel.started);
    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert!(error.to_string().contains("File Recovery"));
    assert_eq!(fs::read(&f.target).unwrap(), b"original bytes");
    assert_eq!(fs::read(&f.source).unwrap(), b"copied bytes");
    assert_eq!(f.inventory().items.len(), 1);
    assert!(
        f.copy(true).is_err(),
        "uncertain retained copy must fence a new writer"
    );
}

struct ChangeTarget<'a> {
    target: &'a Path,
    changed: bool,
}
impl CopyProgress for ChangeTarget<'_> {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Ok(())
    }
    fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
        if !self.changed {
            fs::write(self.target, b"external replacement bytes")?;
            self.changed = true;
        }
        Ok(())
    }
}

#[test]
fn destination_changed_during_staging_is_preserved_and_exposed_for_recovery() {
    let f = Fixture::new();
    let mut progress = ChangeTarget {
        target: &f.target,
        changed: false,
    };
    let error = f
        .runtime
        .replace_copy(f.storage.clone(), &f.source, &f.target, &mut progress)
        .unwrap_err();
    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert_eq!(fs::read(&f.target).unwrap(), b"external replacement bytes");
    assert_eq!(fs::read(&f.source).unwrap(), b"copied bytes");
    assert_eq!(f.inventory().items.len(), 1);
}

#[test]
fn copy_through_an_alias_invalidates_the_physical_directory_listing() {
    let mut f = Fixture::new();
    let physical = f.target.parent().unwrap().to_owned();
    let physical_string = physical.to_string_lossy().into_owned();
    let before = tauri::async_runtime::block_on(crate::files::dir_listing::list_directory(
        physical_string.clone(),
    ))
    .unwrap();
    assert_eq!(
        before
            .entries
            .iter()
            .find(|entry| entry.name == "item.txt")
            .unwrap()
            .size,
        14
    );
    let alias = physical.with_file_name("alias-cache");
    std::os::unix::fs::symlink(&physical, &alias).unwrap();
    f.target = alias.join("item.txt");
    f.copy(true).unwrap();
    let after =
        tauri::async_runtime::block_on(crate::files::dir_listing::list_directory(physical_string))
            .unwrap();
    assert_eq!(
        after
            .entries
            .iter()
            .find(|entry| entry.name == "item.txt")
            .unwrap()
            .size,
        12,
        "copy must invalidate the physical listing even when its receipt uses the alias"
    );
}
