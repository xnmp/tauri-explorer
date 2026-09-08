//! Bounded SQLite storage for opaque recovery records.

use crate::error::AppError;
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use std::{collections::HashSet, path::Path, time::Duration};

pub(crate) const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const MAX_RECORDS: usize = 1024;

const SCHEMA_VERSION: i64 = 1;
const SCHEMA_SQL: &str = include_str!("schema.sql");
const MAX_ID_BYTES: usize = 96;
const MAX_DATABASE_BYTES: i64 = 96 * 1024 * 1024;
const MAX_SCHEMA_OBJECTS: usize = 16;
const MAX_SCHEMA_NAME_BYTES: usize = 256;
const MAX_SCHEMA_SQL_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecordKind {
    Operation,
    Reservation,
}

impl RecordKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Operation => "operation",
            Self::Reservation => "reservation",
        }
    }

    fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "operation" => Ok(Self::Operation),
            "reservation" => Ok(Self::Reservation),
            _ => Err(invalid("record kind is not recognized")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Record {
    pub id: String,
    pub kind: RecordKind,
    pub generation: u64,
    pub payload: Vec<u8>,
}

/// Borrowed input for an atomic admission commit; output records own their bytes.
pub(crate) struct NewRecord<'a> {
    pub id: &'a str,
    pub kind: RecordKind,
    pub payload: &'a [u8],
}

pub(crate) struct Journal {
    connection: Connection,
}

impl Journal {
    #[cfg(test)]
    pub(crate) fn open(path: &Path) -> Result<Self, AppError> {
        let connection = Connection::open(path).map_err(|error| sql("open database", error))?;
        Self::initialize(connection)
    }

