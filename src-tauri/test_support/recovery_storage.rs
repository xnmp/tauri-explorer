use super::*;
use std::{
    cell::Cell,
    fs,
    os::unix::fs::{symlink, PermissionsExt},
};

fn catalog() -> (tempfile::TempDir, Catalog) {
    let temporary = tempfile::tempdir().unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let catalog = Catalog::open(Directory::open(temporary.path()).unwrap()).unwrap();
    (temporary, catalog)
}

#[test]
fn catalog_can_discover_and_retire_exact_evidence_without_a_database() {
    let (temporary, catalog) = catalog();
    let first = catalog
        .publish("operation-a", b"\0native opaque intent\xff")
        .unwrap();
    let second = catalog.publish("operation-b", b"second").unwrap();
    drop(catalog);
    let reopened = Catalog::open(Directory::open(temporary.path()).unwrap()).unwrap();
    assert_eq!(reopened.records().unwrap(), vec![first, second]);
    let records = reopened.records().unwrap();
    reopened.retire(&records[0]).unwrap();
    assert_eq!(
        reopened.records().unwrap(),
        vec![records.into_iter().nth(1).unwrap()]
    );
}

#[test]
fn ensure_exact_publishes_absent_evidence_and_reopens_it() {
    let (temporary, catalog) = catalog();
    let published = catalog
        .ensure_exact("operation", b"durable intent")
        .unwrap();
    drop(catalog);

    let reopened = Catalog::open(Directory::open(temporary.path()).unwrap()).unwrap();
    let records = reopened.records().unwrap();
    assert_eq!(records.as_slice(), std::slice::from_ref(&published));
    assert_eq!(
        reopened
            .ensure_exact("operation", b"durable intent")
            .unwrap(),
        published
    );
}

#[test]
fn ensure_exact_retry_preserves_the_published_object() {
    let (_temporary, catalog) = catalog();
    let first = catalog.ensure_exact("operation", b"same intent").unwrap();
    let second = catalog.ensure_exact("operation", b"same intent").unwrap();

    assert_eq!(second, first);
}

#[test]
fn ensure_exact_does_not_accept_existing_bytes_until_both_barriers_succeed() {
    let (_temporary, catalog) = catalog();
    let published = catalog.publish("operation", b"same intent").unwrap();
    let directory_sync_called = Cell::new(false);

    let file_failure = catalog.ensure_exact_with(
        "operation",
        b"same intent",
        |_file| Err(io::Error::other("injected file sync failure")),
        |_directory| {
            directory_sync_called.set(true);
            Ok(())
        },
    );
    assert!(file_failure.is_err());
    assert!(!directory_sync_called.get());

    let directory_failure =
        catalog.ensure_exact_with("operation", b"same intent", File::sync_all, |_directory| {
            Err(io::Error::other("injected directory sync failure"))
        });
    assert!(directory_failure.is_err());

    assert_eq!(
        catalog.ensure_exact("operation", b"same intent").unwrap(),
        published,
        "a later complete retry accepts the same object without replacement"
    );
}

#[test]
fn ensure_exact_revalidates_the_named_object_after_durability_barriers() {
    let (temporary, catalog) = catalog();
    catalog.publish("operation", b"same intent").unwrap();
    let path = temporary.path().join("operation.intent");
    let retained_directory = tempfile::tempdir().unwrap();
    let retained = retained_directory.path().join("original.intent");

    let substituted =
        catalog.ensure_exact_with("operation", b"same intent", File::sync_all, |directory| {
            fs::rename(&path, &retained)?;
            fs::copy(&retained, &path)?;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            directory.sync()
        });

    assert!(substituted.is_err());
    assert_eq!(fs::read(&path).unwrap(), fs::read(&retained).unwrap());
}

