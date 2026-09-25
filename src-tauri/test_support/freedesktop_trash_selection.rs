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

#[test]
fn deletion_is_refused_while_a_managed_copy_owns_its_source() {
    use crate::files::recovery::{ResourceRequest, Runtime};
    let (root, context, source) = fixture();
    let file = source.join("held.txt");
    fs::write(&file, b"must remain while a copy reads it").unwrap();
    let runtime = Runtime::default();
    let storage = root.path().join("recovery");
    let held = tauri::async_runtime::block_on(runtime.admit(
        storage.clone(),
        vec![ResourceRequest {
            path: file.clone(),
            access: Access::Read,
            scope: Scope::Subtree,
        }],
    ))
    .unwrap();
    let key = file.to_string_lossy().into_owned();
    let result = tauri::async_runtime::block_on(runtime.admit_prepared(storage, move || {
        context
            .prepare_selection(Arc::new(vec![key.clone()]))
            .map(PreparedSelection::into_admission)
    }));
    assert!(
        result.is_err(),
        "deletion must reject a source still owned by a copy"
    );
    assert_eq!(
        fs::read(&file).unwrap(),
        b"must remain while a copy reads it"
    );
    held.finish().unwrap();
}

fn admit(
    runtime: &crate::files::recovery::Runtime,
    storage: &Path,
    context: Context,
    paths: Vec<String>,
) -> Result<(PreparedSelection, crate::files::recovery::MutationAdmission), AppError> {
    let paths = Arc::new(paths);
    tauri::async_runtime::block_on(runtime.admit_prepared(storage.to_owned(), move || {
        context
            .prepare_selection(Arc::clone(&paths))
            .map(PreparedSelection::into_admission)
    }))
}

fn claim(
    runtime: &crate::files::recovery::Runtime,
    storage: &Path,
    path: &Path,
    access: Access,
) -> Result<crate::files::recovery::MutationAdmission, AppError> {
    tauri::async_runtime::block_on(runtime.admit(
        storage.to_owned(),
        vec![resources::Request {
            path: path.to_owned(),
            access,
            scope: Scope::Subtree,
        }],
    ))
}

#[test]
fn disjoint_deletions_share_first_use_layouts_and_retain_exact_artifact_claims() {
    let (root, context, source) = fixture();
    let runtime = crate::files::recovery::Runtime::default();
    let storage = root.path().join("recovery");
    let data = context.data_home.clone();
    let other_context = Context {
        mounts: crate::files::trash_mounts::MountSnapshot::read().unwrap(),
        data_home: data.clone(),
    };
    let first = source.join("first");
    let second = source.join("second");
    fs::write(&first, b"one").unwrap();
    fs::write(&second, b"two").unwrap();
    let first_key = first.to_string_lossy().into_owned();
    let second_key = second.to_string_lossy().into_owned();
    let (mut a, a_owner) = admit(&runtime, &storage, context, vec![first_key.clone()]).unwrap();
    let (mut b, b_owner) =
        admit(&runtime, &storage, other_context, vec![second_key.clone()]).unwrap();
    assert!(!data.exists(), "both preparations must be read-only");
    assert!(claim(&runtime, &storage, &first, Access::Read).is_err());
    assert!(claim(&runtime, &storage, &data.join("Trash"), Access::Write).is_err());
    let a_receipt = a.execute_next(&first_key).unwrap();
    let b_receipt = b.execute_next(&second_key).unwrap();
    assert!(a_receipt.artifact.is_some() && b_receipt.artifact.is_some());
    assert!(!first.exists() && !second.exists());
    assert_eq!(fs::read_dir(data.join("Trash/files")).unwrap().count(), 2);
    a_owner.finish().unwrap();
    b_owner.finish().unwrap();
    claim(&runtime, &storage, &data.join("Trash"), Access::Write)
        .unwrap()
        .finish()
        .unwrap();
}

#[test]
fn admitted_selection_keeps_alias_dependencies_and_requested_receipt_keys() {
    let (root, context, source) = fixture();
    let runtime = crate::files::recovery::Runtime::default();
    let storage = root.path().join("recovery");
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    let file = source.join("entry");
    fs::write(&file, b"owned").unwrap();
    let key = alias.join("entry").to_string_lossy().into_owned();
    let (mut selection, owner) = admit(&runtime, &storage, context, vec![key.clone()]).unwrap();
    assert!(claim(&runtime, &storage, &alias, Access::Write).is_err());
    assert!(claim(&runtime, &storage, &file, Access::Read).is_err());
    assert!(selection.execute_next(&key).unwrap().artifact.is_some());
    assert!(!file.exists());
    owner.finish().unwrap();
}

#[test]
fn an_unmanaged_candidate_collision_never_reallocates_unclaimed_trash_names() {
    let (root, context, source) = fixture();
    let runtime = crate::files::recovery::Runtime::default();
    let storage = root.path().join("recovery");
    // Establish the layout without moving any selected object.
    let dirs = context
        .open_trash(&super::super::TrashLayout::Home)
        .unwrap();
    let file = source.join("entry");
    fs::write(&file, b"source").unwrap();
    let key = file.to_string_lossy().into_owned();
    let (mut selection, owner) = admit(&runtime, &storage, context, vec![key.clone()]).unwrap();
    let prepared = selection.items.front().unwrap().as_ref().unwrap();
    let candidate = dirs.root_path.join("files").join(&prepared.name);
    fs::write(&candidate, b"external occupant").unwrap();
    assert!(selection.execute_next(&key).is_err());
    assert_eq!(fs::read(&file).unwrap(), b"source");
    assert_eq!(fs::read(&candidate).unwrap(), b"external occupant");
    assert_eq!(
        fs::read_dir(dirs.root_path.join("files")).unwrap().count(),
        1
    );
    owner.finish().unwrap();
}
