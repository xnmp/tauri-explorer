use super::*;
use std::{fs, path::PathBuf};

fn database_path() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let path = directory
        .path()
        .canonicalize()
        .expect("canonical temporary journal directory")
        .join("recovery.sqlite3");
    (directory, path)
}

#[test]
fn batch_insert_is_atomic_when_a_later_child_collides() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    journal
        .insert("existing", RecordKind::Reservation, b"original")
        .unwrap();
    let before = journal.records().unwrap();
    let revision = journal.revision().unwrap();
    assert!(journal
        .insert_batch(&[
            NewRecord {
                id: "first",
                kind: RecordKind::Reservation,
                payload: b"first"
            },
            NewRecord {
                id: "existing",
                kind: RecordKind::Reservation,
                payload: b"replacement"
            },
        ])
        .is_err());
    assert_eq!(journal.records().unwrap(), before);
    assert_eq!(journal.revision().unwrap(), revision);
    drop(journal);
    assert_eq!(Journal::open(&path).unwrap().records().unwrap(), before);
}

#[test]
fn batch_children_have_independent_cas_generations_after_reopen() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let children = journal
        .insert_batch(&[
            NewRecord {
                id: "first",
                kind: RecordKind::Reservation,
                payload: b"first",
            },
            NewRecord {
                id: "second",
                kind: RecordKind::Reservation,
                payload: b"second",
            },
        ])
        .unwrap();
    assert_ne!(children[0].generation, children[1].generation);
    drop(journal);
    let mut journal = Journal::open(&path).unwrap();
    journal.remove("first", children[0].generation).unwrap();
    assert!(journal.remove("second", children[0].generation).is_err());
    assert_eq!(journal.records().unwrap(), vec![children[1].clone()]);
    journal.remove("second", children[1].generation).unwrap();
    assert!(journal.records().unwrap().is_empty());
}

#[test]
fn batch_capacity_failure_preserves_existing_records_and_revision() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let ids: Vec<_> = (0..MAX_RECORDS - 1)
        .map(|i| format!("reserved-{i}"))
        .collect();
    let records: Vec<_> = ids
        .iter()
        .map(|id| NewRecord {
            id,
            kind: RecordKind::Reservation,
            payload: b"",
        })
        .collect();
    journal.insert_batch(&records).unwrap();
    let before = journal.records().unwrap();
    let revision = journal.revision().unwrap();
    assert!(journal
        .insert_batch(&[
            NewRecord {
                id: "last",
                kind: RecordKind::Reservation,
                payload: b""
            },
            NewRecord {
                id: "overflow",
                kind: RecordKind::Reservation,
                payload: b""
            },
        ])
        .is_err());
    assert_eq!(journal.records().unwrap(), before);
    assert_eq!(journal.revision().unwrap(), revision);
}

#[test]
fn open_existing_never_creates_a_missing_database() {
    let (_directory, path) = database_path();

    assert!(Journal::open_existing(&path).is_err());
    assert!(!path.exists());
}

#[test]
fn open_existing_initializes_a_precreated_empty_database() {
    let (_directory, path) = database_path();
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();

    let journal = Journal::open_existing(&path).unwrap();

    assert_eq!(journal.revision().unwrap(), 0);
    drop(journal);
    assert!(fs::metadata(&path).unwrap().len() > 0);
    assert_eq!(
        Journal::open_existing(&path).unwrap().revision().unwrap(),
        0
    );
}

#[cfg(unix)]
#[test]
fn open_existing_rejects_a_symbolic_link_database_path() {
    use std::os::unix::fs::symlink;

    let (directory, link) = database_path();
    let target = directory.path().join("actual.sqlite3");
    fs::File::create(&target).unwrap();
    symlink(&target, &link).unwrap();

    assert!(Journal::open_existing(&link).is_err());
    assert_eq!(fs::metadata(target).unwrap().len(), 0);
}

#[cfg(unix)]
#[test]
fn open_existing_preserves_a_non_utf8_native_database_path() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    let parent = tempfile::tempdir().unwrap();
    let directory = parent.path().join(OsString::from_vec(vec![
        b'n', b'a', b't', b'i', b'v', b'e', b'-', 0xff,
    ]));
    fs::create_dir(&directory).unwrap();
    let directory = directory.canonicalize().unwrap();
    let path = directory.join("recovery.sqlite3");
    fs::File::create(&path).unwrap();

    let mut journal = Journal::open_existing(&path).unwrap();
    let inserted = journal
        .insert("native-path", RecordKind::Operation, b"opaque")
        .unwrap();
    drop(journal);

    assert_eq!(
        Journal::open_existing(&path).unwrap().records().unwrap(),
        vec![inserted]
    );
}

