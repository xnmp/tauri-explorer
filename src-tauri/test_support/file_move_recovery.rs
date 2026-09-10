use super::{cross_device_move, move_entry_with};
use crate::error::AppError;
use crate::files::move_plan::MovePlan;
#[cfg(target_os = "linux")]
use crate::files::{
    move_execution,
    recovery::{Access, ResourceRequest, Runtime, Scope},
};
use std::{cell::Cell, fs, path::PathBuf};

struct MoveFixture {
    _root: tempfile::TempDir,
    source: PathBuf,
    destination: PathBuf,
    target: PathBuf,
}

impl MoveFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("temporary move root");
        let source = root.path().join("source-tree");
        let destination = root.path().join("destination");
        let target = destination.join("source-tree");
        fs::create_dir(&source).expect("create source tree");
        fs::create_dir(&destination).expect("create destination");
        fs::write(source.join("first.txt"), "first contents").expect("write first source");
        fs::write(source.join("second.txt"), "second contents").expect("write second source");
        Self {
            _root: root,
            source,
            destination,
            target,
        }
    }

    fn assert_complete_target(&self) {
        assert_eq!(
            fs::read_to_string(self.target.join("first.txt")).unwrap(),
            "first contents",
        );
        assert_eq!(
            fs::read_to_string(self.target.join("second.txt")).unwrap(),
            "second contents",
        );
    }

    fn assert_complete_source(&self) {
        assert_eq!(
            fs::read_to_string(self.source.join("first.txt")).unwrap(),
            "first contents",
        );
        assert_eq!(
            fs::read_to_string(self.source.join("second.txt")).unwrap(),
            "second contents",
        );
    }
}

#[cfg(target_os = "linux")]
fn writing(path: &std::path::Path) -> Vec<ResourceRequest> {
    vec![ResourceRequest {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]
}

#[cfg(target_os = "linux")]
fn assert_move_rejects_live_recovery_claim(claim: impl FnOnce(&MoveFixture) -> PathBuf) {
    let fixture = MoveFixture::new();
    let runtime = Runtime::default();
    let storage = fixture._root.path().join("recovery");
    let owner = tauri::async_runtime::block_on(
        runtime
            .clone()
            .admit(storage.clone(), writing(&claim(&fixture))),
    )
    .unwrap();
    let plan = MovePlan::new(
        fixture.source.to_string_lossy().into_owned(),
        fixture.destination.to_string_lossy().into_owned(),
        false,
    )
    .unwrap();

    let result = tauri::async_runtime::block_on(move_execution::execute(plan, runtime, storage));

    assert!(
        result.completion.result.is_err(),
        "a live recovery claim must fence move effects"
    );
    fixture.assert_complete_source();
    assert!(!fixture.target.exists());
    drop(owner);
}

#[test]
#[cfg(target_os = "linux")]
fn move_rejects_an_outstanding_recovery_source_claim() {
    assert_move_rejects_live_recovery_claim(|fixture| fixture.source.clone());
}

#[test]
#[cfg(target_os = "linux")]
fn move_rejects_an_outstanding_recovery_target_claim() {
    assert_move_rejects_live_recovery_claim(|fixture| fixture.target.clone());
}

#[test]
#[cfg(target_os = "linux")]
fn admitted_move_executes_a_normal_file_move() {
    let fixture = MoveFixture::new();
    let plan = MovePlan::new(
        fixture.source.to_string_lossy().into_owned(),
        fixture.destination.to_string_lossy().into_owned(),
        false,
    )
    .unwrap();
    let outcome = tauri::async_runtime::block_on(move_execution::execute(
        plan,
        Runtime::default(),
        fixture._root.path().join("recovery"),
    ));
    assert!(outcome.completion.result.is_ok());
    assert!(!fixture.source.exists());
    fixture.assert_complete_target();
}

#[test]
#[cfg(target_os = "linux")]
fn admitted_move_resolves_parent_aliases_and_preserves_a_symlink_leaf() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination");
    let source_alias = root.path().join("source-alias");
    let destination_alias = root.path().join("destination-alias");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&destination).unwrap();
    std::os::unix::fs::symlink(&source, &source_alias).unwrap();
    std::os::unix::fs::symlink(&destination, &destination_alias).unwrap();
    let referent = root.path().join("referent.txt");
    fs::write(&referent, b"referent bytes").unwrap();
    std::os::unix::fs::symlink(&referent, source.join("link.txt")).unwrap();
    let plan = MovePlan::new(
        source_alias.join("link.txt").to_string_lossy().into_owned(),
        destination_alias.to_string_lossy().into_owned(),
        false,
    )
    .unwrap();
    let outcome = tauri::async_runtime::block_on(move_execution::execute(
        plan,
        Runtime::default(),
        root.path().join("recovery"),
    ));

    let receipt = outcome.completion.result.unwrap();
    let moved = destination.join("link.txt");
    assert_eq!(
        receipt.path,
        destination_alias.join("link.txt").to_string_lossy()
    );
    assert!(fs::symlink_metadata(&moved)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_link(&moved).unwrap(), referent);
    assert!(!source.join("link.txt").exists());
}

