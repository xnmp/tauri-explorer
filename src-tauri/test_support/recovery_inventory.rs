use super::super::test_fixture::fixture;
use super::*;

#[test]
fn catalog_only_evidence_remains_visible_without_an_invented_generation() {
    let (_directory, coordinator, reservation, spec) = fixture();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let id = operation.intent().id.clone();
    let expected = operation.intent().clone();
    let generation = operation.generation;
    drop(operation);
    coordinator
        .admitted(|inner| inner.journal.remove(&id, generation))
        .unwrap();
    let inventory = coordinator.inventory().unwrap();
    assert_eq!(inventory.entries.len(), 1);
    assert_eq!(inventory.entries[0].intent, expected);
    assert_eq!(inventory.entries[0].generation, None);
    let snapshot = super::super::super::service::inspect(&coordinator, &id).unwrap();
    assert_eq!(snapshot.items[0].generation, 0);
    assert!(snapshot.items[0].actions.is_empty());
    assert!(snapshot.error.is_some());
    assert_eq!(
        coordinator.inventory().unwrap().revision,
        inventory.revision
    );
}

#[test]
fn unrelated_malformed_journal_evidence_fences_the_entire_inventory() {
    let (_directory, coordinator, reservation, spec) = fixture();
    let _operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    coordinator
        .admitted(|inner| {
            inner
                .journal
                .insert("malformed", RecordKind::Reservation, b"{}")
        })
        .unwrap();
    assert!(coordinator.inventory().is_err());
    assert_eq!(
        coordinator
            .admitted(|inner| inner.journal.records())
            .unwrap()
            .len(),
        2
    );
}