    /// Opens only a precreated database beneath the caller's retained anchor.
    /// The caller owns namespace identity checks around every journal call.
    pub(crate) fn open_existing(path: &Path) -> Result<Self, AppError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let connection = Connection::open_with_flags(path, flags)
            .map_err(|error| sql("open existing database", error))?;
        if !opened_path_matches(&connection, path)? {
            return Err(invalid(
                "opened database path does not match the requested path",
            ));
        }
        Self::initialize(connection)
    }

    fn initialize(mut connection: Connection) -> Result<Self, AppError> {
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| sql("configure busy timeout", error))?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|error| sql("enable foreign keys", error))?;
        connection
            .pragma_update(None, "trusted_schema", false)
            .map_err(|error| sql("disable trusted schema", error))?;

        let version = user_version(&connection)?;
        if version > SCHEMA_VERSION {
            return Err(invalid(format!(
                "database schema version {version} is newer than supported version {SCHEMA_VERSION}"
            )));
        }
        if version < 0 {
            return Err(invalid("database schema version is negative"));
        }
        if version == 0 && user_schema_object_count(&connection)? != 0 {
            return Err(invalid("version-zero database is not empty"));
        }

        if version == 0 {
            configure_durability(&connection)?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| sql("begin schema creation", error))?;
            if user_version(&transaction)? != 0 || user_schema_object_count(&transaction)? != 0 {
                return Err(invalid("database changed while preparing schema creation"));
            }
            transaction
                .execute_batch(SCHEMA_SQL)
                .map_err(|error| sql("create schema", error))?;
            transaction
                .commit()
                .map_err(|error| sql("commit schema creation", error))?;
        } else {
            // Recognize the expected schema and bounded row domain before a
            // persistent journal-mode or page-limit pragma can touch an
            // unrelated database carrying the same user_version.
            validate_known_schema(&connection)?;
            validate_revision(&connection)?;
            validate_record_metadata(&connection)?;
            configure_durability(&connection)?;
        }
        configure_page_limit(&connection)?;
        validate_revision(&connection)?;

        Ok(Self { connection })
    }

    pub(crate) fn revision(&self) -> Result<u64, AppError> {
        validate_revision(&self.connection)
    }

    pub(crate) fn records(&self) -> Result<Vec<Record>, AppError> {
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| sql("begin record snapshot", error))?;
        validate_revision(&transaction)?;
        let (count, expected_total) = validate_record_metadata(&transaction)?;
        let records = {
            let mut statement = transaction
                .prepare(
                    "SELECT
                        CASE
                          WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= ?1
                          THEN id
                        END,
                        CASE
                          WHEN typeof(kind) = 'text'
                               AND kind IN ('operation', 'reservation')
                          THEN kind
                        END,
                        generation,
                        CASE
                          WHEN typeof(payload) = 'blob' AND length(payload) <= ?2
                          THEN payload
                        END,
                        length(payload)
                     FROM recovery_records
                     ORDER BY id
                     LIMIT ?3",
                )
                .map_err(|error| sql("prepare bounded record read", error))?;
            let mut rows = statement
                .query(params![
                    MAX_ID_BYTES as i64,
                    MAX_RECORD_BYTES as i64,
                    (MAX_RECORDS + 1) as i64
                ])
                .map_err(|error| sql("query bounded records", error))?;
            let mut records = Vec::with_capacity(count);
            let mut actual_total = 0usize;
            while let Some(row) = rows
                .next()
                .map_err(|error| sql("read bounded record", error))?
            {
                if records.len() == MAX_RECORDS {
                    return Err(invalid("record count exceeds storage limit"));
                }
                let id = row
                    .get::<_, Option<String>>(0)
                    .map_err(|error| sql("read record ID", error))?
                    .ok_or_else(|| invalid("record ID has an invalid storage type or length"))?;
                validate_id(&id)?;
                let kind = row
                    .get::<_, Option<String>>(1)
                    .map_err(|error| sql("read record kind", error))?
                    .ok_or_else(|| invalid("record kind is not recognized"))?;
                let generation = positive_generation(
                    row.get::<_, i64>(2)
                        .map_err(|error| sql("read record generation", error))?,
                )?;
                let payload = row
                    .get::<_, Option<Vec<u8>>>(3)
                    .map_err(|error| sql("read bounded record payload", error))?
                    .ok_or_else(|| invalid("record payload has an invalid storage type or size"))?;
                let stored_length = row
                    .get::<_, Option<i64>>(4)
                    .map_err(|error| sql("read record payload length", error))?
                    .ok_or_else(|| invalid("record payload length is unavailable"))?;
                let stored_length = bounded_length(stored_length, MAX_RECORD_BYTES, "record")?;
                if payload.len() != stored_length {
                    return Err(invalid("record payload length changed while reading"));
                }
                actual_total = actual_total
                    .checked_add(payload.len())
                    .ok_or_else(|| invalid("total record payload size overflowed"))?;
                if actual_total > MAX_TOTAL_BYTES {
                    return Err(invalid("total record payload size exceeds storage limit"));
                }
                records.push(Record {
                    id,
                    kind: RecordKind::parse(&kind)?,
                    generation,
                    payload,
                });
            }
            if records.len() != count || actual_total != expected_total {
                return Err(invalid("record snapshot changed while reading"));
            }
            records
        };
        transaction
            .commit()
            .map_err(|error| sql("finish record snapshot", error))?;
        Ok(records)
    }

    #[cfg(test)]
    pub(crate) fn insert(
        &mut self,
        id: &str,
        kind: RecordKind,
        payload: &[u8],
    ) -> Result<Record, AppError> {
        self.insert_batch(&[NewRecord { id, kind, payload }])
            .map(|mut records| records.pop().expect("one requested record"))
    }

    /// Admit all records or none. Each child retains a unique generation and
    /// can subsequently promote/finish independently under ordinary CAS rules.
    pub(crate) fn insert_batch(
        &mut self,
        records: &[NewRecord<'_>],
    ) -> Result<Vec<Record>, AppError> {
        if records.is_empty() {
            return Ok(Vec::new());
        }
        if records.len() > MAX_RECORDS {
            return Err(invalid("record count exceeds storage limit"));
        }
        let mut bytes = 0usize;
        for record in records {
            validate_id(record.id)?;
            validate_payload(record.payload)?;
            bytes = bytes
                .checked_add(record.payload.len())
                .filter(|bytes| *bytes <= MAX_TOTAL_BYTES)
                .ok_or_else(|| invalid("record payloads exceed total storage limit"))?;
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sql("begin record insert", error))?;
        let (count, total) = validate_record_metadata(&transaction)?;
        if count + records.len() > MAX_RECORDS {
            return Err(invalid("record count exceeds storage limit"));
        }
        ensure_total(total, 0, bytes)?;
        let (revision, _) = next_revision(&transaction)?;
        let next = revision
            .checked_add(records.len() as i64)
            .ok_or_else(|| invalid("journal revision is exhausted"))?;
        let mut inserted = Vec::with_capacity(records.len());
        for (index, record) in records.iter().enumerate() {
            let generation = revision + index as i64 + 1;
            transaction.execute(
                "INSERT INTO recovery_records(id, kind, generation, payload) VALUES(?1, ?2, ?3, ?4)",
                params![record.id, record.kind.as_str(), generation, record.payload],
            ).map_err(|error| sql("insert record", error))?;
            inserted.push(Record {
                id: record.id.to_owned(),
                kind: record.kind,
                generation: generation as u64,
                payload: record.payload.to_vec(),
            });
        }
        advance_revision(&transaction, revision, next)?;
        transaction
            .commit()
            .map_err(|error| sql("commit record insert", error))?;
        Ok(inserted)
    }

    pub(crate) fn replace(
        &mut self,
        id: &str,
        expected_generation: u64,
        payload: &[u8],
    ) -> Result<Record, AppError> {
        validate_id(id)?;
        validate_payload(payload)?;
        let expected_generation = stored_generation(expected_generation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sql("begin record replacement", error))?;
        let (_, total) = validate_record_metadata(&transaction)?;
        let (kind, generation, old_length) = transaction
            .query_row(
                "SELECT kind, generation, length(payload)
                 FROM recovery_records WHERE id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| sql("read record for replacement", error))?
            .ok_or_else(|| conflict("record does not exist"))?;
        if generation != expected_generation {
            return Err(conflict("record generation does not match"));
        }
        let old_length = bounded_length(old_length, MAX_RECORD_BYTES, "record")?;
        ensure_total(total, old_length, payload.len())?;
        let kind = RecordKind::parse(&kind)?;
        let (revision, next) = next_revision(&transaction)?;
        let changed = transaction
            .execute(
                "UPDATE recovery_records
                 SET generation = ?1, payload = ?2
                 WHERE id = ?3 AND generation = ?4",
                params![next, payload, id, expected_generation],
            )
            .map_err(|error| sql("replace record", error))?;
        require_one(changed, "record replacement")?;
        advance_revision(&transaction, revision, next)?;
        transaction
            .commit()
            .map_err(|error| sql("commit record replacement", error))?;
        Ok(Record {
            id: id.to_owned(),
            kind,
            generation: next as u64,
            payload: payload.to_vec(),
        })
    }

    #[cfg(test)]
    pub(crate) fn promote(
        &mut self,
        reservation_id: &str,
        expected_generation: u64,
        operation_id: &str,
        payload: &[u8],
    ) -> Result<Record, AppError> {
        self.promote_with(
            reservation_id,
            expected_generation,
            operation_id,
            payload,
            || Ok(()),
        )
    }

    pub(crate) fn promote_with(
        &mut self,
        reservation_id: &str,
        expected_generation: u64,
        operation_id: &str,
        payload: &[u8],
        publish: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<Record, AppError> {
        validate_id(reservation_id)?;
        validate_id(operation_id)?;
        validate_payload(payload)?;
        let expected_generation = stored_generation(expected_generation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sql("begin reservation promotion", error))?;
        let (_, total) = validate_record_metadata(&transaction)?;
        let (kind, generation, old_length) = transaction
            .query_row(
                "SELECT kind, generation, length(payload)
                 FROM recovery_records WHERE id = ?1",
                [reservation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| sql("read reservation for promotion", error))?
            .ok_or_else(|| conflict("reservation does not exist"))?;
        if RecordKind::parse(&kind)? != RecordKind::Reservation {
            return Err(conflict("record is not a reservation"));
        }
        if generation != expected_generation {
            return Err(conflict("reservation generation does not match"));
        }
        if reservation_id != operation_id {
            let occupied = transaction
                .query_row(
                    "SELECT 1 FROM recovery_records WHERE id = ?1",
                    [operation_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|error| sql("check promoted operation ID", error))?
                .is_some();
            if occupied {
                return Err(conflict("promoted operation ID is already occupied"));
            }
        }

        let old_length = bounded_length(old_length, MAX_RECORD_BYTES, "record")?;
        ensure_total(total, old_length, payload.len())?;
        let (revision, next) = next_revision(&transaction)?;
        publish()?;
        let changed = transaction
            .execute(
                "UPDATE recovery_records
                 SET id = ?1, kind = 'operation', generation = ?2, payload = ?3
                 WHERE id = ?4 AND kind = 'reservation' AND generation = ?5",
                params![
                    operation_id,
                    next,
                    payload,
                    reservation_id,
                    expected_generation
                ],
            )
            .map_err(|error| sql("promote reservation", error))?;
        require_one(changed, "reservation promotion")?;
        advance_revision(&transaction, revision, next)?;
        transaction
            .commit()
            .map_err(|error| sql("commit reservation promotion", error))?;
        Ok(Record {
            id: operation_id.to_owned(),
            kind: RecordKind::Operation,
            generation: next as u64,
            payload: payload.to_vec(),
        })
    }

    pub(crate) fn remove(&mut self, id: &str, expected_generation: u64) -> Result<u64, AppError> {
        validate_id(id)?;
        let expected_generation = stored_generation(expected_generation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sql("begin record removal", error))?;
        validate_record_metadata(&transaction)?;
        let (revision, next) = next_revision(&transaction)?;
        let changed = transaction
            .execute(
                "DELETE FROM recovery_records WHERE id = ?1 AND generation = ?2",
                params![id, expected_generation],
            )
            .map_err(|error| sql("remove record", error))?;
        require_one(changed, "record removal")?;
        advance_revision(&transaction, revision, next)?;
        transaction
            .commit()
            .map_err(|error| sql("commit record removal", error))?;
        Ok(next as u64)
    }
}

#[cfg(unix)]
fn opened_path_matches(connection: &Connection, requested: &Path) -> Result<bool, AppError> {
    use std::{ffi::CStr, os::unix::ffi::OsStrExt};

    // SAFETY: the connection remains alive while SQLite's owned filename is read;
    // sqlite3_db_filename returns either null or a terminated connection-owned string.
    let actual = unsafe {
        let pointer = rusqlite::ffi::sqlite3_db_filename(connection.handle(), c"main".as_ptr());
        if pointer.is_null() {
            return Err(invalid("opened database has no main filename"));
        }
        CStr::from_ptr(pointer)
    };
    Ok(actual.to_bytes() == requested.as_os_str().as_bytes())
}

#[cfg(not(unix))]
fn opened_path_matches(connection: &Connection, requested: &Path) -> Result<bool, AppError> {
    let actual = connection
        .path()
        .map(Path::new)
        .ok_or_else(|| invalid("opened database path is not representable as a native path"))?;
    Ok(actual == requested)
}

fn configure_durability(connection: &Connection) -> Result<(), AppError> {
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|error| sql("set rollback journal mode", error))?;
    let mode: String = connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|error| sql("verify rollback journal mode", error))?;
    if !mode.eq_ignore_ascii_case("delete") {
        return Err(invalid(format!(
            "rollback journal mode is {mode}, expected DELETE"
        )));
    }
    connection
        .pragma_update(None, "synchronous", "EXTRA")
        .map_err(|error| sql("set synchronous mode", error))?;
    let synchronous: i64 = connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(|error| sql("verify synchronous mode", error))?;
    if synchronous != 3 {
        return Err(invalid(format!(
            "synchronous mode is {synchronous}, expected EXTRA"
        )));
    }
    let foreign_keys: i64 = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .map_err(|error| sql("verify foreign key enforcement", error))?;
    if foreign_keys != 1 {
        return Err(invalid("foreign key enforcement is disabled"));
    }
    let trusted_schema: i64 = connection
        .pragma_query_value(None, "trusted_schema", |row| row.get(0))
        .map_err(|error| sql("verify trusted schema setting", error))?;
    if trusted_schema != 0 {
        return Err(invalid("trusted schema is enabled"));
    }
    Ok(())
}

fn configure_page_limit(connection: &Connection) -> Result<(), AppError> {
    let page_size: i64 = connection
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .map_err(|error| sql("read database page size", error))?;
    if page_size <= 0 {
        return Err(invalid("database page size is invalid"));
    }
    let maximum_pages = MAX_DATABASE_BYTES
        .checked_add(page_size - 1)
        .ok_or_else(|| invalid("database page limit overflowed"))?
        / page_size;
    let current_pages: i64 = connection
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .map_err(|error| sql("read database page count", error))?;
    if current_pages < 0 || current_pages > maximum_pages {
        return Err(invalid("database exceeds its storage page limit"));
    }
    connection
        .pragma_update(None, "max_page_count", maximum_pages)
        .map_err(|error| sql("set database page limit", error))?;
    Ok(())
}

fn validate_id(id: &str) -> Result<(), AppError> {
    if id.is_empty()
        || id.len() > MAX_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid(
            "record ID must be 1-96 ASCII letters, digits, underscores, or hyphens",
        ));
    }
    Ok(())
}

