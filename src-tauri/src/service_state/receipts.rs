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
pub(super) const RECEIPT_SCHEMA: i64 = 0x5445_4931;
pub(super) const RECEIPT_TABLE: &str = "CREATE TABLE provider_receipts(consumer TEXT NOT NULL,operation TEXT NOT NULL,provider TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(consumer,operation)); PRAGMA application_id=1413826865;";
pub(super) const DISMISSAL_TABLE: &str = "CREATE TABLE IF NOT EXISTS dismissed_operations(consumer TEXT NOT NULL,operation TEXT NOT NULL,revision INTEGER NOT NULL,dismissed_at_ms INTEGER NOT NULL,PRIMARY KEY(consumer,operation))";
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
        self.transaction(|tx| {
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
            evidence(self, tx, &admission, &status, true)?;
            tx.execute("INSERT INTO provider_receipts(consumer,operation,provider,revision,status,digest)VALUES(?1,?2,?3,?4,?5,?6)ON CONFLICT(consumer,operation)DO UPDATE SET revision=excluded.revision,status=excluded.status,digest=excluded.digest", params![consumer,op,encode(&admission.provider)?,revision as i64,raw,digest]).map_err(sql)?;
            let released: bool = tx.query_row("SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2", params![consumer, op], |r| r.get(0)).map_err(sql)?;
            if released && status["execution"]["state"] != "unknown" {
                // Publication and settlement serialize on the same IMMEDIATE
                // transaction. New evidence revokes the old idle disposition;
                // a late success owns recovery before any publisher can crash.
                tx.execute("UPDATE operations SET exec_released=0 WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
                tx.execute("DELETE FROM dismissed_operations WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
                if matches!(status["execution"]["state"].as_str(), Some("accepted" | "running" | "succeeded")) && admission.phase != AdmissionPhase::Released {
                    tx.execute("UPDATE artifacts SET bytes=?3 WHERE consumer=?1 AND operation=?2 AND kind='output' AND status IN ('reserved','staged')", params![consumer, op, 100 * 1024 * 1024i64]).map_err(sql)?;
                }
                if status["delivery"]["state"] == "available" && admission.phase != AdmissionPhase::Released {
                    let mut recovered = admission.clone();
                    transition(recovered.phase, AdmissionPhase::Terminal)?;
                    recovered.phase = AdmissionPhase::Terminal;
                    recovered.output = Some(serde_json::from_value(status["delivery"]["output"].clone()).map_err(|_| reject("invalid provider output descriptor"))?);
                    recovered.needs_attention = false;
                    Self::persist(tx, &recovered)?;
                }
            } else if released && !(admission.phase == AdmissionPhase::Terminal && admission.needs_attention) {
                tx.execute("UPDATE dismissed_operations SET revision=?3 WHERE consumer=?1 AND operation=?2", params![consumer, op, revision as i64]).map_err(sql)?;
            }
            Ok(status)
        })
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
        self.transaction(|tx| {
            let a = Self::record(tx, consumer, op)?.ok_or_else(|| reject("operation is not admitted"))?;
            let receipt = observed(tx, &a)?;
            let status = receipt.as_ref().map(|r| &r.status);
            let execution = status.and_then(|r| r["execution"]["state"].as_str()).unwrap_or("unconfirmed");
            let delivery = status.and_then(|r| r["delivery"]["state"].as_str()).unwrap_or("none");
            if super::receipt::auto_settlement(a.phase, execution, delivery, !no_live_worker) != super::receipt::AutoSettlement::Settle || a.output.is_some() && !(a.phase == AdmissionPhase::Released && a.disposition.as_deref() == Some("discarded")) {
                return Err(reject("automatic settlement requires idle workers and no recoverable output"));
            }
            tx.execute("UPDATE operations SET exec_released=1 WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
            // The artifact identity is forensic evidence; an empty reservation
            // is capacity, not evidence. Preserve sealed/staged original bytes.
            if let Some((handle, bytes, _)) = &reservation {
                tx.execute("UPDATE artifacts SET bytes=?4 WHERE handle=?1 AND consumer=?2 AND operation=?3", params![handle, consumer, op, *bytes as i64]).map_err(sql)?;
            }
            tx.execute("INSERT INTO dismissed_operations(consumer,operation,revision,dismissed_at_ms)VALUES(?1,?2,?3,CAST(strftime('%s','now') AS INTEGER)*1000)ON CONFLICT(consumer,operation)DO UPDATE SET revision=excluded.revision,dismissed_at_ms=excluded.dismissed_at_ms", params![consumer, op, receipt.as_ref().map_or(0, |r| r.revision) as i64]).map_err(sql)?;
            self.settle_dismissed_job_in(tx, consumer, op, status.and_then(|r| r["execution"]["error"]["message"].as_str()))
        })
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
            if a.phase == AdmissionPhase::Terminal && a.needs_attention && a.output.is_none() {
                let reservation = self.idle_output_reservation(&consumer, &op)?;
                self.transaction(|tx| {
                    if let Some((handle, bytes, _)) = &reservation {
                        tx.execute(
                            "UPDATE artifacts SET bytes=?2 WHERE handle=?1",
                            params![handle, *bytes as i64],
                        )
                        .map_err(sql)?;
                    }
                    Ok(())
                })?;
                continue;
            }
            // Legacy Stop is unchanged. Other idle settlements require their
            // transaction's marker and a policy-compatible provider receipt.
            let receipt = observed(&conn, &a)?;
            let status = receipt.as_ref().map(|r| &r.status);
            let revision = receipt.as_ref().map_or(0, |r| r.revision);
            if a.output.is_some() && a.phase != AdmissionPhase::Released
                || self.dismissed_revision(&consumer, &op)? != Some(revision)
                || super::receipt::auto_settlement(
                    a.phase,
                    status
                        .and_then(|r| r["execution"]["state"].as_str())
                        .unwrap_or("unconfirmed"),
                    status
                        .and_then(|r| r["delivery"]["state"].as_str())
                        .unwrap_or("none"),
                    false,
                ) != super::receipt::AutoSettlement::Settle
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
                    if status.is_some_and(|r| matches!(r["execution"]["state"].as_str(), Some("accepted" | "running" | "succeeded"))) && a.phase != AdmissionPhase::Released {
                        tx.execute("UPDATE artifacts SET bytes=?3 WHERE consumer=?1 AND operation=?2 AND kind='output' AND status IN ('reserved','staged')", params![consumer, op, 100 * 1024 * 1024i64]).map_err(sql)?;
                    }
                    Ok(())
                })?;
            } else {
                let reservation = self.idle_output_reservation(&consumer, &op)?;
                self.transaction(|tx| {
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
