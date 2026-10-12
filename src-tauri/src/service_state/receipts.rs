//! Durable monotonic provider observations. Receipt commitment precedes phase
//! reconciliation; equal retries can finish an interrupted local transition.
use super::{
    model::*,
    rules::*,
    store::{decode, encode, sql, Store},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, Weak},
};
type SuccessReceipts = HashMap<(String, String), Value>;
pub(super) type PendingSuccess = Arc<Mutex<SuccessReceipts>>;
/// Session witnesses are shared by handles of the same ledger (lifecycle
/// preflight opens a second handle), and expire with the last store handle.
pub(super) fn pending_success_for_root(root: &Path) -> Result<PendingSuccess> {
    static ROOTS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<SuccessReceipts>>>>> =
        LazyLock::new(Default::default);
    let mut roots = ROOTS
        .lock()
        .map_err(|_| reject("success recovery ownership is unavailable"))?;
    roots.retain(|_, value| value.strong_count() != 0);
    if let Some(existing) = roots.get(root).and_then(Weak::upgrade) {
        return Ok(existing);
    }
    let receipts = Arc::new(Mutex::new(HashMap::new()));
    roots.insert(root.to_path_buf(), Arc::downgrade(&receipts));
    Ok(receipts)
}
pub(super) const RECEIPT_SCHEMA: i64 = 0x5445_4931;
pub(super) const RECEIPT_TABLE: &str = "CREATE TABLE provider_receipts(consumer TEXT NOT NULL,operation TEXT NOT NULL,provider TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(consumer,operation)); PRAGMA application_id=1413826865;";
pub(super) const DISMISSAL_TABLE: &str = "CREATE TABLE IF NOT EXISTS dismissed_operations(consumer TEXT NOT NULL,operation TEXT NOT NULL,revision INTEGER NOT NULL,dismissed_at_ms INTEGER NOT NULL,PRIMARY KEY(consumer,operation)); CREATE TABLE IF NOT EXISTS consumer_removals(package TEXT PRIMARY KEY NOT NULL); CREATE TABLE IF NOT EXISTS retired_generations(package TEXT NOT NULL,digest TEXT NOT NULL,incarnation INTEGER NOT NULL,PRIMARY KEY(package,digest,incarnation)); CREATE TABLE IF NOT EXISTS removal_cancellations(consumer TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(consumer,operation)); CREATE TABLE IF NOT EXISTS preparation_replacements(consumer TEXT NOT NULL,operation TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(consumer,operation))";

fn preparation_job_live(job: &super::job::JobRecord) -> bool {
    !job.state.terminal()
        && !matches!(
            job.phase.as_deref(),
            Some("stopped" | "provider_result_discarded")
        )
}
fn retain_preparation_in(
    conn: &Connection,
    consumer: &str,
    operation: &str,
    replacement: &str,
) -> Result<()> {
    if !digest(replacement) {
        return Err(reject("invalid preparation replacement digest"));
    }
    conn.execute("INSERT INTO preparation_replacements(consumer,operation,digest)VALUES(?1,?2,?3)ON CONFLICT(consumer,operation)DO UPDATE SET digest=excluded.digest", params![consumer,operation,replacement]).map_err(sql)?;
    Ok(())
}

