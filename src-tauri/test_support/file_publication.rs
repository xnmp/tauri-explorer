use super::*;
use std::fs;

#[cfg(unix)]
#[test]
fn publishing_a_read_only_directory_preserves_its_contents_and_final_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("read-only-copy");
    let mut payload_path = None;
    let staged = StagedEntry::prepare(parent.path(), |payload| {
        fs::create_dir(payload)?;
        fs::write(payload.join("content"), "keep")?;
        fs::set_permissions(payload, fs::Permissions::from_mode(0o555))?;
        payload_path = Some(payload.to_owned());
        Ok(())
    })
    .unwrap();

    let result = staged.publish(&target);
    let contents = fs::read_to_string(target.join("content"));
    let mode = fs::metadata(&target).map(|metadata| metadata.permissions().mode() & 0o777);
    // Make only this fixture's copied directories removable even on the
    // failing-before path, where publication leaves retained staging behind.
    for directory in [payload_path.unwrap(), target.clone()] {
        if directory.exists() {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    assert!(
        result.is_ok(),
        "read-only directory publication failed: {result:?}"
    );
    assert_eq!(contents.unwrap(), "keep");
    assert_eq!(mode.unwrap(), 0o555);
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn unpublished_contents_are_private_to_the_current_user() {
    use std::os::unix::fs::PermissionsExt;
    let parent = tempfile::tempdir().unwrap();
    let staged = StagedEntry::prepare(parent.path(), |payload| {
        let permissions = fs::metadata(payload.parent().unwrap())?.permissions();
        assert_eq!(permissions.mode() & 0o077, 0);
        fs::write(payload, "private")?;
        Ok(())
    })
    .unwrap();
    drop(staged);
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
}

#[test]
fn a_partial_write_is_never_published_and_only_its_staging_is_removed() {
    let parent = tempfile::tempdir().unwrap();
    let unrelated = parent.path().join("unrelated");
    fs::write(&unrelated, "keep").unwrap();
    let target = parent.path().join("new.txt");
    let result = StagedEntry::prepare(parent.path(), |payload| {
        fs::write(payload, "partial")?;
        assert!(!target.exists());
        Err(AppError::Other("injected write failure".into()))
    });
    assert!(matches!(result, Err(AppError::Other(message)) if message == "injected write failure"));
    assert!(!target.exists());
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "keep");
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn complete_payload_appears_only_at_publication() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("new.txt");
    let staged = StagedEntry::prepare(parent.path(), |payload| {
        fs::write(payload, "complete")?;
        Ok(())
    })
    .unwrap();
    assert!(!target.exists());
    staged.publish(&target).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "complete");
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn racing_creation_survives_failed_publication() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("new.txt");
    let staged = StagedEntry::prepare(parent.path(), |payload| {
        fs::write(payload, "ours")?;
        Ok(())
    })
    .unwrap();
    fs::write(&target, "theirs").unwrap();
    assert!(matches!(
        staged.publish(&target),
        Err(AppError::AlreadyExists(_))
    ));
    assert_eq!(fs::read_to_string(&target).unwrap(), "theirs");
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn racing_empty_directory_is_not_replaced() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("directory");
    let staged = StagedEntry::prepare(parent.path(), |payload| {
        fs::create_dir(payload)?;
        fs::write(payload.join("ours"), "content")?;
        Ok(())
    })
    .unwrap();
    fs::create_dir(&target).unwrap();
    assert!(staged.publish(&target).is_err());
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn racing_broken_symlink_survives_publication() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("new.txt");
    let staged = StagedEntry::prepare(parent.path(), |payload| {
        fs::write(payload, "ours")?;
        Ok(())
    })
    .unwrap();
    std::os::unix::fs::symlink("missing", &target).unwrap();
    assert!(staged.publish(&target).is_err());
    assert_eq!(fs::read_link(&target).unwrap(), Path::new("missing"));
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[test]
fn concurrent_publishers_have_one_winner_and_preserve_its_bytes() {
    let parent = tempfile::tempdir().unwrap();
    let target = parent.path().join("winner.txt");
    let ready = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let publish = |contents| {
            let staged = StagedEntry::prepare(parent.path(), |payload| {
                fs::write(payload, contents)?;
                Ok(())
            })
            .unwrap();
            ready.wait();
            staged.publish(&target)
        };
        let first = scope.spawn(move || publish("first"));
        let second = scope.spawn(move || publish("second"));
        let first = first.join().unwrap();
        let second = second.join().unwrap();
        assert_ne!(first.is_ok(), second.is_ok());
        let expected = if first.is_ok() { "first" } else { "second" };
        assert_eq!(fs::read_to_string(&target).unwrap(), expected);
    });
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn nul_path_is_rejected_without_mutating_source() {
    let parent = tempfile::tempdir().unwrap();
    let source = parent.path().join("source");
    fs::write(&source, "keep").unwrap();
    let error = rename_noreplace(&source, &parent.path().join("bad\0name")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(fs::read_to_string(&source).unwrap(), "keep");
}
