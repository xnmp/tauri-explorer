use super::*;
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    native_directory::Directory,
    recovery::{
        coordinator::Coordinator,
        model::{
            NativePath, OperationCheckpoint, OperationSpec, OperationState, Phase, ReplacementSpec,
        },
        resources::{Access, Request, Scope},
    },
};
use std::{fs, path::Path, sync::Arc};

fn writing(path: &Path) -> Vec<Request> {
    vec![Request {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]
}

pub(super) fn fixture() -> (tempfile::TempDir, Arc<Coordinator>, DurableOperation) {
    let directory = tempfile::tempdir().unwrap();
    let (coordinator, operation) = fixture_at(directory.path());
    (directory, coordinator, operation)
}

fn fixture_at(directory: &Path) -> (Arc<Coordinator>, DurableOperation) {
    fixture_at_with_source(directory, b"new bytes")
}

fn fixture_at_with_source(
    directory: &Path,
    contents: &[u8],
) -> (Arc<Coordinator>, DurableOperation) {
    fixture_at_with_initializer(directory, |source| fs::write(source, contents).unwrap())
}

pub(super) fn fixture_at_with_initializer(
    directory: &Path,
    initialize_source: impl FnOnce(&Path),
) -> (Arc<Coordinator>, DurableOperation) {
    let base = fs::canonicalize(directory).unwrap();
    let source = base.join("source");
    let target = base.join("target");
    let root = base.join(".tauri-explorer-recovery-artifacts");
    initialize_source(&source);
    fs::write(&target, b"original bytes").unwrap();
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let reservation = coordinator
        .reserve(vec![
            Request {
                path: source.clone(),
                access: Access::Read,
                scope: Scope::Subtree,
            },
            Request {
                path: target.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
            Request {
                path: root.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
        ])
        .unwrap();
    let spec = ReplacementSpec {
        artifact_token: "artifacts".into(),
        source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap()).unwrap(),
        source: NativePath(source),
        target: NativePath(target.clone()),
        root: NativePath(root),
        parent: of_file(&Directory::open(&base).unwrap().file).unwrap(),
        original: version_from_metadata(&fs::symlink_metadata(target).unwrap()).unwrap(),
    };
    let operation = reservation
        .promote(OperationSpec::CopyReplacement(spec))
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    (coordinator, operation)
}

pub(super) fn checkpoint(directory: &Path) -> OperationCheckpoint {
    let connection =
        rusqlite::Connection::open(directory.join("recovery/recovery.sqlite3")).unwrap();
    let payload: Vec<u8> = connection
        .query_row(
            "SELECT payload FROM recovery_records WHERE kind = 'operation'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_slice(&payload).unwrap()
}

pub(super) fn phase(directory: &Path) -> Phase {
    let OperationState::Replacement(state) = checkpoint(directory).state else {
        panic!("expected copy replacement fixture");
    };
    state.phase
}

pub(super) fn generation(directory: &Path) -> u64 {
    let connection =
        rusqlite::Connection::open(directory.join("recovery/recovery.sqlite3")).unwrap();
    connection
        .query_row(
            "SELECT generation FROM recovery_records WHERE kind = 'operation'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
        .try_into()
        .unwrap()
}

fn assert_user_files_untouched(directory: &Path) {
    assert_eq!(fs::read(directory.join("source")).unwrap(), b"new bytes");
    assert_eq!(
        fs::read(directory.join("target")).unwrap(),
        b"original bytes"
    );
}

#[test]
fn concrete_preparation_publishes_manifest_under_durable_ownership() {
    let (directory, coordinator, operation) = fixture();
    let prepared = ReplacementExecution::prepare(operation).unwrap();
    prepared
        .root
        .verify_manifest(prepared.operation.intent())
        .unwrap();
    assert_eq!(phase(directory.path()), Phase::Prepared);
    drop(prepared);
    assert!(directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/manifest.intent")
        .exists());
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    coordinator
        .reserve(writing(&directory.path().join("unrelated")))
        .unwrap()
        .finish()
        .unwrap();
    assert_user_files_untouched(directory.path());
}

#[test]
fn filesystem_effects_follow_intent_and_interruption_retains_the_exact_root() {
    for interrupt_root in [true, false] {
        let (directory, coordinator, operation) = fixture();
        let result = ReplacementExecution::prepare_with(
            operation,
            || {
                assert_eq!(phase(directory.path()), Phase::RootIntent);
                assert!(directory
                    .path()
                    .join(".tauri-explorer-recovery-artifacts")
                    .is_dir());
                if interrupt_root {
                    Err(AppError::Other("interrupted after root creation".into()))
                } else {
                    Ok(())
                }
            },
            || {
                assert_eq!(phase(directory.path()), Phase::ManifestIntent);
                assert!(directory
                    .path()
                    .join(".tauri-explorer-recovery-artifacts/manifest.intent")
                    .exists());
                Err(AppError::Other(
                    "interrupted after manifest publication".into(),
                ))
            },
        );
        assert!(result.is_err());
        assert_eq!(
            phase(directory.path()),
            if interrupt_root {
                Phase::RootIntent
            } else {
                Phase::ManifestIntent
            }
        );
        assert!(directory
            .path()
            .join(".tauri-explorer-recovery-artifacts")
            .is_dir());
        assert!(coordinator
            .reserve(writing(&directory.path().join("target")))
            .is_err());
        assert_eq!(
            Coordinator::discover_catalog(&directory.path().join("recovery"))
                .unwrap()
                .len(),
            1
        );
        assert_user_files_untouched(directory.path());
    }
}

#[test]
fn native_process_death_retains_preparation_evidence_and_fences_its_paths() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for boundary in [
        "root",
        "manifest",
        "stage",
        "displace",
        "publish",
        "restore-park",
        "restore-original",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("preparer-ready");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "files::recovery::replacement_execution::tests::subprocess_preparer",
                "--ignored",
                "--nocapture",
            ])
            .env("EXPLORER_RECOVERY_PREPARATION_TEST", directory.path())
            .env("EXPLORER_RECOVERY_PREPARATION_BOUNDARY", boundary)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("preparer did not reach {boundary} boundary");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if matches!(
            boundary,
            "displace" | "publish" | "restore-park" | "restore-original"
        ) {
            let storage = directory.path().join("recovery");
            let intent = Coordinator::discover_catalog(&storage).unwrap().remove(0);
            let current = generation(directory.path());
            let competitor = Coordinator::open(&storage).unwrap();
            assert!(competitor.try_claim(&intent.id, current).unwrap().is_none());
            assert_eq!(generation(directory.path()), current);
        }
        child.kill().unwrap();
        child.wait().unwrap();

        assert_eq!(
            phase(directory.path()),
            match boundary {
                "root" => Phase::RootIntent,
                "manifest" => Phase::ManifestIntent,
                "stage" => Phase::StageIntent,
                "displace" => Phase::DisplaceIntent,
                "publish" => Phase::PublishIntent,
                _ => Phase::RestoreIntent,
            }
        );
        let storage = directory.path().join("recovery");
        let intents = Coordinator::discover_catalog(&storage).unwrap();
        assert_eq!(intents.len(), 1);
        let root_path = directory.path().join(".tauri-explorer-recovery-artifacts");
        let identity = of_file(&Directory::open(&root_path).unwrap().file).unwrap();
        let manifest = root_path.join("manifest.intent");
        let before = fs::read(&manifest).ok();
        assert_eq!(before.is_some(), boundary != "root");
        if boundary != "root" {
            Anchor::open(&intents[0])
                .unwrap()
                .open_existing(identity)
                .unwrap()
                .verify_manifest(&intents[0])
                .unwrap();
        }
        let reopened = Coordinator::open(&storage).unwrap();
        for path in ["source", "target", ".tauri-explorer-recovery-artifacts"] {
            assert!(reopened
                .reserve(writing(&directory.path().join(path)))
                .is_err());
        }
        reopened
            .reserve(writing(&directory.path().join("unrelated")))
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!(Coordinator::discover_catalog(&storage).unwrap(), intents);
        assert_eq!(
            of_file(&Directory::open(&root_path).unwrap().file).unwrap(),
            identity
        );
        assert_eq!(fs::read(&manifest).ok(), before);
        if boundary == "stage" {
            let source = fs::read(directory.path().join("source")).unwrap();
            assert_eq!(source, vec![b'x'; 2 * 1024 * 1024]);
            let partial = fs::read(root_path.join("publication")).unwrap();
            assert!(!partial.is_empty() && partial.len() < source.len());
            assert_eq!(partial, source[..partial.len()]);
            assert_eq!(
                fs::read(directory.path().join("target")).unwrap(),
                b"original bytes"
            );
        } else if matches!(boundary, "displace" | "publish") {
            assert_eq!(
                fs::read(directory.path().join("source")).unwrap(),
                b"new bytes"
            );
            let original = root_path.join("original");
            assert_eq!(fs::read(&original).unwrap(), b"original bytes");
            let OperationSpec::CopyReplacement(spec) = &intents[0].operation else {
                panic!("expected copy replacement fixture");
            };
            assert_eq!(
                version_from_metadata(&fs::symlink_metadata(original).unwrap()).unwrap(),
                spec.original
            );
            if boundary == "displace" {
                assert!(!directory.path().join("target").exists());
                assert_eq!(
                    fs::read(root_path.join("publication")).unwrap(),
                    b"new bytes"
                );
            } else {
                assert_eq!(
                    fs::read(directory.path().join("target")).unwrap(),
                    b"new bytes"
                );
                assert!(!root_path.join("publication").exists());
                let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
                    panic!("expected copy replacement fixture");
                };
                assert_eq!(
                    version_from_metadata(
                        &fs::symlink_metadata(directory.path().join("target")).unwrap()
                    )
                    .unwrap(),
                    state.published.unwrap().published_version().unwrap()
                );
            }
        } else if matches!(boundary, "restore-park" | "restore-original") {
            assert_eq!(
                fs::read(directory.path().join("source")).unwrap(),
                b"new bytes"
            );
            assert_eq!(
                fs::read(root_path.join("publication")).unwrap(),
                b"new bytes"
            );
            if boundary == "restore-park" {
                assert!(!directory.path().join("target").exists());
                assert_eq!(
                    fs::read(root_path.join("original")).unwrap(),
                    b"original bytes"
                );
            } else {
                assert_eq!(
                    fs::read(directory.path().join("target")).unwrap(),
                    b"original bytes"
                );
                assert!(!root_path.join("original").exists());
            }
            let previous = generation(directory.path());
            let claimed = reopened
                .try_claim(&intents[0].id, previous)
                .unwrap()
                .unwrap();
            assert!(generation(directory.path()) > previous);
            let mut execution = ReplacementExecution::reopen(claimed).unwrap();
            execution.restore_copy().unwrap();
            assert_eq!(phase(directory.path()), Phase::Restored);
            assert_eq!(
                fs::read(directory.path().join("target")).unwrap(),
                b"original bytes"
            );
            assert_eq!(
                fs::read(root_path.join("publication")).unwrap(),
                b"new bytes"
            );
            assert!(!root_path.join("original").exists());
            assert_eq!(fs::read(&manifest).ok(), before);
            assert_eq!(Coordinator::discover_catalog(&storage).unwrap(), intents);
        } else {
            assert_user_files_untouched(directory.path());
        }
        if matches!(boundary, "displace" | "publish") {
            let previous = generation(directory.path());
            let claimed = reopened
                .try_claim(&intents[0].id, previous)
                .unwrap()
                .unwrap();
            assert!(generation(directory.path()) > previous);
            let mut execution = ReplacementExecution::reopen(claimed).unwrap();
            if boundary == "displace" {
                execution.displace_copy().unwrap();
            }
            execution.publish_copy().unwrap();
            assert_eq!(phase(directory.path()), Phase::Published);
            assert_eq!(
                fs::read(directory.path().join("target")).unwrap(),
                b"new bytes"
            );
            assert_eq!(
                fs::read(directory.path().join("source")).unwrap(),
                b"new bytes"
            );
            assert_eq!(
                fs::read(root_path.join("original")).unwrap(),
                b"original bytes"
            );
            assert!(!root_path.join("publication").exists());
            assert_eq!(fs::read(&manifest).ok(), before);
            assert_eq!(Coordinator::discover_catalog(&storage).unwrap(), intents);
        }
    }
}

