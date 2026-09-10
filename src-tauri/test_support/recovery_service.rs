use super::*;
use crate::files::recovery::coordinator::{test_fixture::fixture, DurableOperation};
use std::{fs, path::Path};

fn published() -> (tempfile::TempDir, Arc<Coordinator>, ReplacementExecution) {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let mut execution = ReplacementExecution::prepare(operation).unwrap();
    let mut progress = crate::progress::ProgressTracker::new(None, "copy", "cancelled", 0, 0, None);
    execution.stage_copy(&mut progress).unwrap();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    (directory, coordinator, execution)
}

fn bytes(directory: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(directory.join("target")).unwrap(),
        fs::read(directory.join(".tauri-explorer-recovery-artifacts/original")).unwrap(),
    )
}

#[test]
fn retained_location_names_the_artifact_container_after_restoration() {
    let (directory, coordinator, execution) = published();
    drop(execution);
    let snapshot = list(&coordinator).unwrap();
    let inspected = inspect(&coordinator, &snapshot.items[0].id).unwrap();
    let item = &inspected.items[0];
    resolve(
        &coordinator,
        &item.id,
        item.generation,
        RecoveryChoice::Restore,
    )
    .unwrap();
    let rechecked = inspect(&coordinator, &item.id).unwrap();
    let retained = Path::new(rechecked.items[0].retained_path.as_ref().unwrap());
    assert!(
        retained.is_dir(),
        "retained location must remain useful after the original moves home"
    );
    assert_eq!(
        fs::read(retained.join("publication")).unwrap(),
        b"new content"
    );
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original content"
    );
}

#[test]
fn discovery_does_not_probe_user_files_or_offer_actions() {
    let (directory, coordinator, execution) = published();
    let before = list(&coordinator).unwrap();
    assert_eq!(before.items.len(), 1);
    assert!(before.items[0].actions.is_empty());
    assert_eq!(before.items[0].status, "pending");
    fs::remove_file(directory.path().join("source")).unwrap();
    fs::remove_file(directory.path().join("target")).unwrap();
    fs::rename(
        directory.path().join(".tauri-explorer-recovery-artifacts"),
        directory.path().join("unavailable-root"),
    )
    .unwrap();
    let after = list(&coordinator).unwrap();
    assert_eq!(after.revision, before.revision);
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    drop(execution);
}

#[test]
fn busy_inspection_does_not_advance_generation_or_probe_artifacts() {
    let (directory, coordinator, execution) = published();
    let before = list(&coordinator).unwrap();
    fs::rename(
        directory.path().join(".tauri-explorer-recovery-artifacts"),
        directory.path().join("held-root"),
    )
    .unwrap();
    let result = inspect(&coordinator, &before.items[0].id).unwrap();
    assert_eq!(result.revision, before.revision);
    assert_eq!(result.items[0].generation, before.items[0].generation);
    assert_eq!(result.items[0].status, "busy");
    assert!(result.items[0].actions.is_empty());
    assert!(result.error.is_none());
    drop(execution);
    let result = inspect(&coordinator, &before.items[0].id).unwrap();
    assert!(result.items[0].generation > before.items[0].generation);
    assert_eq!(result.items[0].status, "attention");
    assert!(result.error.is_some());
    assert!(result.items[0].actions.is_empty());
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts")
        .exists());
    assert_eq!(
        fs::read(directory.path().join("held-root/original")).unwrap(),
        b"original content"
    );
}

#[test]
fn inspected_restore_claims_fresh_authority_and_preserves_both_payloads() {
    let (directory, coordinator, execution) = published();
    let before = list(&coordinator).unwrap();
    drop(execution);
    fs::remove_file(directory.path().join("source")).unwrap();
    let inspected = inspect(&coordinator, &before.items[0].id).unwrap();
    let item = &inspected.items[0];
    assert!(item.generation > before.items[0].generation);
    assert_eq!(item.actions, vec![RecoveryChoice::Restore]);
    assert_eq!(item.status, "ready");
    assert_eq!(
        bytes(directory.path()),
        (b"new content".to_vec(), b"original content".to_vec())
    );
    let stale = resolve(
        &coordinator,
        &item.id,
        before.items[0].generation,
        RecoveryChoice::Restore,
    )
    .unwrap();
    assert!(stale.error.is_some());
    assert!(stale.items[0].actions.is_empty());
    assert_eq!(stale.revision, inspected.revision);
    assert_eq!(
        bytes(directory.path()),
        (b"new content".to_vec(), b"original content".to_vec())
    );

    let result = resolve(
        &coordinator,
        &item.id,
        item.generation,
        RecoveryChoice::Restore,
    )
    .unwrap();
    assert!(result.error.is_none());
    assert!(result.items[0].generation > item.generation);
    assert!(result.items[0].actions.is_empty());
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original content"
    );
    assert_eq!(
        fs::read(
            directory
                .path()
                .join(".tauri-explorer-recovery-artifacts/publication")
        )
        .unwrap(),
        b"new content"
    );
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts/original")
        .exists());
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
    let reinspection = inspect(&coordinator, &item.id).unwrap();
    assert!(reinspection.items[0].actions.is_empty());
    assert_eq!(reinspection.items[0].status, "attention");
}