#[test]
fn reopen_preserves_opaque_bytes_kinds_and_revision() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).expect("new journal");
    assert_eq!(journal.revision().unwrap(), 0);
    let first = journal
        .insert("operation-1", RecordKind::Operation, b"\0opaque\xff")
        .expect("insert operation");
    let second = journal
        .insert("reservation_2", RecordKind::Reservation, b"reserved")
        .expect("insert reservation");
    assert_eq!(first.generation, 1);
    assert_eq!(second.generation, 2);
    drop(journal);

    let reopened = Journal::open(&path).expect("reopen journal");

    assert_eq!(reopened.revision().unwrap(), 2);
    assert_eq!(
        reopened.records().unwrap(),
        vec![
            Record {
                id: "operation-1".into(),
                kind: RecordKind::Operation,
                generation: 1,
                payload: b"\0opaque\xff".to_vec(),
            },
            Record {
                id: "reservation_2".into(),
                kind: RecordKind::Reservation,
                generation: 2,
                payload: b"reserved".to_vec(),
            },
        ]
    );
}

#[test]
fn accepted_connection_uses_the_required_sqlite_safety_configuration() {
    let (_directory, path) = database_path();
    let journal = Journal::open(&path).unwrap();

    let journal_mode: String = journal
        .connection
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .unwrap();
    let synchronous: i64 = journal
        .connection
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .unwrap();
    let foreign_keys: i64 = journal
        .connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .unwrap();
    let trusted_schema: i64 = journal
        .connection
        .pragma_query_value(None, "trusted_schema", |row| row.get(0))
        .unwrap();

    assert_eq!(journal_mode.to_ascii_lowercase(), "delete");
    assert_eq!(synchronous, 3);
    assert_eq!(foreign_keys, 1);
    assert_eq!(trusted_schema, 0);
}

#[test]
fn stale_generation_cannot_replace_or_remove_a_record() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let inserted = journal
        .insert("operation", RecordKind::Operation, b"original")
        .unwrap();

    assert!(journal
        .replace("operation", inserted.generation + 1, b"forged")
        .is_err());
    assert!(journal
        .remove("operation", inserted.generation + 1)
        .is_err());

    assert_eq!(journal.revision().unwrap(), inserted.generation);
    assert_eq!(journal.records().unwrap(), vec![inserted]);
}

#[test]
fn two_connections_cannot_settle_one_observed_generation_twice() {
    let (_directory, path) = database_path();
    let mut first = Journal::open(&path).unwrap();
    let mut second = Journal::open(&path).unwrap();
    let inserted = first
        .insert("shared", RecordKind::Reservation, b"pending")
        .unwrap();
    let observed = second.records().unwrap().pop().unwrap();
    assert_eq!(observed.generation, inserted.generation);

    let replaced = first
        .replace("shared", observed.generation, b"settled by first")
        .unwrap();
    let error = second
        .replace("shared", observed.generation, b"settled by second")
        .expect_err("stale second connection must lose");

    assert!(error.to_string().contains("generation"));
    assert_eq!(second.revision().unwrap(), replaced.generation);
    assert_eq!(second.records().unwrap(), vec![replaced]);
}

#[test]
fn promotion_atomically_persists_the_operation_identity_kind_generation_and_payload() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let reservation = journal
        .insert(
            "reservation-before",
            RecordKind::Reservation,
            b"reserved payload",
        )
        .unwrap();

    let operation = journal
        .promote(
            &reservation.id,
            reservation.generation,
            "operation-after",
            b"committed payload",
        )
        .unwrap();

    assert_eq!(
        operation,
        Record {
            id: "operation-after".into(),
            kind: RecordKind::Operation,
            generation: 2,
            payload: b"committed payload".to_vec(),
        }
    );
    assert_eq!(journal.revision().unwrap(), operation.generation);
    assert_eq!(journal.records().unwrap(), vec![operation.clone()]);
    drop(journal);
    assert_eq!(
        Journal::open(&path).unwrap().records().unwrap(),
        vec![operation]
    );
}