#[test]
#[cfg(target_os = "linux")]
fn resolved_move_uses_admitted_parent_after_requested_alias_retargets() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let admitted = root.path().join("admitted");
    let retargeted = root.path().join("retargeted");
    let requested_alias = root.path().join("requested-alias");
    let stable_alias = root.path().join("stable-alias");
    for path in [&source, &admitted, &retargeted] {
        fs::create_dir(path).unwrap();
    }
    fs::write(source.join("item.txt"), b"bound bytes").unwrap();
    std::os::unix::fs::symlink(&admitted, &requested_alias).unwrap();
    std::os::unix::fs::symlink(&admitted, &stable_alias).unwrap();
    let runtime = Runtime::default();
    let storage = root.path().join("recovery");
    let plan = MovePlan::new(
        source.join("item.txt").to_string_lossy().into_owned(),
        requested_alias.to_string_lossy().into_owned(),
        false,
    )
    .unwrap();
    let admission =
        tauri::async_runtime::block_on(runtime.clone().admit(storage.clone(), plan.resources()))
            .unwrap();
    let plan = plan
        .resolve(admission.paths().map(std::path::Path::to_path_buf))
        .unwrap();
    fs::remove_file(&requested_alias).unwrap();
    std::os::unix::fs::symlink(&retargeted, &requested_alias).unwrap();

    let outcome =
        tauri::async_runtime::block_on(move_execution::execute_owned(plan, admission.context()));
    let receipt = outcome.completion.result.unwrap();
    assert_eq!(receipt.path, admitted.join("item.txt").to_string_lossy());
    assert_eq!(fs::read(admitted.join("item.txt")).unwrap(), b"bound bytes");
    assert!(!retargeted.join("item.txt").exists());
    assert!(tauri::async_runtime::block_on(
        runtime
            .clone()
            .admit(storage.clone(), writing(&stable_alias.join("item.txt")),)
    )
    .is_err());
    admission.finish().unwrap();
    tauri::async_runtime::block_on(runtime.admit(storage, writing(&stable_alias.join("item.txt"))))
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn cleanup_failure_after_partial_removal_reports_a_committed_move_and_source_remainder() {
    let fixture = MoveFixture::new();

    let result = cross_device_move(
        &fixture.source,
        &fixture.destination,
        &fixture.target,
        |owned_source| {
            fs::remove_file(owned_source.join("first.txt"))?;
            Err(AppError::Other("injected cleanup failure".into()))
        },
    );

    fixture.assert_complete_target();
    assert!(
        fixture.source.exists(),
        "the failed cleanup must report the source remainder honestly",
    );
    assert!(!fixture.source.join("first.txt").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("second.txt")).unwrap(),
        "second contents",
    );
    let recovery = result
        .expect("the published destination must remain a committed move")
        .expect("failed cleanup must return recovery details");
    assert_eq!(recovery.source_path, fixture.source.to_string_lossy());
    assert_eq!(recovery.destination_path, fixture.target.to_string_lossy());
    assert!(recovery.error.contains("injected cleanup failure"));
    assert_eq!(recovery.displaced_path, None);
}

#[test]
fn cleanup_failure_before_removal_reports_a_committed_move_and_intact_source() {
    let fixture = MoveFixture::new();

    let result = cross_device_move(
        &fixture.source,
        &fixture.destination,
        &fixture.target,
        |_| Err(AppError::Other("injected cleanup refusal".into())),
    );

    fixture.assert_complete_target();
    fixture.assert_complete_source();
    let recovery = result
        .expect("cleanup after publication must not report the move as unapplied")
        .expect("failed cleanup must return recovery details");
    assert_eq!(recovery.source_path, fixture.source.to_string_lossy());
    assert_eq!(recovery.destination_path, fixture.target.to_string_lossy());
    assert!(recovery.error.contains("injected cleanup refusal"));
    assert_eq!(recovery.displaced_path, None);
}

#[test]
fn successful_cleanup_returns_no_recovery_and_removes_the_source() {
    let fixture = MoveFixture::new();

    let recovery = cross_device_move(
        &fixture.source,
        &fixture.destination,
        &fixture.target,
        |source| {
            fs::remove_dir_all(source)?;
            Ok(())
        },
    )
    .expect("complete move must succeed");

    assert!(recovery.is_none());
    fixture.assert_complete_target();
    assert!(!fixture.source.exists());
}

#[test]
fn target_collision_fails_before_cleanup_and_preserves_the_source() {
    let fixture = MoveFixture::new();
    fs::write(&fixture.target, "occupied target").expect("create target collision");
    let cleanup_called = Cell::new(false);

    let result = cross_device_move(
        &fixture.source,
        &fixture.destination,
        &fixture.target,
        |_| {
            cleanup_called.set(true);
            Ok(())
        },
    );

    assert!(result.is_err(), "target collision must reject publication");
    assert!(
        !cleanup_called.get(),
        "cleanup must not run before publication"
    );
    fixture.assert_complete_source();
    assert_eq!(
        fs::read_to_string(&fixture.target).unwrap(),
        "occupied target"
    );
}