#[test]
#[ignore = "controlled helper for native_process_death_retains_preparation_evidence_and_fences_its_paths"]
fn subprocess_preparer() {
    let directory = std::path::PathBuf::from(
        std::env::var_os("EXPLORER_RECOVERY_PREPARATION_TEST").expect("parent fixture"),
    );
    let boundary =
        std::env::var("EXPLORER_RECOVERY_PREPARATION_BOUNDARY").expect("parent boundary");
    assert!(matches!(
        boundary.as_str(),
        "root"
            | "manifest"
            | "stage"
            | "displace"
            | "publish"
            | "restore-park"
            | "restore-original"
    ));
    if boundary == "stage" {
        struct Pause<'a>(&'a Path);
        impl crate::files::anchored_copy::CopyProgress for Pause<'_> {
            fn check_cancelled(&mut self) -> Result<(), AppError> {
                Ok(())
            }
            fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
                fs::write(self.0.join("preparer-ready"), b"stage")?;
                loop {
                    std::thread::park();
                }
            }
        }
        let (_coordinator, operation) =
            fixture_at_with_source(&directory, &vec![b'x'; 2 * 1024 * 1024]);
        let mut prepared = ReplacementExecution::prepare(operation).unwrap();
        prepared.stage_copy(&mut Pause(&directory)).unwrap();
        panic!("copy must stop at its first progress boundary");
    }
    let (_coordinator, operation) = fixture_at(&directory);
    let stop = || -> Result<(), AppError> {
        fs::write(directory.join("preparer-ready"), boundary.as_bytes())?;
        loop {
            std::thread::park();
        }
    };
    if matches!(
        boundary.as_str(),
        "displace" | "publish" | "restore-park" | "restore-original"
    ) {
        let mut execution = ReplacementExecution::prepare(operation).unwrap();
        let mut tracker = crate::progress::ProgressTracker::new(
            None,
            "copy-progress",
            "Copy cancelled",
            0,
            0,
            None,
        );
        execution.stage_copy(&mut tracker).unwrap();
        if boundary == "displace" {
            execution.displace_with(stop).unwrap();
        } else if boundary == "publish" {
            execution.displace_copy().unwrap();
            execution.publish_with(|_| stop()).unwrap();
        } else {
            execution.displace_copy().unwrap();
            execution.publish_copy().unwrap();
            execution
                .operation
                .advance(ReplacementTransition::BeginRestoration)
                .unwrap();
            execution
                .root
                .restore_copy_with_hook(
                    execution.operation.intent(),
                    execution.payload().unwrap(),
                    |effect| {
                        if (boundary == "restore-park" && effect == "park")
                            || (boundary == "restore-original" && effect == "restore")
                        {
                            stop()
                        } else {
                            Ok(())
                        }
                    },
                )
                .unwrap();
        }
        panic!("transfer must stop before completion checkpoint");
    }
    let _held = ReplacementExecution::prepare_with(
        operation,
        || if boundary == "root" { stop() } else { Ok(()) },
        || {
            if boundary == "manifest" {
                stop()
            } else {
                Ok(())
            }
        },
    )
    .unwrap();
}