#[test]
fn ensure_exact_retains_different_corrupt_and_partial_evidence() {
    let (temporary, catalog) = catalog();
    catalog.ensure_exact("different", b"first intent").unwrap();
    let different = temporary.path().join("different.intent");
    let original = fs::read(&different).unwrap();
    assert!(catalog.ensure_exact("different", b"second intent").is_err());
    assert_eq!(fs::read(&different).unwrap(), original);

    catalog.ensure_exact("corrupt", b"intact intent").unwrap();
    let corrupt = temporary.path().join("corrupt.intent");
    let mut corrupt_bytes = fs::read(&corrupt).unwrap();
    *corrupt_bytes.last_mut().unwrap() ^= 1;
    fs::write(&corrupt, &corrupt_bytes).unwrap();
    assert!(catalog.ensure_exact("corrupt", b"intact intent").is_err());
    assert_eq!(fs::read(&corrupt).unwrap(), corrupt_bytes);

    let partial = temporary.path().join("partial.intent");
    fs::write(&partial, b"TERCV001").unwrap();
    fs::set_permissions(&partial, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(catalog.ensure_exact("partial", b"replacement").is_err());
    assert_eq!(fs::read(partial).unwrap(), b"TERCV001");
}

#[test]
fn ensure_exact_rejects_invalid_ids_and_oversized_payloads_without_writing() {
    let (temporary, catalog) = catalog();
    let invalid_ids = [
        String::new(),
        "../escape".to_owned(),
        "contains.dot".to_owned(),
        "a".repeat(97),
    ];
    for id in invalid_ids {
        assert!(catalog.ensure_exact(&id, b"intent").is_err());
    }
    assert!(catalog
        .ensure_exact("oversized", &vec![0; MAX_RECORD_BYTES + 1])
        .is_err());
    assert!(fs::read_dir(temporary.path()).unwrap().next().is_none());
}

#[test]
fn collision_and_substituted_retirement_preserve_both_intents() {
    let (temporary, catalog) = catalog();
    let expected = catalog.publish("operation", b"retained").unwrap();
    assert!(catalog.publish("operation", b"replacement").is_err());
    assert_eq!(
        catalog.records().unwrap(),
        vec![Evidence {
            id: expected.id.clone(),
            payload: expected.payload.clone(),
            object: expected.object,
            digest: expected.digest,
        }]
    );
    let path = temporary.path().join("operation.intent");
    let retained_directory = tempfile::tempdir().unwrap();
    let retained = retained_directory.path().join("held.intent");
    // Retain the original inode so the replacement cannot reuse its identity.
    fs::rename(&path, &retained).unwrap();
    fs::copy(&retained, &path).unwrap();
    assert!(catalog.retire(&expected).is_err());
    assert!(path.exists());
    assert_eq!(fs::read(&retained).unwrap(), fs::read(&path).unwrap());
    fs::remove_file(retained).unwrap();
}

#[test]
fn substitution_during_retirement_preserves_the_unexpected_occupant() {
    let (temporary, catalog) = catalog();
    let expected = catalog.publish("operation", b"original intent").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let path = temporary.path().join("operation.intent");
    let result = catalog.retire_with(&expected, || {
        fs::rename(&path, outside.path().join("original.intent")).unwrap();
        fs::write(&path, b"unexpected occupant must survive").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    });
    assert!(
        result.is_err(),
        "a replacement cannot authorize successful retirement"
    );
    fn contains_bytes(root: &std::path::Path, expected: &[u8]) -> bool {
        fs::read_dir(root).unwrap().any(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                contains_bytes(&entry.path(), expected)
            } else {
                fs::read(entry.path()).unwrap() == expected
            }
        })
    }
    assert!(contains_bytes(
        temporary.path(),
        b"unexpected occupant must survive"
    ));
    assert!(outside.path().join("original.intent").is_file());
}

#[test]
fn interrupted_or_corrupt_writes_fence_new_publications_without_erasing_evidence() {
    for content in [b"TERCV001".as_slice(), &[0u8; HEADER_BYTES + 5]] {
        let (temporary, catalog) = catalog();
        let path = temporary.path().join("interrupted.intent");
        let mut file = catalog
            .directory
            .create_file(OsStr::new("interrupted.intent"))
            .unwrap();
        file.write_all(content).unwrap();
        file.sync_all().unwrap();
        assert!(catalog.records().is_err());
        assert!(catalog.publish("next", b"not admitted").is_err());
        assert_eq!(fs::read(&path).unwrap(), content);
        assert!(!temporary.path().join("next.intent").exists());
    }
}

#[test]
fn oversized_sparse_files_and_unknown_entries_are_not_materialized_or_removed() {
    let (temporary, catalog) = catalog();
    let file = catalog
        .directory
        .create_file(OsStr::new("huge.intent"))
        .unwrap();
    file.set_len(MAX_RECORD_BYTES as u64 + HEADER_BYTES as u64 + 1)
        .unwrap();
    assert!(catalog.records().is_err());
    assert_eq!(
        file.metadata().unwrap().len(),
        MAX_RECORD_BYTES as u64 + HEADER_BYTES as u64 + 1
    );
    fs::remove_file(temporary.path().join("huge.intent")).unwrap();
    fs::write(temporary.path().join("unknown"), b"preserve me").unwrap();
    assert!(catalog.records().is_err());
    assert_eq!(
        fs::read(temporary.path().join("unknown")).unwrap(),
        b"preserve me"
    );
}

#[test]
fn checksum_changes_and_nonprivate_or_aliased_evidence_are_rejected() {
    let (temporary, catalog) = catalog();
    catalog.publish("operation", b"original bytes").unwrap();
    let path = temporary.path().join("operation.intent");
    let bytes = fs::read(&path).unwrap();
    let mut changed = bytes.clone();
    *changed.last_mut().unwrap() ^= 1;
    fs::write(&path, changed).unwrap();
    assert!(catalog.records().is_err());
    fs::write(&path, &bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(catalog.records().is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let other = tempfile::tempdir().unwrap();
    fs::hard_link(&path, other.path().join("alias")).unwrap();
    assert!(catalog.records().is_err());
    fs::remove_file(other.path().join("alias")).unwrap();
    fs::rename(&path, other.path().join("original")).unwrap();
    symlink(other.path().join("original"), &path).unwrap();
    assert!(catalog.records().is_err());
    assert_eq!(fs::read(other.path().join("original")).unwrap(), bytes);
}

#[test]
fn renamed_catalog_anchor_never_switches_to_a_replacement_directory() {
    let parent = tempfile::tempdir().unwrap();
    let directory = Directory::open(parent.path()).unwrap();
    let catalog =
        Catalog::open(directory.create_directory(OsStr::new("catalog")).unwrap()).unwrap();
    let original = catalog.publish("original", b"original bytes").unwrap();
    fs::rename(
        parent.path().join("catalog"),
        parent.path().join("retained"),
    )
    .unwrap();
    fs::create_dir(parent.path().join("catalog")).unwrap();
    fs::write(parent.path().join("catalog/unrelated"), b"replacement").unwrap();
    assert_eq!(catalog.records().unwrap(), vec![original]);
    catalog.publish("next", b"still anchored").unwrap();
    assert!(parent.path().join("retained/next.intent").exists());
    assert!(!parent.path().join("catalog/next.intent").exists());
}