fn validate_payload(payload: &[u8]) -> Result<(), AppError> {
    if payload.len() > MAX_RECORD_BYTES {
        return Err(invalid("record payload exceeds storage limit"));
    }
    Ok(())
}

fn validate_record_metadata(connection: &Connection) -> Result<(usize, usize), AppError> {
    let revision = validate_revision(connection)?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM recovery_records", [], |row| {
            row.get(0)
        })
        .map_err(|error| sql("count records", error))?;
    let count = usize::try_from(count).map_err(|_| invalid("record count is invalid"))?;
    if count > MAX_RECORDS {
        return Err(invalid("record count exceeds storage limit"));
    }

    let mut statement = connection
        .prepare(
            "SELECT
                CASE
                  WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) <= ?1
                  THEN id
                END,
                CASE
                  WHEN typeof(kind) = 'text'
                       AND kind IN ('operation', 'reservation')
                  THEN kind
                END,
                generation,
                typeof(payload),
                length(payload)
             FROM recovery_records
             LIMIT ?2",
        )
        .map_err(|error| sql("prepare record validation", error))?;
    let mut rows = statement
        .query(params![MAX_ID_BYTES as i64, (MAX_RECORDS + 1) as i64])
        .map_err(|error| sql("query record metadata", error))?;
    let mut seen = 0usize;
    let mut total = 0usize;
    let mut generations = HashSet::with_capacity(count);
    while let Some(row) = rows
        .next()
        .map_err(|error| sql("read record metadata", error))?
    {
        seen += 1;
        if seen > MAX_RECORDS {
            return Err(invalid("record count exceeds storage limit"));
        }
        let id = row
            .get::<_, Option<String>>(0)
            .map_err(|error| sql("validate record ID", error))?
            .ok_or_else(|| invalid("record ID has an invalid storage type or length"))?;
        validate_id(&id)?;
        let kind = row
            .get::<_, Option<String>>(1)
            .map_err(|error| sql("validate record kind", error))?
            .ok_or_else(|| invalid("record kind is not recognized"))?;
        RecordKind::parse(&kind)?;
        let generation = positive_generation(
            row.get::<_, i64>(2)
                .map_err(|error| sql("validate record generation", error))?,
        )?;
        if generation > revision {
            return Err(invalid("record generation exceeds journal revision"));
        }
        if !generations.insert(generation) {
            return Err(invalid("record generations are not unique"));
        }
        let payload_type = row
            .get::<_, String>(3)
            .map_err(|error| sql("validate record payload type", error))?;
        if payload_type != "blob" {
            return Err(invalid("record payload is not an opaque byte string"));
        }
        let length = row
            .get::<_, Option<i64>>(4)
            .map_err(|error| sql("validate record payload length", error))?
            .ok_or_else(|| invalid("record payload length is unavailable"))?;
        let length = bounded_length(length, MAX_RECORD_BYTES, "record")?;
        total = total
            .checked_add(length)
            .ok_or_else(|| invalid("total record payload size overflowed"))?;
        if total > MAX_TOTAL_BYTES {
            return Err(invalid("total record payload size exceeds storage limit"));
        }
    }
    if seen != count {
        return Err(invalid("record count changed while validating"));
    }
    Ok((count, total))
}