#[test]
fn staging_records_the_native_payload_without_touching_the_public_destination() {
    let (directory, coordinator, operation) = fixture();
    let mut prepared = ReplacementExecution::prepare(operation).unwrap();
    let mut tracker =
        crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None);
    prepared.stage_copy(&mut tracker).unwrap();
    assert_eq!(phase(directory.path()), Phase::Staged);
    let publication = directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/publication");
    assert_eq!(fs::read(&publication).unwrap(), b"new bytes");
    let OperationState::Replacement(state) = prepared.operation.state() else {
        panic!("expected copy replacement fixture");
    };
    assert_eq!(
        state.published.as_ref().unwrap().version,
        version_from_metadata(&fs::symlink_metadata(&publication).unwrap()).unwrap()
    );
    assert!(state.published.as_ref().unwrap().final_mode.is_none());
    assert_user_files_untouched(directory.path());
    drop(prepared);
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    assert_eq!(fs::read(publication).unwrap(), b"new bytes");
}

#[cfg(target_os = "linux")]
#[test]
fn reclaimed_publication_intent_finalizes_an_owner_unreadable_directory() {
    use std::os::unix::fs::PermissionsExt;

    for mode in [0o000, 0o300] {
        let directory = tempfile::tempdir().unwrap();
        let (coordinator, operation) = fixture_at_with_initializer(directory.path(), |source| {
            fs::create_dir(source).unwrap();
            fs::write(source.join("child"), b"new tree bytes").unwrap();
            fs::set_permissions(source, fs::Permissions::from_mode(0o500)).unwrap();
        });
        let mut execution = ReplacementExecution::prepare(operation).unwrap();
        execution
            .operation
            .advance(ReplacementTransition::BeginStaging)
            .unwrap();
        let mut tracker = crate::progress::ProgressTracker::new(
            None,
            "copy-progress",
            "Copy cancelled",
            0,
            0,
            None,
        );
        let mut staged = execution
            .root
            .copy_payload(execution.operation.intent(), &mut tracker)
            .unwrap();
        // Persist the final-mode contract before any displacement/publication.
        // Access granted to a source by its ownership/ACL may not transfer.
        staged.final_mode = Some(mode);
        let expected = staged.published_version().unwrap();
        execution
            .operation
            .advance(ReplacementTransition::StagingCompleted(staged))
            .unwrap();
        execution.displace_copy().unwrap();
        assert!(execution
            .publish_with(|_| Err(AppError::Other("lost publication reply".into())))
            .is_err());
        assert_eq!(phase(directory.path()), Phase::PublishIntent);
        let target = directory.path().join("target");
        assert_eq!(
            version_from_metadata(&fs::symlink_metadata(&target).unwrap()).unwrap(),
            expected
        );
        let intents = Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap();
        let previous = generation(directory.path());
        drop(execution);
        drop(coordinator);

        let coordinator = Coordinator::open(&directory.path().join("recovery")).unwrap();
        let claimed = coordinator
            .try_claim(&intents[0].id, previous)
            .unwrap()
            .unwrap();
        assert!(generation(directory.path()) > previous);
        let mut reopened = ReplacementExecution::reopen(claimed).unwrap();
        assert_eq!(reopened.publish_copy().unwrap(), expected);
        assert_eq!(phase(directory.path()), Phase::Published);
        let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
            panic!("expected copy replacement fixture");
        };
        assert!(state.error.is_none());
        assert_eq!(
            version_from_metadata(&fs::symlink_metadata(&target).unwrap()).unwrap(),
            expected
        );
        let root = directory.path().join(".tauri-explorer-recovery-artifacts");
        let OperationSpec::CopyReplacement(spec) = &intents[0].operation else {
            panic!("expected copy replacement fixture");
        };
        assert_eq!(
            version_from_metadata(&fs::symlink_metadata(root.join("original")).unwrap()).unwrap(),
            spec.original
        );
        assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
        assert!(!root.join("publication").exists());
        assert_eq!(
            Coordinator::discover_catalog(&directory.path().join("recovery")).unwrap(),
            intents
        );
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::read(target.join("child")).unwrap(), b"new tree bytes");
        assert_eq!(
            fs::read(directory.path().join("source/child")).unwrap(),
            b"new tree bytes"
        );
    }
}

