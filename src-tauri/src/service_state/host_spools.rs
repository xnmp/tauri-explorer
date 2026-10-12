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
    for name in ["consumer", "operation", "completion"] {
        if !columns.iter().any(|c| c == name) {
            conn.execute_batch(&format!("ALTER TABLE host_spools ADD COLUMN {name} TEXT"))
                .map_err(sql)?;
        }
    }
    if !columns.iter().any(|c| c == "custody_recorded") {
        conn.execute_batch(
            "ALTER TABLE host_spools ADD COLUMN custody_recorded INTEGER NOT NULL DEFAULT 0",
        )
        .map_err(sql)?;
    }
    // Legacy calls do not name their operation. Capture their possible owners
    // once, rather than transferring custody to a later provider admission.
    conn.execute_batch("CREATE TABLE IF NOT EXISTS host_spool_admissions(handle TEXT NOT NULL,consumer TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(handle,consumer,operation));
        INSERT OR IGNORE INTO host_spool_admissions SELECT h.handle,o.consumer,o.operation FROM host_spools h JOIN operations o ON json_extract(o.admission,'$.provider.packageId')=h.package WHERE h.custody_recorded=0 AND (h.consumer IS NULL OR h.consumer=o.consumer AND h.operation=o.operation);
        UPDATE host_spools SET custody_recorded=1 WHERE custody_recorded=0;").map_err(sql)?;
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
    #[serde(skip)]
    stderr_incomplete: bool,
}