#[test]
fn target_change_after_inspection_cannot_be_restored_or_discarded() {
    let (directory, coordinator, execution) = published();
    let id = execution.operation.intent().id.clone();
    drop(execution);
    let inspected = inspect(&coordinator, &id).unwrap();
    fs::write(
        directory.path().join("target"),
        b"changed by another program",
    )
    .unwrap();
    assert!(resolve(
        &coordinator,
        &id,
        inspected.items[0].generation,
        RecoveryChoice::Discard
    )
    .is_err());
    assert_eq!(list(&coordinator).unwrap().revision, inspected.revision);
    let result = resolve(
        &coordinator,
        &id,
        inspected.items[0].generation,
        RecoveryChoice::Restore,
    )
    .unwrap();
    assert!(result.error.is_some());
    assert!(result.items[0].actions.is_empty());
    assert!(result.items[0].generation > inspected.items[0].generation);
    assert_eq!(
        bytes(directory.path()),
        (
            b"changed by another program".to_vec(),
            b"original content".to_vec()
        )
    );
}

#[test]
fn early_checkpoint_inspection_keeps_evidence_without_inventing_a_root() {
    let (directory, coordinator, reservation, spec) = fixture();
    let operation: DurableOperation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let id = operation.intent().id.clone();
    drop(operation);
    let result = inspect(&coordinator, &id).unwrap();
    assert!(result.error.is_none());
    assert_eq!(result.items[0].status, "attention");
    assert!(result.items[0].actions.is_empty());
    assert!(!directory
        .path()
        .join(".tauri-explorer-recovery-artifacts")
        .exists());
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original content"
    );
}

#[test]
fn inspection_and_restore_preserve_generations_beyond_javascript_integer_precision() {
    let (directory, coordinator, execution) = published();
    let id = execution.operation.intent().id.clone();
    drop(execution);
    let connection =
        rusqlite::Connection::open(directory.path().join("recovery/recovery.sqlite3")).unwrap();
    let large = 9_007_199_254_740_993_i64;
    connection
        .execute("UPDATE recovery_meta SET revision = ?1", [large])
        .unwrap();
    connection
        .execute(
            "UPDATE recovery_records SET generation = ?1 WHERE id = ?2",
            rusqlite::params![large, id],
        )
        .unwrap();
    drop(connection);
    let snapshot = list(&coordinator).unwrap();
    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(wire["revision"], "9007199254740993");
    assert_eq!(wire["items"][0]["generation"], "9007199254740993");
    let inspected = inspect(&coordinator, &id).unwrap();
    assert_eq!(inspected.items[0].generation, large as u64 + 1);
    let generation = super::super::model::parse_generation(
        serde_json::to_value(&inspected).unwrap()["items"][0]["generation"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let result = resolve(&coordinator, &id, generation, RecoveryChoice::Restore).unwrap();
    assert!(result.error.is_none());
    assert_eq!(
        fs::read(directory.path().join("target")).unwrap(),
        b"original content"
    );
}

#[test]
fn generation_input_is_canonical_bounded_and_lossless() {
    use super::super::model::parse_generation;
    for invalid in [
        "",
        "0",
        "01",
        "-1",
        "+1",
        " 1",
        "1.0",
        "1e3",
        "9223372036854775808",
        &"9".repeat(100_000),
    ] {
        assert!(parse_generation(invalid).is_err(), "{invalid:.30}");
    }
    assert_eq!(
        parse_generation("9007199254740993").unwrap(),
        9_007_199_254_740_993
    );
    assert_eq!(
        parse_generation("9223372036854775807").unwrap(),
        i64::MAX as u64
    );
}

#[cfg(target_os = "linux")]
#[test]
fn runtime_dispatches_native_recovery_and_rejects_storage_retargeting() {
    tauri::async_runtime::block_on(async {
        let (directory, _coordinator, execution) = published();
        let id = execution.operation.intent().id.clone();
        drop(execution);
        let runtime = super::super::Runtime::default();
        let path = directory.path().join("recovery");
        let initial = runtime.list(path.clone()).await.unwrap();
        assert_eq!(initial.items[0].id, id);
        let inspected = runtime.inspect(path.clone(), id.clone()).await.unwrap();
        assert_eq!(inspected.items[0].actions, vec![RecoveryChoice::Restore]);
        let restored = runtime
            .resolve(
                path.clone(),
                id,
                inspected.items[0].generation,
                RecoveryChoice::Restore,
            )
            .await
            .unwrap();
        assert!(restored.error.is_none());
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original content"
        );
        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join(".tauri-explorer-recovery-artifacts/publication")
            )
            .unwrap(),
            b"new content"
        );
        let other = directory.path().join("other-storage");
        assert!(runtime.list(other.clone()).await.is_err());
        assert!(!other.exists());
    });
}

