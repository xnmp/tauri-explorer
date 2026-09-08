use super::*;
use crate::files::native_directory::Directory;
use std::{fs, path::PathBuf};

fn publication(path: &Path) -> Arc<PublishedEntry> {
    let parent = Directory::open(path.parent().unwrap()).unwrap();
    Arc::new(PublishedEntry {
        path: path.to_owned(),
        parent: crate::files::file_identity::of_file(&parent.file).unwrap(),
        version: version_from_metadata(&fs::symlink_metadata(path).unwrap()).unwrap(),
    })
}

fn fixture() -> (tempfile::TempDir, Context, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    let context = Context {
        mounts: crate::files::trash_mounts::MountSnapshot::read().unwrap(),
        data_home: root.path().join("data"),
    };
    (root, context, source)
}

#[test]
fn published_copy_identity_rejects_a_substituted_entry_before_trash_effects() {
    let (_root, context, source) = fixture();
    let path = source.join("published");
    fs::write(&path, b"published bytes").unwrap();
    let expected = publication(&path);
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"substitute bytes").unwrap();

    let result = context.prepare_publication(
        Arc::new(vec![path.to_string_lossy().into_owned()]),
        expected,
    );

    assert!(result.is_err());
    assert_eq!(fs::read(path).unwrap(), b"substitute bytes");
    assert!(!context.data_home.exists());
}

#[test]
fn published_copy_identity_rejects_same_object_content_and_mode_changes() {
    use std::{fs::File, os::unix::fs::PermissionsExt};

    for change_mode in [false, true] {
        let (_root, context, source) = fixture();
        let path = source.join(if change_mode { "mode" } else { "content" });
        fs::write(&path, b"original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let expected = publication(&path);
        if change_mode {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        } else {
            fs::write(&path, b"modified").unwrap();
            File::open(&path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(42)),
                )
                .unwrap();
        }
        let result = context.prepare_publication(
            Arc::new(vec![path.to_string_lossy().into_owned()]),
            expected,
        );
        assert!(result.is_err());
        assert!(path.exists());
        assert!(!context.data_home.exists());
    }
}

#[test]
fn published_copy_identity_rejects_a_substituted_parent_with_the_same_leaf_object() {
    let (root, context, source) = fixture();
    let path = source.join("published");
    fs::write(&path, b"published bytes").unwrap();
    let expected = publication(&path);
    let displaced = root.path().join("old-source");
    fs::rename(&source, &displaced).unwrap();
    fs::create_dir(&source).unwrap();
    fs::hard_link(displaced.join("published"), &path).unwrap();

    let result = context.prepare_publication(
        Arc::new(vec![path.to_string_lossy().into_owned()]),
        expected,
    );

    assert!(result.is_err());
    assert_eq!(fs::read(path).unwrap(), b"published bytes");
    assert!(!context.data_home.exists());
}

#[test]
fn published_copy_identity_rejects_an_alias_spelling_and_retarget() {
    use std::os::unix::fs::symlink;

    let (root, context, source) = fixture();
    let path = source.join("published");
    fs::write(&path, b"published bytes").unwrap();
    let expected = publication(&path);
    let alias = root.path().join("alias");
    symlink(&source, &alias).unwrap();
    let alias_path = alias.join("published");
    let mut forged = (*expected).clone();
    forged.path = alias_path.clone();
    fs::remove_file(&alias).unwrap();
    let other = root.path().join("other");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("published"), b"other bytes").unwrap();
    symlink(&other, &alias).unwrap();

    let result = context.prepare_publication(
        Arc::new(vec![alias_path.to_string_lossy().into_owned()]),
        Arc::new(forged),
    );

    assert!(result.is_err());
    assert_eq!(fs::read(other.join("published")).unwrap(), b"other bytes");
    assert_eq!(fs::read(path).unwrap(), b"published bytes");
    assert!(!context.data_home.exists());
}

#[test]
fn published_copy_identity_trashes_and_restores_the_exact_entry() {
    let (_root, context, source) = fixture();
    let path = source.join("published");
    fs::write(&path, b"published bytes").unwrap();
    let expected = publication(&path);
    let key = path.to_string_lossy().into_owned();
    let mut prepared = context
        .prepare_publication(Arc::new(vec![key.clone()]), expected)
        .unwrap();

    let receipt = prepared.execute_next(&key).unwrap();
    assert!(!path.exists());
    super::super::restore(
        &crate::files::trash_artifact::RestoreRequest {
            path: key,
            artifact: receipt.artifact.unwrap(),
        },
        &crate::files::batch::DirectoryEffects::default(),
    )
    .unwrap();
    assert_eq!(fs::read(path).unwrap(), b"published bytes");
}