impl Store {
    /// Startup may open the ledger before forwarding a committed lifecycle
    /// journal. Presentation is durable evidence that an unfinished capture
    /// belongs to retained work; only dead-generation or explicit lifecycle
    /// policy may decide to release it.
    pub(super) fn live_preparation_job_in(
        &self,
        conn: &Connection,
        consumer: &str,
        operation: &str,
    ) -> Result<bool> {
        Ok(self.jobs_in(conn)?.iter().any(|job| {
            job.owner.package_id == consumer
                && job.operation_id == operation
                && preparation_job_live(job)
        }))
    }
    pub fn preparation_retained(&self, consumer: &str, operation: &str) -> Result<bool> {
        if !identity(consumer) || !identity(operation) {
            return Err(reject("invalid preparation identity"));
        }
        self.preparation_retained_in(&self.connect()?, consumer, operation)
    }
    pub(super) fn preparation_retained_in(
        &self,
        conn: &Connection,
        consumer: &str,
        operation: &str,
    ) -> Result<bool> {
        let granted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM preparation_replacements WHERE consumer=?1 AND operation=?2)",params![consumer,operation],|r|r.get(0)).map_err(sql)?;
        let stored_phase: Option<String> = conn
            .query_row(
                "SELECT phase FROM operations WHERE consumer=?1 AND operation=?2",
                params![consumer, operation],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        Ok(granted
            && stored_phase
                .as_deref()
                .is_none_or(|phase| phase == "reserved")
            && Self::record(conn, consumer, operation)?.is_none()
            && self.live_preparation_job_in(conn, consumer, operation)?)
    }
    /// Only a committed lifecycle decision can authorize a new generation to
    /// resume a preparation. The adoption is atomic with presentation, before
    /// the first paid admission; original descriptors and job IDs survive.
    pub fn adopt_preparation(&self, current: &PackageGeneration, operation: &str) -> Result<bool> {
        generation(current)?;
        if !identity(operation) {
            return Err(reject("invalid preparation identity"));
        }
        self.transaction(|tx| {
            let replacement: Option<String> = tx.query_row("SELECT digest FROM preparation_replacements WHERE consumer=?1 AND operation=?2",params![current.package_id,operation],|r|r.get(0)).optional().map_err(sql)?;
            if replacement.as_deref() != Some(&current.digest) || !self.preparation_retained_in(tx, &current.package_id, operation)? { return Ok(false); }
            Self::generation_admitted(tx, current)?;
            tx.execute("UPDATE operations SET owner=?3 WHERE consumer=?1 AND operation=?2 AND admission IS NULL AND phase='reserved'",params![current.package_id,operation,encode(current)?]).map_err(sql)?;
            self.adopt_preparation_job_in(tx, current, operation)?;
            Ok(true)
        })
    }
    pub fn list_releasable_preparations(&self) -> Result<Vec<PackageGeneration>> {
        let conn = self.connect()?;
        let mut owners = Vec::new();
        for (operation, owner) in self.preparation_rows()? {
            if !self.preparation_retained_in(&conn, &owner.package_id, &operation)?
                && !owners.contains(&owner)
            {
                owners.push(owner);
            }
        }
        Ok(owners)
    }
}
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_unstable();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonical(&object[key]));
            }
            Value::Object(sorted)
        }
        Value::Array(array) => Value::Array(array.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}
