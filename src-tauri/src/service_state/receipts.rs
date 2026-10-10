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
            Ok(status)
        })
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