fn ensure_total(total: usize, removed: usize, added: usize) -> Result<(), AppError> {
    let next = total
        .checked_sub(removed)
        .and_then(|value| value.checked_add(added))
        .ok_or_else(|| invalid("total record payload size overflowed"))?;
    if next > MAX_TOTAL_BYTES {
        return Err(invalid("total record payload size exceeds storage limit"));
    }
    Ok(())
}

fn bounded_length(value: i64, maximum: usize, label: &str) -> Result<usize, AppError> {
    let value = usize::try_from(value).map_err(|_| invalid(format!("{label} size is invalid")))?;
    if value > maximum {
        return Err(invalid(format!("{label} payload exceeds storage limit")));
    }
    Ok(value)
}

fn user_version(connection: &Connection) -> Result<i64, AppError> {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| sql("read schema version", error))
}

fn user_schema_object_count(connection: &Connection) -> Result<i64, AppError> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sql("inspect existing schema", error))
}

#[derive(Debug, Eq, PartialEq)]
struct SchemaObject {
    object_type: String,
    name: String,
    table_name: String,
    definition: String,
}

fn validate_known_schema(connection: &Connection) -> Result<(), AppError> {
    let expected = Connection::open_in_memory()
        .map_err(|error| sql("open canonical schema database", error))?;
    expected
        .execute_batch(SCHEMA_SQL)
        .map_err(|error| sql("create canonical schema", error))?;
    if schema_objects(connection)? != schema_objects(&expected)? {
        return Err(invalid(
            "database schema does not match the supported schema",
        ));
    }
    Ok(())
}