#[test]
fn promotion_can_retain_the_reservation_id() {
    use std::cell::Cell;

    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let reservation = journal
        .insert("same-id", RecordKind::Reservation, b"reserved")
        .unwrap();
    let publications = Cell::new(0);

    let operation = journal
        .promote_with(
            &reservation.id,
            reservation.generation,
            &reservation.id,
            b"operation",
            || {
                publications.set(publications.get() + 1);
                Ok(())
            },
        )
        .unwrap();

    assert_eq!(publications.get(), 1);
    assert_eq!(operation.id, reservation.id);
    assert_eq!(operation.kind, RecordKind::Operation);
    assert_eq!(operation.payload, b"operation");
    assert_eq!(journal.records().unwrap(), vec![operation]);
}

#[test]
fn rejected_promotion_preconditions_never_publish() {
    use std::cell::Cell;

    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let wrong_kind = journal
        .insert("wrong-kind", RecordKind::Operation, b"operation")
        .unwrap();
    let reservation = journal
        .insert("reserved", RecordKind::Reservation, b"reserved")
        .unwrap();
    let occupied = journal
        .insert("occupied-target", RecordKind::Operation, b"occupied")
        .unwrap();
    let publications = Cell::new(0);
    let publish = || {
        publications.set(publications.get() + 1);
        Ok(())
    };

    assert!(journal
        .promote_with("bad/id", 1, "never", b"ignored", publish)
        .is_err());
    assert!(journal
        .promote_with(
            &reservation.id,
            reservation.generation,
            "oversized",
            &vec![0x5a; MAX_RECORD_BYTES + 1],
            publish,
        )
        .is_err());
    assert!(journal
        .promote_with(
            &reservation.id,
            reservation.generation + 1,
            "stale",
            b"ignored",
            publish,
        )
        .is_err());
    assert!(journal
        .promote_with(
            &wrong_kind.id,
            wrong_kind.generation,
            "wrong-kind-result",
            b"ignored",
            publish,
        )
        .is_err());
    assert!(journal
        .promote_with(
            &reservation.id,
            reservation.generation,
            &occupied.id,
            b"ignored",
            publish,
        )
        .is_err());

    assert_eq!(publications.get(), 0);
}

#[test]
fn exhausted_revision_rejects_promotion_before_publication() {
    use std::cell::Cell;

    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let reservation = journal
        .insert("reserved", RecordKind::Reservation, b"reserved")
        .unwrap();
    drop(journal);
    let raw = Connection::open(&path).unwrap();
    raw.execute("UPDATE recovery_meta SET revision = ?1", [i64::MAX])
        .unwrap();
    drop(raw);
    let mut journal = Journal::open(&path).unwrap();
    let publications = Cell::new(0);

    assert!(journal
        .promote_with(
            &reservation.id,
            reservation.generation,
            "never-published",
            b"operation",
            || {
                publications.set(publications.get() + 1);
                Ok(())
            },
        )
        .is_err());

    assert_eq!(publications.get(), 0);
    assert_eq!(journal.revision().unwrap(), i64::MAX as u64);
    assert_eq!(journal.records().unwrap(), vec![reservation]);
}

#[test]
fn failed_publication_rolls_back_the_unchanged_reservation_and_revision() {
    use std::cell::Cell;

    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let reservation = journal
        .insert("reserved", RecordKind::Reservation, b"reserved")
        .unwrap();
    let revision = journal.revision().unwrap();
    let publications = Cell::new(0);

    let error = journal
        .promote_with(
            &reservation.id,
            reservation.generation,
            "operation",
            b"operation",
            || {
                publications.set(publications.get() + 1);
                Err(AppError::Other("catalog publication failed".into()))
            },
        )
        .unwrap_err();

    assert_eq!(publications.get(), 1);
    assert!(error.to_string().contains("catalog publication failed"));
    assert_eq!(journal.revision().unwrap(), revision);
    assert_eq!(journal.records().unwrap(), vec![reservation.clone()]);
    drop(journal);
    assert_eq!(
        Journal::open(&path).unwrap().records().unwrap(),
        vec![reservation]
    );
}