#[test]
fn stage_intent_is_durable_before_copy_callbacks_and_cancellation_creates_no_payload() {
    struct Cancel<'a>(&'a Path);
    impl crate::files::anchored_copy::CopyProgress for Cancel<'_> {
        fn check_cancelled(&mut self) -> Result<(), AppError> {
            assert_eq!(phase(self.0), Phase::StageIntent);
            Err(AppError::Other("injected cancellation".into()))
        }
        fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
            unreachable!()
        }
    }
    let (directory, coordinator, operation) = fixture();
    let mut prepared = ReplacementExecution::prepare(operation).unwrap();
    assert!(prepared.stage_copy(&mut Cancel(directory.path())).is_err());
    assert_eq!(phase(directory.path()), Phase::StageIntent);
    let OperationState::Replacement(stored) = checkpoint(directory.path()).state else {
        panic!("expected copy replacement fixture");
    };
    assert!(stored.error.unwrap().contains("injected cancellation"));
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/publication")
        .exists());
    assert!(directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/manifest.intent")
        .exists());
    drop(prepared);
    assert!(coordinator
        .reserve(writing(&directory.path().join("source")))
        .is_err());
    assert_user_files_untouched(directory.path());
}

#[test]
fn staged_copy_rejects_changed_source_and_occupied_payload_without_replacement() {
    for changed_source in [true, false] {
        let (directory, _coordinator, operation) = fixture();
        let mut prepared = ReplacementExecution::prepare(operation).unwrap();
        let publication = directory
            .path()
            .join(".tauri-explorer-recovery-artifacts/publication");
        if changed_source {
            fs::rename(
                directory.path().join("source"),
                directory.path().join("held-source"),
            )
            .unwrap();
            fs::write(directory.path().join("source"), b"different occupant").unwrap();
        } else {
            fs::write(&publication, b"occupied private name").unwrap();
        }
        let mut tracker = crate::progress::ProgressTracker::new(
            None,
            "copy-progress",
            "Copy cancelled",
            0,
            0,
            None,
        );
        assert!(prepared.stage_copy(&mut tracker).is_err());
        assert_eq!(phase(directory.path()), Phase::StageIntent);
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original bytes"
        );
        if changed_source {
            assert!(!publication.exists());
            assert_eq!(
                fs::read(directory.path().join("source")).unwrap(),
                b"different occupant"
            );
            assert_eq!(
                fs::read(directory.path().join("held-source")).unwrap(),
                b"new bytes"
            );
        } else {
            assert_eq!(fs::read(publication).unwrap(), b"occupied private name");
            assert_user_files_untouched(directory.path());
        }
    }
}