fn schema_objects(connection: &Connection) -> Result<Vec<SchemaObject>, AppError> {
    let mut statement = connection
        .prepare(
            "SELECT
                CASE WHEN typeof(type) = 'text'
                           AND length(CAST(type AS BLOB)) <= ?1 THEN type END,
                CASE WHEN typeof(name) = 'text'
                           AND length(CAST(name AS BLOB)) <= ?1 THEN name END,
                CASE WHEN typeof(tbl_name) = 'text'
                           AND length(CAST(tbl_name AS BLOB)) <= ?1 THEN tbl_name END,
                CASE WHEN typeof(sql) = 'text'
                           AND length(CAST(sql AS BLOB)) <= ?2 THEN sql END
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name
             LIMIT ?3",
        )
        .map_err(|error| sql("prepare schema authentication", error))?;
    let mut rows = statement
        .query(params![
            MAX_SCHEMA_NAME_BYTES as i64,
            MAX_SCHEMA_SQL_BYTES as i64,
            (MAX_SCHEMA_OBJECTS + 1) as i64,
        ])
        .map_err(|error| sql("query schema authentication", error))?;
    let mut objects = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| sql("read schema authentication", error))?
    {
        if objects.len() == MAX_SCHEMA_OBJECTS {
            return Err(invalid("database schema contains too many objects"));
        }
        objects.push(SchemaObject {
            object_type: row
                .get::<_, Option<String>>(0)
                .map_err(|error| sql("read schema object type", error))?
                .ok_or_else(|| invalid("database schema object type is invalid"))?,
            name: row
                .get::<_, Option<String>>(1)
                .map_err(|error| sql("read schema object name", error))?
                .ok_or_else(|| invalid("database schema object name is invalid"))?,
            table_name: row
                .get::<_, Option<String>>(2)
                .map_err(|error| sql("read schema table name", error))?
                .ok_or_else(|| invalid("database schema table name is invalid"))?,
            definition: row
                .get::<_, Option<String>>(3)
                .map_err(|error| sql("read schema definition", error))?
                .ok_or_else(|| invalid("database schema definition is invalid"))?,
        });
    }
    Ok(objects)
}

