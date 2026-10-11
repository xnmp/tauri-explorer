//! Durable custody for complete host-owned CLI replies. It is independent of
//! broker lifetime: a replacement can read or recover the original reply.
use super::{artifacts::*, model::*, rules::*, store::*};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) const TABLE: &str = "CREATE TABLE IF NOT EXISTS host_spools(handle TEXT PRIMARY KEY,package TEXT NOT NULL,owner TEXT NOT NULL,request_id TEXT NOT NULL,limit_bytes INTEGER NOT NULL,bytes INTEGER NOT NULL,status TEXT NOT NULL,process_status INTEGER,UNIQUE(owner,request_id));";

pub(super) fn initialize(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(TABLE).map_err(sql)?;
    let mut q = conn
        .prepare("PRAGMA table_info(host_spools)")
        .map_err(sql)?;
    let columns = q
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    drop(q);
    for name in ["consumer", "operation"] {
        if !columns.iter().any(|c| c == name) {
            conn.execute_batch(&format!("ALTER TABLE host_spools ADD COLUMN {name} TEXT"))
                .map_err(sql)?;
        }
    }
    Ok(())
}
const MAX_SPOOL: u64 = 17 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    status: i64,
    stdout_length: u64,
    stderr_length: u64,
    stdout_sha256: String,
    stderr_sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner() -> PackageGeneration {
        PackageGeneration {
            package_id: "fixture.spool-provider".into(),
            digest: "b".repeat(64),
            incarnation: 11,
        }
    }
    fn store() -> (tempfile::TempDir, Store) {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        (root, store)
    }
    fn charged(store: &Store) -> u64 {
        store
            .connect()
            .unwrap()
            .query_row("SELECT coalesce(sum(bytes),0) FROM host_spools", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap() as u64
    }
    fn complete(store: &Store, request: &str) -> (String, PathBuf) {
        let (handle, path) = store.reserve_host_spool(&owner(), request, 1024).unwrap();
        fs::write(path.join("stdout"), b"original paid CLI output").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store.seal_host_spool(&owner(), &handle, 0).unwrap();
        (handle, path)
    }
    #[test]
    fn complete_reply_is_recoverable_after_retirement_and_reopen_without_reexecution() {
        let (root, store) = store();
        let (handle, path) = complete(&store, "host:1");
        store.retire_generation(&owner()).unwrap();
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let result = reopened
            .host_spool_result(&owner().package_id, "host:1")
            .unwrap()
            .unwrap();
        assert_eq!(result["status"], 0);
        assert_eq!(
            fs::read(result["stdout"].as_str().unwrap()).unwrap(),
            b"original paid CLI output"
        );
        assert_eq!(charged(&reopened), 24);
        reopened
            .release_host_spool(&owner().package_id, &handle)
            .unwrap();
        assert!(!path.exists());
        assert_eq!(charged(&reopened), 0);
        assert!(reopened
            .host_spool_result(&owner().package_id, "host:1")
            .unwrap()
            .is_none());
    }
    #[test]
    fn fsynced_complete_output_survives_lost_ledger_completion() {
        let (root, store) = store();
        let (handle, path) = store
            .reserve_host_spool(&owner(), "host:lost", 1024)
            .unwrap();
        fs::write(path.join("stdout"), b"paid bytes").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store
            .fail_next_commit
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(store.seal_host_spool(&owner(), &handle, 0).is_err());
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&reopened), 10);
        assert_eq!(
            reopened
                .host_spool_result(&owner().package_id, "host:lost")
                .unwrap()
                .unwrap()["status"],
            0
        );
        assert_eq!(fs::read(path.join("stdout")).unwrap(), b"paid bytes");
    }
    #[test]
    fn removal_cancels_pinned_writer_and_releases_capacity_after_writer_ends() {
        let (_root, store) = store();
        let (handle, path) = store
            .reserve_host_spool(&owner(), "host:running", 1024)
            .unwrap();
        let writer = store.pin_host_spool(&handle).unwrap();
        store.release_package_spools(&owner().package_id).unwrap();
        assert_eq!(charged(&store), 1024);
        fs::write(path.join("stdout"), b"late original bytes").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        assert!(store.seal_pinned_host_spool(&owner(), &writer, 0).is_err());
        drop(writer);
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 0);
        assert!(!path.exists());
    }
    #[test]
    fn failed_directory_sync_keeps_accounting_through_power_loss_and_retry() {
        let (_root, store) = store();
        let (handle, path) = complete(&store, "host:durable-unlink");
        store.test_fs.faults(false, true);
        store
            .release_host_spool(&owner().package_id, &handle)
            .unwrap();
        assert_eq!(charged(&store), 24);
        store.test_fs.power_loss();
        assert_eq!(
            fs::read(path.join("stdout")).unwrap(),
            b"original paid CLI output"
        );
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 0);
        assert!(!path.exists());
    }
    #[test]
    fn missing_successful_spool_shrinks_to_zero_without_forgetting_success() {
        let (_root, store) = store();
        let (_handle, path) = complete(&store, "host:missing");
        fs::remove_file(path.join("stdout")).unwrap();
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 0);
        let state: (String, i64) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT status,process_status FROM host_spools WHERE request_id='host:missing'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, ("sealed".into(), 0));
    }

    #[test]
    fn repeated_request_ids_require_the_original_owner_instead_of_returning_newer_bytes() {
        let (_root, store) = store();
        let (_, original) = complete(&store, "host:reset-1");
        let replacement = PackageGeneration {
            incarnation: 12,
            ..owner()
        };
        let (handle, path) = store
            .reserve_host_spool(&replacement, "host:reset-1", 1024)
            .unwrap();
        fs::write(path.join("stdout"), b"different later output").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store.seal_host_spool(&replacement, &handle, 0).unwrap();
        assert!(store
            .host_spool_result(&owner().package_id, "host:reset-1")
            .is_err());
        let old = store
            .host_spool_result_for_owner(&owner().package_id, "host:reset-1", Some(&owner()))
            .unwrap()
            .unwrap();
        assert_eq!(
            old["stdout"],
            original.join("stdout").to_string_lossy().as_ref()
        );
        assert_eq!(
            fs::read(old["stdout"].as_str().unwrap()).unwrap(),
            b"original paid CLI output"
        );
        let newer = store
            .host_spool_result_for_owner(&owner().package_id, "host:reset-1", Some(&replacement))
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(newer["stdout"].as_str().unwrap()).unwrap(),
            b"different later output"
        );
    }

    #[test]
    fn missing_bytes_cannot_lower_successful_charge_before_the_directory_barrier() {
        let (_root, store) = store();
        let (_handle, path) = complete(&store, "host:missing-unsynced");
        store.test_fs.unlink(&path.join("stdout")).unwrap();
        store.test_fs.faults(false, true);
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 24);
        store.test_fs.power_loss();
        assert_eq!(
            fs::read(path.join("stdout")).unwrap(),
            b"original paid CLI output"
        );
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 24);
        store.test_fs.unlink(&path.join("stdout")).unwrap();
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 0);
    }

    #[test]
    fn abandoned_reservation_is_collected_even_while_its_provider_remains_alive() {
        let (_root, store) = store();
        let (handle, path) = store
            .reserve_host_spool(&owner(), "host:cleanup-failed", 1024)
            .unwrap();
        store
            .fail_next_commit
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(store
            .release_host_spool(&owner().package_id, &handle)
            .is_err());
        assert_eq!(charged(&store), 1024);
        store.sweep_host_spools(|_| true).unwrap();
        assert_eq!(charged(&store), 0);
        assert!(!path.exists());
    }

    fn forwarded(store: &Store, consumer: &str, operation: &str) {
        let caller = PackageGeneration {
            package_id: consumer.into(),
            digest: "c".repeat(64),
            incarnation: 7,
        };
        store
            .reserve(Admission {
                consumer: caller.clone(),
                provider: owner(),
                target: ServiceTarget {
                    package_id: owner().package_id,
                    service_id: "image-generation".into(),
                    major: 1,
                },
                operation_id: operation.into(),
                fingerprint: "d".repeat(64),
                phase: AdmissionPhase::Reserved,
                inputs: vec![],
                output: None,
                needs_attention: false,
                disposition: None,
                transfer_receipt: None,
            })
            .unwrap();
        store.claim_forwarding(&caller, operation).unwrap();
        store.accepted(&owner(), consumer, operation).unwrap();
    }
    fn bound(
        store: &Store,
        consumer: &str,
        operation: &str,
        request: &str,
        status: i64,
    ) -> PathBuf {
        forwarded(store, consumer, operation);
        let (handle, path, writer) = store
            .reserve_pinned_host_spool(&owner(), request, 1024)
            .unwrap();
        store
            .bind_host_spool(&owner(), &handle, consumer, operation)
            .unwrap();
        fs::write(path.join("stdout"), b"original paid CLI output").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store
            .seal_pinned_host_spool(&owner(), &writer, status)
            .unwrap();
        path
    }
    #[test]
    fn consumer_removal_collects_only_its_bound_output_and_preserves_other_originals() {
        let (_root, store) = store();
        let first = bound(
            &store,
            "fixture.first-consumer",
            "op-first",
            "host:first",
            0,
        );
        let second = bound(
            &store,
            "fixture.second-consumer",
            "op-second",
            "host:second",
            0,
        );
        let (_, unrelated) = complete(&store, "host:unrelated");
        store
            .release_operation_spools("fixture.first-consumer", "op-first")
            .unwrap();
        assert!(!first.exists());
        assert!(second.exists());
        assert!(unrelated.exists());
        assert!(!store
            .has_bound_host_output("fixture.first-consumer", "op-first")
            .unwrap());
        assert!(store
            .has_bound_host_output("fixture.second-consumer", "op-second")
            .unwrap());
        assert_eq!(charged(&store), 48);
        store.release_package_spools(&owner().package_id).unwrap();
        assert_eq!(charged(&store), 0);
    }
    #[test]
    fn unsuccessful_bound_cli_is_not_a_success_witness() {
        let (_root, store) = store();
        let failed = bound(
            &store,
            "fixture.failed-consumer",
            "op-failed",
            "host:failed",
            256,
        );
        assert!(!store
            .has_bound_host_output("fixture.failed-consumer", "op-failed")
            .unwrap());
        store
            .release_operation_spools("fixture.failed-consumer", "op-failed")
            .unwrap();
        assert!(!failed.exists());
        assert_eq!(charged(&store), 0);
    }

    #[test]
    fn truncated_or_missing_host_bytes_cannot_pin_an_inactive_unknown_operation() {
        for missing in [false, true] {
            let (_root, store) = store();
            let consumer = "fixture.unknown-consumer";
            let op = "op-unknown";
            let path = bound(&store, consumer, op, "host:unknown", 0);
            let receipt = json!({"version":1,"operationId":op,"requestFingerprint":"d".repeat(64),"provider":{"packageId":owner().package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"unknown","error":{"code":"interrupted","message":"Host reply was lost","correlationId":null}},"delivery":{"state":"none"}});
            store
                .observe_receipt(&owner(), consumer, op, 1, receipt)
                .unwrap();
            if missing {
                fs::remove_file(path.join("stdout")).unwrap();
            } else {
                fs::write(path.join("stdout"), b"partial").unwrap();
            }
            assert!(!store.has_bound_host_output(consumer, op).unwrap());
            store.auto_settle_operation(consumer, op, true).unwrap();
            assert!(store.execution_released(consumer, op).unwrap());
            assert!(store.claims().unwrap().is_empty());
            store.sweep_host_spools(|_| false).unwrap();
            assert_eq!(charged(&store), 0);
            assert!(!path.exists());
        }
    }

    #[test]
    fn provider_rejected_host_reply_cannot_pin_inactive_failed_or_cancelled_work() {
        for state in ["failed", "cancelled"] {
            let (_root, store) = store();
            let consumer = "fixture.invalid-reply-consumer";
            let op = "op-invalid-reply";
            let path = bound(&store, consumer, op, "host:invalid-reply", 0);
            let execution = if state == "failed" {
                json!({"state":state,"error":{"code":"invalid_output","message":"The completed CLI reply contains no valid image","correlationId":null}})
            } else {
                json!({"state":state})
            };
            let receipt = json!({"version":1,"operationId":op,"requestFingerprint":"d".repeat(64),"provider":{"packageId":owner().package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":execution,"delivery":{"state":"none"}});
            store
                .observe_receipt(&owner(), consumer, op, 1, receipt)
                .unwrap();
            assert!(
                !store.has_bound_host_output(consumer, op).unwrap(),
                "provider {state} supersedes the raw CLI reply"
            );
            store.auto_settle_operation(consumer, op, true).unwrap();
            store.sweep_host_spools(|_| false).unwrap();
            assert!(store.claims().unwrap().is_empty());
            assert_eq!(charged(&store), 0);
            assert!(!path.exists());
        }
    }

    #[test]
    fn unbound_discovery_uses_complete_original_owner_evidence_without_guessing_operations() {
        let (_root, store) = store();
        let (handle, directory) = complete(&store, "host:legacy-result");
        assert!(store.has_unbound_host_output(&owner()).unwrap());
        assert!(!store
            .has_unbound_host_output(&PackageGeneration {
                incarnation: owner().incarnation + 1,
                ..owner()
            })
            .unwrap());
        bound(
            &store,
            "fixture.bound-consumer",
            "op-bound",
            "host:bound-result",
            0,
        );
        store
            .release_host_spool(&owner().package_id, &handle)
            .unwrap();
        assert!(!directory.exists());
        assert!(!store.has_unbound_host_output(&owner()).unwrap());
        assert!(store
            .has_bound_host_output("fixture.bound-consumer", "op-bound")
            .unwrap());
        let (_, partial) = complete(&store, "host:damaged-result");
        fs::write(partial.join("stdout"), b"truncated").unwrap();
        assert!(!store.has_unbound_host_output(&owner()).unwrap());
    }

    #[test]
    fn visible_completion_cannot_publish_recovery_or_lower_quota_before_directory_retry() {
        let (_root, store) = store();
        let (handle, directory) = store
            .reserve_host_spool(&owner(), "host:unsynced-completion", 1024)
            .unwrap();
        fs::write(directory.join("stdout"), b"paid bytes").unwrap();
        fs::write(directory.join("stderr"), []).unwrap();
        store.test_fs.faults(false, true);
        assert!(store.seal_host_spool(&owner(), &handle, 0).is_err());
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(
            charged(&store),
            1024,
            "visible manifest bypassed failed directory durability"
        );
        assert!(store
            .host_spool_result(&owner().package_id, "host:unsynced-completion")
            .is_err());
        store.test_fs.faults(false, false);
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 10);
        let recovered = store
            .host_spool_result(&owner().package_id, "host:unsynced-completion")
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(recovered["stdout"].as_str().unwrap()).unwrap(),
            b"paid bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_complete_host_output_defers_settlement_and_collection() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, store) = store();
        let consumer = "fixture.unreadable-consumer";
        let op = "op-unreadable";
        let bound = bound(&store, consumer, op, "host:bound-unreadable", 0);
        fs::set_permissions(bound.join("stdout"), fs::Permissions::from_mode(0)).unwrap();
        assert!(
            store.has_bound_host_output(consumer, op).is_err(),
            "unreadable output is not absent output"
        );
        fs::set_permissions(bound.join("stdout"), fs::Permissions::from_mode(0o600)).unwrap();
        let (handle, directory) = store
            .reserve_host_spool(&owner(), "host:unbound-unreadable", 1024)
            .unwrap();
        fs::write(directory.join("stdout"), b"paid bytes").unwrap();
        fs::write(directory.join("stderr"), []).unwrap();
        store.fail_next_write();
        assert!(store.seal_host_spool(&owner(), &handle, 0).is_err());
        fs::set_permissions(directory.join("stdout"), fs::Permissions::from_mode(0)).unwrap();
        assert!(store.has_unbound_host_output(&owner()).is_err());
        store.sweep_host_spools(|_| false).unwrap();
        assert!(
            directory.join("stdout").exists(),
            "unreadable completed bytes were collected as inactive partial work"
        );
        assert_eq!(charged(&store), 1048);
        fs::set_permissions(directory.join("stdout"), fs::Permissions::from_mode(0o600)).unwrap();
        store.sweep_host_spools(|_| false).unwrap();
        assert!(store.has_unbound_host_output(&owner()).unwrap());
        assert_eq!(charged(&store), 34);
    }
}

fn spool_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(reject("invalid host output file"));
        }
        Ok(_) => (),
        Err(cause) => return Err(cause.into()),
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > limit {
        return Err(reject("invalid host output file"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(reject("host output exceeds its bound"));
    }
    Ok(bytes)
}

pub(crate) struct HostSpoolWriter<'a> {
    handle: String,
    store: &'a Store,
    _lease: ArtifactLease<'a>,
}