#[test]
fn same_object_source_permission_changes_are_rejected_before_staging() {
    reject_same_object_source_change(true);
}

#[test]
fn same_object_source_content_changes_are_rejected_before_staging() {
    reject_same_object_source_change(false);
}

fn reject_same_object_source_change(permissions_only: bool) {
    use std::os::unix::fs::PermissionsExt;
    let (directory, _coordinator, operation) = fixture();
    let mut prepared = ReplacementExecution::prepare(operation).unwrap();
    let source = directory.path().join("source");
    if permissions_only {
        fs::set_permissions(&source, fs::Permissions::from_mode(0o400)).unwrap();
    } else {
        fs::write(&source, b"bad bytes").unwrap();
        let file = fs::File::open(&source).unwrap();
        file.set_times(
            fs::FileTimes::new()
                .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1)),
        )
        .unwrap();
    }
    let mut tracker =
        crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None);
    assert!(
        prepared.stage_copy(&mut tracker).is_err(),
        "changed source was silently adopted"
    );
    assert_eq!(phase(directory.path()), Phase::StageIntent);
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/publication")
        .exists());
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original bytes"
    );
    assert_eq!(
        fs::read(source).unwrap(),
        if permissions_only {
            b"new bytes"
        } else {
            b"bad bytes"
        }
    );
}