#[cfg(target_os = "linux")]
#[test]
fn first_discovery_keeps_catalog_visible_when_the_index_is_missing() {
    tauri::async_runtime::block_on(async {
        let (directory, coordinator, execution) = published();
        let id = execution.operation.intent().id.clone();
        drop(execution);
        drop(coordinator);
        let path = directory.path().join("recovery");
        let before = Coordinator::discover_catalog(&path).unwrap();
        fs::remove_file(path.join("recovery.sqlite3")).unwrap();
        let runtime = super::super::Runtime::default();
        let result = runtime.list(path.clone()).await.unwrap();
        assert_eq!(result.items[0].id, id);
        assert_eq!(result.items[0].generation, 0);
        assert_eq!(result.items[0].status, "attention");
        assert!(result.items[0].actions.is_empty());
        assert!(result.error.is_some());
        assert!(!path.join("recovery.sqlite3").exists());
        assert_eq!(Coordinator::discover_catalog(&path).unwrap(), before);
        assert_eq!(
            bytes(directory.path()),
            (b"new content".to_vec(), b"original content".to_vec())
        );
    });
}

#[cfg(target_os = "linux")]
#[test]
fn failed_live_storage_never_becomes_a_revision_zero_fallback() {
    tauri::async_runtime::block_on(async {
        let (directory, _coordinator, execution) = published();
        drop(execution);
        let path = directory.path().join("recovery");
        let runtime = super::super::Runtime::default();
        assert!(runtime.list(path.clone()).await.unwrap().revision > 0);
        fs::rename(
            path.join("recovery.sqlite3"),
            directory.path().join("held-index"),
        )
        .unwrap();
        assert!(runtime.list(path.clone()).await.is_err());
        assert!(!path.join("recovery.sqlite3").exists());
        assert_eq!(
            bytes(directory.path()),
            (b"new content".to_vec(), b"original content".to_vec())
        );
    });
}

#[cfg(target_os = "linux")]
#[test]
fn runtime_publishes_inspection_and_restoration_to_other_renderers_and_stops_after_release() {
    tauri::async_runtime::block_on(async {
        let (directory, _coordinator, execution) = published();
        let id = execution.operation.intent().id.clone();
        drop(execution);
        let path = directory.path().join("recovery");
        let runtime = super::super::Runtime::default();
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let receiver = observed.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON snapshot");
            };
            receiver
                .lock()
                .unwrap()
                .push(serde_json::from_str::<serde_json::Value>(&json).unwrap());
            Ok(())
        });
        let renderer = crate::renderer_owner::Owner::default();
        runtime
            .subscribe(path.clone(), renderer.clone(), 1, move |snapshot| {
                channel.send(snapshot.clone()).is_ok()
            })
            .await
            .unwrap();
        let inspected = runtime.inspect(path.clone(), id.clone()).await.unwrap();
        let latest = observed.lock().unwrap().last().unwrap().clone();
        assert_eq!(latest["items"][0]["status"], "ready");
        assert_eq!(
            latest["items"][0]["generation"],
            inspected.items[0].generation.to_string()
        );
        runtime
            .resolve(
                path.clone(),
                id,
                inspected.items[0].generation,
                RecoveryChoice::Restore,
            )
            .await
            .unwrap();
        let latest = observed.lock().unwrap().last().unwrap().clone();
        assert_eq!(latest["items"][0]["status"], "attention");
        assert_eq!(
            fs::read(directory.path().join("target")).unwrap(),
            b"original content"
        );
        runtime.unsubscribe(&renderer, 1).unwrap();
        let before = observed.lock().unwrap().len();
        runtime.list(path).await.unwrap();
        assert_eq!(observed.lock().unwrap().len(), before);
    });
}

#[cfg(target_os = "linux")]
#[test]
fn failed_initial_discovery_releases_channel_and_a_new_token_can_retry() {
    tauri::async_runtime::block_on(async {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("not-a-directory/recovery");
        fs::write(directory.path().join("not-a-directory"), b"occupied").unwrap();
        let runtime = super::super::Runtime::default();
        let owner = crate::renderer_owner::Owner::default();
        let deliveries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = deliveries.clone();
        let result = runtime
            .subscribe(path, owner.clone(), 1, move |_| {
                seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                true
            })
            .await;
        assert!(result.is_err());
        let path = directory.path().join("valid/recovery");
        runtime.list(path.clone()).await.unwrap();
        assert_eq!(deliveries.load(std::sync::atomic::Ordering::Relaxed), 0);
        runtime.subscribe(path, owner, 2, |_| true).await.unwrap();
    });
}