impl Store {
    fn sync_host_spool_directory(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        self.test_fs.sync(path)?;
        #[cfg(not(test))]
        crate::durable_dir::sync(path)?;
        Ok(())
    }
    fn sync_complete_host_spool(&self, handle: &str) -> Result<()> {
        let directory = self.host_spool_path(handle)?;
        for name in ["stdout", "stderr", "completed.json"] {
            let file = fs::File::open(directory.join(name))?;
            file.sync_all()?;
        }
        self.sync_host_spool_directory(&directory)?;
        self.sync_host_spool_directory(directory.parent().unwrap())
    }
    fn host_spool_path(&self, handle: &str) -> Result<PathBuf> {
        if handle.len() != 48
            || !handle
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(reject("invalid host output handle"));
        }
        Ok(self.root.join("host-spools").join(handle))
    }

    pub fn reserve_host_spool(
        &self,
        owner: &PackageGeneration,
        request_id: &str,
        limit: u64,
    ) -> Result<(String, PathBuf)> {
        let (handle, path, _writer) = self.reserve_pinned_host_spool(owner, request_id, limit)?;
        Ok((handle, path))
    }

    pub fn reserve_pinned_host_spool(
        &self,
        owner: &PackageGeneration,
        request_id: &str,
        limit: u64,
    ) -> Result<(String, PathBuf, HostSpoolWriter<'_>)> {
        generation(owner)?;
        if !identity(request_id) || limit > MAX_SPOOL {
            return Err(reject("invalid host output reservation"));
        }
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| reject("host output identity unavailable"))?;
        let handle = hex::encode(random);
        let path = self.host_spool_path(&handle)?;
        // Pin before the reservation is advertised: acquiring this same
        // lease is then sufficient evidence that no original writer survives.
        let writer = self.pin_host_spool(&handle)?;
        self.transaction(|tx| {
            Self::generation_admitted(tx,owner)?;
            self.quota(tx,&owner.package_id,limit,false)?;
            tx.execute("INSERT INTO host_spools(handle,package,owner,request_id,limit_bytes,bytes,status) VALUES(?1,?2,?3,?4,?5,?5,'reserved')",params![handle,owner.package_id,encode(owner)?,request_id,limit as i64]).map_err(sql)?;
            Ok(())
        })?;
        if let Err(cause) = (|| {
            fs::create_dir(&path).map_err(|_| reject("host output directory creation failed"))?;
            private_directory(&path)?;
            self.sync_host_spool_directory(path.parent().unwrap())?;
            Ok::<_, crate::error::AppError>(())
        })() {
            drop(writer);
            let _ = self.release_host_spool(&owner.package_id, &handle);
            return Err(cause);
        }
        Ok((handle, path, writer))
    }

    pub fn bind_host_spool(
        &self,
        owner: &PackageGeneration,
        handle: &str,
        consumer: &str,
        operation: &str,
    ) -> Result<()> {
        let a = self.verify_provider(owner, consumer, operation)?;
        if !matches!(
            a.phase,
            AdmissionPhase::Forwarding | AdmissionPhase::Accepted
        ) || self.execution_released(consumer, operation)?
        {
            return Err(reject(
                "host process requires an active forwarded admission",
            ));
        }
        self.transaction(|tx| {
            let current=Self::record(tx,consumer,operation)?.ok_or_else(||reject("host process admission disappeared"))?;
            if current!=a{return Err(reject("host process admission changed before execution"))}
            Self::generation_admitted(tx,owner)?;
            let changed=tx.execute("UPDATE host_spools SET consumer=?3,operation=?4 WHERE handle=?1 AND owner=?2 AND status='reserved' AND consumer IS NULL AND operation IS NULL",params![handle,encode(owner)?,consumer,operation]).map_err(sql)?;
            if changed!=1{return Err(reject("host process output binding is unavailable"))}
            Ok(())
        })
    }

    pub fn has_bound_host_output(&self, consumer: &str, operation: &str) -> Result<bool> {
        self.has_bound_host_output_at(&self.connect()?, consumer, operation)
    }

    /// Legacy process calls lack an operation binding. Their exact original
    /// owner's complete reply keeps unpaid status discovery alive, without
    /// guessing which operation its bytes belong to or retaining execution
    /// capacity. Only the provider's journal can make that association.
    pub fn has_unbound_host_output(&self, provider: &PackageGeneration) -> Result<bool> {
        generation(provider)?;
        let connection = self.connect()?;
        let mut query = connection.prepare(
            "SELECT handle FROM host_spools WHERE owner=?1 AND consumer IS NULL AND operation IS NULL AND status IN ('reserved','sealed','completed-pending')",
        ).map_err(sql)?;
        let handles = query
            .query_map([encode(provider)?], |row| row.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        for handle in handles {
            if self
                .completion_evidence(&handle)?
                .is_some_and(|completion| completion.status == 0 && completion.stdout_length > 0)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub(super) fn has_bound_host_output_at(
        &self,
        conn: &rusqlite::Connection,
        consumer: &str,
        operation: &str,
    ) -> Result<bool> {
        // A successful process exit is only a possible provider result: the
        // provider may subsequently reject its reply as having no valid image.
        // Authoritative terminal failure therefore supersedes raw stdout.
        let rejected = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM provider_receipts WHERE consumer=?1 AND operation=?2 AND json_extract(status,'$.execution.state') IN ('failed','cancelled'))",
            params![consumer, operation],
            |row| row.get::<_, bool>(0),
        ).map_err(sql)?;
        if rejected {
            return Ok(false);
        }
        let mut q=conn.prepare("SELECT handle FROM host_spools WHERE consumer=?1 AND operation=?2 AND status IN ('reserved','sealed','completed-pending')").map_err(sql)?;
        let handles = q
            .query_map(params![consumer, operation], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        for handle in handles {
            if self
                .completion_evidence(&handle)?
                .is_some_and(|c| c.status == 0 && c.stdout_length > 0)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn release_operation_spools(&self, consumer: &str, operation: &str) -> Result<()> {
        let conn = self.connect()?;
        let mut q = conn
            .prepare("SELECT handle,package FROM host_spools WHERE consumer=?1 AND operation=?2")
            .map_err(sql)?;
        let rows = q
            .query_map(params![consumer, operation], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(q);
        drop(conn);
        for (handle, package) in rows {
            self.release_host_spool(&package, &handle)?;
        }
        Ok(())
    }

    /// Completion is durable before a success reply can leave the host. The
    /// fsynced manifest repairs the ledger if the following commit is lost.
    pub fn seal_host_spool(
        &self,
        owner: &PackageGeneration,
        handle: &str,
        status: i64,
    ) -> Result<()> {
        generation(owner)?;
        let _lease = self.lease(handle)?;
        self.seal_host_spool_inner(owner, handle, status)
    }

    pub fn pin_host_spool(&self, handle: &str) -> Result<HostSpoolWriter<'_>> {
        self.host_spool_path(handle)?;
        Ok(HostSpoolWriter {
            handle: handle.into(),
            store: self,
            _lease: self.lease(handle)?,
        })
    }

    pub fn seal_pinned_host_spool(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
        status: i64,
    ) -> Result<()> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        self.seal_host_spool_inner(owner, &writer.handle, status)
    }

    pub fn retain_pinned_host_execution(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
        status: i64,
    ) -> Result<bool> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        self.transaction(|tx| {
            let changed=tx.execute("UPDATE host_spools SET status='completed-pending',process_status=?3 WHERE handle=?1 AND owner=?2 AND status!='released'",params![writer.handle,encode(owner)?,status]).map_err(sql)?;
            Ok(changed==1)
        })
    }

    fn seal_host_spool_inner(
        &self,
        owner: &PackageGeneration,
        handle: &str,
        status: i64,
    ) -> Result<()> {
        let (raw, state, limit): (String, String, i64) = self
            .connect()?
            .query_row(
                "SELECT owner,status,limit_bytes FROM host_spools WHERE handle=?1",
                [handle],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql)?;
        if decode::<PackageGeneration>(&raw)? != *owner || state == "released" {
            return Err(reject("host output reservation was cancelled"));
        }
        let path = self.host_spool_path(handle)?;
        let stdout = spool_bytes(&path.join("stdout"), MAX_SPOOL)?;
        let stderr = spool_bytes(&path.join("stderr"), MAX_SPOOL)?;
        let bytes = stdout.len() as u64 + stderr.len() as u64;
        if limit < 0 || bytes > limit as u64 {
            return Err(reject("host output exceeds reservation"));
        }
        for name in ["stdout", "stderr"] {
            let file = fs::OpenOptions::new().read(true).open(path.join(name))?;
            if !file.metadata()?.is_file() {
                return Err(reject("host output is not a regular file"));
            }
            file.sync_all()?;
        }
        let completion = Completion {
            status,
            stdout_length: stdout.len() as u64,
            stderr_length: stderr.len() as u64,
            stdout_sha256: hex::encode(Sha256::digest(&stdout)),
            stderr_sha256: hex::encode(Sha256::digest(&stderr)),
        };
        let mut stage = tempfile::NamedTempFile::new_in(&path)?;
        serde_json::to_writer(&mut stage, &completion)
            .map_err(|_| reject("host output manifest serialization failed"))?;
        stage.flush()?;
        stage.as_file().sync_all()?;
        stage
            .persist(path.join("completed.json"))
            .map_err(|e| crate::error::AppError::from(e.error))?;
        self.sync_host_spool_directory(&path)?;
        self.sync_host_spool_directory(path.parent().unwrap())?;
        self.transaction(|tx| {
            let changed=tx.execute("UPDATE host_spools SET status='sealed',bytes=?2,process_status=?3 WHERE handle=?1 AND status!='released'",params![handle,bytes as i64,status]).map_err(sql)?;
            if changed!=1 { return Err(reject("host output reservation was cancelled during completion")); }
            Ok(())
        })
    }

    fn host_completion(&self, handle: &str) -> Result<Option<Completion>> {
        let path = self.host_spool_path(handle)?;
        let raw = match spool_bytes(&path.join("completed.json"), 4096) {
            Ok(raw) => raw,
            Err(crate::error::AppError::NotFound(_)) => return Ok(None),
            Err(e) => return Err(e),
        };
        if raw.len() > 4096 {
            return Err(reject("invalid host output manifest"));
        }
        let c: Completion =
            serde_json::from_slice(&raw).map_err(|_| reject("invalid host output manifest"))?;
        for (name, length, sha) in [
            ("stdout", c.stdout_length, &c.stdout_sha256),
            ("stderr", c.stderr_length, &c.stderr_sha256),
        ] {
            if length > MAX_SPOOL {
                return Err(reject("invalid host output length"));
            }
            let file = path.join(name);
            let bytes = spool_bytes(&file, MAX_SPOOL)?;
            if bytes.len() as u64 != length || hex::encode(Sha256::digest(&bytes)) != *sha {
                return Err(reject("host output no longer matches completion"));
            }
        }
        Ok(Some(c))
    }

    fn completion_evidence(&self, handle: &str) -> Result<Option<Completion>> {
        match self.host_completion(handle) {
            // Missing names, malformed metadata and mismatching bytes prove
            // that this path is not a complete reply. Transient storage
            // errors defer disposition rather than erase custody.
            Err(crate::error::AppError::NotFound(_) | crate::error::AppError::Other(_)) => Ok(None),
            result => result,
        }
    }

    /// A lost response is recovered by its original reverse request ID;
    /// this never starts the process again or changes its execution result.
    pub fn host_spool_result(&self, package: &str, request_id: &str) -> Result<Option<Value>> {
        self.host_spool_result_for_owner(package, request_id, None)
    }

    pub fn host_spool_result_for_owner(
        &self,
        package: &str,
        request_id: &str,
        original: Option<&PackageGeneration>,
    ) -> Result<Option<Value>> {
        if !identity(package) || !identity(request_id) {
            return Err(reject("invalid host output lookup"));
        }
        if let Some(original) = original {
            generation(original)?;
            if original.package_id != package {
                return Err(reject("original host output belongs to another package"));
            }
        }
        let conn = self.connect()?;
        let mut query=conn.prepare("SELECT handle,owner FROM host_spools WHERE package=?1 AND request_id=?2 AND status!='released' AND (?3 IS NULL OR owner=?3)").map_err(sql)?;
        let rows = query
            .query_map(
                params![package, request_id, original.map(encode).transpose()?],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        if rows.len() > 1 {
            return Err(reject(
                "original host request ID is ambiguous; supply its original owner",
            ));
        }
        let Some((handle, owner)) = rows.into_iter().next() else {
            return Ok(None);
        };
        let _lease = self.lease(&handle)?;
        let Some(c) = self.host_completion(&handle)? else {
            return Ok(None);
        };
        // A manifest can be visible after an interrupted fsync. Retrying
        // that barrier precedes every recovered reply, including a lost seal
        // transaction, so visibility cannot stand in for durable custody.
        self.sync_complete_host_spool(&handle)?;
        let path = self.host_spool_path(&handle)?;
        Ok(Some(
            json!({"handle":handle,"owner":decode::<PackageGeneration>(&owner)?,"status":c.status,"stdout":path.join("stdout"),"stderr":path.join("stderr")}),
        ))
    }

    pub fn release_host_spool(&self, package: &str, handle: &str) -> Result<()> {
        if !identity(package) {
            return Err(reject("invalid host output owner"));
        }
        self.host_spool_path(handle)?;
        self.transaction(|tx| {
            tx.execute(
                "UPDATE host_spools SET status='released' WHERE handle=?1 AND package=?2",
                params![handle, package],
            )
            .map_err(sql)?;
            Ok(())
        })?;
        self.collect_host_spool(handle)
    }

    pub fn release_package_spools(&self, package: &str) -> Result<()> {
        let conn = self.connect()?;
        let mut q = conn
            .prepare("SELECT handle FROM host_spools WHERE package=?1")
            .map_err(sql)?;
        let handles = q
            .query_map([package], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(q);
        drop(conn);
        for handle in handles {
            self.release_host_spool(package, &handle)?;
        }
        Ok(())
    }

    fn collect_host_spool(&self, handle: &str) -> Result<()> {
        let released = |conn: &rusqlite::Connection| -> Result<bool> {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM host_spools WHERE handle=?1 AND status='released')",
                [handle],
                |r| r.get(0),
            )
            .map_err(sql)
        };
        if !released(&self.connect()?)? {
            return Ok(());
        }
        let Ok(_lease) = self.lease(handle) else {
            return Ok(());
        };
        if !released(&self.connect()?)? {
            return Ok(());
        }
        let path = self.host_spool_path(handle)?;
        match fs::read_dir(&path) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry?;
                    #[cfg(test)]
                    let removed = self.test_fs.unlink(&entry.path());
                    #[cfg(not(test))]
                    let removed = fs::remove_file(entry.path());
                    if removed.is_err() {
                        return Ok(());
                    }
                }
                if self.sync_host_spool_directory(&path).is_err() {
                    return Ok(());
                }
                if fs::remove_dir(&path).is_err() {
                    return Ok(());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => {
                log::warn!("Host process output cleanup deferred: {e}");
                return Ok(());
            }
        }
        // Also sync on NotFound: the previous unlink may have lacked this
        // barrier. Retain the row and charge until removal is durable.
        if self
            .sync_host_spool_directory(path.parent().unwrap())
            .is_err()
        {
            return Ok(());
        }
        self.transaction(|tx| {
            tx.execute(
                "DELETE FROM host_spools WHERE handle=?1 AND status='released'",
                [handle],
            )
            .map_err(sql)?;
            Ok(())
        })
    }

    pub fn sweep_host_spools(&self, live: impl Fn(&PackageGeneration) -> bool) -> Result<()> {
        let conn = self.connect()?;
        let mut q = conn
            .prepare("SELECT handle,package,owner,status FROM host_spools")
            .map_err(sql)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(q);
        drop(conn);
        for (handle, package, raw, state) in rows {
            if state == "released" {
                self.collect_host_spool(&handle)?;
                continue;
            }
            let Ok(lease) = self.lease(&handle) else {
                continue;
            };
            match self.completion_evidence(&handle) {
                Ok(Some(c)) => {
                    if self.sync_complete_host_spool(&handle).is_err() {
                        continue;
                    }
                    self.transaction(|tx|{tx.execute("UPDATE host_spools SET status='sealed',bytes=?2,process_status=?3 WHERE handle=?1 AND status!='released'",params![handle,(c.stdout_length+c.stderr_length) as i64,c.status]).map_err(sql)?;Ok(())})?;
                }
                Ok(None) if state == "reserved" => {
                    drop(lease);
                    self.release_host_spool(&package, &handle)?;
                    continue;
                }
                Ok(None)
                    if state == "sealed"
                        || state == "completed-pending"
                            && !live(&decode::<PackageGeneration>(&raw)?) =>
                {
                    let path = self.host_spool_path(&handle)?;
                    if path.exists() && self.sync_host_spool_directory(&path).is_err() {
                        continue;
                    }
                    if self
                        .sync_host_spool_directory(path.parent().unwrap())
                        .is_err()
                    {
                        continue;
                    }
                    let bytes = ["stdout", "stderr"]
                        .into_iter()
                        .try_fold(0u64, |sum, name| match fs::metadata(path.join(name)) {
                            Ok(m) => Ok(sum + m.len()),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(sum),
                            Err(e) => Err(e),
                        })?;
                    self.transaction(|tx|{tx.execute("UPDATE host_spools SET bytes=?2 WHERE handle=?1 AND status IN ('sealed','completed-pending')",params![handle,bytes as i64]).map_err(sql)?;Ok(())})?;
                }
                Ok(None) | Err(_) => (),
            }
        }
        Ok(())
    }
}