#[test]
fn failed_stage_retains_bounded_diagnostics_without_masking_the_original_error() {
    struct Fail {
        message: String,
        catalog: Option<std::path::PathBuf>,
    }
    impl crate::files::anchored_copy::CopyProgress for Fail {
        fn check_cancelled(&mut self) -> Result<(), AppError> {
            if let Some(path) = self.catalog.take() {
                fs::write(path, b"changed evidence")?;
            }
            Err(AppError::Other(self.message.clone()))
        }
        fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
            unreachable!()
        }
    }
    for corrupt_catalog in [false, true] {
        let (directory, _coordinator, operation) = fixture();
        let mut prepared = ReplacementExecution::prepare(operation).unwrap();
        let catalog = directory
            .path()
            .join("recovery/catalog")
            .join(format!("{}.intent", prepared.operation.intent().id));
        let message = "failed staging: ".to_owned() + &"界".repeat(10_000);
        let expected = AppError::Other(message.clone()).to_string();
        let returned = prepared
            .stage_copy(&mut Fail {
                message,
                catalog: corrupt_catalog.then_some(catalog.clone()),
            })
            .unwrap_err();
        assert_eq!(returned.to_string(), expected);
        let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
            panic!("expected copy replacement fixture");
        };
        assert_eq!(state.phase, Phase::StageIntent);
        if corrupt_catalog {
            assert!(state.error.is_none());
            assert_eq!(fs::read(catalog).unwrap(), b"changed evidence");
        } else {
            let stored = state.error.unwrap();
            assert!(stored.len() <= super::super::model::MAX_ERROR_BYTES);
            assert!(stored.len() > super::super::model::MAX_ERROR_BYTES - 4);
            assert!(expected.starts_with(&stored));
        }
        assert!(!directory
            .path()
            .join(".tauri-explorer-recovery-artifacts/publication")
            .exists());
        assert_user_files_untouched(directory.path());
    }
}