#[test]
fn overwrite_cleanup_recovery_retains_the_displaced_target_without_rolling_back() {
    let fixture = MoveFixture::new();
    fs::create_dir(&fixture.target).expect("create existing target tree");
    fs::write(fixture.target.join("old.txt"), "old target contents")
        .expect("write existing target child");

    let receipt = move_entry_with(
        fixture.source.to_string_lossy().into_owned(),
        fixture.destination.to_string_lossy().into_owned(),
        Some(true),
        |source, destination, target| {
            cross_device_move(source, destination, target, |owned_source| {
                fs::remove_file(owned_source.join("first.txt"))?;
                Err(AppError::Other("injected overwrite cleanup failure".into()))
            })
        },
    )
    .expect("published overwrite remains committed");

    assert_eq!(receipt.path, fixture.target.to_string_lossy());
    fixture.assert_complete_target();
    assert!(!fixture.source.join("first.txt").exists());
    assert_eq!(
        fs::read_to_string(fixture.source.join("second.txt")).unwrap(),
        "second contents",
    );
    let recovery = receipt
        .recovery
        .expect("partial cleanup must return recovery details");
    assert_eq!(recovery.source_path, fixture.source.to_string_lossy());
    assert_eq!(recovery.destination_path, fixture.target.to_string_lossy());
    assert!(recovery
        .error
        .contains("injected overwrite cleanup failure"));
    let displaced = PathBuf::from(
        recovery
            .displaced_path
            .expect("the displaced target must be retained for recovery"),
    );
    assert_eq!(
        fs::read_to_string(displaced.join("old.txt")).unwrap(),
        "old target contents",
    );
}

#[test]
fn failed_overwrite_publication_preserves_a_racing_target_and_reports_the_retained_original() {
    let fixture = MoveFixture::new();
    fs::create_dir(&fixture.target).expect("create existing target tree");
    fs::write(fixture.target.join("old.txt"), "old target contents")
        .expect("write existing target child");

    let error = move_entry_with(
        fixture.source.to_string_lossy().into_owned(),
        fixture.destination.to_string_lossy().into_owned(),
        Some(true),
        |_source, _destination, target| {
            fs::create_dir(target)?;
            fs::write(target.join("racer.txt"), "racing target")?;
            Err(AppError::Other("injected prepublication failure".into()))
        },
    )
    .expect_err("failed publication must not produce a committed receipt")
    .to_string();

    fixture.assert_complete_source();
    assert_eq!(
        fs::read_to_string(fixture.target.join("racer.txt")).unwrap(),
        "racing target",
    );
    assert!(error.contains("injected prepublication failure"));
    let retained = error
        .rsplit_once("It is retained at ")
        .map(|(_, path)| PathBuf::from(path))
        .expect("rollback failure must report the retained original path");
    assert_eq!(
        fs::read_to_string(retained.join("old.txt")).unwrap(),
        "old target contents",
    );
}

#[test]
fn failed_overwrite_publication_restores_the_original_and_removes_its_recovery_record() {
    let fixture = MoveFixture::new();
    fs::create_dir(&fixture.target).expect("create existing target tree");
    fs::write(fixture.target.join("old.txt"), "old target contents")
        .expect("write existing target child");

    let error = move_entry_with(
        fixture.source.to_string_lossy().into_owned(),
        fixture.destination.to_string_lossy().into_owned(),
        Some(true),
        |_source, _destination, _target| {
            Err(AppError::Other("injected publication failure".into()))
        },
    )
    .expect_err("failed publication must not produce a committed receipt")
    .to_string();

    assert!(error.contains("injected publication failure"));
    fixture.assert_complete_source();
    assert_eq!(
        fs::read_to_string(fixture.target.join("old.txt")).unwrap(),
        "old target contents",
    );
    let mut destination_entries = fs::read_dir(&fixture.destination)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    destination_entries.sort();
    assert_eq!(destination_entries, vec!["source-tree"]);
    let target_entries = fs::read_dir(&fixture.target)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(target_entries, vec!["old.txt"]);
}

#[test]
fn move_plan_rejects_invalid_or_unbounded_input_before_filesystem_work() {
    for source in [
        "".to_owned(),
        "relative".into(),
        "/".into(),
        "/tmp/../entry".into(),
        "/tmp/a\0b".into(),
        format!("/{}", "a".repeat(128 * 1024)),
    ] {
        assert!(
            MovePlan::new(source.clone(), "/tmp/destination".into(), false).is_err(),
            "accepted source {source:?}"
        );
    }
    for destination in [
        "relative".to_owned(),
        "/tmp/../destination".into(),
        "/tmp/a\0b".into(),
        format!("/{}", "a".repeat(128 * 1024)),
    ] {
        assert!(
            MovePlan::new("/tmp/source".into(), destination.clone(), false).is_err(),
            "accepted destination {destination:?}"
        );
    }
}