#[test]
fn invalid_promotion_sources_and_occupied_targets_leave_the_journal_unchanged() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let wrong_kind = journal
        .insert("already-operation", RecordKind::Operation, b"operation")
        .unwrap();
    let reservation = journal
        .insert("reservation", RecordKind::Reservation, b"reserved")
        .unwrap();
    let occupied = journal
        .insert("occupied", RecordKind::Operation, b"occupied")
        .unwrap();
    let before = journal.records().unwrap();
    let revision = journal.revision().unwrap();

    assert!(journal
        .promote(
            &wrong_kind.id,
            wrong_kind.generation,
            "wrong-kind-result",
            b"ignored",
        )
        .unwrap_err()
        .to_string()
        .contains("not a reservation"));
    assert!(journal
        .promote(
            &reservation.id,
            reservation.generation + 1,
            "stale-result",
            b"ignored",
        )
        .unwrap_err()
        .to_string()
        .contains("generation"));
    assert!(journal
        .promote("missing", 1, "missing-result", b"ignored")
        .unwrap_err()
        .to_string()
        .contains("does not exist"));
    assert!(journal
        .promote(
            &reservation.id,
            reservation.generation,
            &occupied.id,
            b"ignored",
        )
        .unwrap_err()
        .to_string()
        .contains("occupied"));
    assert!(journal
        .promote(
            &reservation.id,
            reservation.generation,
            "invalid/id",
            b"ignored",
        )
        .is_err());

    assert_eq!(journal.revision().unwrap(), revision);
    assert_eq!(journal.records().unwrap(), before);
}

#[test]
fn two_connections_cannot_promote_one_reservation_generation_twice() {
    let (_directory, path) = database_path();
    let mut first = Journal::open(&path).unwrap();
    let mut second = Journal::open(&path).unwrap();
    let reservation = first
        .insert("shared-reservation", RecordKind::Reservation, b"reserved")
        .unwrap();
    let observed = second.records().unwrap().pop().unwrap();

    let promoted = first
        .promote(
            &reservation.id,
            observed.generation,
            "first-operation",
            b"first committed",
        )
        .unwrap();
    assert!(second
        .promote(
            &reservation.id,
            observed.generation,
            "second-operation",
            b"second committed",
        )
        .is_err());

    assert_eq!(second.revision().unwrap(), promoted.generation);
    assert_eq!(second.records().unwrap(), vec![promoted]);
}

#[test]
fn promotion_payload_bounds_fail_without_consuming_the_reservation() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let reservation = journal
        .insert("bounded-reservation", RecordKind::Reservation, b"reserved")
        .unwrap();
    let revision = journal.revision().unwrap();

    assert!(journal
        .promote(
            &reservation.id,
            reservation.generation,
            "oversized-operation",
            &vec![0x5a; MAX_RECORD_BYTES + 1],
        )
        .is_err());

    assert_eq!(journal.revision().unwrap(), revision);
    assert_eq!(journal.records().unwrap(), vec![reservation]);
}

#[test]
fn promotion_uses_the_replacement_delta_for_the_aggregate_budget() {
    use std::cell::Cell;

    let (_directory, path) = database_path();
    drop(Journal::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.execute(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('large', 'operation', 1, zeroblob(?1))",
        [MAX_RECORD_BYTES as i64],
    )
    .unwrap();
    raw.execute(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('extra', 'operation', 2, X'01')",
        [],
    )
    .unwrap();
    raw.execute(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('bounded-reservation', 'reservation', 3, X'02')",
        [],
    )
    .unwrap();
    raw.execute("UPDATE recovery_meta SET revision = 3", [])
        .unwrap();
    drop(raw);
    let mut journal = Journal::open(&path).unwrap();
    let publications = Cell::new(0);

    assert!(journal
        .promote_with(
            "bounded-reservation",
            3,
            "too-large-in-aggregate",
            &vec![0x5a; MAX_RECORD_BYTES],
            || {
                publications.set(publications.get() + 1);
                Ok(())
            },
        )
        .is_err());

    assert_eq!(publications.get(), 0);
    assert_eq!(journal.revision().unwrap(), 3);
    let records = journal.records().unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(
        records
            .iter()
            .find(|record| record.id == "bounded-reservation")
            .unwrap(),
        &Record {
            id: "bounded-reservation".into(),
            kind: RecordKind::Reservation,
            generation: 3,
            payload: vec![0x02],
        }
    );
}

#[test]
fn invalid_id_and_oversized_payload_leave_existing_data_unchanged() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let existing = journal
        .insert("kept", RecordKind::Operation, b"kept bytes")
        .unwrap();
    let revision = journal.revision().unwrap();

    assert!(journal
        .insert("bad/id", RecordKind::Operation, b"ignored")
        .is_err());
    assert!(journal
        .replace(
            "kept",
            existing.generation,
            &vec![0x5a; MAX_RECORD_BYTES + 1],
        )
        .is_err());

    assert_eq!(journal.revision().unwrap(), revision);
    assert_eq!(journal.records().unwrap(), vec![existing]);
}