fn staged_fixture() -> (tempfile::TempDir, Arc<Coordinator>, ReplacementExecution) {
    let (directory, coordinator, operation) = fixture();
    let mut prepared = ReplacementExecution::prepare(operation).unwrap();
    let mut tracker =
        crate::progress::ProgressTracker::new(None, "copy-progress", "Copy cancelled", 0, 0, None);
    prepared.stage_copy(&mut tracker).unwrap();
    (directory, coordinator, prepared)
}

#[test]
fn copied_payload_replaces_the_target_while_its_original_remains_recoverable() {
    let (directory, coordinator, mut execution) = staged_fixture();
    execution.displace_copy().unwrap();
    assert_eq!(phase(directory.path()), Phase::Displaced);
    assert!(!directory.path().join("target").exists());
    let original = directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/original");
    assert_eq!(fs::read(&original).unwrap(), b"original bytes");
    let published = execution.publish_copy().unwrap();
    assert_eq!(phase(directory.path()), Phase::Published);
    assert_eq!(
        published,
        version_from_metadata(&fs::symlink_metadata(directory.path().join("target")).unwrap())
            .unwrap()
    );
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"new bytes"
    );
    assert_eq!(
        fs::read(directory.path().join("source")).unwrap(),
        b"new bytes"
    );
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/publication")
        .exists());
    assert!(coordinator
        .reserve(writing(&directory.path().join("target")))
        .is_err());
    drop(execution);
    assert_eq!(fs::read(&original).unwrap(), b"original bytes");
    coordinator
        .reserve(writing(&directory.path().join("target")))
        .unwrap()
        .finish()
        .unwrap();
    assert!(coordinator.reserve(writing(&original)).is_err());
}

#[test]
fn changed_original_is_preserved_and_never_displaced_by_an_old_plan() {
    let (directory, _coordinator, mut execution) = staged_fixture();
    fs::write(directory.path().join("target"), b"changed original").unwrap();
    assert!(execution.displace_copy().is_err());
    assert_eq!(phase(directory.path()), Phase::DisplaceIntent);
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"changed original"
    );
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/original")
        .exists());
    assert_eq!(
        fs::read(
            directory
                .path()
                .join(".tauri-explorer-recovery-artifacts/publication")
        )
        .unwrap(),
        b"new bytes"
    );
}

#[test]
fn publication_collision_preserves_the_new_occupant_and_both_retained_payloads() {
    let (directory, _coordinator, mut execution) = staged_fixture();
    execution.displace_copy().unwrap();
    fs::write(directory.path().join("target"), b"racing occupant").unwrap();
    assert!(execution.publish_copy().is_err());
    assert_eq!(phase(directory.path()), Phase::PublishIntent);
    for (name, bytes) in [
        ("target", b"racing occupant".as_slice()),
        (
            ".tauri-explorer-recovery-artifacts/original",
            b"original bytes".as_slice(),
        ),
        (
            ".tauri-explorer-recovery-artifacts/publication",
            b"new bytes".as_slice(),
        ),
    ] {
        assert_eq!(fs::read(directory.path().join(name)).unwrap(), bytes);
    }
}

#[test]
fn interruptions_between_native_transfer_and_checkpoint_keep_intent_and_evidence() {
    for publishing in [false, true] {
        let (directory, _coordinator, mut execution) = staged_fixture();
        if publishing {
            execution.displace_copy().unwrap();
            assert!(execution
                .publish_with(|version| {
                    assert_eq!(phase(directory.path()), Phase::PublishIntent);
                    assert_eq!(
                        version,
                        &version_from_metadata(
                            &fs::symlink_metadata(directory.path().join("target")).unwrap()
                        )
                        .unwrap()
                    );
                    Err(AppError::Other("interrupted publication checkpoint".into()))
                })
                .is_err());
        } else {
            assert!(execution
                .displace_with(|| {
                    assert_eq!(phase(directory.path()), Phase::DisplaceIntent);
                    assert!(!directory.path().join("target").exists());
                    Err(AppError::Other(
                        "interrupted displacement checkpoint".into(),
                    ))
                })
                .is_err());
        }
        assert_eq!(
            phase(directory.path()),
            if publishing {
                Phase::PublishIntent
            } else {
                Phase::DisplaceIntent
            }
        );
        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join(".tauri-explorer-recovery-artifacts/original")
            )
            .unwrap(),
            b"original bytes"
        );
        let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
            panic!("expected copy replacement fixture");
        };
        assert!(state.error.unwrap().contains("interrupted"));
        if publishing {
            execution.publish_copy().unwrap();
            assert_eq!(phase(directory.path()), Phase::Published);
        } else {
            execution.displace_copy().unwrap();
            assert_eq!(phase(directory.path()), Phase::Displaced);
        }
        let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
            panic!("expected copy replacement fixture");
        };
        assert!(state.error.is_none());
        assert_eq!(
            fs::read(directory.path().join("source")).unwrap(),
            b"new bytes"
        );
    }
}

