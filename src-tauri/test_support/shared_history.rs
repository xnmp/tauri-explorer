use super::{
    model::{Collection, Mutation, RecentEntry, Seed},
    store,
};
use std::{path::Path, process::Command};
fn recent(key: &str, time: f64) -> Mutation {
    Mutation::Recent {
        key: key.into(),
        entry: RecentEntry {
            name: key.into(),
            path: key.into(),
            kind: "file".into(),
            timestamp: time,
            revision: 0,
        },
    }
}
#[test]
fn separate_connections_keep_updates_and_seed_import_is_one_time() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    store::access(&database,Some(serde_json::from_str(r#"{"recent":[{"key":"/legacy","entry":{"name":"legacy","path":"/legacy","kind":"file","timestamp":1}}],"frecency":[]}"#).unwrap()),None).unwrap();
    store::access(&database, None, Some(recent("/new", 2.0))).unwrap();
    let snapshot = store::access(&database, Some(Seed::default()), None).unwrap();
    assert_eq!(
        snapshot
            .recent
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        vec!["/new", "/legacy"]
    );
    store::access(
        &database,
        None,
        Some(Mutation::Clear {
            collection: Collection::Recent,
        }),
    )
    .unwrap();
    let stale_seed=serde_json::from_str(r#"{"recent":[{"key":"/legacy","entry":{"name":"legacy","path":"/legacy","kind":"file","timestamp":1}}],"frecency":[]}"#).unwrap();
    assert!(store::access(&database, Some(stale_seed), None)
        .unwrap()
        .recent
        .is_empty());
}
#[test]
fn invalid_operations_roll_back_and_frequency_retains_contracts() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    for time in 1..=12 {
        store::access(
            &database,
            None,
            Some(Mutation::Access {
                key: "/dir".into(),
                path: "/dir".into(),
                timestamp: f64::from(time),
            }),
        )
        .unwrap();
    }
    let snapshot = store::access(&database, None, None).unwrap();
    assert_eq!(
        snapshot.frecency[0].accesses,
        (3..=12).map(f64::from).collect::<Vec<_>>()
    );
    assert!(store::access(
        &database,
        None,
        Some(Mutation::Access {
            key: "/bad".into(),
            path: "/bad".into(),
            timestamp: f64::NAN
        })
    )
    .is_err());
    assert_eq!(store::access(&database, None, None).unwrap(), snapshot);
    let snapshot = store::access(
        &database,
        None,
        Some(Mutation::Downvote {
            key: "/dir".into(),
            dismiss: true,
        }),
    )
    .unwrap();
    assert_eq!(snapshot.frecency[0].accesses, vec![3.0, 4.0, 5.0, 6.0, 7.0]);
    assert!(snapshot.frecency[0].dismissed_from_recent);
    let snapshot = store::access(
        &database,
        None,
        Some(Mutation::Access {
            key: "/dir".into(),
            path: "/dir".into(),
            timestamp: 13.0,
        }),
    )
    .unwrap();
    assert!(!snapshot.frecency[0].dismissed_from_recent);
}
#[test]
fn history_bounds_survive_many_writes() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    for index in 0..210 {
        let key = format!("/{index}");
        store::access(&database, None, Some(recent(&key, f64::from(index)))).unwrap();
        store::access(
            &database,
            None,
            Some(Mutation::Access {
                key: key.clone(),
                path: key,
                timestamp: f64::from(index),
            }),
        )
        .unwrap();
    }
    let snapshot = store::access(&database, None, None).unwrap();
    assert_eq!(snapshot.recent.len(), 50);
    assert_eq!(snapshot.frecency.len(), 200);
    assert_eq!(snapshot.recent[0].path, "/209");
}
#[test]
#[ignore = "spawned by the cross-process history contract"]
fn process_client() {
    let database = std::env::var("TAURI_HISTORY_TEST_DATABASE").unwrap();
    let mode = std::env::var("TAURI_HISTORY_TEST_MODE").unwrap();
    if mode == "read" {
        println!(
            "HISTORY_SNAPSHOT:{}",
            serde_json::to_string(
                &store::access(Path::new(&database), Some(Seed::default()), None).unwrap()
            )
            .unwrap()
        );
        return;
    }
    for index in 0..10 {
        let key = format!("/{mode}/{index}");
        store::access(
            Path::new(&database),
            None,
            Some(recent(&key, f64::from(index))),
        )
        .unwrap();
        store::access(
            Path::new(&database),
            None,
            Some(Mutation::Access {
                key: key.clone(),
                path: key,
                timestamp: f64::from(index),
            }),
        )
        .unwrap();
    }
}
#[test]
fn independent_processes_observe_changes_without_losing_concurrent_writes() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    store::access(&database, Some(Seed::default()), None).unwrap();
    let mut children = vec![];
    for mode in ["source", "picker"] {
        children.push(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "shared_history::tests::process_client",
                    "--ignored",
                    "--nocapture",
                ])
                .env("TAURI_HISTORY_TEST_DATABASE", &database)
                .env("TAURI_HISTORY_TEST_MODE", mode)
                .spawn()
                .unwrap(),
        );
    }
    for child in &mut children {
        assert!(child.wait().unwrap().success());
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "shared_history::tests::process_client",
            "--ignored",
            "--nocapture",
        ])
        .env("TAURI_HISTORY_TEST_DATABASE", &database)
        .env("TAURI_HISTORY_TEST_MODE", "read")
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    let json = text
        .split("HISTORY_SNAPSHOT:")
        .nth(1)
        .unwrap()
        .lines()
        .next()
        .unwrap();
    let snapshot: super::model::Snapshot = serde_json::from_str(json).unwrap();
    assert_eq!(snapshot.recent.len(), 20);
    assert_eq!(snapshot.frecency.len(), 20);
    for mode in ["source", "picker"] {
        assert!(snapshot
            .recent
            .iter()
            .any(|entry| entry.path == format!("/{mode}/9")));
    }
}

#[test]
fn stale_pruning_does_not_remove_reused_paths_even_with_the_same_timestamp() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("history.sqlite");
    let old = store::access(&database, None, Some(recent("/file", 1.0))).unwrap();
    let fresh = store::access(&database, None, Some(recent("/file", 1.0))).unwrap();
    assert_ne!(old.recent[0].revision, fresh.recent[0].revision);
    let snapshot = store::access(
        &database,
        None,
        Some(Mutation::Prune {
            collection: Collection::Recent,
            entries: vec![super::model::ObservedEntry {
                key: "/file".into(),
                revision: old.recent[0].revision,
            }],
        }),
    )
    .unwrap();
    assert_eq!(snapshot.recent, fresh.recent);
    let snapshot = store::access(
        &database,
        None,
        Some(Mutation::Prune {
            collection: Collection::Recent,
            entries: vec![super::model::ObservedEntry {
                key: "/file".into(),
                revision: fresh.recent[0].revision,
            }],
        }),
    )
    .unwrap();
    assert!(snapshot.recent.is_empty());
}