#[test]
fn preparation_budget_rejects_before_layout_or_source_effects() {
    let (_root, context, source) = fixture();
    let path = source.join("entry");
    fs::write(&path, b"retain bytes").unwrap();
    let result = context.prepare_selection_with(
        vec![path.to_str().unwrap().to_owned()],
        &mut random_bytes,
        128,
        None,
    );
    assert!(matches!(result, Err(AppError::InvalidPath(_))));
    assert_eq!(fs::read(path).unwrap(), b"retain bytes");
    assert!(!context.data_home.exists());
}

#[test]
fn repeated_candidate_names_reject_before_any_source_moves() {
    let (_root, context, source) = fixture();
    let paths: Vec<_> = ["one", "two"]
        .map(|name| source.join(name))
        .into_iter()
        .collect();
    for path in &paths {
        fs::write(path, b"original").unwrap();
    }
    // Distinct payload basenames still collide on their staged metadata name.
    let result = context.prepare_selection_with(
        paths
            .iter()
            .map(|path| path.to_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        &mut |bytes| {
            bytes.fill(7);
            Ok(())
        },
        MAX_PLAN_BYTES,
        None,
    );
    assert!(result.is_err());
    for path in paths {
        assert_eq!(fs::read(path).unwrap(), b"original");
    }
    assert!(!context.data_home.exists());
}

#[test]
fn ordinary_preparation_failure_and_late_disappearance_preserve_sibling_plans() {
    let (_root, context, source) = fixture();
    let paths: Vec<_> = ["first", "missing", "disappearing", "last"]
        .map(|name| source.join(name))
        .into_iter()
        .collect();
    for index in [0, 2, 3] {
        fs::write(&paths[index], b"original").unwrap();
    }
    let keys: Vec<_> = paths
        .iter()
        .map(|path| path.to_str().unwrap().to_owned())
        .collect();
    let mut selection = context.prepare_selection(Arc::new(keys.clone())).unwrap();
    assert!(
        !context.data_home.exists(),
        "preparing all items must be read-only"
    );
    fs::remove_file(&paths[2]).unwrap();
    let outcomes: Vec<_> = keys.iter().map(|key| selection.execute_next(key)).collect();
    assert!(outcomes[0].is_ok() && outcomes[3].is_ok());
    assert!(outcomes[1].is_err() && outcomes[2].is_err());
    for index in [0, 3] {
        let success = outcomes[index].as_ref().unwrap();
        super::super::restore(
            &crate::files::trash_artifact::RestoreRequest {
                path: keys[index].clone(),
                artifact: success.artifact.clone().unwrap(),
            },
            &crate::files::batch::DirectoryEffects::default(),
        )
        .unwrap();
        assert_eq!(fs::read(&paths[index]).unwrap(), b"original");
    }
}

#[test]
fn shared_layout_cost_is_bounded_for_a_large_selection() {
    let (_root, context, source) = fixture();
    let paths: Vec<_> = (0..200)
        .map(|i| {
            let path = source.join(format!("file-{i}"));
            fs::write(&path, b"retain").unwrap();
            path.to_str().unwrap().to_owned()
        })
        .collect();
    let selection = context
        .prepare_selection_with(paths.clone(), &mut random_bytes, 256 * 1024, None)
        .unwrap();
    assert_eq!(selection.items.len(), paths.len());
    assert!(!context.data_home.exists());
    for path in paths {
        assert_eq!(fs::read(path).unwrap(), b"retain");
    }
}

#[test]
fn selected_ancestor_still_conflicts_when_its_destination_preparation_fails() {
    use std::os::unix::fs::symlink;
    let (root, context, source) = fixture();
    let child = source.join("child");
    fs::write(&child, b"retain child").unwrap();
    let alias = root.path().join("alias");
    symlink(root.path(), &alias).unwrap();
    let ancestor = alias.join("source");
    let mut fixed = |bytes: &mut [u8]| {
        bytes.fill(7);
        Ok(())
    };
    let prepared = context.prepare(&ancestor, &mut fixed).unwrap();
    let directories = context
        .open_trash(&super::super::TrashLayout::Home)
        .unwrap();
    let occupant = directories.root_path.join("files").join(&prepared.name);
    fs::write(&occupant, b"retain occupant").unwrap();
    let result = context.prepare_selection_with(
        vec![
            ancestor.to_str().unwrap().to_owned(),
            child.to_str().unwrap().to_owned(),
        ],
        &mut fixed,
        MAX_PLAN_BYTES,
        None,
    );
    assert!(
        result.is_err(),
        "a destination planning failure cannot erase a selected ancestor"
    );
    assert_eq!(fs::read(child).unwrap(), b"retain child");
    assert_eq!(fs::read(occupant).unwrap(), b"retain occupant");
    assert_eq!(
        fs::read_dir(directories.root_path.join("info"))
            .unwrap()
            .count(),
        0
    );
}