fn receipt_json(
    status: &Value,
    admission: &Admission,
    revision: u64,
) -> Result<(Value, String, String)> {
    let status = super::receipt::validate(status, admission)?;
    if status["revision"].as_u64() != Some(revision) {
        return Err(reject(
            "provider receipt revision does not match its observation",
        ));
    }
    let status = canonical(&status);
    let raw = encode(&status)?;
    if raw.len() > 16 * 1024 {
        return Err(reject("provider receipt exceeds metadata bound"));
    }
    let digest = hex::encode(Sha256::digest(raw.as_bytes()));
    Ok((status, raw, digest))
}
struct Observed {
    revision: u64,
    status: Value,
    digest: String,
}
fn observed(conn: &Connection, admission: &Admission) -> Result<Option<Observed>> {
    let row: Option<(String, i64, String, String)> = conn
        .query_row(
            "SELECT CASE WHEN length(CAST(provider AS BLOB))<=4096 THEN provider ELSE '' END,revision,CASE WHEN length(CAST(status AS BLOB))<=16384 THEN status ELSE '' END,CASE WHEN length(CAST(digest AS BLOB))<=64 THEN digest ELSE '' END FROM provider_receipts WHERE consumer=?1 AND operation=?2",
            params![admission.consumer.package_id, admission.operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(sql)?;
    let Some((provider, revision, raw, digest)) = row else {
        return Ok(None);
    };
    let provider: PackageGeneration = decode(&provider)?;
    if provider != admission.provider {
        return Err(reject(
            "provider receipt owner conflicts with its admission",
        ));
    }
    let revision =
        u64::try_from(revision).map_err(|_| reject("invalid durable provider receipt revision"))?;
    if raw.len() > 16 * 1024 {
        return Err(reject("provider receipt exceeds metadata bound"));
    }
    let (status, _, actual_digest) = receipt_json(&decode::<Value>(&raw)?, admission, revision)?;
    if actual_digest != digest {
        return Err(reject("durable provider receipt digest is corrupt"));
    }
    Ok(Some(Observed {
        revision,
        status,
        digest,
    }))
}
fn evidence(
    store: &Store,
    conn: &Connection,
    admission: &Admission,
    status: &Value,
    advance: bool,
) -> Result<()> {
    match status["delivery"]["state"].as_str() {
        Some("available") => {
            let descriptor: ArtifactDescriptor =
                serde_json::from_value(status["delivery"]["output"].clone())
                    .map_err(|_| reject("invalid provider output descriptor"))?;
            if admission
                .output
                .as_ref()
                .is_some_and(|output| output != &descriptor)
            {
                return Err(reject(
                    "provider output conflicts with the pinned operation output",
                ));
            }
            if admission.phase == AdmissionPhase::Released {
                // Historical observations may survive acknowledged byte GC;
                // a new available observation cannot restore a disposed output.
                if advance || admission.output.as_ref() != Some(&descriptor) {
                    return Err(reject("provider output has already been disposed"));
                }
            } else {
                store.exact_artifact(
                    conn,
                    &admission.consumer.package_id,
                    &admission.operation_id,
                    &descriptor,
                    "output",
                )?;
            }
        }
        Some("acquired") => {
            let receipt = status["delivery"]["transferReceipt"]
                .as_str()
                .ok_or_else(|| reject("invalid acquisition receipt"))?;
            Store::verify_acquisition_at(conn, admission, receipt)?;
        }
        _ => {}
    }
    Ok(())
}
impl Store {
    pub fn pending_success(&self, a: &Admission) -> Result<Option<Value>> {
        Ok(self
            .pending_success
            .lock()
            .map_err(|_| reject("success recovery ownership is unavailable"))?
            .get(&(a.consumer.package_id.clone(), a.operation_id.clone()))
            .cloned())
    }
    pub(super) fn pending_success_keys(&self) -> Result<Vec<(String, String)>> {
        Ok(self
            .pending_success
            .lock()
            .map_err(|_| reject("success recovery ownership is unavailable"))?
            .keys()
            .cloned()
            .collect())
    }
    pub fn success_known(&self, a: &Admission) -> Result<bool> {
        Ok(a.output.is_some()
            || self.pending_success(a)?.is_some()
            || self
                .provider_receipt(&a.consumer.package_id, &a.operation_id)?
                .is_some_and(|r| r["execution"]["state"] == "succeeded"))
    }
    pub fn retain_success(
        &self,
        provider: &PackageGeneration,
        a: &Admission,
        status: &Value,
    ) -> Result<()> {
        generation(provider)?;
        if !same_owner(&a.provider, provider) {
            return Err(reject("provider receipt owner does not match"));
        }
        if a.phase == AdmissionPhase::Released
            && a.disposition.as_deref() == Some("discarded")
            && matches!(
                status["delivery"]["state"].as_str(),
                Some("available" | "unavailable")
            )
        {
            return Err(reject("operation was explicitly discarded"));
        }
        let status = super::receipt::validate(status, a)?;
        if status["execution"]["state"] == "succeeded"
            && matches!(
                status["delivery"]["state"].as_str(),
                Some("available" | "unavailable")
            )
        {
            if status["delivery"]["state"] == "available" {
                let d: ArtifactDescriptor =
                    serde_json::from_value(status["delivery"]["output"].clone())
                        .map_err(|_| reject("invalid output descriptor"))?;
                if a.output.as_ref().is_some_and(|output| output != &d) {
                    return Err(reject("provider output conflicts with its pinned output"));
                }
                if let Ok(conn) = self.connect() {
                    let artifact:Option<(String,Option<String>)>=conn.query_row(
                        "SELECT status,descriptor FROM artifacts WHERE handle=?1 AND consumer=?2 AND operation=?3 AND kind='output'",
                        params![d.handle,a.consumer.package_id,a.operation_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
                    if artifact.is_none_or(|(state, raw)| {
                        state == "sealed"
                            && raw
                                .and_then(|r| decode::<ArtifactDescriptor>(&r).ok())
                                .as_ref()
                                != Some(&d)
                    }) {
                        return Err(reject(
                            "artifact descriptor or ownership does not match durable metadata",
                        ));
                    }
                }
            }
            if let Ok(Some(previous)) =
                self.provider_receipt(&a.consumer.package_id, &a.operation_id)
            {
                if status["revision"].as_u64() < previous["revision"].as_u64() {
                    return Ok(());
                }
                if status["revision"] == previous["revision"] {
                    if status != previous {
                        return Err(reject("provider receipt conflicts at the same revision"));
                    }
                    return Ok(());
                }
                super::receipt::validate_transition(&previous, &status)?;
            }
            self.remember_success(a, &status)?;
        }
        Ok(())
    }
    fn remember_success(&self, a: &Admission, status: &Value) -> Result<()> {
        let mut pending = self
            .pending_success
            .lock()
            .map_err(|_| reject("success recovery ownership is unavailable"))?;
        let key = (a.consumer.package_id.clone(), a.operation_id.clone());
        if let Some(previous) = pending.get(&key) {
            if status["revision"].as_u64() < previous["revision"].as_u64() {
                return Err(reject("provider observation predates its retained success"));
            }
            if status["revision"] == previous["revision"] {
                if status != previous {
                    return Err(reject("provider success conflicts at the same revision"));
                }
            } else {
                super::receipt::validate_transition(previous, status)?;
            }
        }
        if a.phase != AdmissionPhase::Released
            && status["execution"]["state"] == "succeeded"
            && matches!(
                status["delivery"]["state"].as_str(),
                Some("available" | "unavailable")
            )
        {
            pending.insert(key, status.clone());
        }
        Ok(())
    }
    fn forget_success(&self, consumer: &str, operation: &str) -> Result<()> {
        self.pending_success
            .lock()
            .map_err(|_| reject("success recovery ownership is unavailable"))?
            .remove(&(consumer.into(), operation.into()));
        Ok(())
    }
    pub fn queue_removal_cancellations(&self, admissions: &[Admission]) -> Result<()> {
        self.transaction(|tx| {
            for a in admissions {
                tx.execute(
                    "INSERT OR IGNORE INTO removal_cancellations(consumer,operation)VALUES(?1,?2)",
                    params![a.consumer.package_id, a.operation_id],
                )
                .map_err(sql)?;
            }
            Ok(())
        })
    }
    pub fn pending_removal_cancellations(&self) -> Result<Vec<Admission>> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT consumer,operation FROM removal_cancellations")
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        rows.into_iter()
            .map(|(consumer, op)| {
                Self::record(&conn, &consumer, &op)?
                    .ok_or_else(|| reject("cancellation admission disappeared"))
            })
            .collect()
    }
    pub fn finish_removal_cancellation(&self, a: &Admission) -> Result<()> {
        self.transaction(|tx| {
            tx.execute(
                "DELETE FROM removal_cancellations WHERE consumer=?1 AND operation=?2",
                params![a.consumer.package_id, a.operation_id],
            )
            .map_err(sql)?;
            Ok(())
        })
    }
    pub fn prepare_consumer_removal(&self, package: &str) -> Result<()> {
        if !identity(package) {
            return Err(reject("invalid consumer package"));
        }
        self.transaction(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO consumer_removals(package)VALUES(?1)",
                [package],
            )
            .map_err(sql)?;
            Ok(())
        })
    }
    pub fn pending_consumer_removals(&self) -> Result<Vec<String>> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT package FROM consumer_removals")
            .map_err(sql)?;
        let removals = query
            .query_map([], |r| r.get(0))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        Ok(removals)
    }
    pub fn finish_consumer_removal(&self, package: &str) -> Result<()> {
        self.transaction(|tx| {
            tx.execute("DELETE FROM consumer_removals WHERE package=?1", [package])
                .map_err(sql)?;
            Ok(())
        })
    }
    /// An old settlement marker may predate provider reconciliation. Startup
    /// rechecks uncertain outcomes without revoking the no-replay fence.
    pub fn revisit_uncertain_settlements(&self) -> Result<()> {
        self.transaction(|tx| {
            tx.execute("DELETE FROM dismissed_operations WHERE EXISTS(SELECT 1 FROM operations o LEFT JOIN provider_receipts r ON r.consumer=o.consumer AND r.operation=o.operation WHERE o.consumer=dismissed_operations.consumer AND o.operation=dismissed_operations.operation AND o.phase NOT IN('released','reserved') AND coalesce(json_extract(r.status,'$.execution.state'),'unconfirmed') NOT IN('failed','cancelled'))", []).map_err(sql)?;
            Ok(())
        })
    }
    /// The common custody boundary for explicit removal and incompatible
    /// replacement. Enumerate the ledger, never claims(): settled and acquired
    /// admissions, preparations and presentation-only jobs are all included.
    pub fn abandon_package_outputs(&self, package: &str) -> Result<Vec<super::job::JobRecord>> {
        self.abandon_package_operations(package, |_| false)
    }
    pub fn abandon_package_operations(
        &self,
        package: &str,
        retain: impl Fn(&Admission) -> bool,
    ) -> Result<Vec<super::job::JobRecord>> {
        let jobs = self.abandon_package_operations_deferred(package, retain)?;
        self.gc()?;
        self.sweep_host_spools(|_| true)?;
        Ok(jobs)
    }
    pub fn abandon_package_operations_deferred(
        &self,
        package: &str,
        retain: impl Fn(&Admission) -> bool,
    ) -> Result<Vec<super::job::JobRecord>> {
        self.abandon_package_work_deferred(package, retain, |_, _| None)
    }
    /// Retention includes captured preparations and presentation-only jobs.
    /// The replacement digest is a durable authorization to adopt unadmitted
    /// work; admitted identities remain pinned and are never rewritten.
    pub fn abandon_package_work_deferred(
        &self,
        package: &str,
        retain: impl Fn(&Admission) -> bool,
        retain_preparation: impl Fn(&PackageGeneration, &super::job::JobRecord) -> Option<String>,
    ) -> Result<Vec<super::job::JobRecord>> {
        if !identity(package) {
            return Err(reject("invalid package"));
        }
        let (jobs, abandoned) = self.transaction(|tx| {
            let mut query = tx.prepare("SELECT consumer,operation FROM operations").map_err(sql)?;
            let rows = query.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
                .map_err(sql)?.collect::<std::result::Result<Vec<_>,_>>().map_err(sql)?;
            drop(query);
            // Artifact rows retain their own package/preparation custody even
            // when an interrupted recapture deleted its operation record.
            tx.execute("UPDATE artifacts SET status='released' WHERE consumer=?1 AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.consumer=artifacts.consumer AND o.operation=artifacts.operation)", [package]).map_err(sql)?;
            let mut jobs = Vec::new();
            let mut abandoned = Vec::new();
            let mut retained = std::collections::HashSet::new();
            let original_jobs = self.jobs_in(tx)?;
            for (consumer, op) in rows {
                let admission = Self::record(tx, &consumer, &op)?;
                let affected = admission.as_ref().map_or(consumer == package, |a| a.consumer.package_id == package || a.provider.package_id == package);
                if !affected { continue; }
                let preparation_digest = if admission.is_none() {
                    Self::preparation_owner(tx, &consumer, &op)?
                        .and_then(|owner| original_jobs.iter().find(|job| same_owner(&job.owner, &owner) && job.operation_id == op)
                            .filter(|job| preparation_job_live(job))
                            .and_then(|job| retain_preparation(&owner, job)))
                } else { None };
                if let Some(replacement) = &preparation_digest {
                    retain_preparation_in(tx, &consumer, &op, replacement)?;
                }
                if admission.as_ref().is_some_and(&retain) || preparation_digest.is_some() {
                    // A new compatible participant must inspect all retained
                    // phases again this session. Keep execution fenced against
                    // replay while revoking only the old idle presentation.
                    tx.execute("DELETE FROM dismissed_operations WHERE consumer=?1 AND operation=?2",params![consumer,op]).map_err(sql)?;
                    retained.insert((consumer, op));
                    continue;
                }
                if let Some(mut a) = admission {
                    let success = a.output.is_some() || self.pending_success(&a)?.is_some()
                        || self.has_removal_host_image_at(tx, &consumer, &op).unwrap_or_else(|cause| {
                            // Reading a potential original cannot veto explicit
                            // removal. Report possible delivery loss and commit
                            // custody release; collection can unlink unreadable
                            // files or retain its charge while retrying failures.
                            log::warn!("Removed host output could not be inspected: {cause}");
                            true
                        })
                        || tx.query_row("SELECT EXISTS(SELECT 1 FROM artifacts WHERE consumer=?1 AND operation=?2 AND kind='output' AND status='sealed')", params![consumer,op], |r| r.get::<_,bool>(0)).map_err(sql)?
                        || Self::provider_receipt_at(tx, &a)?.is_some_and(|r| r["execution"]["state"] == "succeeded");
                    let undelivered = success && a.disposition.as_deref() != Some("acquired")
                        && a.disposition.as_deref() != Some("discarded");
                    if a.phase != AdmissionPhase::Released {
                        if let Some(receipt) = Self::provider_receipt_at(tx, &a)? {
                            if receipt["delivery"]["state"] == "available" {
                                a.output = Some(serde_json::from_value(receipt["delivery"]["output"].clone()).map_err(|_|reject("invalid output descriptor"))?);
                            }
                        }
                        a.phase = AdmissionPhase::Released;
                        a.disposition = Some("discarded".into());
                        a.transfer_receipt = None;
                        a.needs_attention = false;
                        Self::persist(tx, &a)?;
                    }
                    if undelivered {
                        if let Some(job) = self.report_undelivered_in(tx, &a, package)? { jobs.push(job); }
                    }
                } else {
                    tx.execute("UPDATE operations SET phase='released' WHERE consumer=?1 AND operation=?2",params![consumer,op]).map_err(sql)?;
                }
                // Custody ends in this commit. The durable artifact row keeps
                // charging pending collection until the files are gone.
                tx.execute("UPDATE artifacts SET status='released' WHERE consumer=?1 AND operation=?2",params![consumer,op]).map_err(sql)?;
                Self::release_operation_spools_in(tx, &consumer, &op, true)?;
                tx.execute("UPDATE operations SET exec_released=0 WHERE consumer=?1 AND operation=?2",params![consumer,op]).map_err(sql)?;
                tx.execute("DELETE FROM dismissed_operations WHERE consumer=?1 AND operation=?2",params![consumer,op]).map_err(sql)?;
                tx.execute("DELETE FROM preparation_replacements WHERE consumer=?1 AND operation=?2",params![consumer,op]).map_err(sql)?;
                if let Some(job) = self.cancel_removed_job_in(tx, &consumer, &op)? { jobs.push(job); }
                abandoned.push((consumer, op));
            }
            for job in self.jobs_in(tx)? {
                if job.owner.package_id == package && !retained.contains(&(package.to_owned(),job.operation_id.clone())) {
                    // Production registers presentation before capture. Keep
                    // compatible jobs even when the first capture has not run.
                    if preparation_job_live(&job) && Self::record(tx, package, &job.operation_id)?.is_none() {
                        if let Some(replacement) = retain_preparation(&job.owner, &job) {
                            retain_preparation_in(tx, package, &job.operation_id, &replacement)?;
                            continue;
                        }
                    }
                    tx.execute("DELETE FROM preparation_replacements WHERE consumer=?1 AND operation=?2",params![package,job.operation_id]).map_err(sql)?;
                    if let Some(job) = self.cancel_removed_job_in(tx, package, &job.operation_id)? { jobs.push(job); }
                }
            }
            Ok((jobs, abandoned))
        })?;
        for (consumer, op) in abandoned {
            self.forget_success(&consumer, &op)?;
        }
        Ok(jobs)
    }
    pub(super) fn provider_receipt_at(
        conn: &Connection,
        admission: &Admission,
    ) -> Result<Option<Value>> {
        Ok(observed(conn, admission)?.map(|receipt| receipt.status))
    }
    pub fn provider_receipt(&self, consumer: &str, operation: &str) -> Result<Option<Value>> {
        let conn = self.connect()?;
        let Some(a) = Self::record(&conn, consumer, operation)? else {
            return Ok(None);
        };
        Ok(observed(&conn, &a)?.map(|receipt| receipt.status))
    }
    pub fn observe_receipt(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        revision: u64,
        status: Value,
    ) -> Result<Value> {
        generation(provider)?;
        let admission = self.verify_provider(provider, consumer, op)?;
        self.retain_success(provider, &admission, &status)?;
        let result = self.transaction(|tx| {
            let admission = Self::record(tx,consumer,op)?.ok_or_else(||reject("provider receipt has no admitted operation"))?;
            if !same_owner(&admission.provider,provider) {return Err(reject("provider receipt owner does not match"));}
            let (status, raw, digest) = receipt_json(&status,&admission,revision)?;
            if let Some(old) = observed(tx,&admission)? {
                if revision < old.revision {return Ok(old.status);}
                if revision == old.revision {
                    if digest != old.digest {return Err(reject("provider receipt conflicts at the same revision"));}
                    return Ok(old.status);
                }
                super::receipt::validate_transition(&old.status, &status)?;
            }
            // Capture custody before artifact validation or the receipt commit
            // can fail. The existing recovery loop retries this exact answer.
            self.remember_success(&admission, &status)?;
            self.checkpoint("receipt-success-witness")?;
            evidence(self, tx, &admission, &status, true)?;
            tx.execute("INSERT INTO provider_receipts(consumer,operation,provider,revision,status,digest)VALUES(?1,?2,?3,?4,?5,?6)ON CONFLICT(consumer,operation)DO UPDATE SET revision=excluded.revision,status=excluded.status,digest=excluded.digest", params![consumer,op,encode(&admission.provider)?,revision as i64,raw,digest]).map_err(sql)?;
            if status["execution"]["state"] == "succeeded" && admission.phase != AdmissionPhase::Released {
                let mut recovered=admission.clone();
                transition(recovered.phase,AdmissionPhase::Terminal)?;
                recovered.phase=AdmissionPhase::Terminal;
                if status["delivery"]["state"] == "available" {
                    recovered.output=Some(serde_json::from_value(status["delivery"]["output"].clone()).map_err(|_|reject("invalid provider output descriptor"))?);
                }
                recovered.needs_attention=false;
                Self::persist(tx,&recovered)?;
            }
            let released: bool = tx.query_row("SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2", params![consumer, op], |r| r.get(0)).map_err(sql)?;
            if released && status["execution"]["state"] == "succeeded" {
                // Publication and settlement serialize on the same IMMEDIATE
                // transaction. New evidence revokes the old idle disposition;
                // a late success owns recovery before any publisher can crash.
                // Cached Accepted/Running or terminal failure observations do
                // not introduce live work or revoke the original idle fence.
                tx.execute("UPDATE operations SET exec_released=0 WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
                tx.execute("DELETE FROM dismissed_operations WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
            } else if released && !(admission.phase == AdmissionPhase::Terminal && admission.needs_attention) {
                tx.execute("UPDATE dismissed_operations SET revision=?3 WHERE consumer=?1 AND operation=?2", params![consumer, op, revision as i64]).map_err(sql)?;
            }
            Ok(status)
        });
        if result.is_ok() {
            self.checkpoint("receipt-ledger")?;
        }
        if let Ok(status) = &result {
            let mut pending = self
                .pending_success
                .lock()
                .map_err(|_| reject("success recovery ownership is unavailable"))?;
            let key = (consumer.to_owned(), op.to_owned());
            if pending.get(&key).is_some_and(|witness| {
                status["execution"]["state"] == "succeeded"
                    && status["revision"].as_u64() >= witness["revision"].as_u64()
            }) {
                pending.remove(&key);
            }
        }
        result
    }
    /// Records the user's acceptance of an unknown outcome. Receipts, evidence
    /// and the admission are untouched; only a marker pinned to the current
    /// receipt revision is added, so newer provider evidence resurfaces the
    /// operation. A presentation job still parked by the earlier stop is
    /// settled in the same transaction.
    pub fn dismiss_operation(
        &self,
        consumer: &str,
        op: &str,
    ) -> Result<Option<super::job::JobRecord>> {
        self.transaction(|tx| {
            let a = Self::record(tx, consumer, op)?
                .ok_or_else(|| reject("operation is not admitted"))?;
            let stopped: i64 = tx
                .query_row(
                    "SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2",
                    params![consumer, op],
                    |r| r.get(0),
                )
                .map_err(sql)?;
            let receipt = observed(tx, &a)?;
            let state = |side: &str| {
                receipt
                    .as_ref()
                    .and_then(|r| r.status[side]["state"].as_str())
                    .map(str::to_owned)
            };
            let (execution, delivery) = (state("execution"), state("delivery"));
            if a.phase == AdmissionPhase::Released
                || !super::receipt::dismissable(
                    stopped == 1,
                    execution.as_deref().unwrap_or(""),
                    delivery.as_deref().unwrap_or(""),
                )
            {
                return Err(reject(
                    "only a stopped operation with unknown execution and no retained output can be dismissed",
                ));
            }
            let revision = receipt.map_or(0, |r| r.revision);
            tx.execute(
                "INSERT INTO dismissed_operations(consumer,operation,revision,dismissed_at_ms)VALUES(?1,?2,?3,CAST(strftime('%s','now') AS INTEGER)*1000)ON CONFLICT(consumer,operation)DO UPDATE SET revision=excluded.revision,dismissed_at_ms=excluded.dismissed_at_ms",
                params![consumer, op, revision as i64],
            )
            .map_err(sql)?;
            self.settle_dismissed_job_in(tx, consumer, op, None)
        })
    }
    /// Host-only settlement after both workers are proven idle. The receipt
    /// stays provider-owned; releasing execution fences every future start.
    pub fn auto_settle_operation(
        &self,
        consumer: &str,
        op: &str,
        no_live_worker: bool,
    ) -> Result<Option<super::job::JobRecord>> {
        if !no_live_worker {
            return Err(reject(
                "automatic settlement requires idle workers and no recoverable output",
            ));
        }
        let reservation = self.idle_output_reservation(consumer, op)?;
        let settled = self.transaction(|tx| {
            let a = Self::record(tx, consumer, op)?.ok_or_else(|| reject("operation is not admitted"))?;
            let receipt = observed(tx, &a)?;
            let status = receipt.as_ref().map(|r| &r.status);
            let execution = status.and_then(|r| r["execution"]["state"].as_str()).unwrap_or("unconfirmed");
            let delivery = status.and_then(|r| r["delivery"]["state"].as_str()).unwrap_or("none");
            if self.pending_success(&a)?.is_some() || self.retained_output_at(tx, consumer, op)? || super::receipt::auto_settlement(a.phase, execution, delivery, !no_live_worker) != super::receipt::AutoSettlement::Settle || a.output.is_some() && !(a.phase == AdmissionPhase::Released && a.disposition.as_deref() == Some("discarded")) {
                return Err(reject("automatic settlement requires idle workers and no recoverable output"));
            }
            tx.execute("UPDATE operations SET exec_released=1 WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
            Self::release_operation_spools_in(tx, consumer, op, false)?;
            // Inactive no-output operations cannot need their captured inputs
            // again: Unknown is fenced against replay. Keep descriptors in the
            // admission as evidence, but retire custody and capacity atomically.
            tx.execute("UPDATE artifacts SET status='released' WHERE consumer=?1 AND operation=?2 AND kind='input'", params![consumer, op]).map_err(sql)?;
            // The artifact identity is forensic evidence; an empty reservation
            // is capacity, not evidence. Preserve sealed/staged original bytes.
            if let Some((handle, bytes, _)) = &reservation {
                tx.execute("UPDATE artifacts SET bytes=?4 WHERE handle=?1 AND consumer=?2 AND operation=?3", params![handle, consumer, op, *bytes as i64]).map_err(sql)?;
            }
            tx.execute("INSERT INTO dismissed_operations(consumer,operation,revision,dismissed_at_ms)VALUES(?1,?2,?3,CAST(strftime('%s','now') AS INTEGER)*1000)ON CONFLICT(consumer,operation)DO UPDATE SET revision=excluded.revision,dismissed_at_ms=excluded.dismissed_at_ms", params![consumer, op, receipt.as_ref().map_or(0, |r| r.revision) as i64]).map_err(sql)?;
            self.settle_dismissed_job_in(tx, consumer, op, status.and_then(|r| r["execution"]["error"]["message"].as_str()))
        })?;
        drop(reservation);
        if let Err(error) = self.sweep_host_spools(|_| true) {
            log::warn!("settled host output sweep deferred: {error}");
        }
        if let Err(error) = self.gc() {
            log::warn!("settled artifact sweep deferred: {error}");
        }
        Ok(settled)
    }
    pub(super) fn validate_execution_releases(&self) -> Result<()> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare(
                "SELECT consumer,operation,exec_released FROM operations WHERE exec_released!=0",
            )
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(sql)?;
        for row in rows {
            let (consumer, op, flag) = row.map_err(sql)?;
            let a = Self::record(&conn, &consumer, &op)?
                .ok_or_else(|| reject("invalid retained execution claim"))?;
            if flag != 1 {
                return Err(reject("invalid retained execution claim"));
            }
            let receipt = observed(&conn, &a)?;
            // A second handle can reopen while the first owns unpaid original
            // IO. Keep its full reservation and input custody until that
            // writer finishes; a no-replay fence does not prove IO inactivity.
            if self.original_writer_active(&consumer, &op)? {
                continue;
            }
            // Execution release is a durable no-replay fence. Presentation
            // dismissal is independent: replacement or startup may re-arm
            // inspection by removing that marker without revoking this fence.
            let status = receipt.as_ref().map(|r| &r.status);
            let idle_success = status.is_some_and(|r| {
                r["execution"]["state"] == "succeeded" && r["delivery"]["state"] == "unavailable"
            });
            if !idle_success
                && (a.output.is_some() && a.phase != AdmissionPhase::Released
                    || super::receipt::auto_settlement(
                        a.phase,
                        status
                            .and_then(|r| r["execution"]["state"].as_str())
                            .unwrap_or("unconfirmed"),
                        status
                            .and_then(|r| r["delivery"]["state"].as_str())
                            .unwrap_or("none"),
                        false,
                    ) != super::receipt::AutoSettlement::Settle)
            {
                // Older hosts could publish valid newer evidence after an idle
                // settlement without revoking its flag. Retain and restore the
                // claim instead of making the entire service store unopenable.
                self.transaction(|tx| {
                    tx.execute(
                        "UPDATE operations SET exec_released=0 WHERE consumer=?1 AND operation=?2",
                        params![consumer, op],
                    )
                    .map_err(sql)?;
                    tx.execute(
                        "DELETE FROM dismissed_operations WHERE consumer=?1 AND operation=?2",
                        params![consumer, op],
                    )
                    .map_err(sql)?;
                    Ok(())
                })?;
            } else {
                let reservation = match self.idle_output_reservation(&consumer, &op) {
                    Ok(reservation) => reservation,
                    Err(error) => {
                        // An unfinished physical cleanup cannot veto opening
                        // the ledger or a user's lifecycle decision. Keep its
                        // conservative charge until a later durable sweep.
                        log::warn!("inactive reservation reconciliation deferred: {error}");
                        continue;
                    }
                };
                self.transaction(|tx| {
                    tx.execute("UPDATE artifacts SET status='released' WHERE consumer=?1 AND operation=?2 AND kind='input'", params![consumer, op]).map_err(sql)?;
                    if let Some((handle, bytes, _)) = &reservation {
                        tx.execute(
                            "UPDATE artifacts SET bytes=?2 WHERE handle=?1",
                            params![handle, *bytes as i64],
                        )
                        .map_err(sql)?;
                    }
                    Ok(())
                })?;
            }
        }
        Ok(())
    }
    pub(super) fn validate_receipts(&self) -> Result<()> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT consumer,operation FROM provider_receipts")
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?;
        for row in rows {
            let (consumer, op) = row.map_err(sql)?;
            let admission = Self::record(&conn, &consumer, &op)?
                .ok_or_else(|| reject("durable provider receipt has no admission"))?;
            let receipt = observed(&conn, &admission)?
                .ok_or_else(|| reject("durable provider receipt disappeared"))?;
            evidence(self, &conn, &admission, &receipt.status, false)?;
        }
        Ok(())
    }
}