#[test]
fn aggregate_payload_limit_rejects_the_next_write_without_advancing() {
    let (_directory, path) = database_path();
    drop(Journal::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    let transaction = raw.unchecked_transaction().unwrap();
    transaction
        .execute(
            "INSERT INTO recovery_records(id, kind, generation, payload)
             VALUES('large-a', 'operation', 1, zeroblob(?1))",
            [MAX_RECORD_BYTES as i64],
        )
        .unwrap();
    transaction
        .execute(
            "INSERT INTO recovery_records(id, kind, generation, payload)
             VALUES('large-b', 'reservation', 2, zeroblob(?1))",
            [MAX_RECORD_BYTES as i64],
        )
        .unwrap();
    transaction
        .execute("UPDATE recovery_meta SET revision = 2", [])
        .unwrap();
    transaction.commit().unwrap();
    drop(raw);
    let mut journal = Journal::open(&path).unwrap();

    assert!(journal
        .insert("one-too-many", RecordKind::Operation, b"x")
        .is_err());

    assert_eq!(journal.revision().unwrap(), 2);
    drop(journal);
    let raw = Connection::open(&path).unwrap();
    let count: i64 = raw
        .query_row("SELECT COUNT(*) FROM recovery_records", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn record_count_limit_rejects_new_data_without_advancing() {
    let (_directory, path) = database_path();
    drop(Journal::open(&path).unwrap());
    let mut raw = Connection::open(&path).unwrap();
    let transaction = raw.transaction().unwrap();
    for index in 0..MAX_RECORDS {
        transaction
            .execute(
                "INSERT INTO recovery_records(id, kind, generation, payload)
                 VALUES(?1, 'operation', ?2, X'')",
                rusqlite::params![format!("record-{index}"), (index + 1) as i64],
            )
            .unwrap();
    }
    transaction
        .execute(
            "UPDATE recovery_meta SET revision = ?1",
            [MAX_RECORDS as i64],
        )
        .unwrap();
    transaction.commit().unwrap();
    drop(raw);
    let mut journal = Journal::open(&path).unwrap();

    assert!(journal
        .insert("overflow", RecordKind::Operation, b"")
        .is_err());
    assert_eq!(journal.revision().unwrap(), MAX_RECORDS as u64);
    assert_eq!(journal.records().unwrap().len(), MAX_RECORDS);
}

#[test]
fn unsupported_and_corrupt_databases_are_preserved() {
    let (_unsupported_directory, unsupported_path) = database_path();
    let unsupported = Connection::open(&unsupported_path).unwrap();
    unsupported
        .execute_batch(
            "CREATE TABLE sentinel(value BLOB NOT NULL);
             INSERT INTO sentinel VALUES(X'010203');
             PRAGMA user_version = 2;",
        )
        .unwrap();
    drop(unsupported);
    let unsupported_bytes = fs::read(&unsupported_path).unwrap();

    assert!(Journal::open(&unsupported_path).is_err());
    assert_eq!(fs::read(&unsupported_path).unwrap(), unsupported_bytes);

    let (_corrupt_directory, corrupt_path) = database_path();
    let corrupt_bytes = b"not an SQLite database\0with retained evidence";
    fs::write(&corrupt_path, corrupt_bytes).unwrap();
    assert!(Journal::open(&corrupt_path).is_err());
    assert_eq!(fs::read(corrupt_path).unwrap(), corrupt_bytes);
}

#[test]
fn version_zero_database_with_user_data_is_not_adopted() {
    let (_directory, path) = database_path();
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch(
        "CREATE TABLE user_data(value BLOB NOT NULL);
         INSERT INTO user_data VALUES(X'CAFE');",
    )
    .unwrap();
    drop(raw);

    assert!(Journal::open(&path).is_err());

    let raw = Connection::open(&path).unwrap();
    let retained: Vec<u8> = raw
        .query_row("SELECT value FROM user_data", [], |row| row.get(0))
        .unwrap();
    assert_eq!(retained, [0xca, 0xfe]);
}

#[test]
fn version_zero_database_with_a_user_view_is_not_adopted() {
    let (_directory, path) = database_path();
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch("CREATE VIEW user_view AS SELECT 'retained' AS value;")
        .unwrap();
    drop(raw);
    let original = fs::read(&path).unwrap();

    assert!(Journal::open(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn unexpected_schema_objects_are_rejected_without_modifying_the_database() {
    let (_directory, path) = database_path();
    drop(Journal::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch(
        "CREATE TRIGGER unexpected_recovery_trigger
         AFTER INSERT ON recovery_records
         BEGIN
           SELECT 1;
         END;",
    )
    .unwrap();
    drop(raw);
    let original = fs::read(&path).unwrap();

    assert!(Journal::open(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn duplicate_or_future_record_generations_are_rejected() {
    let (_future_directory, future_path) = database_path();
    drop(Journal::open(&future_path).unwrap());
    let raw = Connection::open(&future_path).unwrap();
    raw.execute(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('future', 'operation', 2, X'')",
        [],
    )
    .unwrap();
    raw.execute("UPDATE recovery_meta SET revision = 1", [])
        .unwrap();
    drop(raw);
    assert!(Journal::open(&future_path).is_err());

    let (_duplicate_directory, duplicate_path) = database_path();
    drop(Journal::open(&duplicate_path).unwrap());
    let raw = Connection::open(&duplicate_path).unwrap();
    raw.execute_batch(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('first', 'operation', 1, X'');
         INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('second', 'reservation', 1, X'');
         UPDATE recovery_meta SET revision = 2;",
    )
    .unwrap();
    drop(raw);
    assert!(Journal::open(&duplicate_path).is_err());
}

#[test]
fn successful_replace_and_remove_survive_reopen_with_global_ordering() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    let first = journal
        .insert("first", RecordKind::Operation, b"old")
        .unwrap();
    let first = journal.replace("first", first.generation, b"new").unwrap();
    let retained = journal
        .insert("retained", RecordKind::Reservation, b"kept")
        .unwrap();
    assert_eq!(journal.remove("first", first.generation).unwrap(), 4);
    drop(journal);

    let reopened = Journal::open(&path).unwrap();
    assert_eq!(reopened.revision().unwrap(), 4);
    assert_eq!(reopened.records().unwrap(), vec![retained]);
}

#[test]
fn unknown_kind_and_corrupt_row_metadata_fail_closed() {
    let (_directory, path) = database_path();
    drop(Journal::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    raw.execute(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('unknown', 'future-kind', 1, X'01')",
        [],
    )
    .unwrap();
    raw.execute("UPDATE recovery_meta SET revision = 1", [])
        .unwrap();
    drop(raw);
    assert!(Journal::open(&path).is_err());
    let raw = Connection::open(&path).unwrap();
    let revision: i64 = raw
        .query_row("SELECT revision FROM recovery_meta", [], |row| row.get(0))
        .unwrap();
    let count: i64 = raw
        .query_row("SELECT COUNT(*) FROM recovery_records", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(revision, 1);
    assert_eq!(count, 1);
}

#[test]
fn oversized_tampered_blob_is_rejected_without_materializing_a_record() {
    let (_directory, path) = database_path();
    drop(Journal::open(&path).unwrap());
    let raw = Connection::open(&path).unwrap();
    raw.pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    raw.execute(
        "INSERT INTO recovery_records(id, kind, generation, payload)
         VALUES('oversized', 'operation', 1, zeroblob(?1))",
        [MAX_RECORD_BYTES as i64 + 1],
    )
    .unwrap();
    raw.execute("UPDATE recovery_meta SET revision = 1", [])
        .unwrap();
    drop(raw);
    assert!(Journal::open(&path).is_err());
    let raw = Connection::open(&path).unwrap();
    let revision: i64 = raw
        .query_row("SELECT revision FROM recovery_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(revision, 1);
}

#[test]
fn unknown_ids_and_exhausted_revision_do_not_mutate_storage() {
    let (_directory, path) = database_path();
    let mut journal = Journal::open(&path).unwrap();
    assert!(journal.remove("missing", 1).is_err());
    assert_eq!(journal.revision().unwrap(), 0);
    drop(journal);

    let raw = Connection::open(&path).unwrap();
    raw.execute("UPDATE recovery_meta SET revision = ?1", [i64::MAX])
        .unwrap();
    drop(raw);
    let mut journal = Journal::open(&path).unwrap();

    assert!(journal
        .insert("cannot-advance", RecordKind::Operation, b"payload")
        .is_err());
    assert_eq!(journal.revision().unwrap(), i64::MAX as u64);
    assert!(journal.records().unwrap().is_empty());
}