#[test]
fn restoration_recovers_original_across_forward_boundaries_without_needing_the_source() {
    for boundary in ["displace-intent", "displaced", "published"] {
        let (directory, coordinator, mut execution) = staged_fixture();
        if boundary == "displace-intent" {
            execution
                .operation
                .advance(ReplacementTransition::BeginDisplacement)
                .unwrap();
        } else {
            execution.displace_copy().unwrap();
            if boundary == "published" {
                execution.publish_copy().unwrap();
            }
        }
        fs::remove_file(directory.path().join("source")).unwrap();
        let original = match &execution.operation.intent().operation {
            OperationSpec::CopyReplacement(spec) => spec.original.clone(),
            OperationSpec::Move(_) => panic!("expected copy replacement fixture"),
        };
        let restored = execution.restore_copy().unwrap();
        assert_eq!(restored, original);
        assert_eq!(phase(directory.path()), Phase::Restored);
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original bytes"
        );
        let root = directory.path().join(".tauri-explorer-recovery-artifacts");
        assert!(!root.join("original").exists());
        assert_eq!(fs::read(root.join("publication")).unwrap(), b"new bytes");
        assert!(!directory.path().join("source").exists());
        assert!(coordinator
            .reserve(writing(&directory.path().join("target")))
            .is_err());
        drop(execution);
        coordinator
            .reserve(writing(&directory.path().join("target")))
            .unwrap()
            .finish()
            .unwrap();
        assert!(coordinator.reserve(writing(&root)).is_err());
        assert!(root.join("manifest.intent").exists());
    }
}

#[test]
fn changed_publication_is_preserved_when_restoration_is_requested() {
    let (directory, _coordinator, mut execution) = staged_fixture();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    fs::write(
        directory.path().join("target"),
        b"user edited this after publication",
    )
    .unwrap();
    assert!(execution.restore_copy().is_err());
    assert_eq!(phase(directory.path()), Phase::RestoreIntent);
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"user edited this after publication"
    );
    let root = directory.path().join(".tauri-explorer-recovery-artifacts");
    assert_eq!(fs::read(root.join("original")).unwrap(), b"original bytes");
    assert!(!root.join("publication").exists());
    let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
        panic!("expected copy replacement fixture");
    };
    assert!(state.error.is_some());
}

#[test]
fn restoration_completion_retry_retains_both_versions_and_clears_the_error() {
    let (directory, _coordinator, mut execution) = staged_fixture();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    assert!(execution
        .restore_with(|_| {
            assert_eq!(phase(directory.path()), Phase::RestoreIntent);
            assert_eq!(
                fs::read(directory.path().join("target")).unwrap(),
                b"original bytes"
            );
            Err(AppError::Other("interrupted restoration checkpoint".into()))
        })
        .is_err());
    let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
        panic!("expected copy replacement fixture");
    };
    assert!(state.error.unwrap().contains("interrupted restoration"));
    execution.restore_copy().unwrap();
    assert_eq!(phase(directory.path()), Phase::Restored);
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original bytes"
    );
    assert_eq!(
        fs::read(
            directory
                .path()
                .join(".tauri-explorer-recovery-artifacts/publication")
        )
        .unwrap(),
        b"new bytes"
    );
    let OperationState::Replacement(state) = checkpoint(directory.path()).state else {
        panic!("expected copy replacement fixture");
    };
    assert!(state.error.is_none());
}
