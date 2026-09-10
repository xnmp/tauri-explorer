use super::*;

fn change(origin: ChangeOrigin, at: Instant, observed_at_ms: u64) -> PendingChange {
    PendingChange {
        origin,
        last_event: at,
        observed_at_ms,
    }
}

#[test]
fn watcher_batches_wait_for_quiet_after_the_latest_event() {
    let start = Instant::now();
    let mut batch = change(ChangeOrigin::Watcher, start, 100);
    batch.merge(change(
        ChangeOrigin::Watcher,
        start + Duration::from_millis(200),
        300,
    ));
    assert!(!batch.ready(start + Duration::from_millis(499)));
    assert!(batch.ready(start + Duration::from_millis(500)));
}

#[test]
fn mutation_is_ready_despite_newer_watcher_churn_and_keeps_latest_observation() {
    let start = Instant::now();
    let mut batch = change(ChangeOrigin::Watcher, start, 100);
    batch.merge(change(
        ChangeOrigin::Mutation,
        start + Duration::from_millis(10),
        110,
    ));
    batch.merge(change(
        ChangeOrigin::Watcher,
        start + Duration::from_millis(20),
        120,
    ));
    // Out-of-order delivery cannot move the observation clock backward.
    batch.merge(change(ChangeOrigin::Watcher, start, 100));
    assert!(batch.ready(start + Duration::from_millis(20)));
    let payload = DirectoryChangedPayload {
        path: "/observed".into(),
        origin: batch.origin,
        observed_at_ms: batch.observed_at_ms,
    };
    assert_eq!(
        serde_json::to_value(payload).unwrap(),
        serde_json::json!({
            "path": "/observed", "origin": "mutation", "observed_at_ms": 120,
        })
    );
    let next = change(
        ChangeOrigin::Watcher,
        start + Duration::from_millis(30),
        130,
    );
    assert!(!next.ready(start + Duration::from_millis(30)));
}
