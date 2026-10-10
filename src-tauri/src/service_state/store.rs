use super::{model::*, rules::*};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::PathBuf, time::Duration};
pub(crate) struct Store {
    pub(super) root: PathBuf,
    pub(super) limits: Limits,
    #[cfg(test)]
    pub(super) fail_next_commit: std::sync::atomic::AtomicBool,
    #[cfg(all(test, unix))]
    pub(super) fail_evidence_sync_at: std::sync::Mutex<Option<PathBuf>>,
}
pub(super) fn sql(_: rusqlite::Error) -> crate::error::AppError {
    reject("durable ledger is unavailable or corrupt")
}
pub(super) fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|_| reject("record serialization failed"))
}
pub(super) fn decode<T: DeserializeOwned>(value: &str) -> Result<T> {
    if value.len() > 128 * 1024 {
        return Err(reject("record exceeds metadata bound"));
    }
    serde_json::from_str(value).map_err(|_| reject("durable record is malformed or unsupported"))
}
impl Store {
    pub fn open(root: PathBuf, limits: Limits) -> Result<Self> {
        crate::native_deadline::check()?;
        if limits.disk_bytes == 0
            || limits.disk_bytes > i64::MAX as u64
            || limits.operations == 0
            || limits.operations > i64::MAX as usize
            || limits.per_consumer == 0
            || limits.per_consumer > limits.operations
        {
            return Err(reject("invalid store limits"));
        }
        let fresh = !root.exists();
        let created_directories: Vec<_> = root
            .ancestors()
            .take_while(|path| !path.exists())
            .map(std::path::Path::to_path_buf)
            .collect();
        if fresh {
            fs::create_dir_all(&root)
                .map_err(|_| reject("could not create private service directory"))?;
        }
        super::artifacts::private_directory(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| reject("could not secure service directory"))?;
        }
        let store = Self {
            root: dunce::canonicalize(&root)
                .map_err(|_| reject("service directory is unreadable"))?,
            limits,
            #[cfg(test)]
            fail_next_commit: std::sync::atomic::AtomicBool::new(false),
            #[cfg(all(test, unix))]
            fail_evidence_sync_at: std::sync::Mutex::new(None),
        };
        let init_path = store.root.join(".initialize.lock");
        super::artifacts::regular_or_missing(&init_path)?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY);
        }
        let init = options
            .open(&init_path)
            .map_err(|_| reject("initialization coordination unavailable"))?;
        if !init
            .metadata()
            .map_err(|_| reject("initialization lock unavailable"))?
            .is_file()
        {
            return Err(reject("invalid initialization lock"));
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match init.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => return Err(reject("initialization coordination unavailable")),
            }
        }
        let path = store.root.join("ledger.sqlite");
        let exists = path.exists();
        // A crash between SQLite creating the file and the schema commit leaves
        // an empty database that is first-run, not an unsupported ledger.
        let missing = !exists || store.interrupted_first_run()?;
        if !exists
            && !fresh
            && fs::read_dir(&store.root)
                .map_err(|_| reject("service directory is unreadable"))?
                .filter_map(std::result::Result::ok)
                .any(|entry| entry.file_name() != ".initialize.lock")
        {
            return Err(reject("durable ledger is missing; restore service state"));
        }
        let mut connection = store.connect_with_create(missing)?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(sql)?;
        if missing {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(sql)?;
            tx.execute_batch("CREATE TABLE operations(consumer TEXT NOT NULL,operation TEXT NOT NULL,owner TEXT NOT NULL,admission TEXT,phase TEXT NOT NULL DEFAULT 'reserved',capture_spec TEXT,captures TEXT,exec_released INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(consumer,operation)); CREATE TABLE artifacts(handle TEXT PRIMARY KEY,consumer TEXT NOT NULL,operation TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,bytes INTEGER NOT NULL,descriptor TEXT,source TEXT,width INTEGER,height INTEGER); CREATE INDEX artifacts_operation ON artifacts(consumer,operation); CREATE TABLE evidence(receipt TEXT PRIMARY KEY,consumer TEXT NOT NULL,operation TEXT NOT NULL,descriptor TEXT NOT NULL,path TEXT NOT NULL,UNIQUE(consumer,operation)); CREATE TABLE roots(package TEXT PRIMARY KEY,path TEXT NOT NULL); PRAGMA user_version=1;").map_err(sql)?;
            tx.commit().map_err(sql)?;
        } else if version != 1 {
            return Err(reject(
                "durable ledger schema is unsupported; update or restore service state",
            ));
        }
        let core_tables: i64 = connection
            .query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN('operations','artifacts','evidence','roots')", [], |r| r.get(0))
            .map_err(sql)?;
        if core_tables != 4 {
            return Err(reject("durable ledger core schema is missing or corrupt"));
        }
        let marker: i64 = connection
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(sql)?;
        let receipt_table: bool = connection
            .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provider_receipts')", [], |r| r.get(0))
            .map_err(sql)?;
        if marker == 0 && !receipt_table {
            // Explicit schema-1 extension. The marker and table commit together;
            // once present, a missing receipt table is corruption, never defaults.
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(sql)?;
            tx.execute_batch(super::receipts::RECEIPT_TABLE)
                .map_err(sql)?;
            tx.commit().map_err(sql)?;
        } else if !matches!(
            marker,
            super::receipts::RECEIPT_SCHEMA
                | super::intents::INTENT_SCHEMA
                | super::job_store::JOB_SCHEMA
        ) || !receipt_table
        {
            return Err(reject("durable receipt schema is missing or unsupported"));
        }
        let marker: i64 = connection
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(sql)?;
        let intent_table: bool = connection
            .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='operation_intents')", [], |r| r.get(0))
            .map_err(sql)?;
        if marker == super::receipts::RECEIPT_SCHEMA && !intent_table {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(sql)?;
            tx.execute_batch(super::intents::INTENT_TABLE)
                .map_err(sql)?;
            tx.commit().map_err(sql)?;
        } else if !matches!(
            marker,
            super::intents::INTENT_SCHEMA | super::job_store::JOB_SCHEMA
        ) || !intent_table
        {
            return Err(reject("durable intent schema is missing or unsupported"));
        }
        let marker: i64 = connection
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(sql)?;
        let job_tables:i64=connection.query_row("SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('presentation_jobs','presentation_sequence')",[],|r|r.get(0)).map_err(sql)?;
        if marker == super::intents::INTENT_SCHEMA && job_tables == 0 {
            let tx = connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(sql)?;
            tx.execute_batch(super::job_store::JOB_TABLE).map_err(sql)?;
            tx.commit().map_err(sql)?;
        } else if marker != super::job_store::JOB_SCHEMA || job_tables != 2 {
            return Err(reject(
                "durable job presentation schema is missing or unsupported",
            ));
        }
        let integrity: String = connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(sql)?;
        if integrity != "ok" {
            return Err(reject("durable ledger is corrupt"));
        }
        drop(connection);
        for name in ["bytes", "stages", "leases"] {
            let path = store.root.join(name);
            if !path.exists() {
                fs::create_dir(&path)
                    .map_err(|_| reject("could not create private artifact directory"))?;
            }
            super::artifacts::private_directory(&path)?;
        }
        // SQLite syncs its journal and files; commit newly-created host
        // directory entries too before any admission can be advertised.
        crate::durable_dir::sync(&store.root)
            .map_err(|_| reject("service directory sync failed"))?;
        for directory in created_directories {
            if let Some(parent) = directory.parent() {
                crate::durable_dir::sync(parent)
                    .map_err(|_| reject("service parent directory sync failed"))?;
            }
        }
        // Deserialization is part of startup reconciliation, before claims advertised.
        store.claims()?;
        let invalid_execution:i64=store.connect()?.query_row("SELECT count(*) FROM operations WHERE exec_released NOT IN(0,1) OR (exec_released=1 AND (phase!='terminal' OR admission IS NULL OR json_extract(admission,'$.output') IS NOT NULL OR json_extract(admission,'$.needsAttention') IS NOT 1))",[],|r|r.get(0)).map_err(sql)?;
        if invalid_execution != 0 {
            return Err(reject("invalid retained execution claim"));
        }
        store.validate_receipts()?;
        store.validate_intents()?;
        store.validate_jobs()?;
        store
            .connect()?
            .prepare("SELECT created_at_ms FROM operations LIMIT 0")
            .map_err(sql)?;
        drop(init);
        // Directory-entry durability is qualified on every supported platform
        // (see crate::durable_dir), so startup recovery and GC run everywhere.
        store.recover_unaccepted()?;
        // Released rows are already durable; a failed byte sweep (e.g. a file
        // held open on Windows) must not take the Store down. It retries on
        // the next sweep.
        if let Err(error) = store.gc() {
            log::warn!("startup artifact sweep deferred: {error}");
        }
        Ok(store)
    }
    /// True only for a ledger that provably never held state: no tables,
    /// `user_version` 0, and nothing else durable in the service directory
    /// (bytes, stages and leases hold no entries). Any doubt fails closed.
    fn interrupted_first_run(&self) -> Result<bool> {
        for name in [
            "ledger.sqlite",
            "ledger.sqlite-wal",
            "ledger.sqlite-shm",
            "ledger.sqlite-journal",
        ] {
            super::artifacts::regular_or_missing(&self.root.join(name))?;
        }
        let entries = fs::read_dir(&self.root)
            .map_err(|_| reject("service directory is unreadable"))?
            .filter_map(std::result::Result::ok);
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let inert = matches!(
                name.as_ref(),
                ".initialize.lock"
                    | "ledger.sqlite"
                    | "ledger.sqlite-wal"
                    | "ledger.sqlite-shm"
                    | "ledger.sqlite-journal"
            ) || (matches!(name.as_ref(), "bytes" | "stages" | "leases")
                && fs::read_dir(entry.path()).is_ok_and(|mut d| d.next().is_none()));
            if !inert {
                return Ok(false);
            }
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let Ok(connection) = Connection::open_with_flags(self.root.join("ledger.sqlite"), flags)
        else {
            return Ok(false);
        };
        let blank = connection
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version)=0 AND (SELECT count(*) FROM sqlite_schema)=0",
                [],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false);
        Ok(blank)
    }
    fn connect_with_create(&self, create: bool) -> Result<Connection> {
        crate::native_deadline::check()?;
        super::artifacts::private_directory(&self.root)?;
        for name in [
            "ledger.sqlite",
            "ledger.sqlite-wal",
            "ledger.sqlite-shm",
            "ledger.sqlite-journal",
        ] {
            super::artifacts::regular_or_missing(&self.root.join(name))?;
        }
        let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let conn =
            Connection::open_with_flags(self.root.join("ledger.sqlite"), flags).map_err(sql)?;
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH, 256 * 1024)
            .map_err(sql)?;
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024)
            .map_err(sql)?;
        conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_COLUMN, 64)
            .map_err(sql)?;
        conn.busy_timeout(crate::native_deadline::remaining(Duration::from_secs(3))?)
            .map_err(sql)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(sql)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(sql)?;
        Ok(conn)
    }
    /// Failure injection for cross-module recovery tests: the next durable
    /// transaction is rolled back after its work, before commit.
    #[cfg(test)]
    pub(crate) fn fail_next_write(&self) {
        self.fail_next_commit
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    /// Holds an artifact's IO lease, as a concurrent reader would, so tests
    /// can observe deferred byte collection.
    #[cfg(test)]
    pub(crate) fn hold_artifact_io(&self, handle: &str) -> Result<std::fs::File> {
        self.lease(handle)
    }
    pub(super) fn connect(&self) -> Result<Connection> {
        let conn = self.connect_with_create(false)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(sql)?;
        let marker: i64 = conn
            .pragma_query_value(None, "application_id", |r| r.get(0))
            .map_err(sql)?;
        if version != 1 || marker != super::job_store::JOB_SCHEMA {
            return Err(reject("durable ledger schema is unsupported"));
        }
        Ok(conn)
    }
    pub(super) fn transaction<T>(
        &self,
        work: impl FnOnce(&rusqlite::Transaction) -> Result<T>,
    ) -> Result<T> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql)?;
        let result = work(&tx)?;
        #[cfg(test)]
        if self
            .fail_next_commit
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return Err(reject("injected metadata commit failure"));
        }
        tx.commit().map_err(sql)?;
        Ok(result)
    }
    pub(super) fn record(conn: &Connection, consumer: &str, op: &str) -> Result<Option<Admission>> {
        let row: Option<(Option<String>, String, String)> = conn
            .query_row(
                "SELECT CASE WHEN admission IS NULL THEN NULL WHEN length(CAST(admission AS BLOB))<=131072 THEN admission ELSE '' END,CASE WHEN length(CAST(owner AS BLOB))<=4096 THEN owner ELSE '' END,CASE WHEN length(CAST(phase AS BLOB))<=32 THEN phase ELSE '' END FROM operations WHERE consumer=?1 AND operation=?2",
                params![consumer, op],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(sql)?;
        let Some((raw, owner, stored_phase)) = row else {
            return Ok(None);
        };
        let owner: PackageGeneration = decode(&owner)?;
        generation(&owner)?;
        if owner.package_id != consumer {
            return Err(reject("durable operation owner conflicts with its key"));
        }
        let Some(raw) = raw else {
            if !matches!(stored_phase.as_str(), "reserved" | "released") {
                return Err(reject("durable admission record is missing"));
            }
            return Ok(None);
        };
        let a: Admission = decode(&raw)?;
        persisted(&a)?;
        if a.operation_id != op
            || a.consumer.package_id != consumer
            || !same_owner(&owner, &a.consumer)
            || phase(a.phase) != stored_phase
        {
            return Err(reject(
                "durable admission conflicts with its key, owner or phase",
            ));
        }
        Ok(Some(a))
    }
    pub fn get(&self, consumer: &str, op: &str) -> Result<Option<Admission>> {
        if !identity(consumer) || !identity(op) {
            return Err(reject("invalid operation identity"));
        }
        Self::record(&self.connect()?, consumer, op)
    }
    pub(super) fn persist(conn: &Connection, a: &Admission) -> Result<()> {
        persisted(a)?;
        conn.execute(
            "UPDATE operations SET admission=?3,phase=?4 WHERE consumer=?1 AND operation=?2",
            params![
                a.consumer.package_id,
                a.operation_id,
                encode(a)?,
                phase(a.phase)
            ],
        )
        .map_err(sql)?;
        Ok(())
    }
    pub(super) fn quota(
        &self,
        conn: &Connection,
        consumer: &str,
        additional_bytes: u64,
        new_operation: bool,
    ) -> Result<()> {
        let bytes: i64 = conn
            .query_row("SELECT coalesce(sum(bytes),0) FROM artifacts", [], |r| {
                r.get(0)
            })
            .map_err(sql)?;
        if u64::try_from(bytes)
            .map_err(|_| reject("negative artifact reservation"))?
            .checked_add(additional_bytes)
            .is_none_or(|n| n > self.limits.disk_bytes)
        {
            return Err(reject("artifact capacity reached"));
        }
        if new_operation {
            let (global, local): (i64, i64) = conn
                .query_row("SELECT count(*),coalesce(sum(consumer=?1),0) FROM operations WHERE phase!='released' AND exec_released=0", [consumer], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(sql)?;
            if global >= self.limits.operations as i64 || local >= self.limits.per_consumer as i64 {
                return Err(reject("operation capacity reached"));
            }
        }
        Ok(())
    }
    pub fn reserve(&self, a: Admission) -> Result<Admission> {
        self.reserve_with_intent(a, None)
    }
    pub(super) fn reserve_with_intent(
        &self,
        a: Admission,
        semantic: Option<&str>,
    ) -> Result<Admission> {
        admission(&a)?;
        if semantic.is_some_and(|value| !digest(value)) {
            return Err(reject("invalid semantic intent digest"));
        }
        self.transaction(|tx| {
            if let Some(old) = Self::record(tx, &a.consumer.package_id, &a.operation_id)? {
                if old.fingerprint != a.fingerprint
                    || !same_owner(&old.consumer, &a.consumer)
                    || !same_owner(&old.provider, &a.provider)
                    || old.target != a.target
                    || !(if semantic.is_some() { super::intents::same_input_content(&old.inputs, &a.inputs) } else { old.inputs == a.inputs })
                {
                    return Err(reject("operation ID conflicts with its original request"));
                }
                if old.phase == AdmissionPhase::Reserved && (old.consumer != a.consumer || old.provider != a.provider) {
                    return Err(reject("preparation owner expired; create a new operation ID"));
                }
                if let Some(semantic) = semantic {
                    super::intents::attach_or_match(tx, &old, semantic)?;
                }
                return Ok(old);
            }
            let owner: Option<String> = tx
                .query_row("SELECT owner FROM operations WHERE consumer=?1 AND operation=?2", params![a.consumer.package_id, a.operation_id], |r| r.get(0))
                .optional()
                .map_err(sql)?;
            if owner.is_some() {
                let phase: String = tx
                    .query_row("SELECT phase FROM operations WHERE consumer=?1 AND operation=?2", params![a.consumer.package_id, a.operation_id], |r| r.get(0))
                    .map_err(sql)?;
                if phase == "released" {
                    return Err(reject("released preparation ID cannot be reused"));
                }
            }
            if let Some(owner) = &owner {
                if decode::<PackageGeneration>(owner)? != a.consumer {
                    return Err(reject("preparation owner expired; create a new operation ID"));
                }
            }
            self.quota(tx, &a.consumer.package_id, 100 * 1024 * 1024, owner.is_none())?;
            for input in &a.inputs {
                self.exact_artifact(tx, &a.consumer.package_id, &a.operation_id, input, "input")?;
            }
            if owner.is_none() {
                tx.execute("INSERT INTO operations(consumer,operation,owner,created_at_ms)VALUES(?1,?2,?3,CAST(strftime('%s','now') AS INTEGER)*1000)", params![a.consumer.package_id, a.operation_id, encode(&a.consumer)?])
                    .map_err(sql)?;
            }
            let handle = super::artifacts::opaque_id()?;
            tx.execute(
                "INSERT INTO artifacts(handle,consumer,operation,kind,status,bytes)VALUES(?1,?2,?3,'output','reserved',?4)",
                params![handle, a.consumer.package_id, a.operation_id, 100 * 1024 * 1024i64],
            )
            .map_err(sql)?;
            Self::persist(tx, &a)?;
            if let Some(semantic) = semantic {
                super::intents::attach_or_match(tx, &a, semantic)?;
            }
            Ok(a.clone())
        })
    }
    pub(super) fn exact_artifact(
        &self,
        conn: &Connection,
        consumer: &str,
        op: &str,
        d: &ArtifactDescriptor,
        kind: &str,
    ) -> Result<()> {
        descriptor(d)?;
        let record: Option<(String, String)> = conn
            .query_row(
                "SELECT descriptor,status FROM artifacts WHERE handle=?1 AND consumer=?2 AND operation=?3 AND kind=?4",
                params![d.handle, consumer, op, kind],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        if record.is_none_or(|(raw, status)| {
            status != "sealed" || decode::<ArtifactDescriptor>(&raw).ok().as_ref() != Some(d)
        }) {
            return Err(reject(
                "artifact descriptor or ownership does not match durable metadata",
            ));
        }
        Ok(())
    }
    pub fn verify_consumer(&self, caller: &PackageGeneration, op: &str) -> Result<Admission> {
        generation(caller)?;
        let a = self
            .get(&caller.package_id, op)?
            .ok_or_else(|| reject("operation is not admitted"))?;
        if !same_owner(&a.consumer, caller) {
            return Err(reject("consumer generation does not own this operation"));
        }
        Ok(a)
    }
    pub fn verify_provider(
        &self,
        caller: &PackageGeneration,
        consumer: &str,
        op: &str,
    ) -> Result<Admission> {
        generation(caller)?;
        let a = self
            .get(consumer, op)?
            .ok_or_else(|| reject("operation is not admitted"))?;
        if !same_owner(&a.provider, caller) {
            return Err(reject("provider generation does not own this operation"));
        }
        Ok(a)
    }
    fn change(
        &self,
        caller: &PackageGeneration,
        consumer: &str,
        op: &str,
        to: AdmissionPhase,
        provider: bool,
    ) -> Result<Admission> {
        self.transaction(|tx| {
            let mut a = Self::record(tx, consumer, op)?
                .ok_or_else(|| reject("operation is not admitted"))?;
            if !same_owner(if provider { &a.provider } else { &a.consumer }, caller) {
                return Err(reject("operation owner does not match"));
            }
            transition(a.phase, to)?;
            a.phase = to;
            Self::persist(tx, &a)?;
            Ok(a)
        })
    }
    /// Exactly one caller may persist the dispatch boundary. All later callers
    /// must reconcile the existing operation rather than repeat provider start.
    pub fn claim_forwarding(
        &self,
        caller: &PackageGeneration,
        op: &str,
    ) -> Result<(Admission, bool)> {
        self.transaction(|tx| {
            let mut a = Self::record(tx, &caller.package_id, op)?
                .ok_or_else(|| reject("operation is not admitted"))?;
            if !same_owner(&a.consumer, caller) {
                return Err(reject("operation owner does not match"));
            }
            if a.phase != AdmissionPhase::Reserved {
                return Ok((a, false));
            }
            if &a.consumer != caller {
                return Err(reject(
                    "preparation owner expired; create a new operation ID",
                ));
            }
            a.phase = AdmissionPhase::Forwarding;
            Self::persist(tx, &a)?;
            Ok((a, true))
        })
    }
    #[cfg(test)]
    pub fn forwarding(&self, caller: &PackageGeneration, op: &str) -> Result<Admission> {
        self.claim_forwarding(caller, op).map(|(a, _)| a)
    }
    pub fn accepted(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
    ) -> Result<Admission> {
        self.change(provider, consumer, op, AdmissionPhase::Accepted, true)
    }
    pub fn mark_attention(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
    ) -> Result<Admission> {
        self.transaction(|tx| {
            let mut a = Self::record(tx, consumer, op)?
                .ok_or_else(|| reject("operation is not admitted"))?;
            if !same_owner(&a.provider, provider)
                || !matches!(
                    a.phase,
                    AdmissionPhase::Forwarding | AdmissionPhase::Accepted
                )
            {
                return Err(reject(
                    "attention requires an unresolved provider-owned operation",
                ));
            }
            a.needs_attention = true;
            Self::persist(tx, &a)?;
            Ok(a)
        })
    }
    pub fn terminal(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        output: Option<ArtifactDescriptor>,
        needs_attention: bool,
    ) -> Result<Admission> {
        self.transaction(|tx| {
            let mut a = Self::record(tx, consumer, op)?
                .ok_or_else(|| reject("operation is not admitted"))?;
            if !same_owner(&a.provider, provider) {
                return Err(reject("provider owner does not match"));
            }
            if a.phase == AdmissionPhase::Released {
                if a.output != output || a.needs_attention != needs_attention {
                    return Err(reject("terminal outcome conflicts with durable evidence"));
                }
                return Ok(a);
            }
            if a.phase == AdmissionPhase::Terminal {
                if a.output != output {
                    // Delivery may recover locally after a succeeded receipt
                    // whose bytes were initially unavailable. Never replace a
                    // pinned output or restore a disposed operation.
                    if a.output.is_some() || output.is_none() {
                        return Err(reject("terminal output conflicts with durable evidence"));
                    }
                    self.exact_artifact(tx, consumer, op, output.as_ref().unwrap(), "output")?;
                }
                if needs_attention && !a.needs_attention {
                    return Err(reject("terminal attention conflicts with durable evidence"));
                }
                a.output = output;
                a.needs_attention = needs_attention;
                Self::persist(tx, &a)?;
                return Ok(a);
            }
            transition(a.phase, AdmissionPhase::Terminal)?;
            if let Some(output) = &output {
                self.exact_artifact(tx, consumer, op, output, "output")?;
            }
            a.phase = AdmissionPhase::Terminal;
            a.output = output;
            a.needs_attention = needs_attention;
            Self::persist(tx, &a)?;
            Ok(a)
        })
    }
    #[cfg(test)]
    pub fn release_execution_after_attention(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        no_live_worker: bool,
    ) -> Result<Admission> {
        self.stop_recovery(provider, consumer, op, no_live_worker)
            .map(|(admission, _)| admission)
    }
    pub fn stop_recovery(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        no_live_worker: bool,
    ) -> Result<(Admission, Option<super::job::JobRecord>)> {
        self.transaction(|tx| {
            let a = Self::record(tx, consumer, op)?.ok_or_else(|| reject("operation is not admitted"))?;
            if !same_owner(&a.provider, provider) || a.phase != AdmissionPhase::Terminal || !a.needs_attention || a.output.is_some() || !no_live_worker {
                return Err(reject("execution cannot be released without needs-attention and worker termination proof"));
            }
            tx.execute("UPDATE operations SET exec_released=1 WHERE consumer=?1 AND operation=?2", params![consumer, op]).map_err(sql)?;
            let job=self.stop_job_in(tx,consumer,op)?;
            Ok((a,job))
        })
    }
    pub fn release(
        &self,
        provider: &PackageGeneration,
        consumer: &str,
        op: &str,
        disposition: &str,
        receipt: Option<&str>,
    ) -> Result<Admission> {
        let a = self.transaction(|tx| {
            let mut a = Self::record(tx, consumer, op)?.ok_or_else(|| reject("operation is not admitted"))?;
            if !same_owner(&a.provider, provider) || !matches!(disposition, "acquired" | "discarded") {
                return Err(reject("invalid handoff authority or disposition"));
            }
            if a.phase == AdmissionPhase::Released {
                if a.disposition.as_deref() != Some(disposition) || a.transfer_receipt.as_deref() != receipt {
                    return Err(reject("handoff disposition conflicts with its tombstone"));
                }
                return Ok(a);
            }
            if a.phase != AdmissionPhase::Terminal {
                return Err(reject("only terminal handoffs may be released"));
            }
            if disposition == "acquired" {
                let raw: Option<(String, String)> = tx
                    .query_row("SELECT receipt,descriptor FROM evidence WHERE consumer=?1 AND operation=?2", params![consumer, op], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(sql)?;
                if raw.is_none_or(|(id, d)| Some(id.as_str()) != receipt || decode::<ArtifactDescriptor>(&d).ok() != a.output) {
                    return Err(reject("acquisition receipt does not prove this output"));
                }
            } else if receipt.is_some() {
                return Err(reject("discard cannot use an acquisition receipt"));
            }
            a.phase = AdmissionPhase::Released;
            a.disposition = Some(disposition.into());
            a.transfer_receipt = receipt.map(str::to_owned);
            Self::persist(tx, &a)?;
            Ok(a)
        })?;
        self.collect_released(consumer, op)?;
        Ok(a)
    }
    /// Old consumers do not understand retained shared-operation links. Even
    /// explicitly stopped unknown outcomes must keep that history intact.
    pub fn legacy_consumer_compatible(&self, package: &str) -> Result<bool> {
        let retained: bool = self.connect()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM operations WHERE consumer=?1 AND admission IS NOT NULL AND phase!='released')",
            [package], |row| row.get(0),
        ).map_err(sql)?;
        Ok(!retained)
    }
    pub fn retained_operations(&self) -> Result<Vec<(Admission, u64, bool)>> {
        let conn = self.connect()?;
        let mut query=conn.prepare("SELECT consumer,operation,created_at_ms,exec_released FROM operations WHERE admission IS NOT NULL AND phase!='released' ORDER BY created_at_ms DESC LIMIT 128").map_err(sql)?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(sql)?;
        let mut result = Vec::new();
        for row in rows {
            let (consumer, operation, created, released) = row.map_err(sql)?;
            if created < 0 || !matches!(released, 0 | 1) {
                return Err(reject("invalid operation retention metadata"));
            }
            let a = Self::record(&conn, &consumer, &operation)?
                .ok_or_else(|| reject("missing retained operation"))?;
            result.push((a, created as u64, released != 0));
        }
        Ok(result)
    }
    pub fn execution_released(&self, consumer: &str, operation: &str) -> Result<bool> {
        self.connect()?
            .query_row(
                "SELECT exec_released FROM operations WHERE consumer=?1 AND operation=?2",
                params![consumer, operation],
                |r| r.get::<_, i64>(0),
            )
            .map_err(sql)
            .and_then(|value| {
                if matches!(value, 0 | 1) {
                    Ok(value != 0)
                } else {
                    Err(reject("invalid execution retention flag"))
                }
            })
    }
    pub fn busy(&self, package: &str) -> Result<bool> {
        if self.snapshot_jobs()?.jobs.iter().any(|j| {
            j.owner.package_id == package
                && !j.state.terminal()
                && !matches!(
                    j.phase.as_deref(),
                    Some("stopped" | "provider_result_discarded")
                )
        }) {
            return Ok(true);
        }
        if self
            .claims()?
            .iter()
            .any(|a| a.consumer.package_id == package || a.provider.package_id == package)
        {
            return Ok(true);
        }
        let conn = self.connect()?;
        let count: i64 = conn
            .query_row("SELECT count(*) FROM operations WHERE consumer=?1 AND admission IS NULL AND phase!='released'", [package], |r| r.get(0))
            .map_err(sql)?;
        Ok(count > 0)
    }
    pub fn claims(&self) -> Result<Vec<Admission>> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT consumer,operation,exec_released FROM operations WHERE (admission IS NOT NULL AND ((phase!='released' AND (exec_released=0 OR json_extract(admission,'$.output') IS NOT NULL)) OR json_extract(admission,'$.phase') IS NOT phase)) OR exec_released NOT IN(0,1)")
            .map_err(sql)?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            })
            .map_err(sql)?;
        let mut claims = Vec::new();
        for row in rows {
            let (consumer, op, released) = row.map_err(sql)?;
            if let Some(a) = Self::record(&conn, &consumer, &op)? {
                if a.phase != AdmissionPhase::Released && (!released || a.output.is_some()) {
                    claims.push(a);
                }
            }
        }
        Ok(claims)
    }
    pub(super) fn preparation_owner(
        conn: &Connection,
        consumer: &str,
        op: &str,
    ) -> Result<Option<PackageGeneration>> {
        if !identity(consumer) || !identity(op) {
            return Err(reject("invalid preparation identity"));
        }
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT owner,phase FROM operations WHERE consumer=?1 AND operation=?2",
                params![consumer, op],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        let Some((owner, stored_phase)) = row else {
            return Ok(None);
        };
        let admission = Self::record(conn, consumer, op)?;
        if stored_phase != "reserved" {
            return Ok(None);
        }
        // Once reserved, Admission.consumer is the current live owner. The
        // snapshot's original owner remains evidence, and may have a previous
        // incarnation after a same-package/digest local replay.
        let owner = match admission {
            Some(a) => a.consumer,
            None => decode(&owner)?,
        };
        generation(&owner)?;
        Ok(Some(owner))
    }
    pub(super) fn preparation_rows(&self) -> Result<Vec<(String, PackageGeneration)>> {
        let conn = self.connect()?;
        let mut query = conn
            .prepare("SELECT consumer,operation FROM operations WHERE phase='reserved'")
            .map_err(sql)?;
        let keys = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        let mut rows = Vec::new();
        for (consumer, op) in keys {
            if let Some(owner) = Self::preparation_owner(&conn, &consumer, &op)? {
                rows.push((op, owner));
            }
        }
        Ok(rows)
    }
    pub fn list_preparations(&self) -> Result<Vec<PackageGeneration>> {
        let mut owners = Vec::new();
        for (_, owner) in self.preparation_rows()? {
            if !owners.contains(&owner) {
                owners.push(owner);
            }
        }
        Ok(owners)
    }
    pub fn register_consumer_root(&self, package: &str, path: PathBuf) -> Result<()> {
        if !identity(package) {
            return Err(reject("invalid consumer package"));
        }
        let path = super::artifacts::canonical_regular_directory(&path)?;
        if path.starts_with(&self.root) || self.root.starts_with(&path) {
            return Err(reject(
                "consumer storage must be separate from host service state",
            ));
        }
        self.transaction(|tx| {
            tx.execute("INSERT INTO roots(package,path)VALUES(?1,?2)ON CONFLICT(package)DO UPDATE SET path=excluded.path", params![package, path.to_string_lossy()])
                .map_err(sql)?;
            Ok(())
        })
    }
    pub fn release_unaccepted(&self, caller: &PackageGeneration, op: &str) -> Result<bool> {
        let released = self.transaction(|tx| {
            let row: Option<(String, String)> = tx
                .query_row(
                    "SELECT owner,phase FROM operations WHERE consumer=?1 AND operation=?2",
                    params![caller.package_id, op],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(sql)?;
            let Some((owner, phase)) = row else {
                return Ok(false);
            };
            if !same_owner(&decode::<PackageGeneration>(&owner)?, caller)
                || !matches!(phase.as_str(), "reserved" | "released")
            {
                return Err(reject("forwarded operations cannot release preparations"));
            }
            if let Some(mut a) = Self::record(tx, &caller.package_id, op)? {
                if a.phase == AdmissionPhase::Released {
                    if a.disposition.as_deref() != Some("never_forwarded") {
                        return Err(reject("forwarded handoff cannot release preparations"));
                    }
                    return Ok(true);
                }
                a.phase = AdmissionPhase::Released;
                a.disposition = Some("never_forwarded".into());
                Self::persist(tx, &a)?;
            } else {
                tx.execute(
                    "UPDATE operations SET phase='released' WHERE consumer=?1 AND operation=?2",
                    params![caller.package_id, op],
                )
                .map_err(sql)?;
            }
            Ok(true)
        })?;
        self.collect_released(&caller.package_id, op)?;
        Ok(released)
    }
}

impl Store {
    pub fn verify_acquisition(
        &self,
        consumer: &PackageGeneration,
        op: &str,
        output_sha256: &str,
        receipt: &str,
    ) -> Result<()> {
        let a = self.verify_consumer(consumer, op)?;
        if !matches!(a.phase, AdmissionPhase::Terminal | AdmissionPhase::Released)
            || a.output.as_ref().is_none_or(|d| d.sha256 != output_sha256)
        {
            return Err(reject("receipt does not refer to this terminal output"));
        }
        Self::verify_acquisition_at(&self.connect()?, &a, receipt)
    }
    pub(super) fn verify_acquisition_at(
        conn: &Connection,
        a: &Admission,
        receipt: &str,
    ) -> Result<()> {
        let record: Option<(String, String)> = conn
            .query_row(
                "SELECT receipt,descriptor FROM evidence WHERE consumer=?1 AND operation=?2",
                params![a.consumer.package_id, a.operation_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        let Some((id, raw)) = record else {
            return Err(reject("acquisition receipt or output identity is invalid"));
        };
        if id != receipt || Some(decode::<ArtifactDescriptor>(&raw)?) != a.output {
            return Err(reject("acquisition receipt or output identity is invalid"));
        }
        Ok(())
    }
}