fn completion_for(status: i64, stdout: &[u8], stderr: &[u8]) -> Completion {
    Completion {
        status,
        stdout_length: stdout.len() as u64,
        stderr_length: stderr.len() as u64,
        stdout_sha256: hex::encode(Sha256::digest(stdout)),
        stderr_sha256: hex::encode(Sha256::digest(stderr)),
        stderr_incomplete: false,
    }
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
    #[test]
    fn every_reply_identity_names_power_loss_durable_bytes() {
        for stop in 1..=17 {
            let (root, store) = store();
            let (handle, path, writer) = store
                .reserve_pinned_host_spool(&owner(), "host:ordering", 1024)
                .unwrap();
            let stdout = b"sole paid original";
            let stderr = b"diagnostic";
            assert!(store
                .write_pinned_host_reply_observed(&owner(), &writer, stdout, stderr, 0, |point| {
                    if point == stop {
                        Err(reject("crash"))
                    } else {
                        Ok(())
                    }
                },)
                .is_err());
            let identified = !store.recorded_host_completions(&handle).unwrap().is_empty();
            drop(writer);
            store.test_fs.power_loss();
            if identified {
                assert_eq!(
                    fs::read(path.join("stdout")).unwrap_or_default(),
                    stdout,
                    "identity preceded durable stdout at checkpoint {stop}"
                );
                assert_eq!(
                    fs::read(path.join("stderr")).unwrap_or_default(),
                    stderr,
                    "identity preceded durable stderr at checkpoint {stop}"
                );
            }
            drop(store);
            let reopened =
                Store::open(root.path().join("service-state"), Limits::default()).unwrap();
            let reply = reopened
                .host_spool_result(&owner().package_id, "host:ordering")
                .unwrap();
            if identified {
                let reply = reply.expect("published original must recover");
                assert_eq!(fs::read(reply["stdout"].as_str().unwrap()).unwrap(), stdout);
            } else {
                assert!(reply.is_none(), "unidentified reply advertised success");
                reopened.sweep_host_spools(|_| false).unwrap();
                assert_eq!(charged(&reopened), 0);
            }
        }
    }

    #[test]
    fn first_seal_crash_boundaries_preserve_committed_output() {
        let points = [
            "host-seal-temp-create",
            "host-seal-temp-partial",
            "host-seal-temp-full",
            "host-seal-temp-sync",
            "host-seal-rename",
            "host-seal-target-sync",
            "host-seal-directory-sync",
        ];
        for (index, point) in points.into_iter().enumerate() {
            for power_loss in [false, true] {
                let (root, store) = store();
                let (handle, directory, writer) = store
                    .reserve_pinned_host_spool(&owner(), "host:first-seal", 1024)
                    .unwrap();
                let original = b"sole paid original";
                store.test_fs.crash_at(point);
                let error = store
                    .write_pinned_host_reply(&owner(), &writer, original, b"diagnostics", 0)
                    .unwrap_err();
                assert!(error.to_string().contains("injected aggregate crash"));
                drop(writer);
                if power_loss {
                    store.test_fs.power_loss();
                }
                drop(store);
                let reopened =
                    Store::open(root.path().join("service-state"), Limits::default()).unwrap();
                reopened.sweep_host_spools(|_| false).unwrap();
                let committed = index == 6 || index >= 4 && !power_loss;
                let reply = reopened
                    .host_spool_result(&owner().package_id, "host:first-seal")
                    .unwrap();
                if committed {
                    let reply = reply.expect("published seal lost original");
                    assert_eq!(
                        fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
                        original
                    );
                    reopened
                        .abandon_unsealed_host_spool(&owner().package_id, &handle)
                        .unwrap();
                    assert_eq!(fs::read(directory.join("stdout")).unwrap(), original);
                    reopened
                        .release_host_spool(&owner().package_id, &handle)
                        .unwrap();
                } else {
                    assert!(reply.is_none());
                }
                assert!(!directory.exists());
                assert_eq!(charged(&reopened), 0);
            }
        }
    }

    #[test]
    fn sealed_original_recovers_identity_after_crash_before_database_commit() {
        let (root, store) = store();
        let (handle, directory, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:seal-before-db", 1024)
            .unwrap();
        let original = b"sole paid original";
        assert!(store
            .write_pinned_host_reply_observed(
                &owner(),
                &writer,
                original,
                b"diagnostics",
                0,
                |point| {
                    if point == 10 {
                        Err(reject("crash after seal before database commit"))
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
        let indexed: Option<String> = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT completion FROM host_spools WHERE handle=?1",
                [&handle],
                |r| r.get(0),
            )
            .unwrap();
        assert!(indexed.is_none());
        assert!(directory.join("completed.json").exists());
        drop(writer);
        store.test_fs.power_loss();
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let indexed: Option<String> = reopened
            .connect()
            .unwrap()
            .query_row(
                "SELECT completion FROM host_spools WHERE handle=?1",
                [&handle],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            indexed.is_some(),
            "recovery must rebuild the derived database identity"
        );
        let reply = reopened
            .host_spool_result(&owner().package_id, "host:seal-before-db")
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            original
        );
        reopened
            .abandon_unsealed_host_spool(&owner().package_id, &handle)
            .unwrap();
        assert_eq!(fs::read(directory.join("stdout")).unwrap(), original);
        reopened
            .release_host_spool(&owner().package_id, &handle)
            .unwrap();
        assert!(!directory.exists());
        assert_eq!(charged(&reopened), 0);
    }

    #[test]
    fn conflicting_repeat_cannot_overwrite_identified_original() {
        let (_root, store) = store();
        let (_, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:immutable", 1024)
            .unwrap();
        store
            .write_pinned_host_reply(&owner(), &writer, b"first original", b"", 0)
            .unwrap();
        assert!(store
            .write_pinned_host_reply(&owner(), &writer, b"different original", b"", 0)
            .is_err());
        assert_eq!(fs::read(path.join("stdout")).unwrap(), b"first original");
        store.test_fs.power_loss();
        assert_eq!(fs::read(path.join("stdout")).unwrap(), b"first original");
    }
    fn complete(store: &Store, request: &str) -> (String, PathBuf) {
        let (handle, path) = store.reserve_host_spool(&owner(), request, 1024).unwrap();
        fs::write(path.join("stdout"), b"original paid CLI output").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store.seal_host_spool(&owner(), &handle, 0).unwrap();
        (handle, path)
    }
    #[test]
    fn sealing_and_recovery_use_writable_file_flushes_on_every_os() {
        let (_root, store) = store();
        crate::durable_dir::take_file_syncs();
        let (_, path) = complete(&store, "host:flush-mode");
        let synced = crate::durable_dir::take_file_syncs();
        for name in ["stdout", "stderr", "completed.json"] {
            assert!(
                synced.contains(&path.join(name)),
                "sealing bypassed the portable file flush for {name}"
            );
        }
        store
            .host_spool_result(&owner().package_id, "host:flush-mode")
            .unwrap()
            .unwrap();
        let synced = crate::durable_dir::take_file_syncs();
        for name in ["stdout", "stderr", "completed.json"] {
            assert!(
                synced.contains(&path.join(name)),
                "recovery bypassed the portable file flush for {name}"
            );
        }
    }
    #[test]
    fn pending_success_without_manifest_recovers_and_cannot_be_settled() {
        let (root, store) = store();
        forwarded(&store, "fixture.pending-consumer", "op-pending");
        let (handle, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:pending", 1024)
            .unwrap();
        store
            .bind_host_spool(&owner(), &handle, "fixture.pending-consumer", "op-pending")
            .unwrap();
        fs::write(path.join("stdout"), b"original paid CLI output").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        crate::durable_dir::sync_file(&path.join("stdout")).unwrap();
        crate::durable_dir::sync_file(&path.join("stderr")).unwrap();
        store
            .retain_pinned_host_execution(&owner(), &writer, 0)
            .unwrap();
        drop(writer);
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        assert!(
            reopened
                .has_bound_host_output("fixture.pending-consumer", "op-pending")
                .unwrap(),
            "durable pending success disappeared without a manifest"
        );
        assert!(reopened
            .auto_settle_operation("fixture.pending-consumer", "op-pending", true)
            .is_err());
        let recovered = reopened
            .host_spool_result(&owner().package_id, "host:pending")
            .unwrap()
            .unwrap();
        assert_eq!(recovered["status"], 0);
        assert_eq!(
            fs::read(recovered["stdout"].as_str().unwrap()).unwrap(),
            b"original paid CLI output"
        );
    }
    #[test]
    fn partial_pending_manifest_cannot_mask_committed_completion() {
        let (root, store) = store();
        forwarded(&store, "fixture.partial-pending", "op-partial");
        let (handle, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:partial-pending", 1024)
            .unwrap();
        store
            .bind_host_spool(&owner(), &handle, "fixture.partial-pending", "op-partial")
            .unwrap();
        fs::write(path.join("stdout"), b"sole paid original").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        fs::write(path.join("pending.json"), b"{\"status\":").unwrap();
        store
            .retain_pinned_host_execution(&owner(), &writer, 0)
            .unwrap();
        drop(writer);
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        assert!(
            reopened
                .has_bound_host_output("fixture.partial-pending", "op-partial")
                .unwrap(),
            "partial witness masked committed original"
        );
        assert!(reopened
            .auto_settle_operation("fixture.partial-pending", "op-partial", true)
            .is_err());
        let reply = reopened
            .host_spool_result(&owner().package_id, "host:partial-pending")
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            b"sole paid original"
        );
    }
    #[test]
    fn partial_pending_and_commit_failure_cannot_discard_fsynced_original() {
        let (root, store) = store();
        let (_handle, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:partial-and-ledger", 1024)
            .unwrap();
        fs::write(path.join("pending.json"), b"{\"status\":").unwrap();
        store.fail_next_write();
        assert!(store
            .write_pinned_host_reply(&owner(), &writer, b"sole paid original", b"", 0)
            .is_err());
        drop(writer);
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let reply = reopened
            .host_spool_result(&owner().package_id, "host:partial-and-ledger")
            .unwrap()
            .expect("compound witness faults discarded fsynced original");
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            b"sole paid original"
        );
    }
    #[test]
    fn missing_recorded_empty_stderr_recovers_verified_stdout_after_crash() {
        let (root, store) = store();
        let (_, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:missing-empty", 1024)
            .unwrap();
        store
            .write_pinned_host_reply(&owner(), &writer, b"sole paid original", b"", 0)
            .unwrap();
        // The intent and stdout survived; the host died before creating stderr.
        fs::remove_file(path.join("stderr")).unwrap();
        drop(writer);
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        let reply = reopened
            .host_spool_result(&owner().package_id, "host:missing-empty")
            .unwrap()
            .expect("verified original was collected for a missing empty stream");
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            b"sole paid original"
        );
        assert_eq!(fs::read(reply["stderr"].as_str().unwrap()).unwrap(), b"");
        reopened.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&reopened), b"sole paid original".len() as u64);
    }

    #[test]
    fn verified_stdout_survives_unknown_settlement_when_nonempty_stderr_is_lost() {
        let (_root, store) = store();
        let consumer = "fixture.sibling-consumer";
        let operation = "op-sibling";
        forwarded(&store, consumer, operation);
        let (_, path, writer) = store
            .reserve_pinned_host_spool_with_custody(
                &owner(),
                "host:sibling",
                64 * 1024,
                Some((consumer, operation)),
            )
            .unwrap();
        let original = include_bytes!("../../../static/favicon.png");
        store
            .write_pinned_host_reply(&owner(), &writer, original, b"nonempty diagnostic", 0)
            .unwrap();
        fs::remove_file(path.join("stderr")).unwrap();
        drop(writer);
        let receipt = json!({"version":1,"operationId":operation,"requestFingerprint":"d".repeat(64),"provider":{"packageId":owner().package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"unknown","error":{"code":"interrupted","message":"Host reply was lost","correlationId":null}},"delivery":{"state":"none"}});
        store
            .observe_receipt(&owner(), consumer, operation, 1, receipt)
            .unwrap();
        let _ = store.auto_settle_operation(consumer, operation, true);
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(
            fs::read(path.join("stdout")).unwrap(),
            original,
            "Unknown settlement collected verified stdout because stderr was incomplete"
        );
        assert!(store.has_bound_host_output(consumer, operation).unwrap());
        assert!(
            store
                .has_removal_host_image_at(&store.connect().unwrap(), consumer, operation)
                .unwrap(),
            "explicit removal lost the original-image notice evidence"
        );
        let reply = store
            .host_spool_result(&owner().package_id, "host:sibling")
            .unwrap()
            .expect("verified stdout must remain deliverable without diagnostics");
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            original
        );
        assert_eq!(fs::read(reply["stderr"].as_str().unwrap()).unwrap(), b"");
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), original.len() as u64);
        store
            .release_host_spool(&owner().package_id, reply["handle"].as_str().unwrap())
            .unwrap();
        assert_eq!(charged(&store), 0);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn damaged_diagnostics_keep_the_previous_charge_until_their_barrier_succeeds() {
        use std::os::unix::fs::PermissionsExt;
        let (_root, store) = store();
        let (_, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:diagnostic-charge", 4096)
            .unwrap();
        store
            .write_pinned_host_reply(&owner(), &writer, b"paid original", &vec![b'd'; 300], 0)
            .unwrap();
        drop(writer);
        store.sweep_host_spools(|_| false).unwrap();
        let stderr = path.join("stderr");
        store.test_fs.before_mutation(&stderr);
        fs::write(&stderr, vec![b'c'; 1000]).unwrap();
        store.sweep_host_spools(|_| false).unwrap();
        let previous = charged(&store);
        store.test_fs.before_mutation(&stderr);
        fs::write(&stderr, b"x").unwrap();
        fs::set_permissions(&stderr, fs::Permissions::from_mode(0o400)).unwrap();
        store.sweep_host_spools(|_| false).unwrap();
        assert!(charged(&store) >= previous);
        fs::set_permissions(&stderr, fs::Permissions::from_mode(0o600)).unwrap();
        store.test_fs.power_loss();
        assert!(
            charged(&store)
                >= fs::metadata(path.join("stdout")).unwrap().len()
                    + fs::metadata(stderr).unwrap().len()
        );
    }

    #[test]
    fn invalid_sibling_stream_never_authorizes_collecting_verified_bytes() {
        for bad_stream in ["stdout", "stderr"] {
            for missing in [false, true] {
                let (root, store) = store();
                let (_, path, writer) = store
                    .reserve_pinned_host_spool(&owner(), "host:independent", 1024)
                    .unwrap();
                store
                    .write_pinned_host_reply(
                        &owner(),
                        &writer,
                        b"paid image",
                        b"paid diagnostic",
                        0,
                    )
                    .unwrap();
                if missing {
                    fs::remove_file(path.join(bad_stream)).unwrap();
                } else {
                    fs::write(path.join(bad_stream), b"partial").unwrap();
                }
                let (good_stream, expected) = if bad_stream == "stdout" {
                    ("stderr", b"paid diagnostic".as_slice())
                } else {
                    ("stdout", b"paid image".as_slice())
                };
                drop(writer);
                drop(store);
                let reopened =
                    Store::open(root.path().join("service-state"), Limits::default()).unwrap();
                reopened.sweep_host_spools(|_| false).unwrap();
                assert_eq!(
                    fs::read(path.join(good_stream)).unwrap(),
                    expected,
                    "valid {good_stream} was discarded because {bad_stream} did not validate"
                );
                assert!(
                    (bad_stream == "stderr")
                        == matches!(
                            reopened.host_spool_result(&owner().package_id, "host:independent"),
                            Ok(Some(_))
                        ),
                    "damaged reply was advertised as complete"
                );
                assert!(charged(&reopened) >= expected.len() as u64);
            }
        }
    }

    #[test]
    fn reserved_completion_intent_recovers_only_exact_original_bytes() {
        for damaged in 0..3 {
            let (root, store) = store();
            let (_handle, path, writer) = store
                .reserve_pinned_host_spool(&owner(), "host:intent-only", 1024)
                .unwrap();
            store
                .write_pinned_host_reply(&owner(), &writer, b"sole paid original", b"", 0)
                .unwrap();
            // No pending or seal commit ran. A short witness cannot mask the
            // earlier reserved intent, nor can that intent excuse damaged bytes.
            fs::write(path.join("pending.json"), b"{\"status\":").unwrap();
            if damaged == 1 {
                fs::write(path.join("stdout"), b"partial").unwrap();
            }
            if damaged == 2 {
                fs::remove_file(path.join("stdout")).unwrap();
            }
            drop(writer);
            drop(store);
            let reopened =
                Store::open(root.path().join("service-state"), Limits::default()).unwrap();
            let reply = reopened.host_spool_result(&owner().package_id, "host:intent-only");
            if damaged == 0 {
                let reply = reply
                    .unwrap()
                    .expect("reserved completion intent lost original");
                assert_eq!(
                    fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
                    b"sole paid original"
                );
            } else {
                assert!(
                    !matches!(reply, Ok(Some(_))),
                    "intent accepted damaged original bytes"
                );
            }
        }
    }
    #[test]
    fn ambiguous_unbound_custody_is_refused_before_reserving_output() {
        let (_root, store) = store();
        forwarded(&store, "fixture.first", "op-first");
        forwarded(&store, "fixture.second", "op-second");
        assert!(
            store
                .reserve_host_spool(&owner(), "host:ambiguous", 1024)
                .is_err(),
            "ambiguous unbound process admitted without an owner"
        );
        assert_eq!(charged(&store), 0);
        assert_eq!(
            fs::read_dir(store.root.join("host-spools"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    fn compatible_replacement_unbound_reply_stays_tied_to_fenced_admission() {
        let (_root, store) = store();
        let consumer = "fixture.replacement-custody";
        let operation = "op-replacement";
        forwarded(&store, consumer, operation);
        let receipt = json!({"version":1,"operationId":operation,"requestFingerprint":"d".repeat(64),"provider":{"packageId":owner().package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"unknown","error":{"code":"interrupted","message":"Lost reply","correlationId":null}},"delivery":{"state":"none"}});
        store
            .observe_receipt(&owner(), consumer, operation, 1, receipt)
            .unwrap();
        store
            .auto_settle_operation(consumer, operation, true)
            .unwrap();
        let replacement = PackageGeneration {
            digest: "a".repeat(64),
            incarnation: 12,
            ..owner()
        };
        let admission = store.get(consumer, operation).unwrap().unwrap();
        let _repair = store.output_recovery_guard(&admission).unwrap();
        let (handle, path) = store
            .reserve_host_spool(&replacement, "host:unpaid-repair", 1024)
            .unwrap();
        fs::write(path.join("stdout"), b"unpaid original recovery").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store.seal_host_spool(&replacement, &handle, 0).unwrap();
        assert!(
            store
                .has_operation_unbound_host_output(consumer, operation)
                .unwrap(),
            "replacement reply escaped original admission"
        );
        let reply = store
            .host_spool_result_for_operation(
                &owner().package_id,
                "host:unpaid-repair",
                consumer,
                operation,
                Some(&replacement),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            b"unpaid original recovery"
        );
        store.abandon_package_outputs(consumer).unwrap();
        store.sweep_host_spools(|_| true).unwrap();
        assert!(!path.exists());
        assert_eq!(charged(&store), 0);
    }
    #[test]
    fn operation_recovery_cannot_cross_request_id_collisions() {
        let (_root, store) = store();
        forwarded(&store, "fixture.collision", "op-a");
        forwarded(&store, "fixture.collision", "op-b");
        let (a, a_path) = store
            .reserve_host_spool_with_custody(
                &owner(),
                "host:1",
                1024,
                Some(("fixture.collision", "op-a")),
            )
            .unwrap();
        fs::write(a_path.join("stdout"), b"original A").unwrap();
        fs::write(a_path.join("stderr"), []).unwrap();
        store.seal_host_spool(&owner(), &a, 0).unwrap();
        let replacement = PackageGeneration {
            incarnation: 12,
            ..owner()
        };
        let candidates = store.package_operations(&owner().package_id).unwrap();
        let _repairs: Vec<_> = candidates
            .iter()
            .map(|a| store.output_recovery_guard(a).unwrap())
            .collect();
        let (b, b_path) = store
            .reserve_host_spool_with_custody(
                &replacement,
                "host:1",
                1024,
                Some(("fixture.collision", "op-b")),
            )
            .unwrap();
        fs::write(b_path.join("stdout"), b"original B").unwrap();
        fs::write(b_path.join("stderr"), []).unwrap();
        store.seal_host_spool(&replacement, &b, 0).unwrap();
        let reply = store
            .host_spool_result_for_operation(
                &owner().package_id,
                "host:1",
                "fixture.collision",
                "op-b",
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            b"original B"
        );
        assert!(
            store
                .host_spool_result_for_operation(
                    &owner().package_id,
                    "host:1",
                    "fixture.collision",
                    "op-b",
                    Some(&owner())
                )
                .unwrap()
                .is_none(),
            "explicit owner escaped operation custody"
        );
    }
    #[test]
    fn original_custody_wins_replacement_request_counter_collision() {
        let (_root, store) = store();
        let consumer = "fixture.original-collision";
        let operation = "op-original";
        forwarded(&store, consumer, operation);
        let (original, original_path) = store
            .reserve_host_spool_with_custody(&owner(), "host:1", 1024, Some((consumer, operation)))
            .unwrap();
        fs::write(original_path.join("stdout"), b"sole paid original").unwrap();
        fs::write(original_path.join("stderr"), []).unwrap();
        store.seal_host_spool(&owner(), &original, 0).unwrap();
        let replacement = PackageGeneration {
            digest: "a".repeat(64),
            incarnation: 12,
            ..owner()
        };
        let candidates = store.package_operations(&owner().package_id).unwrap();
        let _repairs: Vec<_> = candidates
            .iter()
            .map(|a| store.output_recovery_guard(a).unwrap())
            .collect();
        let (other, other_path) = store
            .reserve_host_spool(&replacement, "host:1", 1024)
            .unwrap();
        fs::write(other_path.join("stdout"), b"unrelated replacement output").unwrap();
        fs::write(other_path.join("stderr"), []).unwrap();
        store.seal_host_spool(&replacement, &other, 0).unwrap();
        let reply = store
            .host_spool_result_for_operation(
                &owner().package_id,
                "host:1",
                consumer,
                operation,
                None,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read(reply["stdout"].as_str().unwrap()).unwrap(),
            b"sole paid original"
        );
    }
    #[test]
    fn reply_survives_failure_before_pending_metadata_publication() {
        let (root, store) = store();
        let (handle, path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:metadata-failure", 1024)
            .unwrap();
        assert!(store
            .write_pinned_host_reply_observed(
                &owner(),
                &writer,
                b"sole paid original",
                b"",
                0,
                |point| {
                    if point == 10 {
                        crate::durable_dir::fail_next_file_sync();
                    }
                    Ok(())
                }
            )
            .is_err());
        assert!(path.join("pending.json").exists());
        drop(writer);
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let recovered = reopened
            .host_spool_result(&owner().package_id, "host:metadata-failure")
            .unwrap()
            .expect("metadata publication failure discarded durable original");
        assert_eq!(
            fs::read(recovered["stdout"].as_str().unwrap()).unwrap(),
            b"sole paid original"
        );
        assert_eq!(recovered["status"], 0);
        assert_eq!(charged(&reopened), 18);
        reopened
            .release_host_spool(&owner().package_id, &handle)
            .unwrap();
    }
    #[test]
    fn reply_survives_combined_metadata_and_pending_commit_failure() {
        let (root, store) = store();
        let (_handle, _path, writer) = store
            .reserve_pinned_host_spool(&owner(), "host:combined-failure", 1024)
            .unwrap();
        store.fail_next_write();
        assert!(store
            .write_pinned_host_reply_observed(
                &owner(),
                &writer,
                b"sole paid original",
                b"",
                0,
                |point| {
                    if point == 10 {
                        crate::durable_dir::fail_next_file_sync();
                    }
                    Ok(())
                }
            )
            .is_err());
        drop(writer);
        drop(store);
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        let recovered = reopened
            .host_spool_result(&owner().package_id, "host:combined-failure")
            .unwrap()
            .expect("combined metadata faults discarded durable original");
        assert_eq!(
            fs::read(recovered["stdout"].as_str().unwrap()).unwrap(),
            b"sole paid original"
        );
        assert_eq!(recovered["status"], 0);
    }
    #[test]
    fn sweeper_discovers_settled_spool_even_if_release_commit_was_lost() {
        let (root, store) = store();
        let path = bound(
            &store,
            "fixture.settled-consumer",
            "op-settled",
            "host:settled",
            0,
        );
        // Old-host crash image: the settlement committed but its separate
        // spool release did not. No recovery candidate is needed for cleanup.
        store
            .transaction(|tx| {
                tx.execute(
                    "UPDATE operations SET exec_released=1 WHERE consumer=?1 AND operation=?2",
                    params!["fixture.settled-consumer", "op-settled"],
                )
                .map_err(sql)?;
                tx.execute(
                    "INSERT INTO dismissed_operations VALUES(?1,?2,0,0)",
                    params!["fixture.settled-consumer", "op-settled"],
                )
                .map_err(sql)?;
                Ok(())
            })
            .unwrap();
        let receipt = json!({"version":1,"operationId":"op-settled","requestFingerprint":"d".repeat(64),"provider":{"packageId":owner().package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"failed","error":{"code":"invalid_output","message":"Rejected","correlationId":null}},"delivery":{"state":"none"}});
        store
            .observe_receipt(
                &owner(),
                "fixture.settled-consumer",
                "op-settled",
                1,
                receipt,
            )
            .unwrap();
        let reopened = Store::open(root.path().join("service-state"), Limits::default()).unwrap();
        reopened.sweep_host_spools(|_| false).unwrap();
        assert_eq!(
            charged(&reopened),
            0,
            "settled spool is permanently charged"
        );
        assert!(!path.exists());
    }
    #[test]
    fn removal_releases_unbound_spools_reachable_from_admissions() {
        let (_root, store) = store();
        forwarded(&store, "fixture.legacy-consumer", "op-legacy");
        let (_, path) = complete(&store, "host:unbound-removal");
        store
            .abandon_package_outputs("fixture.legacy-consumer")
            .unwrap();
        store.sweep_host_spools(|_| true).unwrap();
        assert_eq!(
            charged(&store),
            0,
            "removed consumer retained provider-owned output"
        );
        assert!(!path.exists());
    }
    #[test]
    fn removal_collects_unbound_reply_from_restarted_same_digest_provider() {
        let (_root, store) = store();
        forwarded(&store, "fixture.reincarnated-consumer", "op-reincarnated");
        let restarted = PackageGeneration {
            incarnation: owner().incarnation + 1,
            ..owner()
        };
        let candidates = store.package_operations(&owner().package_id).unwrap();
        let _repairs: Vec<_> = candidates
            .iter()
            .map(|a| store.output_recovery_guard(a).unwrap())
            .collect();
        let (handle, path) = store
            .reserve_host_spool(&restarted, "host:reincarnated", 1024)
            .unwrap();
        fs::write(path.join("stdout"), b"restarted provider original").unwrap();
        fs::write(path.join("stderr"), []).unwrap();
        store.seal_host_spool(&restarted, &handle, 0).unwrap();
        store
            .abandon_package_outputs("fixture.reincarnated-consumer")
            .unwrap();
        store.sweep_host_spools(|_| true).unwrap();
        assert_eq!(
            charged(&store),
            0,
            "same-owner reincarnation escaped consumer removal"
        );
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn unreadable_original_cannot_veto_explicit_consumer_removal() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_root, store) = store();
        let path = bound(
            &store,
            "fixture.unreadable-removal",
            "op-unreadable",
            "host:unreadable-removal",
            0,
        );
        fs::set_permissions(path.join("stdout"), fs::Permissions::from_mode(0)).unwrap();
        store
            .abandon_package_outputs("fixture.unreadable-removal")
            .expect("unreadable stdout vetoed explicit removal");
        store.sweep_host_spools(|_| true).unwrap();
        assert_eq!(charged(&store), 0);
        assert!(!path.exists());
    }
    #[test]
    fn rejected_unbound_reply_does_not_leak_after_settlement() {
        let (_root, store) = store();
        let consumer = "fixture.nonzero-consumer";
        let operation = "op-nonzero";
        forwarded(&store, consumer, operation);
        let (handle, path) = store
            .reserve_host_spool(&owner(), "host:nonzero", 1024)
            .unwrap();
        fs::write(path.join("stdout"), b"nonzero CLI output").unwrap();
        fs::write(path.join("stderr"), b"diagnostic").unwrap();
        store.seal_host_spool(&owner(), &handle, 1).unwrap();
        let receipt = json!({"version":1,"operationId":operation,"requestFingerprint":"d".repeat(64),"provider":{"packageId":owner().package_id,"serviceId":"image-generation","major":1},"revision":1,"execution":{"state":"failed","error":{"code":"cli_error","message":"Failed","correlationId":null}},"delivery":{"state":"none"}});
        store
            .observe_receipt(&owner(), consumer, operation, 1, receipt)
            .unwrap();
        store
            .auto_settle_operation(consumer, operation, true)
            .unwrap();
        store.sweep_host_spools(|_| true).unwrap();
        assert_eq!(
            charged(&store),
            0,
            "settled nonzero unbound reply leaked quota"
        );
        assert!(!path.exists());
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
        let (_handle, path, writer) = store
            .reserve_pinned_host_spool_with_custody(
                &owner(),
                request,
                1024,
                Some((consumer, operation)),
            )
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
        let (_, unrelated) = complete(&store, "host:unrelated");
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
    fn failed_capture_directory_barrier_cannot_publish_success() {
        let (_root, store) = store();
        let (handle, directory) = store
            .reserve_host_spool(&owner(), "host:unsynced-completion", 1024)
            .unwrap();
        fs::write(directory.join("stdout"), b"paid bytes").unwrap();
        fs::write(directory.join("stderr"), []).unwrap();
        store.test_fs.faults(false, true);
        assert!(store.seal_host_spool(&owner(), &handle, 0).is_err());
        assert!(!store.host_spool_has_recorded_identity(&handle).unwrap());
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(
            charged(&store),
            1024,
            "failed directory barrier released charge early"
        );
        assert!(store
            .host_spool_result(&owner().package_id, "host:unsynced-completion")
            .unwrap()
            .is_none());
        store.test_fs.faults(false, false);
        store.sweep_host_spools(|_| false).unwrap();
        assert_eq!(charged(&store), 0);
        assert!(!directory.exists());
        assert!(store
            .host_spool_result(&owner().package_id, "host:unsynced-completion")
            .unwrap()
            .is_none());
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
    fn sync_host_spool_file(&self, path: &Path) -> Result<()> {
        crate::durable_dir::sync_file(path)?;
        #[cfg(test)]
        self.test_fs.file_synced(path);
        Ok(())
    }

    fn observe_host_spool_mutation(&self, path: &Path) {
        #[cfg(test)]
        self.test_fs.before_mutation(path);
        #[cfg(not(test))]
        let _ = path;
    }

    fn write_host_stream_observed(
        &self,
        path: &Path,
        bytes: &[u8],
        first: u8,
        checkpoint: &mut impl FnMut(u8) -> Result<()>,
    ) -> Result<()> {
        // A streaming reader may already have written exactly this stream.
        // Do not truncate it and reopen a RAM-only capture window at completion.
        if spool_bytes(path, MAX_SPOOL).ok().as_deref() == Some(bytes) {
            checkpoint(first)?;
            checkpoint(first + 1)?;
            checkpoint(first + 2)?;
            self.sync_host_spool_file(path)?;
            return checkpoint(first + 3);
        }
        self.observe_host_spool_mutation(path);
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        checkpoint(first)?;
        let middle = bytes.len() / 2;
        file.write_all(&bytes[..middle])?;
        checkpoint(first + 1)?;
        file.write_all(&bytes[middle..])?;
        file.flush()?;
        checkpoint(first + 2)?;
        self.sync_host_spool_file(path)?;
        checkpoint(first + 3)
    }

    fn sync_host_spool_directory(&self, path: &Path) -> Result<()> {
        #[cfg(test)]
        self.test_fs.sync(path)?;
        #[cfg(not(test))]
        crate::durable_dir::sync(path)?;
        Ok(())
    }
    fn sync_complete_host_spool(&self, handle: &str) -> Result<()> {
        let directory = self.host_spool_path(handle)?;
        let completion = self
            .host_completion(handle)?
            .ok_or_else(|| reject("host reply is incomplete"))?;
        self.sync_host_spool_file(&directory.join("stdout"))?;
        if !completion.stderr_incomplete {
            self.sync_host_spool_file(&directory.join("stderr"))?;
        }
        // Repair old completed-pending rows as well as an interrupted manifest
        // publication. A status plus bounded durable bytes is still custody.
        if !directory.join("completed.json").try_exists()? {
            let completion = self
                .host_completion(handle)?
                .ok_or_else(|| reject("host reply is incomplete"))?;
            self.write_host_completion(&directory, "completed.json", &completion)?;
        }
        self.sync_host_spool_file(&directory.join("completed.json"))?;
        self.sync_host_spool_directory(&directory)?;
        self.sync_host_spool_directory(directory.parent().unwrap())
    }

    /// The atomic sealed-sidecar rename is the sole completion commit point.
    /// The temporary spool's bytes and header are fsynced before publication;
    /// SQLite completion metadata is only a recoverable index of this seal.
    /// Both native capture and ProcessSpool completion enter through this seam.
    fn durable_host_completion(&self, directory: &Path, status: i64) -> Result<Completion> {
        let stdout = spool_bytes(&directory.join("stdout"), MAX_SPOOL)?;
        let stderr = spool_bytes(&directory.join("stderr"), MAX_SPOOL)?;
        let completion = completion_for(status, &stdout, &stderr);
        self.ensure_host_completion_identity(
            directory.file_name().unwrap().to_str().unwrap(),
            &completion,
        )?;
        for name in ["stdout", "stderr"] {
            self.sync_host_spool_file(&directory.join(name))?;
        }
        // Durable stream names must precede the seal's rename. Recovery can
        // never find a committed seal whose referenced streams were not synced.
        self.sync_host_spool_directory(directory)?;
        self.sync_host_spool_directory(directory.parent().unwrap())?;
        if !directory.join("completed.json").try_exists()? {
            self.write_host_completion_observed(
                directory,
                "completed.json",
                &completion,
                &mut |point| {
                    #[cfg(test)]
                    self.test_fs.checkpoint(
                        [
                            "host-seal-temp-create",
                            "host-seal-temp-partial",
                            "host-seal-temp-full",
                            "host-seal-temp-sync",
                            "host-seal-rename",
                            "host-seal-target-sync",
                            "host-seal-directory-sync",
                        ][usize::from(point - 1)],
                    )?;
                    #[cfg(not(test))]
                    let _ = point;
                    Ok(())
                },
            )?;
        }
        self.sync_host_spool_directory(directory)?;
        Ok(completion)
    }

    fn ensure_host_completion_identity(&self, handle: &str, completion: &Completion) -> Result<()> {
        for recorded in self.recorded_host_completions(handle)? {
            if recorded.status != completion.status
                || recorded.stdout_length != completion.stdout_length
                || recorded.stderr_length != completion.stderr_length
                || recorded.stdout_sha256 != completion.stdout_sha256
                || recorded.stderr_sha256 != completion.stderr_sha256
            {
                return Err(reject("host reply completion is immutable"));
            }
        }
        Ok(())
    }

    fn write_host_completion(
        &self,
        directory: &Path,
        name: &str,
        completion: &Completion,
    ) -> Result<()> {
        self.write_host_completion_observed(directory, name, completion, &mut |_| Ok(()))
    }

    fn write_host_completion_observed(
        &self,
        directory: &Path,
        name: &str,
        completion: &Completion,
        checkpoint: &mut impl FnMut(u8) -> Result<()>,
    ) -> Result<()> {
        if name == "pending.json" {
            // Evidence is immutable and follows durable capture. Retain its
            // name when flushing fails so another publication can recover it.
            let raw = serde_json::to_vec(completion)
                .map_err(|_| reject("host output manifest serialization failed"))?;
            let target = directory.join(name);
            self.observe_host_spool_mutation(&target);
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&target) {
                Ok(mut file) => {
                    checkpoint(2)?;
                    let middle = raw.len() / 2;
                    file.write_all(&raw[..middle])?;
                    checkpoint(3)?;
                    file.write_all(&raw[middle..])?;
                    file.flush()?;
                    checkpoint(4)?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if spool_bytes(&target, 4096)? != raw {
                        return Err(reject("host reply completion is immutable"));
                    }
                }
                Err(e) => return Err(e.into()),
            }
            self.sync_host_spool_file(&target)?;
            checkpoint(5)?;
            self.sync_host_spool_directory(directory)?;
            return checkpoint(6);
        }
        let mut stage = tempfile::NamedTempFile::new_in(directory)?;
        #[cfg(test)]
        self.test_fs.created(stage.path());
        if let Err(cause) = checkpoint(1) {
            let _ = stage.keep();
            return Err(cause);
        }
        let raw = serde_json::to_vec(completion)
            .map_err(|_| reject("host output manifest serialization failed"))?;
        let middle = raw.len() / 2;
        stage.write_all(&raw[..middle])?;
        if let Err(cause) = checkpoint(2) {
            let _ = stage.keep();
            return Err(cause);
        }
        stage.write_all(&raw[middle..])?;
        stage.flush()?;
        if let Err(cause) = checkpoint(3) {
            let _ = stage.keep();
            return Err(cause);
        }
        self.sync_host_spool_file(stage.path())?;
        if let Err(cause) = checkpoint(4) {
            let _ = stage.keep();
            return Err(cause);
        }
        #[cfg(test)]
        self.test_fs
            .before_rename(stage.path(), &directory.join(name));
        stage
            .persist(directory.join(name))
            .map_err(|e| crate::error::AppError::from(e.error))?;
        checkpoint(5)?;
        self.sync_host_spool_file(&directory.join(name))?;
        checkpoint(6)?;
        self.sync_host_spool_directory(directory)?;
        checkpoint(7)
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

    pub fn reserve_host_spool_with_custody(
        &self,
        owner: &PackageGeneration,
        request_id: &str,
        limit: u64,
        custody: Option<(&str, &str)>,
    ) -> Result<(String, PathBuf)> {
        let (handle, path, _writer) =
            self.reserve_pinned_host_spool_with_custody(owner, request_id, limit, custody)?;
        Ok((handle, path))
    }

    pub fn reserve_pinned_host_spool(
        &self,
        owner: &PackageGeneration,
        request_id: &str,
        limit: u64,
    ) -> Result<(String, PathBuf, HostSpoolWriter<'_>)> {
        self.reserve_pinned_host_spool_with_custody(owner, request_id, limit, None)
    }

    /// Explicit custody and its reservation are one decision. A custody-less
    /// call is safe only when at most one admission can own its original bytes.
    pub fn reserve_pinned_host_spool_with_custody(
        &self,
        owner: &PackageGeneration,
        request_id: &str,
        limit: u64,
        custody: Option<(&str, &str)>,
    ) -> Result<(String, PathBuf, HostSpoolWriter<'_>)> {
        generation(owner)?;
        if !identity(request_id) || limit > MAX_SPOOL {
            return Err(reject("invalid host output reservation"));
        }
        let admission = custody
            .map(|(consumer, operation)| {
                let a = self
                    .get(consumer, operation)?
                    .ok_or_else(|| reject("host process admission disappeared"))?;
                if a.provider.package_id != owner.package_id
                    || a.provider != *owner && !self.original_writer_active(consumer, operation)?
                {
                    return Err(reject(
                        "host process requires the original provider or an unpaid recovery permit",
                    ));
                }
                if !matches!(
                    a.phase,
                    AdmissionPhase::Forwarding | AdmissionPhase::Accepted
                ) || self.execution_released(consumer, operation)?
                {
                    if self.original_writer_active(consumer, operation)?
                        && a.phase != AdmissionPhase::Released
                    {
                        return Ok(a);
                    }
                    return Err(reject(
                        "host process requires an active forwarded admission",
                    ));
                }
                Ok(a)
            })
            .transpose()?;
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| reject("host output identity unavailable"))?;
        let handle = hex::encode(random);
        let path = self.host_spool_path(&handle)?;
        // Pin before the reservation is advertised: acquiring this same
        // lease is then sufficient evidence that no original writer survives.
        let writer = self.pin_host_spool(&handle)?;
        self.transaction(|tx| {
            Self::generation_admitted(tx,owner)?;
            let candidates = if let Some(a) = &admission {
                let current = Self::record(tx,&a.consumer.package_id,&a.operation_id)?.ok_or_else(|| reject("host process admission disappeared"))?;
                let released: bool = tx.query_row("SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2", params![a.consumer.package_id,a.operation_id], |r| r.get(0)).map_err(sql)?;
                if current != *a || released && !self.original_writer_active(&a.consumer.package_id, &a.operation_id)? { return Err(reject("host process admission changed before execution")); }
                if current.provider != *owner && !self.original_writer_active(&a.consumer.package_id, &a.operation_id)? {
                    return Err(reject("host process requires the original execution generation or an unpaid recovery permit"));
                }
                vec![(a.consumer.package_id.clone(), a.operation_id.clone())]
            } else {
                let mut q = tx.prepare("SELECT consumer,operation FROM operations WHERE json_extract(admission,'$.provider.packageId')=?1 AND phase!='released'").map_err(sql)?;
                let candidates = q.query_map([&owner.package_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
                if candidates.len() > 1 { return Err(reject("host output custody is ambiguous; supply consumer and operation")); }
                candidates
            };
            for (consumer, operation) in &candidates {
                let a = Self::record(tx, consumer, operation)?.ok_or_else(|| reject("host process admission disappeared"))?;
                let released: bool = tx.query_row("SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2",params![consumer,operation],|r|r.get(0)).map_err(sql)?;
                if Self::provider_receipt_at(tx,&a)?.is_some_and(|receipt| matches!(receipt["execution"]["state"].as_str(),Some("failed"|"cancelled"))) {
                    return Err(reject("host process cannot restart a terminal provider execution"));
                }

                if (released || a.provider != *owner || !matches!(a.phase, AdmissionPhase::Forwarding | AdmissionPhase::Accepted)) && !self.original_writer_active(consumer, operation)? {
                    return Err(reject("host process requires an active original execution or an unpaid recovery permit"));
                }
            }
            self.quota(tx,&owner.package_id,limit,false)?;
            tx.execute("INSERT INTO host_spools(handle,package,owner,request_id,limit_bytes,bytes,status,custody_recorded,consumer,operation) VALUES(?1,?2,?3,?4,?5,?5,'reserved',1,?6,?7)",params![handle,owner.package_id,encode(owner)?,request_id,limit as i64,custody.map(|c| c.0),custody.map(|c| c.1)]).map_err(sql)?;
            for (consumer, operation) in candidates {
                tx.execute("INSERT INTO host_spool_admissions VALUES(?1,?2,?3)", params![handle,consumer,operation]).map_err(sql)?;
            }
            Ok(())
        })?;
        if let Err(cause) = (|| {
            self.observe_host_spool_mutation(&path);
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
            tx.execute("DELETE FROM host_spool_admissions WHERE handle=?1", [handle]).map_err(sql)?;
            tx.execute("INSERT INTO host_spool_admissions VALUES(?1,?2,?3)", params![handle,consumer,operation]).map_err(sql)?;
            Ok(())
        })
    }

    pub fn has_bound_host_output(&self, consumer: &str, operation: &str) -> Result<bool> {
        self.has_bound_host_output_at(&self.connect()?, consumer, operation)
    }

    /// Removal notices require a valid original image, rather than treating
    /// arbitrary raw CLI stdout as a successful image-service result.
    pub(super) fn has_removal_host_image_at(
        &self,
        conn: &rusqlite::Connection,
        consumer: &str,
        operation: &str,
    ) -> Result<bool> {
        if conn.query_row("SELECT EXISTS(SELECT 1 FROM provider_receipts WHERE consumer=?1 AND operation=?2 AND json_extract(status,'$.execution.state') IN ('failed','cancelled'))", params![consumer,operation], |r| r.get::<_,bool>(0)).map_err(sql)? { return Ok(false); }
        let mut query = conn.prepare("SELECT h.handle FROM host_spools h WHERE h.status!='released' AND (h.consumer=?1 AND h.operation=?2 OR EXISTS(SELECT 1 FROM host_spool_admissions s WHERE s.handle=h.handle AND s.consumer=?1 AND s.operation=?2))").map_err(sql)?;
        let handles = query
            .query_map(params![consumer, operation], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        for handle in handles {
            if self.has_verified_successful_stdout(&handle)? {
                let bytes = spool_bytes(&self.host_spool_path(&handle)?.join("stdout"), MAX_SPOOL)?;
                if super::artifacts::image(&bytes, true).is_ok() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
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
            if self.has_verified_successful_stdout(&handle)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub fn has_operation_unbound_host_output(
        &self,
        consumer: &str,
        operation: &str,
    ) -> Result<bool> {
        let conn = self.connect()?;
        let mut query = conn.prepare("SELECT h.handle FROM host_spools h JOIN host_spool_admissions s ON s.handle=h.handle WHERE s.consumer=?1 AND s.operation=?2 AND h.consumer IS NULL AND h.status!='released'").map_err(sql)?;
        let handles = query
            .query_map(params![consumer, operation], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        for handle in handles {
            if self.has_verified_successful_stdout(&handle)? {
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
            if self.has_verified_successful_stdout(&handle)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn release_operation_spools(&self, consumer: &str, operation: &str) -> Result<()> {
        self.transaction(|tx| Self::release_operation_spools_in(tx, consumer, operation, true))?;
        self.sweep_host_spools(|_| true)
    }

    /// The release intent shares the admission's transaction; only physical
    /// unlink and its durability barriers are deferred. Ambiguous unbound
    /// custody belongs to the surviving admissions until the last one leaves.
    pub(super) fn release_operation_spools_in(
        tx: &rusqlite::Connection,
        consumer: &str,
        operation: &str,
        unbound: bool,
    ) -> Result<()> {
        tx.execute(
            "UPDATE host_spools SET status='released' WHERE consumer=?1 AND operation=?2",
            params![consumer, operation],
        )
        .map_err(sql)?;
        if unbound {
            tx.execute("UPDATE host_spools SET status='released' WHERE consumer IS NULL AND EXISTS(SELECT 1 FROM host_spool_admissions s WHERE s.handle=host_spools.handle AND s.consumer=?1 AND s.operation=?2) AND NOT EXISTS(SELECT 1 FROM host_spool_admissions s WHERE s.handle=host_spools.handle AND (s.consumer!=?1 OR s.operation!=?2))", params![consumer,operation]).map_err(sql)?;
            tx.execute(
                "DELETE FROM host_spool_admissions WHERE consumer=?1 AND operation=?2",
                params![consumer, operation],
            )
            .map_err(sql)?;
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
        self.publish_pinned_host_manifest(owner, writer, status)?;
        self.commit_pinned_host_seal(owner, writer)
    }

    pub fn sync_pinned_host_reply(&self, writer: &HostSpoolWriter<'_>) -> Result<()> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        let path = self.host_spool_path(&writer.handle)?;
        for name in ["stdout", "stderr"] {
            self.sync_host_spool_file(&path.join(name))?;
        }
        self.sync_host_spool_directory(&path)?;
        self.sync_host_spool_directory(path.parent().unwrap())
    }

    pub fn publish_pinned_host_manifest(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
        status: i64,
    ) -> Result<()> {
        self.publish_pinned_host_manifest_observed(owner, writer, status, |_| Ok(()))
    }

    pub(crate) fn publish_pinned_host_manifest_observed(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
        status: i64,
        mut checkpoint: impl FnMut(u8) -> Result<()>,
    ) -> Result<()> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        self.publish_host_spool_manifest_observed(owner, &writer.handle, status, &mut checkpoint)
    }

    pub fn commit_pinned_host_seal(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
    ) -> Result<()> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        self.commit_host_spool_seal(owner, &writer.handle)
    }

    /// Open the sole process reader's stdout destination under its writer pin.
    pub(crate) fn open_pinned_host_stdout(&self, writer: &HostSpoolWriter<'_>) -> Result<fs::File> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        let path = self.host_spool_path(&writer.handle)?.join("stdout");
        self.observe_host_spool_mutation(&path);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Ok(options.open(path)?)
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
        let path = self.host_spool_path(&writer.handle)?;
        let completion = self.durable_host_completion(&path, status)?;
        self.transaction(|tx| {
            let changed=tx.execute("UPDATE host_spools SET status='completed-pending',process_status=?3,completion=?4 WHERE handle=?1 AND owner=?2 AND status!='released'",params![writer.handle,encode(owner)?,status,encode(&completion)?]).map_err(sql)?;
            Ok(changed==1)
        })
    }

    /// Seal the original before publishing any derived database/pending
    /// metadata. A crash before the database commit recovers from the seal;
    /// legacy pending markers remain readable for existing reservations.
    pub fn write_pinned_host_reply(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
        stdout: &[u8],
        stderr: &[u8],
        status: i64,
    ) -> Result<()> {
        self.write_pinned_host_reply_observed(owner, writer, stdout, stderr, status, |_| Ok(()))
    }

    /// The ordinary persistence path, observed at individual filesystem and
    /// transaction boundaries by crash tests. Observers never supply reply IO.
    pub(crate) fn write_pinned_host_reply_observed(
        &self,
        owner: &PackageGeneration,
        writer: &HostSpoolWriter<'_>,
        stdout: &[u8],
        stderr: &[u8],
        status: i64,
        mut checkpoint: impl FnMut(u8) -> Result<()>,
    ) -> Result<()> {
        if !std::ptr::eq(self, writer.store) {
            return Err(reject("host output writer belongs to another store"));
        }
        let path = self.host_spool_path(&writer.handle)?;
        let (raw, state, limit): (String, String, i64) = self
            .connect()?
            .query_row(
                "SELECT owner,status,limit_bytes FROM host_spools WHERE handle=?1",
                [&writer.handle],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql)?;
        if decode::<PackageGeneration>(&raw)? != *owner || state == "released" {
            return Err(reject("host output reservation was cancelled"));
        }
        if limit < 0 || stdout.len().saturating_add(stderr.len()) as u64 > limit as u64 {
            return Err(reject("host output exceeds reservation"));
        }
        self.ensure_host_completion_identity(
            &writer.handle,
            &completion_for(status, stdout, stderr),
        )?;
        // Until the sealed-sidecar rename, this is only a temporary capture.
        checkpoint(1)?;
        self.write_host_stream_observed(&path.join("stdout"), stdout, 2, &mut checkpoint)?;
        self.write_host_stream_observed(&path.join("stderr"), stderr, 6, &mut checkpoint)?;
        let completion = self.durable_host_completion(&path, status)?;
        checkpoint(10)?;
        match self.transaction(|tx| {
            tx.execute("UPDATE host_spools SET process_status=?3,completion=?4 WHERE handle=?1 AND owner=?2 AND status!='released'", params![writer.handle,encode(owner)?,status,encode(&completion)?]).map(|changed| changed == 1).map_err(sql)
        }) {
            Ok(false) => return Err(reject("host output reservation was cancelled")),
            Ok(true) => (),
            Err(cause) => log::warn!("Host reply identity deferred to its file witness: {cause}"),
        }
        checkpoint(11)?;
        let mut observer_failed = false;
        let metadata =
            self.write_host_completion_observed(&path, "pending.json", &completion, &mut |point| {
                let result = checkpoint(point + 10);
                observer_failed |= result.is_err();
                result
            });
        if observer_failed {
            return metadata;
        }
        self.sync_host_spool_directory(path.parent().unwrap())?;
        checkpoint(17)?;
        // The sealed sidecar already owns completion. These metadata writes
        // can fail without releasing the original.
        if let Err(cause) = metadata {
            if !self.retain_pinned_host_execution(owner, writer, status)? {
                return Err(reject("host output reservation was cancelled"));
            }
            return Err(cause);
        }
        Ok(())
    }

    fn seal_host_spool_inner(
        &self,
        owner: &PackageGeneration,
        handle: &str,
        status: i64,
    ) -> Result<()> {
        self.publish_host_spool_manifest(owner, handle, status)?;
        self.commit_host_spool_seal(owner, handle)
    }

    fn publish_host_spool_manifest(
        &self,
        owner: &PackageGeneration,
        handle: &str,
        status: i64,
    ) -> Result<()> {
        self.publish_host_spool_manifest_observed(owner, handle, status, &mut |_| Ok(()))
    }

    fn publish_host_spool_manifest_observed(
        &self,
        owner: &PackageGeneration,
        handle: &str,
        status: i64,
        checkpoint: &mut impl FnMut(u8) -> Result<()>,
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
        let completion = self.durable_host_completion(&path, status)?;
        self.write_host_completion_observed(&path, "completed.json", &completion, checkpoint)?;
        self.sync_host_spool_directory(&path)?;
        self.sync_host_spool_directory(path.parent().unwrap())?;
        checkpoint(8)
    }

    fn commit_host_spool_seal(&self, owner: &PackageGeneration, handle: &str) -> Result<()> {
        let completion = self
            .host_completion(handle)?
            .ok_or_else(|| reject("host reply is incomplete"))?;
        self.sync_complete_host_spool(handle)?;
        let bytes = completion.stdout_length + completion.stderr_length;
        let status = completion.status;
        self.transaction(|tx| {
            let changed=tx.execute("UPDATE host_spools SET status='sealed',bytes=?2,process_status=?3 WHERE handle=?1 AND owner=?4 AND status!='released'",params![handle,bytes as i64,status,encode(owner)?]).map_err(sql)?;
            if changed!=1 { return Err(reject("host output reservation was cancelled during completion")); }
            Ok(())
        })
    }

    fn validate_host_completion(&self, path: &Path, raw: &[u8]) -> Result<Completion> {
        let mut c: Completion =
            serde_json::from_slice(raw).map_err(|_| reject("invalid host output manifest"))?;
        if !self.host_stream_matches(path, "stdout", c.stdout_length, &c.stdout_sha256, true)? {
            return Err(reject("host output no longer matches completion"));
        }
        let diagnostic_matches =
            self.host_stream_matches(path, "stderr", c.stderr_length, &c.stderr_sha256, true);
        if !matches!(diagnostic_matches, Ok(true)) {
            if c.status != 0 || c.stdout_length == 0 {
                return Err(reject("host output no longer matches completion"));
            }
            c.stderr_incomplete = true;
        }
        Ok(c)
    }

    fn host_stream_matches(
        &self,
        directory: &Path,
        name: &str,
        length: u64,
        sha: &str,
        repair_empty: bool,
    ) -> Result<bool> {
        if length > MAX_SPOOL {
            return Ok(false);
        }
        let path = directory.join(name);
        let bytes = match spool_bytes(&path, MAX_SPOOL) {
            Ok(bytes) => bytes,
            Err(crate::error::AppError::NotFound(_))
                if repair_empty && length == 0 && sha == hex::encode(Sha256::digest([])) =>
            {
                self.observe_host_spool_mutation(&path);
                let mut options = fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                options.open(&path)?;
                self.sync_host_spool_file(&path)?;
                self.sync_host_spool_directory(directory)?;
                Vec::new()
            }
            Err(crate::error::AppError::NotFound(_) | crate::error::AppError::Other(_)) => {
                return Ok(false)
            }
            Err(cause) => return Err(cause),
        };
        Ok(bytes.len() as u64 == length && hex::encode(Sha256::digest(&bytes)) == sha)
    }

    fn recorded_host_completions(&self, handle: &str) -> Result<Vec<Completion>> {
        use rusqlite::OptionalExtension;
        let path = self.host_spool_path(handle)?;
        let mut records = Vec::new();
        for name in ["completed.json", "pending.json"] {
            match spool_bytes(&path.join(name), 4096) {
                Ok(raw) => records.push(raw),
                Err(crate::error::AppError::NotFound(_) | crate::error::AppError::Other(_)) => (),
                Err(cause) => return Err(cause),
            }
        }
        let raw: Option<Option<String>> = self
            .connect()?
            .query_row(
                "SELECT completion FROM host_spools WHERE handle=?1",
                [handle],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if let Some(Some(raw)) = raw {
            records.push(raw.into_bytes());
        }
        Ok(records
            .into_iter()
            .filter_map(|raw| serde_json::from_slice(&raw).ok())
            .collect())
    }

    #[cfg(test)]
    pub(crate) fn host_spool_has_recorded_identity(&self, handle: &str) -> Result<bool> {
        Ok(!self.recorded_host_completions(handle)?.is_empty())
    }

    /// Incomplete replies may still own a verified original stream. The
    /// collector must inspect every independent identity before releasing one.
    fn has_verified_host_stream(&self, handle: &str) -> Result<bool> {
        let path = self.host_spool_path(handle)?;
        for c in self.recorded_host_completions(handle)? {
            for (name, length, sha) in [
                ("stdout", c.stdout_length, c.stdout_sha256),
                ("stderr", c.stderr_length, c.stderr_sha256),
            ] {
                if length > 0 && self.host_stream_matches(&path, name, length, &sha, false)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// Successful stdout remains output custody even if a diagnostic stream
    /// cannot be reconstructed. This does not advertise an incomplete reply.
    fn has_verified_successful_stdout(&self, handle: &str) -> Result<bool> {
        if self
            .completion_evidence(handle)?
            .is_some_and(|c| c.status == 0 && c.stdout_length > 0)
        {
            return Ok(true);
        }
        let path = self.host_spool_path(handle)?;
        for c in self.recorded_host_completions(handle)? {
            if c.status == 0
                && c.stdout_length > 0
                && self.host_stream_matches(
                    &path,
                    "stdout",
                    c.stdout_length,
                    &c.stdout_sha256,
                    false,
                )?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn host_completion(&self, handle: &str) -> Result<Option<Completion>> {
        let path = self.host_spool_path(handle)?;
        match spool_bytes(&path.join("completed.json"), 4096) {
            Ok(raw) => return self.validate_host_completion(&path, &raw).map(Some),
            Err(crate::error::AppError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
        let pending = spool_bytes(&path.join("pending.json"), 4096)
            .and_then(|raw| self.validate_host_completion(&path, &raw));
        match pending {
            Ok(completion) => return Ok(Some(completion)),
            // A short witness write must not mask the independently committed
            // completion identity. Actual storage failures still defer recovery.
            Err(crate::error::AppError::NotFound(_) | crate::error::AppError::Other(_)) => {}
            Err(e) => return Err(e),
        }
        use rusqlite::OptionalExtension;
        let pending: Option<(i64,i64,Option<String>)> = self.connect()?.query_row(
            "SELECT process_status,limit_bytes,completion FROM host_spools WHERE handle=?1 AND process_status IS NOT NULL AND (status='completed-pending' OR status='reserved' AND completion IS NOT NULL)", [handle], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))
        ).optional().map_err(sql)?;
        let Some((status, limit, recorded)) = pending else {
            return Ok(None);
        };
        if let Some(raw) = recorded {
            let completion = self.validate_host_completion(&path, raw.as_bytes())?;
            if completion.status != status {
                return Err(reject("host completion status conflicts with its ledger"));
            }
            return Ok(Some(completion));
        }
        // Earlier versions persisted status without hashes. Preserve their
        // bounded fsynced originals when publication was interrupted.
        let stdout = spool_bytes(&path.join("stdout"), MAX_SPOOL)?;
        let stderr = spool_bytes(&path.join("stderr"), MAX_SPOOL)?;
        if limit < 0 || stdout.len().saturating_add(stderr.len()) as u64 > limit as u64 {
            return Err(reject("host output exceeds reservation"));
        }
        Ok(Some(completion_for(status, &stdout, &stderr)))
    }

    fn completion_evidence(&self, handle: &str) -> Result<Option<Completion>> {
        match self.host_completion(handle) {
            // This classifies a complete reply, never ownership of individual
            // streams. Collection separately protects every verified stream.
            Err(crate::error::AppError::NotFound(_) | crate::error::AppError::Other(_)) => Ok(None),
            result => result,
        }
    }

    /// A lost response is recovered by its original reverse request ID;
    /// this never starts the process again or changes its execution result.
    pub fn host_spool_result(&self, package: &str, request_id: &str) -> Result<Option<Value>> {
        self.host_spool_result_for_owner(package, request_id, None)
    }
    pub fn host_spool_result_for_operation(
        &self,
        package: &str,
        request: &str,
        consumer: &str,
        operation: &str,
        explicit: Option<&PackageGeneration>,
    ) -> Result<Option<Value>> {
        let a = self
            .get(consumer, operation)?
            .ok_or_else(|| reject("original host process admission is unavailable"))?;
        if a.provider.package_id != package
            || explicit.is_some_and(|owner| owner.package_id != package)
        {
            return Err(reject(
                "original host process owner conflicts with its admission",
            ));
        }
        if let Some(owner) = explicit {
            generation(owner)?;
        }
        let legacy = match explicit {
            Some(owner) if same_owner(owner, &a.provider) => Some(encode(owner)?),
            Some(_) => None,
            None => Some(encode(&a.provider)?),
        };
        // Every operation-scoped lookup checks custody, including an exact
        // original owner. Incarnations can reuse request IDs for other work.
        // Original admission custody wins a replacement's reset request counter,
        // but only after filtering by the requested operation. Other collisions
        // remain ambiguous until the caller names an owner.
        let conn = self.connect()?;
        let mut query = conn.prepare("SELECT h.owner FROM host_spools h WHERE h.package=?1 AND h.request_id=?2 AND h.status!='released' AND (?5 IS NULL OR h.owner=?5) AND (h.consumer=?3 AND h.operation=?4 OR EXISTS(SELECT 1 FROM host_spool_admissions s WHERE s.handle=h.handle AND s.consumer=?3 AND s.operation=?4) OR h.custody_recorded=0 AND h.consumer IS NULL AND h.owner=?6)").map_err(sql)?;
        let owners = query
            .query_map(
                params![
                    package,
                    request,
                    consumer,
                    operation,
                    explicit.map(encode).transpose()?,
                    legacy
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        let original = encode(&a.provider)?;
        if explicit.is_none() && owners.contains(&original) {
            return self.host_spool_result_for_owner(package, request, Some(&a.provider));
        }
        if owners.len() > 1 {
            return Err(reject(
                "original host request ID is ambiguous; supply its original owner",
            ));
        }
        let Some(raw) = owners.first() else {
            return Ok(None);
        };
        self.host_spool_result_for_owner(package, request, Some(&decode::<PackageGeneration>(raw)?))
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
        let stderr = if c.stderr_incomplete {
            self.empty_host_diagnostics()?
        } else {
            path.join("stderr")
        };
        Ok(Some(
            json!({"handle":handle,"owner":decode::<PackageGeneration>(&owner)?,"status":c.status,"stdout":path.join("stdout"),"stderr":stderr}),
        ))
    }

    fn empty_host_diagnostics(&self) -> Result<PathBuf> {
        let path = self.root.join("empty-diagnostics");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        if !spool_bytes(&path, 0)?.is_empty() {
            return Err(reject("invalid empty diagnostics"));
        }
        Ok(path)
    }
    fn completed_host_bytes(&self, handle: &str, completion: &Completion) -> Result<u64> {
        let directory = self.host_spool_path(handle)?;
        let diagnostic = directory.join("stderr");
        // Delivery ignores broken diagnostics. Accounting may shrink only
        // after their independent content/entry barriers succeed.
        let previous: i64 = self
            .connect()?
            .query_row(
                "SELECT bytes FROM host_spools WHERE handle=?1",
                [handle],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let previous = u64::try_from(previous).map_err(|_| reject("negative host spool charge"))?;
        let stderr = match fs::symlink_metadata(&diagnostic) {
            Ok(m) if m.is_file() => {
                if self.sync_host_spool_file(&diagnostic).is_ok()
                    && self.sync_host_spool_directory(&directory).is_ok()
                {
                    m.len()
                } else {
                    return Ok(previous.max(
                        completion
                            .stdout_length
                            .saturating_add(m.len().max(completion.stderr_length)),
                    ));
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound
                    && self.sync_host_spool_directory(&directory).is_ok() =>
            {
                0
            }
            _ => {
                return Ok(previous.max(
                    completion
                        .stdout_length
                        .saturating_add(completion.stderr_length),
                ))
            }
        };
        Ok(completion.stdout_length.saturating_add(stderr))
    }

    /// Destructor cleanup can abandon temporary capture, never a seal.
    /// Explicit delivery acknowledgement/settlement uses release_host_spool.
    pub(crate) fn abandon_unsealed_host_spool(&self, package: &str, handle: &str) -> Result<()> {
        let lease = self.lease(handle)?;
        if self
            .host_spool_path(handle)?
            .join("completed.json")
            .try_exists()?
            || !self.recorded_host_completions(handle)?.is_empty()
        {
            return Ok(());
        }
        // Release intent is published under the same writer exclusion used by
        // capture. Drop the lease only before the collector reacquires it.
        self.transaction(|tx| {
            tx.execute(
                "UPDATE host_spools SET status='released' WHERE handle=?1 AND package=?2",
                params![handle, package],
            )
            .map_err(sql)?;
            Ok(())
        })?;
        drop(lease);
        self.collect_host_spool(handle)
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

    /// Legacy SDK 2 handles name temporary replies; modern handles can still
    /// be released by a legacy replacement. Check durable ownership before
    /// resolving a path so either protocol can use the same release boundary.
    pub fn release_host_spool_if_present(&self, package: &str, handle: &str) -> Result<()> {
        if !identity(package) {
            return Err(reject("invalid host output owner"));
        }
        let exists: bool = self
            .connect()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM host_spools WHERE package=?1 AND handle=?2)",
                params![package, handle],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if exists {
            self.release_host_spool(package, handle)?;
        }
        Ok(())
    }

    /// An incompatible package contract releases standalone and abandoned
    /// replies even when package_operations is empty. A multi-service upgrade
    /// can retain a compatible admission: preserve only its original custody,
    /// including uncertain execution that released its execution slot.
    pub fn release_unretained_package_spools(&self, package: &str) -> Result<()> {
        if !identity(package) {
            return Err(reject("invalid host output owner"));
        }
        let conn = self.connect()?;
        let mut query = conn.prepare("SELECT h.handle FROM host_spools h WHERE h.package=?1 AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.admission IS NOT NULL AND (o.phase!='released' OR coalesce(json_extract(o.admission,'$.disposition'),'') NOT IN ('discarded','acquired','never_forwarded')) AND ((h.consumer=o.consumer AND h.operation=o.operation) OR EXISTS(SELECT 1 FROM host_spool_admissions s WHERE s.handle=h.handle AND s.consumer=o.consumer AND s.operation=o.operation)))").map_err(sql)?;
        let handles = query
            .query_map([package], |r| r.get::<_, String>(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        drop(query);
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
                    // Malformed diagnostics are still owned spool residue.
                    // remove_dir_all does not follow a symlink entry; links use
                    // unlink below. Never require diagnostics to be regular.
                    let removed = if entry.file_type()?.is_dir() {
                        fs::remove_dir_all(entry.path())
                    } else {
                        #[cfg(test)]
                        {
                            self.test_fs.unlink(&entry.path())
                        }
                        #[cfg(not(test))]
                        {
                            fs::remove_file(entry.path())
                        }
                    };
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
            tx.execute("DELETE FROM host_spool_admissions WHERE handle=?1 AND NOT EXISTS(SELECT 1 FROM host_spools WHERE handle=?1)", [handle]).map_err(sql)?;
            Ok(())
        })
    }

    pub fn sweep_host_spools(&self, live: impl Fn(&PackageGeneration) -> bool) -> Result<()> {
        // Upgrade compatibility/recovery candidates do not govern cleanup.
        // Reconstruct release intent for old hosts whose separate release
        // transaction was lost after a completed settlement.
        self.transaction(|tx| {
            let mut query = tx.prepare("SELECT DISTINCT s.consumer,s.operation FROM host_spool_admissions s JOIN operations o ON o.consumer=s.consumer AND o.operation=s.operation WHERE o.phase='released' AND json_extract(o.admission,'$.disposition') IN ('discarded','acquired') OR (o.exec_released=1 OR o.phase='released') AND EXISTS(SELECT 1 FROM provider_receipts r WHERE r.consumer=o.consumer AND r.operation=o.operation AND json_extract(r.status,'$.execution.state') IN ('failed','cancelled'))").map_err(sql)?;
            let removed = query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
            drop(query);
            for (consumer, operation) in removed { Self::release_operation_spools_in(tx, &consumer, &operation, true)?; }
            tx.execute("UPDATE host_spools SET status='released' WHERE consumer IS NOT NULL AND EXISTS(SELECT 1 FROM operations o WHERE o.consumer=host_spools.consumer AND o.operation=host_spools.operation AND (o.phase='released' AND json_extract(o.admission,'$.disposition')='discarded' OR o.exec_released=1 AND EXISTS(SELECT 1 FROM dismissed_operations d WHERE d.consumer=o.consumer AND d.operation=o.operation) AND EXISTS(SELECT 1 FROM provider_receipts r WHERE r.consumer=o.consumer AND r.operation=o.operation AND json_extract(r.status,'$.execution.state') IN ('failed','cancelled'))))", []).map_err(sql)?;
            Ok(())
        })?;
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
                    if c.status != 0 || c.stdout_length == 0 {
                        let disposable = self.transaction(|tx| {
                            tx.query_row("SELECT EXISTS(SELECT 1 FROM host_spool_admissions WHERE handle=?1) AND NOT EXISTS(SELECT 1 FROM host_spool_admissions s JOIN operations o ON o.consumer=s.consumer AND o.operation=s.operation WHERE s.handle=?1 AND o.phase!='released' AND o.exec_released=0)", [&handle], |r| r.get::<_,bool>(0)).map_err(sql)
                        })?;
                        if disposable {
                            drop(lease);
                            self.release_host_spool(&package, &handle)?;
                            continue;
                        }
                    }
                    if self.sync_complete_host_spool(&handle).is_err() {
                        continue;
                    }
                    self.transaction(|tx|{tx.execute("UPDATE host_spools SET status='sealed',bytes=?2,process_status=?3,completion=?4 WHERE handle=?1 AND status!='released'",params![handle,self.completed_host_bytes(&handle, &c)? as i64,c.status,encode(&c)?]).map_err(sql)?;Ok(())})?;
                }
                Ok(None) if state == "reserved" => {
                    // Even an unreadable or damaged seal is retained until an
                    // explicit settlement; absence of valid evidence is not
                    // permission to delete a published original.
                    if self
                        .host_spool_path(&handle)?
                        .join("completed.json")
                        .try_exists()?
                    {
                        continue;
                    }
                    match self.has_verified_host_stream(&handle) {
                        Ok(false) => (),
                        Ok(true) | Err(_) => continue,
                    }
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
