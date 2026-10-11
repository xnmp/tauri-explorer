//! Host-owned job presentation. Receipts and artifact custody stay in their own ledgers.
use super::{
    job::{JobRecord, JobSnapshot, JobState},
    model::PackageGeneration,
    rules::{generation, identity, reject, Result},
    store::{decode, encode, sql, Store},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

pub(super) const JOB_SCHEMA: i64 = 0x5445_4933;
pub(super) const JOB_TABLE: &str = "ALTER TABLE operations ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0; CREATE TABLE presentation_jobs(key TEXT PRIMARY KEY NOT NULL,owner TEXT NOT NULL,operation TEXT NOT NULL,job_id INTEGER NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,UNIQUE(owner,operation),UNIQUE(job_id)); CREATE TABLE presentation_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL); INSERT INTO presentation_sequence(singleton,revision)VALUES(1,0); PRAGMA application_id=1413826867;";
const SAFE: u64 = 9_007_199_254_740_991;
const MAX_RECORD: usize = 16 * 1024;
const MAX_ACTIVE: usize = 128;
const MAX_TERMINAL: usize = 256;
const ROWS: &str = "SELECT CASE WHEN length(CAST(key AS BLOB))<=48 THEN key ELSE NULL END,CASE WHEN length(CAST(owner AS BLOB))<=256 THEN owner ELSE NULL END,CASE WHEN length(CAST(operation AS BLOB))<=128 THEN operation ELSE NULL END,job_id,revision,CASE WHEN length(CAST(record AS BLOB))<=16384 THEN record ELSE NULL END FROM presentation_jobs";

/// Presentation the host already settled by explicit user action: a stopped
/// recovery (no live worker was proven) or a discarded provider result. The
/// operation ledger keeps its execution evidence; this row is presentation
/// only, so it is dismissable and never holds active capacity.
fn parked(record: &JobRecord) -> bool {
    record.state == JobState::NeedsAttention
        && matches!(
            record.phase.as_deref(),
            Some("stopped" | "provider_result_discarded")
        )
}
/// Retained presentation: terminal or parked. Only the rest is active work.
fn retained(record: &JobRecord) -> bool {
    record.state.terminal() || parked(record)
}
fn opaque(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn key(value: &str) -> bool {
    value.len() == 48
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn text(value: &str, bytes: usize) -> bool {
    !value.is_empty() && value.len() <= bytes && !value.chars().any(char::is_control)
}
fn valid(record: &JobRecord, registering: bool) -> Result<()> {
    generation(&record.owner)?;
    if record.source_revision > SAFE {
        return Err(reject("invalid consumer job revision"));
    }
    if !key(&record.job_key)
        || !opaque(&record.operation_id)
        || !opaque(&record.kind)
        || record.owner.incarnation > SAFE
        || record.job_id == 0
        || record.job_id > SAFE
        || record.created_at_ms > SAFE
        || record.updated_at_ms > SAFE
        || record.label.is_empty()
        || record.label.chars().count() > 256
        || record.label.chars().any(char::is_control)
        || record.origin_window.is_empty()
        || record.origin_window.len() > 128
        || !record.origin_window.bytes().all(|b| b.is_ascii_graphic())
        || record.phase.as_ref().is_some_and(|s| !text(s, 128))
        || record.error.as_ref().is_some_and(|s| !text(s, 2048))
        || record
            .output_path
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 4096 || s.contains('\0'))
        || record.run_id.is_some_and(|n| n <= 0 || n as u64 > SAFE)
        || if registering {
            record.revision != 0
                || record.state != JobState::Accepting
                || record.output_path.is_some()
                || record.run_id.is_some()
                || record.error.is_some()
        } else {
            record.revision == 0 || record.revision > SAFE
        }
    {
        return Err(reject("invalid durable job metadata"));
    }
    Ok(())
}
fn serialized(record: &JobRecord) -> Result<String> {
    let value = encode(record)?;
    if value.len() > MAX_RECORD {
        return Err(reject("job metadata exceeds its bound"));
    }
    Ok(value)
}
fn watermark(conn: &Connection) -> Result<u64> {
    let mut query = conn
        .prepare("SELECT singleton,revision FROM presentation_sequence LIMIT 2")
        .map_err(sql)?;
    let values = query
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    match values.as_slice() {
        [(1, n)] if *n >= 0 && *n as u64 <= SAFE => Ok(*n as u64),
        _ => Err(reject("durable job sequence is malformed or missing")),
    }
}
fn next_revision(conn: &Connection) -> Result<u64> {
    let next = watermark(conn)?
        .checked_add(1)
        .filter(|n| *n <= SAFE)
        .ok_or_else(|| reject("durable job sequence exhausted"))?;
    if conn
        .execute(
            "UPDATE presentation_sequence SET revision=?1 WHERE singleton=1",
            [next as i64],
        )
        .map_err(sql)?
        != 1
    {
        return Err(reject("durable job sequence disappeared"));
    }
    Ok(next)
}
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, i64, i64, String)> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
    ))
}
fn checked(raw: (String, String, String, i64, i64, String), sequence: u64) -> Result<JobRecord> {
    let (key, owner, operation, id, revision, body) = raw;
    if body.len() > MAX_RECORD {
        return Err(reject("job metadata exceeds its bound"));
    }
    let record: JobRecord = decode(&body)?;
    valid(&record, false)?;
    if key != record.job_key
        || owner != record.owner.package_id
        || operation != record.operation_id
        || i64::try_from(record.job_id).ok() != Some(id)
        || i64::try_from(record.revision).ok() != Some(revision)
        || record.revision > sequence
    {
        return Err(reject("durable job identity conflicts with its record"));
    }
    Ok(record)
}
fn all(conn: &Connection) -> Result<Vec<JobRecord>> {
    let sequence = watermark(conn)?;
    let mut query = conn
        .prepare(&format!("{ROWS} ORDER BY revision LIMIT 385"))
        .map_err(sql)?;
    let mut records = Vec::new();
    let mut keys = HashSet::new();
    let mut operations = HashSet::new();
    let mut ids = HashSet::new();
    let mut revisions = HashSet::new();
    for item in query.query_map([], row).map_err(sql)? {
        let record = checked(item.map_err(sql)?, sequence)?;
        if !keys.insert(record.job_key.clone())
            || !operations.insert((record.owner.package_id.clone(), record.operation_id.clone()))
            || !ids.insert(record.job_id)
            || !revisions.insert(record.revision)
        {
            return Err(reject("durable job identities are duplicated"));
        }
        records.push(record);
    }
    // Parking moves a row from active to retained without changing the
    // total, so retained presentation is bounded by the total until pruned.
    // More than MAX_ACTIVE active rows is tolerated on read: such a ledger
    // must still open so the user can dismiss; `register_job` refuses new
    // work while it is over capacity.
    if records.len() > MAX_ACTIVE + MAX_TERMINAL {
        return Err(reject("durable jobs exceed retained capacity"));
    }
    Ok(records)
}
fn stored(conn: &Connection, job_key: &str) -> Result<Option<JobRecord>> {
    let sequence = watermark(conn)?;
    conn.query_row(&format!("{ROWS} WHERE key=?1"), [job_key], row)
        .optional()
        .map_err(sql)?
        .map(|raw| checked(raw, sequence))
        .transpose()
}
fn immutable(a: &JobRecord, b: &JobRecord) -> bool {
    a.job_key == b.job_key
        && a.owner == b.owner
        && a.operation_id == b.operation_id
        && a.job_id == b.job_id
        && a.kind == b.kind
        && a.label == b.label
        && a.origin_window == b.origin_window
        && a.created_at_ms == b.created_at_ms
}
fn transition(from: JobState, to: JobState) -> Result<()> {
    if from.terminal() || from != JobState::Accepting && to == JobState::Accepting {
        return Err(reject("invalid durable job transition"));
    }
    Ok(())
}
fn clock() -> Result<u64> {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| reject("job observation clock is unavailable"))?
        .as_millis();
    u64::try_from(n)
        .ok()
        .filter(|n| *n <= SAFE)
        .ok_or_else(|| reject("job observation clock exceeds its bound"))
}
fn persist(conn: &Connection, record: &JobRecord) -> Result<()> {
    if conn
        .execute(
            "UPDATE presentation_jobs SET revision=?2,record=?3 WHERE key=?1",
            params![record.job_key, record.revision as i64, serialized(record)?],
        )
        .map_err(sql)?
        != 1
    {
        return Err(reject("durable job disappeared"));
    }
    Ok(())
}
fn prune(conn: &Connection) -> Result<()> {
    // Metadata retention never releases provider bytes or changes receipt identity.
    let sequence = watermark(conn)?;
    let mut query = conn
        .prepare(&format!("{ROWS} ORDER BY revision LIMIT 385"))
        .map_err(sql)?;
    let records = query
        .query_map([], row)
        .map_err(sql)?
        .map(|r| checked(r.map_err(sql)?, sequence))
        .collect::<Result<Vec<_>>>()?;
    if records.len() > MAX_ACTIVE + MAX_TERMINAL {
        return Err(reject("durable jobs exceed retained capacity"));
    }
    let settled: Vec<_> = records.iter().filter(|r| retained(r)).collect();
    for record in settled
        .iter()
        .take(settled.len().saturating_sub(MAX_TERMINAL))
    {
        conn.execute(
            "DELETE FROM presentation_jobs WHERE key=?1",
            [&record.job_key],
        )
        .map_err(sql)?;
    }
    Ok(())
}
fn indexes(conn: &Connection) -> Result<()> {
    let columns: Vec<(String, i64)> = conn
        .prepare("PRAGMA table_info(presentation_jobs)")
        .map_err(sql)?
        .query_map([], |r| Ok((r.get(1)?, r.get(5)?)))
        .map_err(sql)?
        .collect::<std::result::Result<_, _>>()
        .map_err(sql)?;
    if columns
        .iter()
        .filter(|(_, pk)| *pk != 0)
        .collect::<Vec<_>>()
        != [&("key".to_owned(), 1)]
    {
        return Err(reject("durable job primary key is missing"));
    }
    let names: Vec<String> = conn.prepare("SELECT name FROM pragma_index_list('presentation_jobs') WHERE \"unique\"=1 AND partial=0").map_err(sql)?
        .query_map([], |r| r.get(0)).map_err(sql)?.collect::<std::result::Result<_, _>>().map_err(sql)?;
    let mut has_owner = false;
    let mut has_id = false;
    for name in names {
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .map_err(sql)?
            .query_map([name], |r| r.get(0))
            .map_err(sql)?
            .collect::<std::result::Result<_, _>>()
            .map_err(sql)?;
        has_owner |= columns == ["owner", "operation"];
        has_id |= columns == ["job_id"];
    }
    if !has_owner || !has_id {
        return Err(reject("durable job uniqueness constraints are missing"));
    }
    Ok(())
}
impl Store {
    pub(super) fn stop_job_in(
        &self,
        conn: &Connection,
        consumer: &str,
        operation: &str,
    ) -> Result<Option<JobRecord>> {
        let sequence = watermark(conn)?;
        let Some(raw) = conn
            .query_row(
                &format!("{ROWS} WHERE owner=?1 AND operation=?2"),
                params![consumer, operation],
                row,
            )
            .optional()
            .map_err(sql)?
        else {
            return Ok(None);
        };
        let mut record = checked(raw, sequence)?;
        if record.state.terminal() || record.phase.as_deref() == Some("stopped") {
            return Ok(None);
        }
        transition(record.state, JobState::NeedsAttention)?;
        record.state = JobState::NeedsAttention;
        record.phase = Some("stopped".into());
        record.error =
            Some("Automatic recovery stopped; unknown execution evidence is retained".into());
        record.output_path = None;
        record.updated_at_ms = clock()?;
        record.revision = next_revision(conn)?;
        valid(&record, false)?;
        persist(conn, &record)?;
        prune(conn)?;
        Ok(Some(record))
    }
    pub(super) fn validate_jobs(&self) -> Result<()> {
        self.transaction(|conn| {
            indexes(conn)?;
            all(conn)?;
            Ok(())
        })
    }
    pub fn register_job(&self, mut record: JobRecord) -> Result<JobRecord> {
        valid(&record, true)?;
        serialized(&record)?;
        self.transaction(|conn| {
            let jobs = all(conn)?;
            if let Some(old) = jobs.iter().find(|old| old.job_key == record.job_key || old.owner.package_id == record.owner.package_id && old.operation_id == record.operation_id || old.job_id == record.job_id) {
                if !immutable(old, &record) { return Err(reject("job identity already belongs to another registration")); }
                return Ok(old.clone());
            }
            if jobs.iter().filter(|r| !retained(r)).count() >= MAX_ACTIVE { return Err(reject("resolve active jobs before starting more")); }
            // Parked rows may have filled retained capacity; keep room for one more.
            prune(conn)?;
            record.revision = next_revision(conn)?;
            conn.execute("INSERT INTO presentation_jobs(key,owner,operation,job_id,revision,record)VALUES(?1,?2,?3,?4,?5,?6)",params![record.job_key,record.owner.package_id,record.operation_id,record.job_id as i64,record.revision as i64,serialized(&record)?]).map_err(sql)?;
            Ok(record)
        })
    }
    pub fn job(&self, job_key: &str) -> Result<Option<JobRecord>> {
        if !key(job_key) {
            return Err(reject("invalid job key"));
        }
        self.transaction(|conn| stored(conn, job_key))
    }
    pub fn job_for_operation(&self, package: &str, operation: &str) -> Result<Option<JobRecord>> {
        if !identity(package) || !opaque(operation) {
            return Err(reject("invalid job owner or operation"));
        }
        self.transaction(|conn| {
            let sequence = watermark(conn)?;
            conn.query_row(
                &format!("{ROWS} WHERE owner=?1 AND operation=?2"),
                params![package, operation],
                row,
            )
            .optional()
            .map_err(sql)?
            .map(|raw| checked(raw, sequence))
            .transpose()
        })
    }
    pub fn snapshot_jobs(&self) -> Result<JobSnapshot> {
        let mut conn = self.connect()?;
        let tx = conn.transaction().map_err(sql)?;
        let snapshot = JobSnapshot {
            jobs: all(&tx)?,
            watermark: watermark(&tx)?,
        };
        tx.commit().map_err(sql)?;
        Ok(snapshot)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn update_job(
        &self,
        owner: &PackageGeneration,
        job_key: &str,
        state: JobState,
        phase: Option<String>,
        output_path: Option<String>,
        run_id: Option<i64>,
        error: Option<String>,
    ) -> Result<JobRecord> {
        self.update_job_revision(
            owner,
            job_key,
            state,
            phase,
            output_path,
            run_id,
            error,
            None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn observe_job(
        &self,
        owner: &PackageGeneration,
        job_key: &str,
        source_revision: u64,
        state: JobState,
        phase: Option<String>,
        output_path: Option<String>,
        run_id: Option<i64>,
        error: Option<String>,
    ) -> Result<JobRecord> {
        if source_revision == 0 || source_revision > SAFE {
            return Err(reject("invalid consumer job revision"));
        }
        self.update_job_revision(
            owner,
            job_key,
            state,
            phase,
            output_path,
            run_id,
            error,
            Some(source_revision),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn update_job_revision(
        &self,
        owner: &PackageGeneration,
        job_key: &str,
        state: JobState,
        phase: Option<String>,
        output_path: Option<String>,
        run_id: Option<i64>,
        error: Option<String>,
        source_revision: Option<u64>,
    ) -> Result<JobRecord> {
        generation(owner)?;
        if !key(job_key) {
            return Err(reject("invalid job key"));
        }
        self.transaction(|conn| {
            let old = stored(conn, job_key)?.ok_or_else(|| reject("unknown durable job"))?;
            if &old.owner != owner {
                return Err(reject("job update does not own its exact bound generation"));
            }
            if source_revision.is_some_and(|revision| revision <= old.source_revision) {
                return Ok(old);
            }
            if source_revision.is_some()
                && (old.phase.as_deref() == Some("stopped")
                    || old.phase.as_deref() == Some("provider_result_discarded")
                        && state != JobState::Discarded)
            {
                return Ok(old);
            }
            if old.run_id.is_some() && old.run_id != run_id {
                return Err(reject("job receipt changed its pinned consumer run"));
            }
            let mut next = JobRecord {
                source_revision: source_revision.unwrap_or(old.source_revision),
                state,
                phase,
                output_path,
                run_id,
                error,
                ..old.clone()
            };
            valid(&next, false)?;
            if next == old {
                return Ok(old);
            }
            if old.state.terminal()
                && source_revision.is_some()
                && next.state == old.state
                && next.output_path == old.output_path
                && next.run_id == old.run_id
                && next.error == old.error
            {
                return Ok(old);
            }
            if old.state.terminal() {
                return Err(reject("a terminal job outcome is immutable"));
            }
            // Parked rows do not count toward active capacity, so they may
            // never become active again; only a terminal outcome or another
            // parked state is allowed.
            if parked(&old) && !(next.state.terminal() || parked(&next)) {
                return Err(reject(
                    "a stopped or discarded job cannot become active again",
                ));
            }
            transition(old.state, state)?;
            next.revision = next_revision(conn)?;
            next.updated_at_ms = clock()?;
            persist(conn, &next)?;
            prune(conn)?;
            Ok(next)
        })
    }
    pub fn dismiss_job(&self, job_key: &str) -> Result<Option<u64>> {
        if !key(job_key) {
            return Err(reject("invalid job key"));
        }
        self.transaction(|conn| {
            let Some(record) = stored(conn, job_key)? else {
                return Ok(None);
            };
            if !retained(&record) {
                return Err(reject("a recoverable job cannot be dismissed"));
            }
            let revision = next_revision(conn)?;
            conn.execute("DELETE FROM presentation_jobs WHERE key=?1", [job_key])
                .map_err(sql)?;
            Ok(Some(revision))
        })
    }
    pub fn recover_jobs(&self, package: Option<&str>) -> Result<Vec<JobRecord>> {
        if package.is_some_and(|p| !identity(p)) {
            return Err(reject("invalid recovery package"));
        }
        self.transaction(|conn| {
            let mut changed = Vec::new();
            for mut record in all(conn)? {
                if package.is_none_or(|p| p == record.owner.package_id)
                    && matches!(record.state, JobState::Accepting | JobState::Running)
                {
                    record.state = JobState::Recovering;
                    record.revision = next_revision(conn)?;
                    record.updated_at_ms = clock()?;
                    persist(conn, &record)?;
                    changed.push(record);
                }
            }
            Ok(changed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::Limits;
    use super::*;
    fn record(n: u64) -> JobRecord {
        JobRecord {
            job_key: format!("{n:048x}"),
            owner: PackageGeneration {
                package_id: "consumer".into(),
                digest: "a".repeat(64),
                incarnation: 10,
            },
            operation_id: format!("operation-{n}"),
            job_id: n,
            kind: "openai-image".into(),
            label: "generated.png".into(),
            origin_window: "main".into(),
            revision: 0,
            source_revision: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            state: JobState::Accepting,
            phase: None,
            output_path: None,
            run_id: None,
            error: None,
        }
    }
    fn fixture() -> (tempfile::TempDir, Store) {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().join("services"), Limits::default()).unwrap();
        (root, store)
    }
    fn change(store: &Store, job: &JobRecord, state: JobState) -> Result<JobRecord> {
        store.update_job(
            &job.owner,
            &job.job_key,
            state,
            None,
            (state == JobState::Completed).then(|| "/private/generated.png".into()),
            (state == JobState::Completed).then_some(7),
            (state == JobState::Error).then(|| "Provider rejected the request".into()),
        )
    }
    #[test]
    fn registration_and_recovery_survive_restart_without_rebinding_or_fabricating_outcomes() {
        let (root, store) = fixture();
        let a = store.register_job(record(1)).unwrap();
        let mut other = record(2);
        other.owner.package_id = "different".into();
        let b = store.register_job(other).unwrap();
        let running = change(&store, &a, JobState::Running).unwrap();
        drop(store);
        let reopened = Store::open(root.path().join("services"), Limits::default()).unwrap();
        assert_eq!(reopened.job(&a.job_key).unwrap(), Some(running.clone()));
        assert_eq!(
            reopened
                .job_for_operation("consumer", &a.operation_id)
                .unwrap(),
            Some(running)
        );
        let recovered = reopened.recover_jobs(Some("consumer")).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].state, JobState::Recovering);
        assert_eq!(recovered[0].owner, a.owner);
        assert_eq!(
            reopened.job(&b.job_key).unwrap().unwrap().state,
            JobState::Accepting
        );
        assert!(reopened.recover_jobs(Some("consumer")).unwrap().is_empty());
        assert_eq!(
            change(&reopened, &recovered[0], JobState::Running)
                .unwrap()
                .owner,
            a.owner
        );
    }
    #[test]
    fn duplicate_registration_and_updates_do_not_advance_the_snapshot_watermark() {
        let (_root, store) = fixture();
        let original = record(1);
        let accepted = store.register_job(original.clone()).unwrap();
        assert_eq!(store.register_job(original).unwrap(), accepted);
        let running = change(&store, &accepted, JobState::Running).unwrap();
        assert_eq!(
            change(&store, &running, JobState::Running).unwrap(),
            running
        );
        let snapshot = store.snapshot_jobs().unwrap();
        assert_eq!(snapshot.watermark, running.revision);
        assert_eq!(snapshot.jobs, vec![running]);
    }
    #[test]
    fn foreign_generations_kind_keys_and_display_ids_cannot_take_over_a_job() {
        let (_root, store) = fixture();
        let accepted = store.register_job(record(1)).unwrap();
        for owner in [
            PackageGeneration {
                incarnation: 11,
                ..accepted.owner.clone()
            },
            PackageGeneration {
                digest: "b".repeat(64),
                ..accepted.owner.clone()
            },
            PackageGeneration {
                package_id: "other".into(),
                ..accepted.owner.clone()
            },
        ] {
            assert!(store
                .update_job(
                    &owner,
                    &accepted.job_key,
                    JobState::Running,
                    None,
                    None,
                    None,
                    None
                )
                .is_err());
        }
        for altered in [
            JobRecord {
                kind: "other-kind".into(),
                ..record(1)
            },
            JobRecord {
                job_key: format!("{:048x}", 2),
                ..record(1)
            },
            JobRecord {
                operation_id: "other-operation".into(),
                ..record(1)
            },
        ] {
            assert!(store.register_job(altered).is_err());
        }
        assert!(store.job("arbitrary-key").is_err());
        assert_eq!(store.snapshot_jobs().unwrap().jobs, vec![accepted]);
    }
    #[test]
    fn terminal_completion_is_immutable_and_late_observations_cannot_regress_it() {
        let (_root, store) = fixture();
        let accepted = store.register_job(record(1)).unwrap();
        let complete = change(&store, &accepted, JobState::Completed).unwrap();
        assert_eq!(
            change(&store, &complete, JobState::Completed).unwrap(),
            complete
        );
        for state in [
            JobState::Running,
            JobState::Recovering,
            JobState::NeedsAttention,
            JobState::Error,
            JobState::Cancelled,
            JobState::Discarded,
        ] {
            assert!(change(&store, &complete, state).is_err());
        }
        assert!(store
            .update_job(
                &complete.owner,
                &complete.job_key,
                JobState::Completed,
                Some("Different outcome".into()),
                complete.output_path.clone(),
                complete.run_id,
                None
            )
            .is_err());
        assert!(store.recover_jobs(None).unwrap().is_empty());
        assert_eq!(store.snapshot_jobs().unwrap().watermark, complete.revision);
    }
    #[test]
    fn active_capacity_is_preserved_while_only_old_terminal_presentation_is_pruned() {
        let (_root, store) = fixture();
        for n in 1..=128 {
            store.register_job(record(n)).unwrap();
        }
        assert!(store.register_job(record(129)).is_err());
        let first = store.job(&record(1).job_key).unwrap().unwrap();
        change(&store, &first, JobState::Completed).unwrap();
        for n in 129..=385 {
            let r = store.register_job(record(n)).unwrap();
            change(&store, &r, JobState::Cancelled).unwrap();
        }
        let snapshot = store.snapshot_jobs().unwrap();
        assert_eq!(
            snapshot.jobs.iter().filter(|r| !r.state.terminal()).count(),
            127
        );
        assert_eq!(
            snapshot.jobs.iter().filter(|r| r.state.terminal()).count(),
            256
        );
        assert!(store.job(&first.job_key).unwrap().is_none());
        assert!(store.job(&record(2).job_key).unwrap().is_some());
        assert_eq!(
            snapshot.watermark,
            snapshot.jobs.iter().map(|r| r.revision).max().unwrap()
        );
    }
    #[test]
    fn concurrent_writers_get_distinct_global_revisions_and_consistent_snapshots() {
        let (root, store) = fixture();
        drop(store);
        let path = root.path().join("services");
        let handles: Vec<_> = (1..=8)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    Store::open(path, Limits::default())
                        .unwrap()
                        .register_job(record(n))
                        .unwrap()
                })
            })
            .collect();
        let mut revisions: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().unwrap().revision)
            .collect();
        revisions.sort();
        assert_eq!(revisions, (1..=8).collect::<Vec<_>>());
        let reopened = Store::open(path, Limits::default()).unwrap();
        let snapshot = reopened.snapshot_jobs().unwrap();
        assert_eq!(snapshot.watermark, 8);
        assert_eq!(snapshot.jobs.len(), 8);
        assert!(snapshot
            .jobs
            .iter()
            .all(|r| r.revision <= snapshot.watermark));
    }
    #[test]
    fn commit_failure_preserves_the_previous_job_and_sequence() {
        let (_root, store) = fixture();
        let accepted = store.register_job(record(1)).unwrap();
        store
            .fail_next_commit
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(change(&store, &accepted, JobState::Completed).is_err());
        let snapshot = store.snapshot_jobs().unwrap();
        assert_eq!(snapshot.jobs, vec![accepted.clone()]);
        assert_eq!(snapshot.watermark, accepted.revision);
        assert_eq!(
            change(&store, &accepted, JobState::Completed)
                .unwrap()
                .revision,
            accepted.revision + 1
        );
    }
    #[test]
    fn malformed_oversized_and_conflicting_journal_rows_fail_closed_on_restart() {
        for variant in 0..6 {
            let (root, store) = fixture();
            let accepted = store.register_job(record(1)).unwrap();
            let conn = Connection::open(root.path().join("services/ledger.sqlite")).unwrap();
            match variant {
                0 => {
                    conn.execute(
                        "UPDATE presentation_jobs SET record=?1",
                        ["x".repeat(16385)],
                    )
                    .unwrap();
                }
                1 => {
                    conn.execute("UPDATE presentation_jobs SET record='{}'", [])
                        .unwrap();
                }
                2 => {
                    let mut r = accepted.clone();
                    r.job_id = 2;
                    conn.execute(
                        "UPDATE presentation_jobs SET record=?1",
                        [encode(&r).unwrap()],
                    )
                    .unwrap();
                }
                3 => {
                    conn.execute("UPDATE presentation_sequence SET revision=0", [])
                        .unwrap();
                }
                4 => {
                    conn.execute("DROP TABLE presentation_jobs", []).unwrap();
                }
                _ => {
                    conn.execute("DELETE FROM presentation_sequence", [])
                        .unwrap();
                }
            }
            drop(conn);
            drop(store);
            assert!(
                Store::open(root.path().join("services"), Limits::default()).is_err(),
                "variant {variant}"
            );
        }
    }
    #[test]
    fn input_bounds_and_revision_exhaustion_do_not_create_or_mutate_jobs() {
        let (_root, store) = fixture();
        for bad in [
            JobRecord {
                label: "猫".repeat(257),
                ..record(1)
            },
            JobRecord {
                job_id: SAFE + 1,
                ..record(1)
            },
            JobRecord {
                origin_window: "\0main".into(),
                ..record(1)
            },
            JobRecord {
                state: JobState::Completed,
                ..record(1)
            },
        ] {
            assert!(store.register_job(bad).is_err());
        }
        let accepted = store.register_job(record(1)).unwrap();
        assert!(store
            .update_job(
                &accepted.owner,
                &accepted.job_key,
                JobState::Running,
                Some("x".repeat(129)),
                None,
                None,
                None
            )
            .is_err());
        let conn = store.connect().unwrap();
        conn.execute(
            "UPDATE presentation_sequence SET revision=?1",
            [SAFE as i64],
        )
        .unwrap();
        drop(conn);
        assert!(change(&store, &accepted, JobState::Running).is_err());
        assert_eq!(store.job(&accepted.job_key).unwrap(), Some(accepted));
    }
    #[test]
    fn consumer_revisions_reject_late_receipts_and_pin_the_first_run() {
        let (_root, store) = fixture();
        let accepted = store.register_job(record(1)).unwrap();
        let observe = |revision, state, run| {
            store.observe_job(
                &accepted.owner,
                &accepted.job_key,
                revision,
                state,
                None,
                None,
                Some(run),
                None,
            )
        };
        let running = observe(4, JobState::Running, 7).unwrap();
        assert_eq!(observe(3, JobState::Recovering, 7).unwrap(), running);
        assert_eq!(observe(4, JobState::Recovering, 7).unwrap(), running);
        assert!(observe(5, JobState::Running, 8).is_err());
        assert_eq!(store.snapshot_jobs().unwrap().watermark, running.revision);
        let attention = observe(5, JobState::NeedsAttention, 7).unwrap();
        assert!(attention.revision > running.revision);
        assert_eq!(attention.run_id, Some(7));
    }
    #[test]
    fn autonomous_receipts_cannot_undo_explicit_stop_or_discard_policy() {
        let (_root, store) = fixture();
        let accepted = store.register_job(record(1)).unwrap();
        for phase in ["stopped", "provider_result_discarded"] {
            let policy = store
                .update_job(
                    &accepted.owner,
                    &accepted.job_key,
                    JobState::NeedsAttention,
                    Some(phase.into()),
                    None,
                    None,
                    None,
                )
                .unwrap();
            let late = store
                .observe_job(
                    &accepted.owner,
                    &accepted.job_key,
                    10,
                    JobState::Running,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap();
            assert_eq!(late, policy);
        }
        let discarded = store
            .observe_job(
                &accepted.owner,
                &accepted.job_key,
                11,
                JobState::Discarded,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(discarded.state, JobState::Discarded);
    }
    #[test]
    fn dismissal_only_removes_terminal_presentation_and_advances_the_watermark_once() {
        let (_root, store) = fixture();
        let accepted = store.register_job(record(1)).unwrap();
        assert!(store.dismiss_job(&accepted.job_key).is_err());
        let terminal = change(&store, &accepted, JobState::Cancelled).unwrap();
        assert_eq!(
            store.dismiss_job(&terminal.job_key).unwrap(),
            Some(terminal.revision + 1)
        );
        assert_eq!(store.dismiss_job(&terminal.job_key).unwrap(), None);
        let snapshot = store.snapshot_jobs().unwrap();
        assert_eq!(snapshot.watermark, terminal.revision + 1);
        assert!(snapshot.jobs.is_empty());
    }
    fn park(store: &Store, job: &JobRecord, phase: &str) -> JobRecord {
        store
            .update_job(
                &job.owner,
                &job.job_key,
                JobState::NeedsAttention,
                Some(phase.into()),
                None,
                None,
                Some("Automatic recovery stopped; unknown execution evidence is retained".into()),
            )
            .unwrap()
    }
    #[test]
    fn stopped_and_discarded_jobs_are_dismissable_presentation_only() {
        let (_root, store) = fixture();
        let attention = store.register_job(record(1)).unwrap();
        let attention = park(&store, &attention, "needs_attention");
        // Unresolved recovery stays until an explicit stop or discard.
        assert!(store.dismiss_job(&attention.job_key).is_err());
        for (n, phase) in [(2, "stopped"), (3, "provider_result_discarded")] {
            let parked = park(&store, &store.register_job(record(n)).unwrap(), phase);
            assert!(!parked.state.terminal());
            assert_eq!(
                store.dismiss_job(&parked.job_key).unwrap(),
                Some(store.snapshot_jobs().unwrap().watermark)
            );
            assert!(store.job(&parked.job_key).unwrap().is_none());
            assert!(store
                .job_for_operation("consumer", &parked.operation_id)
                .unwrap()
                .is_none());
        }
        assert!(store.job(&attention.job_key).unwrap().is_some());
    }
    #[test]
    fn parked_jobs_never_exhaust_active_capacity_or_fail_the_journal_closed() {
        let (root, store) = fixture();
        // Far more explicit stops than active capacity, none ever dismissed.
        for n in 1..=300 {
            let job = store.register_job(record(n)).unwrap();
            park(
                &store,
                &job,
                if n % 2 == 0 {
                    "stopped"
                } else {
                    "provider_result_discarded"
                },
            );
        }
        for n in 301..=428 {
            store.register_job(record(n)).unwrap();
        }
        // Only genuinely active jobs refuse new work.
        assert!(store.register_job(record(429)).is_err());
        drop(store);
        let store = Store::open(root.path().join("services"), Limits::default()).unwrap();
        let snapshot = store.snapshot_jobs().unwrap();
        assert_eq!(
            snapshot
                .jobs
                .iter()
                .filter(|r| r.state == JobState::Accepting)
                .count(),
            128
        );
        // Old parked presentation is pruned like terminal presentation.
        assert!(snapshot.jobs.len() <= 384);
        assert!(store.job(&record(1).job_key).unwrap().is_none());
        assert!(store.job(&record(300).job_key).unwrap().is_some());
        let newest = store.job(&record(428).job_key).unwrap().unwrap();
        change(&store, &newest, JobState::Cancelled).unwrap();
        store.register_job(record(429)).unwrap();
    }
    #[test]
    fn a_parked_job_can_only_move_to_a_terminal_state_never_back_to_active() {
        let (root, store) = fixture();
        let parked_jobs: Vec<_> = (1..=2)
            .map(|n| {
                let phase = if n == 1 {
                    "stopped"
                } else {
                    "provider_result_discarded"
                };
                park(&store, &store.register_job(record(n)).unwrap(), phase)
            })
            .collect();
        for n in 3..=130 {
            store.register_job(record(n)).unwrap();
        }
        for job in &parked_jobs {
            for state in [JobState::Recovering, JobState::Running, JobState::Accepting] {
                assert!(change(&store, job, state).is_err());
            }
            assert_eq!(store.job(&job.job_key).unwrap().unwrap(), *job);
        }
        // Still usable and reopenable; the terminal exit remains available.
        assert!(store.register_job(record(131)).is_err());
        drop(store);
        let store = Store::open(root.path().join("services"), Limits::default()).unwrap();
        assert_eq!(store.snapshot_jobs().unwrap().jobs.len(), 130);
        let cancelled = change(&store, &parked_jobs[1], JobState::Cancelled).unwrap();
        assert!(cancelled.state.terminal());
    }
    #[test]
    fn an_existing_over_capacity_ledger_opens_refuses_new_work_and_allows_dismissal() {
        let (root, store) = fixture();
        for n in 1..=128 {
            store.register_job(record(n)).unwrap();
        }
        let mut extra = record(129);
        extra.revision = 129;
        let conn = Connection::open(root.path().join("services/ledger.sqlite")).unwrap();
        conn.execute(
            "INSERT INTO presentation_jobs(key,owner,operation,job_id,revision,record)VALUES(?1,?2,?3,?4,?5,?6)",
            params![extra.job_key, "consumer", extra.operation_id, 129, 129, serialized(&extra).unwrap()],
        )
        .unwrap();
        conn.execute("UPDATE presentation_sequence SET revision=129", [])
            .unwrap();
        drop(conn);
        drop(store);
        let store = Store::open(root.path().join("services"), Limits::default()).unwrap();
        assert_eq!(store.snapshot_jobs().unwrap().jobs.len(), 129);
        assert!(store.register_job(record(130)).is_err());
        // Active work is resolved by the user, after which the ledger recovers.
        change(
            &store,
            &store.job(&extra.job_key).unwrap().unwrap(),
            JobState::Cancelled,
        )
        .unwrap();
        let cancelled = store.job(&extra.job_key).unwrap().unwrap();
        store.dismiss_job(&cancelled.job_key).unwrap();
        change(
            &store,
            &store.job(&record(1).job_key).unwrap().unwrap(),
            JobState::Cancelled,
        )
        .unwrap();
        store.register_job(record(130)).unwrap();
    }
}
