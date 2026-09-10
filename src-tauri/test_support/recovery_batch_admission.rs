use super::*;
use crate::files::recovery::resources::{Access, Scope};

fn request(path: &Path, access: Access) -> Vec<Request> {
    vec![Request {
        path: path.to_owned(),
        access,
        scope: Scope::Subtree,
    }]
}

fn fixture() -> (tempfile::TempDir, PathBuf, Arc<Coordinator>) {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().canonicalize().unwrap();
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    (directory, base, coordinator)
}

#[test]
fn independent_children_hold_all_paths_then_release_only_the_finished_child() {
    let (_directory, base, coordinator) = fixture();
    let paths = [base.join("first"), base.join("second")];
    let mut children = coordinator
        .reserve_batch(paths.iter().map(|p| request(p, Access::Write)).collect())
        .unwrap();
    let peer = Coordinator::open(&base.join("recovery")).unwrap();
    for path in &paths {
        assert!(peer.reserve(request(path, Access::Write)).is_err());
    }
    assert_eq!(
        children[0].paths().collect::<Vec<_>>(),
        vec![paths[0].as_path()]
    );
    children.remove(0).finish().unwrap();
    peer.reserve(request(&paths[0], Access::Write))
        .unwrap()
        .finish()
        .unwrap();
    assert!(peer.reserve(request(&paths[1], Access::Write)).is_err());
    children.pop().unwrap().finish().unwrap();
    peer.reserve(request(&paths[1], Access::Write))
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn a_conflicting_last_child_never_admits_an_earlier_prefix() {
    let (_directory, base, coordinator) = fixture();
    let first = base.join("first");
    let last = base.join("last");
    let peer = Coordinator::open(&base.join("recovery")).unwrap();
    let held = peer.reserve(request(&last, Access::Write)).unwrap();
    let revision = coordinator
        .admitted(|inner| inner.journal.revision())
        .unwrap();
    assert!(coordinator
        .reserve_batch(vec![
            request(&first, Access::Write),
            request(&last, Access::Write)
        ])
        .is_err());
    assert_eq!(
        coordinator
            .admitted(|inner| inner.journal.revision())
            .unwrap(),
        revision
    );
    peer.reserve(request(&first, Access::Write))
        .unwrap()
        .finish()
        .unwrap();
    held.finish().unwrap();
}

#[test]
fn failed_atomic_commit_releases_owners_and_next_admission_reaps_their_lock_files() {
    let (_directory, base, coordinator) = fixture();
    let connection = rusqlite::Connection::open(base.join("recovery/recovery.sqlite3")).unwrap();
    connection
        .execute("UPDATE recovery_meta SET revision = ?1", [i64::MAX - 2])
        .unwrap();
    drop(connection);
    let result = coordinator.reserve_batch(
        ["first", "second", "third"]
            .iter()
            .map(|name| request(&base.join(name), Access::Write))
            .collect(),
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("overflow must reject the whole batch"),
    };
    assert!(error.to_string().contains("exhausted"));
    assert_eq!(
        coordinator
            .admitted(|inner| inner.journal.revision())
            .unwrap(),
        (i64::MAX - 2) as u64
    );
    let locks = base.join("recovery/locks");
    assert_eq!(
        fs::read_dir(&locks).unwrap().count(),
        3,
        "failed commit leaves only unreferenced lock files"
    );
    let child = coordinator
        .reserve(request(&base.join("first"), Access::Write))
        .unwrap();
    assert_eq!(
        fs::read_dir(&locks).unwrap().count(),
        1,
        "next admission must reap all failed-batch owners"
    );
    child.finish().unwrap();
    assert_eq!(fs::read_dir(&locks).unwrap().count(), 0);
    for name in ["first", "second", "third"] {
        assert!(!base.join(name).exists());
    }
}

#[test]
fn child_write_read_and_subtree_overlaps_are_rejected_but_shared_reads_are_allowed() {
    let (_directory, base, coordinator) = fixture();
    let source = base.join("source");
    fs::create_dir(&source).unwrap();
    let descendant = source.join("child");
    for groups in [
        vec![
            request(&source, Access::Write),
            request(&source, Access::Read),
        ],
        vec![
            request(&source, Access::Write),
            request(&descendant, Access::Write),
        ],
        vec![
            request(&descendant, Access::Write),
            request(&source, Access::Read),
        ],
    ] {
        assert!(coordinator.reserve_batch(groups).is_err());
    }
    let readers = coordinator
        .reserve_batch(vec![
            request(&source, Access::Read),
            request(&descendant, Access::Read),
        ])
        .unwrap();
    for reader in readers {
        reader.finish().unwrap();
    }
}

#[test]
fn physical_aliases_conflict_across_children() {
    let (_directory, base, coordinator) = fixture();
    let source = base.join("source");
    let alias = base.join("alias");
    fs::write(&source, b"original").unwrap();
    fs::hard_link(&source, &alias).unwrap();
    assert!(coordinator
        .reserve_batch(vec![
            request(&source, Access::Write),
            request(&alias, Access::Read)
        ])
        .is_err());
    assert_eq!(fs::read(source).unwrap(), b"original");
    assert_eq!(fs::read(alias).unwrap(), b"original");
}

#[test]
fn every_child_is_recaptured_after_a_concurrent_commit() {
    let (_directory, base, coordinator) = fixture();
    let first = base.join("first");
    let last = base.join("last");
    let replacement = base.join("replacement");
    let alias = base.join("alias");
    fs::write(&last, b"old").unwrap();
    fs::write(&replacement, b"new").unwrap();
    fs::hard_link(&replacement, &alias).unwrap();
    let mut reader = None;
    let result = coordinator.reserve_batch_with(
        vec![
            request(&first, Access::Write),
            request(&last, Access::Write),
        ],
        || {
            if reader.is_some() {
                return;
            }
            let writer = coordinator
                .reserve(
                    [
                        request(&last, Access::Write),
                        request(&replacement, Access::Write),
                    ]
                    .concat(),
                )
                .unwrap();
            fs::rename(&replacement, &last).unwrap();
            writer.finish().unwrap();
            reader = Some(coordinator.reserve(request(&alias, Access::Read)).unwrap());
        },
    );
    assert!(
        result.is_err(),
        "a freshly aliased final child must conflict after recapture"
    );
    reader.unwrap().finish().unwrap();
    coordinator
        .reserve(request(&first, Access::Write))
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn batch_request_count_is_bounded_across_individually_valid_children() {
    let (_directory, base, coordinator) = fixture();
    let path = base.join("source");
    let groups = (0..2)
        .map(|_| {
            (0..resources::MAX_CLAIMS / 2 + 1)
                .map(|_| Request {
                    path: path.clone(),
                    access: Access::Read,
                    scope: Scope::Subtree,
                })
                .collect()
        })
        .collect();
    assert!(coordinator.reserve_batch(groups).is_err());
    assert_eq!(
        coordinator
            .admitted(|inner| inner.journal.revision())
            .unwrap(),
        0
    );
}

#[test]
fn children_promote_independently_and_both_remain_discoverable_after_owner_drop() {
    use crate::files::{
        file_identity::version_from_metadata,
        recovery::model::{NativePath, OperationSpec, ReplacementSpec},
    };
    let (_directory, base, coordinator) = fixture();
    let source = base.join("source");
    fs::write(&source, b"copied bytes").unwrap();
    let planned: Vec<_> = ["first", "second"]
        .into_iter()
        .map(|token| {
            let target = base.join(token);
            let root = base.join(format!(".tauri-explorer-recovery-{token}"));
            fs::write(&target, token).unwrap();
            let requests = [
                request(&source, Access::Read),
                request(&target, Access::Write),
                request(&root, Access::Write),
            ]
            .concat();
            let spec = OperationSpec::CopyReplacement(ReplacementSpec {
                artifact_token: token.into(),
                source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap())
                    .unwrap(),
                original: version_from_metadata(&fs::symlink_metadata(&target).unwrap()).unwrap(),
                source: NativePath(source.clone()),
                target: NativePath(target),
                root: NativePath(root),
                parent: of_file(&Directory::open(&base).unwrap().file).unwrap(),
            });
            (requests, spec)
        })
        .collect();
    let (groups, specs): (Vec<_>, Vec<_>) = planned.into_iter().unzip();
    let children = coordinator.reserve_batch(groups).unwrap();
    let operations: Vec<_> = children
        .into_iter()
        .zip(specs)
        .map(|(child, spec)| {
            child
                .promote(spec)
                .unwrap_or_else(|failure| panic!("{}", failure.error))
        })
        .collect();
    let ids: Vec<_> = operations.iter().map(|op| op.intent().id.clone()).collect();
    assert_ne!(ids[0], ids[1]);
    drop(operations);
    let intents = Coordinator::discover_catalog(&base.join("recovery")).unwrap();
    assert_eq!(intents.len(), 2);
    for id in ids {
        assert!(intents.iter().any(|intent| intent.id == id));
    }
    assert!(coordinator
        .reserve(request(&base.join("first"), Access::Write))
        .is_err());
    assert!(coordinator
        .reserve(request(&base.join("second"), Access::Write))
        .is_err());
    assert_eq!(fs::read(base.join("first")).unwrap(), b"first");
    assert_eq!(fs::read(base.join("second")).unwrap(), b"second");
}

#[test]
fn abandoned_native_process_releases_all_unpromoted_children() {
    let (_directory, base, coordinator) = fixture();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::recovery::coordinator::admission::tests::subprocess_batch_owner",
            "--ignored",
            "--nocapture",
        ])
        .env("EXPLORER_BATCH_ADMISSION_FIXTURE", &base)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("batch authority acquired"));
    let recovered = coordinator
        .reserve_batch(
            ["first", "second"]
                .iter()
                .map(|name| request(&base.join(name), Access::Write))
                .collect(),
        )
        .unwrap();
    for child in recovered {
        child.finish().unwrap();
    }
    assert!(!base.join("first").exists());
    assert!(!base.join("second").exists());
}