fn validate_revision(connection: &Connection) -> Result<u64, AppError> {
    let mut statement = connection
        .prepare("SELECT singleton, revision FROM recovery_meta ORDER BY singleton LIMIT 2")
        .map_err(|error| sql("prepare journal revision", error))?;
    let mut rows = statement
        .query([])
        .map_err(|error| sql("query journal revision", error))?;
    let row = rows
        .next()
        .map_err(|error| sql("read journal revision", error))?
        .ok_or_else(|| invalid("journal revision is missing"))?;
    let singleton: i64 = row
        .get(0)
        .map_err(|error| sql("read journal revision singleton", error))?;
    let revision: i64 = row
        .get(1)
        .map_err(|error| sql("read journal revision value", error))?;
    if singleton != 1
        || rows
            .next()
            .map_err(|error| sql("check journal revision uniqueness", error))?
            .is_some()
    {
        return Err(invalid("journal revision singleton is invalid"));
    }
    u64::try_from(revision).map_err(|_| invalid("journal revision is invalid"))
}

fn next_revision(transaction: &Transaction<'_>) -> Result<(i64, i64), AppError> {
    let revision = validate_revision(transaction)?;
    let revision = i64::try_from(revision).map_err(|_| invalid("journal revision is invalid"))?;
    let next = revision
        .checked_add(1)
        .ok_or_else(|| invalid("journal revision is exhausted"))?;
    Ok((revision, next))
}

