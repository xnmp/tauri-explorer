//! Coordinator-level commit point of durable retirement (ADR 0023).
use super::*;
use crate::files::recovery::coordinator::test_fixture::fixture;
use crate::files::recovery::resources::{Access, Scope};

/// Catalog evidence with no journal row is exactly what a crash between the
/// two commits leaves behind. It must be reclaimable, but only once its
/// artifact root is verifiably absent.
#[test]
fn orphan_catalog_evidence_is_retirable_and_releases_its_claims() {
    let (directory, coordinator, reservation, spec) = fixture();
    let base = std::fs::canonicalize(directory.path()).unwrap();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let id = operation.intent().id.clone();
    let generation = operation.generation();
    drop(operation);
    // Simulate the interrupted commit: the journal row is gone, the immutable
    // catalog record and its owner lock remain.
    let database = base.join("recovery/recovery.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection
        .execute("DELETE FROM recovery_records WHERE id = ?1", [&id])
        .unwrap();
    drop(connection);
    let _ = generation;

    let entry = coordinator
        .inventory()
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.intent.id == id)
        .expect("catalog evidence stays visible without a checkpoint");
    assert!(entry.generation.is_none());
    // The recorded paths are fenced while the evidence stands.
    assert!(coordinator
        .reserve(vec![Request {
            path: base.join("target"),
            access: Access::Write,
            scope: Scope::Subtree,
        }])
        .is_err());

    coordinator
        .retire_orphan_catalog(&id, entry.digest)
        .unwrap();
    assert!(coordinator.inventory().unwrap().entries.is_empty());
    coordinator
        .reserve(vec![Request {
            path: base.join("target"),
            access: Access::Write,
            scope: Scope::Subtree,
        }])
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn an_indexed_record_is_never_retired_as_orphaned_evidence() {
    let (_directory, coordinator, reservation, spec) = fixture();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let id = operation.intent().id.clone();
    drop(operation);
    let entry = coordinator
        .inventory()
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.intent.id == id)
        .unwrap();
    assert!(coordinator.retire_orphan_catalog(&id, entry.digest).is_err());
    assert_eq!(coordinator.inventory().unwrap().entries.len(), 1);
}

#[test]
fn changed_catalog_evidence_cannot_be_retired_with_a_stale_digest() {
    let (_directory, coordinator, reservation, spec) = fixture();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let id = operation.intent().id.clone();
    drop(operation);
    assert!(coordinator.retire_orphan_catalog(&id, [0; 32]).is_err());
    assert_eq!(coordinator.inventory().unwrap().entries.len(), 1);
}

#[test]
fn an_incomplete_record_cannot_retire_its_durable_evidence() {
    let (_directory, coordinator, reservation, spec) = fixture();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    // `Planned` is not a completed retirement; evidence must survive.
    assert!(operation.retire_record().is_err());
    assert_eq!(coordinator.inventory().unwrap().entries.len(), 1);
}