#[test]
#[ignore = "subprocess fixture"]
fn subprocess_batch_owner() {
    let base = PathBuf::from(std::env::var_os("EXPLORER_BATCH_ADMISSION_FIXTURE").unwrap());
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let _owned = coordinator
        .reserve_batch(
            ["first", "second"]
                .iter()
                .map(|name| request(&base.join(name), Access::Write))
                .collect(),
        )
        .unwrap();
    use std::io::Write;
    println!("batch authority acquired");
    std::io::stdout().flush().unwrap();
    // Exit without running Rust destructors: ordinary rows must be reclaimable
    // from the actual OS lock state, not an explicit finish or Drop callback.
    std::process::exit(0);
}

#[test]
fn finishing_an_ordinary_child_does_not_retire_its_promoted_sibling() {
    use crate::files::recovery::model::OperationSpec;
    let (directory, coordinator, initial, spec) = super::super::test_fixture::fixture();
    initial.finish().unwrap();
    let OperationSpec::CopyReplacement(ref copy) = spec else {
        panic!("expected copy replacement fixture");
    };
    let ordinary = directory.path().join("ordinary");
    let requests = [
        request(&copy.source.0, Access::Read),
        request(&copy.target.0, Access::Write),
        request(&copy.root.0, Access::Write),
    ]
    .concat();
    let mut children = coordinator
        .reserve_batch(vec![requests, request(&ordinary, Access::Write)])
        .unwrap();
    let operation = children
        .remove(0)
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let id = operation.intent().id.clone();
    let generation = operation.generation();
    children.pop().unwrap().finish().unwrap();
    coordinator
        .reserve(request(&ordinary, Access::Write))
        .unwrap()
        .finish()
        .unwrap();
    drop(operation);
    let reclaimed = coordinator
        .try_claim(&id, generation)
        .unwrap()
        .expect("promoted child remains claimable");
    assert_eq!(reclaimed.intent().id, id);
    assert_eq!(
        Coordinator::discover_catalog(&directory.path().join("recovery"))
            .unwrap()
            .len(),
        1
    );
    super::super::test_fixture::assert_user_files_untouched(directory.path());
}