fn advance_revision(
    transaction: &Transaction<'_>,
    revision: i64,
    next: i64,
) -> Result<(), AppError> {
    let changed = transaction
        .execute(
            "UPDATE recovery_meta SET revision = ?1
             WHERE singleton = 1 AND revision = ?2",
            params![next, revision],
        )
        .map_err(|error| sql("advance journal revision", error))?;
    require_one(changed, "journal revision update")
}

fn positive_generation(generation: i64) -> Result<u64, AppError> {
    if generation <= 0 {
        return Err(invalid("record generation is invalid"));
    }
    Ok(generation as u64)
}

fn stored_generation(generation: u64) -> Result<i64, AppError> {
    let generation = i64::try_from(generation)
        .map_err(|_| invalid("expected record generation exceeds storage range"))?;
    if generation <= 0 {
        return Err(invalid("expected record generation is invalid"));
    }
    Ok(generation)
}

fn require_one(changed: usize, operation: &str) -> Result<(), AppError> {
    if changed == 1 {
        Ok(())
    } else {
        Err(conflict(format!(
            "{operation} did not match the expected record generation"
        )))
    }
}

fn sql(context: &str, error: rusqlite::Error) -> AppError {
    AppError::Other(format!("Recovery journal could not {context}: {error}"))
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Other(format!("Recovery journal is invalid: {}", message.into()))
}

fn conflict(message: impl Into<String>) -> AppError {
    AppError::Other(format!("Recovery journal conflict: {}", message.into()))
}

#[cfg(test)]
#[path = "../../../test_support/recovery_journal.rs"]
mod tests;
