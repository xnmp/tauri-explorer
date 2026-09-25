use super::*;
use crate::files::{batch, native_directory::Directory};
use std::{
    ffi::{OsStr, OsString},
    fs, io,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::PermissionsExt,
    },
    path::{Path, PathBuf},
    sync::Arc,
};

enum Call<'a> {
    Rename { from: &'a OsStr, to: &'a OsStr },
    Unlink { name: &'a OsStr, directory: bool },
}

/// Real native effects with a callback at the exact seam before each one.
struct Hooks<F>(F);

impl<F: FnMut(&Call) -> io::Result<()>> Operations for Hooks<F> {
    fn rename(
        &mut self,
        source: &Directory,
        name: &OsStr,
        target: &Directory,
        target_name: &OsStr,
    ) -> io::Result<()> {
        (self.0)(&Call::Rename {
            from: name,
            to: target_name,
        })?;
        source.rename_to(name, target, target_name)
    }

    fn unlink(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        is_directory: bool,
    ) -> io::Result<()> {
        (self.0)(&Call::Unlink {
            name,
            directory: is_directory,
        })?;
        directory.unlink(name, is_directory)
    }
}

fn is_staging(name: &OsStr) -> bool {
    name.as_bytes().starts_with(b".tauri-delete-")
}

fn staging(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| is_staging(path.file_name().unwrap()))
        .collect()
}

fn select(path: &Path) -> unix::PreparedSelection {
    unix::prepare_selection(Arc::new(vec![path.to_str().unwrap().to_owned()])).unwrap()
}

fn execute(
    selection: &mut unix::PreparedSelection,
    path: &Path,
    hook: impl FnMut(&Call) -> io::Result<()>,
) -> Result<crate::files::trash_artifact::TrashSuccess, AppError> {
    selection.execute_next_with(path.to_str().unwrap(), &mut Hooks(hook))
}

fn no_hook(_: &Call) -> io::Result<()> {
    Ok(())
}

fn injected() -> io::Error {
    io::Error::other("injected failure")
}

fn is_uncertain(result: &Result<crate::files::trash_artifact::TrashSuccess, AppError>) -> bool {
    matches!(result, Err(AppError::MutationUncertain(_)))
}

#[test]
fn a_replaced_source_is_not_permanently_removed() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    let retained = root.path().join("original");
    fs::write(&source, b"selected bytes").unwrap();
    let mut deletion = select(&source);
    fs::rename(&source, &retained).unwrap();
    fs::write(&source, b"unrelated replacement").unwrap();
    let result = execute(&mut deletion, &source, no_hook);
    assert_eq!(
        fs::read(&source).ok().as_deref(),
        Some(b"unrelated replacement".as_slice())
    );
    assert_eq!(fs::read(&retained).unwrap(), b"selected bytes");
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn a_replaced_parent_does_not_redirect_deletion() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("parent");
    let retained = root.path().join("original-parent");
    fs::create_dir(&parent).unwrap();
    let source = parent.join("selected");
    fs::write(&source, b"selected bytes").unwrap();
    let mut deletion = select(&source);
    fs::rename(&parent, &retained).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::write(&source, b"unrelated replacement").unwrap();
    let result = execute(&mut deletion, &source, no_hook);
    assert_eq!(
        fs::read(&source).ok().as_deref(),
        Some(b"unrelated replacement".as_slice())
    );
    assert_eq!(
        fs::read(retained.join("selected")).unwrap(),
        b"selected bytes"
    );
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert!(staging(&parent).is_empty() && staging(&retained).is_empty());
}

#[test]
fn a_parent_replaced_by_a_symlink_is_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("parent");
    let elsewhere = root.path().join("elsewhere");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&elsewhere).unwrap();
    let source = parent.join("selected");
    fs::write(&source, b"selected bytes").unwrap();
    fs::write(elsewhere.join("selected"), b"unrelated").unwrap();
    let mut deletion = select(&source);
    fs::rename(&parent, root.path().join("moved")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &parent).unwrap();
    let result = execute(&mut deletion, &source, no_hook);
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert_eq!(fs::read(elsewhere.join("selected")).unwrap(), b"unrelated");
    assert_eq!(
        fs::read(root.path().join("moved/selected")).unwrap(),
        b"selected bytes"
    );
}

/// A stat-only pseudo-fix passes the tests above; this one substitutes the
/// entry after every check, immediately before the atomic capture.
#[test]
fn substitution_at_the_final_seam_is_restored_not_deleted() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    let retained = root.path().join("original");
    fs::write(&source, b"selected bytes").unwrap();
    let mut deletion = select(&source);
    let mut swapped = false;
    let result = execute(&mut deletion, &source, |call| {
        if let Call::Rename { from, .. } = call {
            if *from == OsStr::new("selected") && !swapped {
                swapped = true;
                fs::rename(&source, &retained)?;
                fs::write(&source, b"unrelated replacement")?;
            }
        }
        Ok(())
    });
    assert!(swapped);
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert_eq!(fs::read(&source).unwrap(), b"unrelated replacement");
    assert_eq!(fs::read(&retained).unwrap(), b"selected bytes");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn a_directory_substituted_at_the_final_seam_keeps_its_contents() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("mine"), b"selected").unwrap();
    let mut deletion = select(&source);
    let result = execute(&mut deletion, &source, |call| {
        if let Call::Rename { from, .. } = call {
            if *from == OsStr::new("selected") && !root.path().join("original").exists() {
                fs::rename(&source, root.path().join("original"))?;
                fs::create_dir(&source)?;
                fs::write(source.join("theirs"), b"unrelated")?;
            }
        }
        Ok(())
    });
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert_eq!(fs::read(source.join("theirs")).unwrap(), b"unrelated");
    assert_eq!(
        fs::read(root.path().join("original/mine")).unwrap(),
        b"selected"
    );
}

#[test]
fn an_occupied_restore_destination_retains_both_objects_as_uncertain_residue() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    let retained = root.path().join("original");
    fs::write(&source, b"selected bytes").unwrap();
    let mut deletion = select(&source);
    let result = execute(&mut deletion, &source, |call| {
        if let Call::Rename { from, to } = call {
            if *from == OsStr::new("selected") {
                fs::rename(&source, &retained)?;
                fs::write(&source, b"unrelated replacement")?;
            } else if *to == OsStr::new("selected") {
                fs::write(&source, b"third occupant")?;
            }
        }
        Ok(())
    });
    let Err(AppError::MutationUncertain(message)) = &result else {
        panic!("expected uncertain residue, got {result:?}");
    };
    let residue = staging(root.path());
    assert_eq!(residue.len(), 1);
    assert!(
        message.contains(&residue[0].display().to_string()),
        "{message}"
    );
    assert_eq!(
        fs::read(residue[0].join("payload")).unwrap(),
        b"unrelated replacement"
    );
    assert_eq!(fs::read(&source).unwrap(), b"third occupant");
    assert_eq!(fs::read(&retained).unwrap(), b"selected bytes");
}

#[test]
fn links_are_removed_without_touching_their_targets() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("file");
    let directory = root.path().join("directory");
    fs::write(&file, b"target").unwrap();
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("inside"), b"inside").unwrap();
    for (name, target) in [
        ("file-link", file.clone()),
        ("directory-link", directory.clone()),
        ("dangling-link", root.path().join("missing")),
    ] {
        let link = root.path().join(name);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        delete(&link).unwrap();
        assert!(fs::symlink_metadata(&link).is_err(), "{name} remains");
    }
    assert_eq!(fs::read(&file).unwrap(), b"target");
    assert_eq!(fs::read(directory.join("inside")).unwrap(), b"inside");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn a_tree_is_removed_without_following_inner_links_or_special_files() {
    let root = tempfile::tempdir().unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep"), b"keep").unwrap();
    let tree = root.path().join("tree");
    fs::create_dir_all(tree.join("a/b/c")).unwrap();
    fs::write(tree.join("a/b/c/leaf"), b"leaf").unwrap();
    fs::write(tree.join("a/top"), b"top").unwrap();
    std::os::unix::fs::symlink(&outside, tree.join("a/b/escape")).unwrap();
    std::os::unix::fs::symlink(root.path().join("nowhere"), tree.join("dangling")).unwrap();
    let fifo = std::ffi::CString::new(tree.join("a/fifo").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    delete(&tree).unwrap();
    assert!(fs::symlink_metadata(&tree).is_err());
    assert_eq!(fs::read(outside.join("keep")).unwrap(), b"keep");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn non_unicode_leaves_and_parents_are_deleted_exactly() {
    let root = tempfile::tempdir().unwrap();
    let parent = root
        .path()
        .join(OsString::from_vec(b"parent-\xff".to_vec()));
    fs::create_dir(&parent).unwrap();
    let leaf = parent.join(OsString::from_vec(b"leaf-\xfe".to_vec()));
    let sibling = parent.join("leaf-\u{fffd}");
    fs::write(&leaf, b"leaf").unwrap();
    fs::write(&sibling, b"lossy spelling").unwrap();
    delete(&leaf).unwrap();
    assert!(fs::symlink_metadata(&leaf).is_err());
    assert_eq!(fs::read(&sibling).unwrap(), b"lossy spelling");
    delete(&parent).unwrap();
    assert!(fs::symlink_metadata(&parent).is_err());
}

#[test]
fn deleting_one_hardlink_keeps_the_other_name() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    fs::write(&first, b"shared").unwrap();
    fs::hard_link(&first, &second).unwrap();
    delete(&first).unwrap();
    assert!(fs::symlink_metadata(&first).is_err());
    assert_eq!(fs::read(&second).unwrap(), b"shared");
}

#[test]
fn an_occupied_staging_name_is_refused_before_effects() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    fs::write(&source, b"selected").unwrap();
    let mut deletion = unix::prepare_with(
        Arc::new(vec![source.to_str().unwrap().to_owned()]),
        &mut |bytes: &mut [u8]| {
            bytes.fill(0xab);
            Ok(())
        },
    )
    .unwrap();
    let occupied = root
        .path()
        .join(format!(".tauri-delete-{}", "ab".repeat(16)));
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("someone"), b"else").unwrap();
    let result = execute(&mut deletion, &source, no_hook);
    assert!(
        matches!(result, Err(AppError::AlreadyExists(_))),
        "{result:?}"
    );
    assert_eq!(fs::read(&source).unwrap(), b"selected");
    assert_eq!(fs::read(occupied.join("someone")).unwrap(), b"else");
}

#[test]
fn a_failed_capture_with_clean_staging_is_an_ordinary_failure() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    fs::write(&source, b"selected").unwrap();
    let mut deletion = select(&source);
    let result = execute(&mut deletion, &source, |call| match call {
        Call::Rename { .. } => Err(injected()),
        _ => Ok(()),
    });
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert_eq!(fs::read(&source).unwrap(), b"selected");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn a_failed_capture_whose_staging_remains_is_uncertain_owned_residue() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    fs::write(&source, b"selected").unwrap();
    let mut deletion = select(&source);
    let result = execute(&mut deletion, &source, |_| Err(injected()));
    let Err(AppError::MutationUncertain(message)) = &result else {
        panic!("expected uncertain residue, got {result:?}");
    };
    let residue = staging(root.path());
    assert_eq!(residue.len(), 1);
    assert!(
        message.contains(&residue[0].display().to_string()),
        "{message}"
    );
    assert_eq!(fs::read_dir(&residue[0]).unwrap().count(), 0);
    assert_eq!(fs::read(&source).unwrap(), b"selected");
}

fn fail_nth_payload_unlink(n: usize) -> impl FnMut(&Call) -> io::Result<()> {
    let mut count = 0;
    move |call| {
        if let Call::Unlink { name, .. } = call {
            if !is_staging(name) {
                count += 1;
                if count == n {
                    return Err(injected());
                }
            }
        }
        Ok(())
    }
}

#[test]
fn partial_removal_is_uncertain_and_returns_what_remains() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("tree");
    fs::create_dir(&source).unwrap();
    for name in ["a", "b", "c"] {
        fs::write(source.join(name), name).unwrap();
    }
    let mut deletion = select(&source);
    let result = execute(&mut deletion, &source, fail_nth_payload_unlink(2));
    let Err(AppError::MutationUncertain(message)) = &result else {
        panic!("expected uncertain partial deletion, got {result:?}");
    };
    assert!(message.contains("partially deleted"), "{message}");
    assert_eq!(fs::read_dir(&source).unwrap().count(), 2);
    assert!(staging(root.path()).is_empty());
}

#[test]
fn removal_failing_before_any_unlink_restores_everything() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("tree");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("nested/file"), b"kept").unwrap();
    let mut deletion = select(&source);
    let result = execute(&mut deletion, &source, fail_nth_payload_unlink(1));
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert_eq!(fs::read(source.join("nested/file")).unwrap(), b"kept");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn completed_deletion_with_leftover_staging_succeeds_with_a_warning() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("file"), b"x").unwrap();
    let mut deletion = select(&source);
    let success = execute(&mut deletion, &source, |call| match call {
        Call::Unlink {
            name,
            directory: true,
        } if is_staging(name) => Err(injected()),
        _ => Ok(()),
    })
    .unwrap();
    let warning = success.warning.expect("leftover staging is reported");
    let residue = staging(root.path());
    assert_eq!(residue.len(), 1);
    assert!(
        warning.contains(&residue[0].display().to_string()),
        "{warning}"
    );
    assert_eq!(fs::read_dir(&residue[0]).unwrap().count(), 0);
    assert!(fs::symlink_metadata(&source).is_err());
    assert!(success.artifact.is_none());
}

#[test]
fn an_uncertain_item_stops_the_batch_before_its_suffix() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    fs::create_dir(&first).unwrap();
    fs::write(first.join("a"), b"a").unwrap();
    fs::write(first.join("b"), b"b").unwrap();
    fs::write(&second, b"second").unwrap();
    let paths = vec![
        first.to_str().unwrap().to_owned(),
        second.to_str().unwrap().to_owned(),
    ];
    let mut selection = unix::prepare_selection(Arc::new(paths.clone())).unwrap();
    let mut hook = fail_nth_payload_unlink(2);
    let outcome = tauri::async_runtime::block_on(batch::run_with_receipts(
        batch::BatchPlan::new(paths).unwrap(),
        move |path, _| selection.execute_next_with(path, &mut Hooks(&mut hook)),
    ));
    assert_eq!(outcome.uncertain.len(), 1, "{outcome:?}");
    assert!(outcome.succeeded.is_empty(), "{outcome:?}");
    assert_eq!(fs::read(&second).unwrap(), b"second");
}

#[test]
fn deep_and_wide_trees_are_removed_with_bounded_descriptors() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("deep");
    fs::create_dir(&source).unwrap();
    // Deeper than PATH_MAX and than the usual 1024 descriptor soft limit.
    let mut directory = Directory::open(&source).unwrap();
    for _ in 0..3_000 {
        directory = directory.create_directory(OsStr::new("d")).unwrap();
    }
    for index in 0..2_000 {
        directory
            .create_file(OsStr::new(&format!("file-{index}")))
            .unwrap();
    }
    drop(directory);
    delete(&source).unwrap();
    assert!(fs::symlink_metadata(&source).is_err());
    assert!(staging(root.path()).is_empty());
}

fn running_as_root() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(target_os = "linux")]
#[test]
fn a_writable_but_unreadable_parent_still_permits_deletion() {
    if running_as_root() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("parent");
    fs::create_dir(&parent).unwrap();
    let source = parent.join("selected");
    fs::write(&source, b"x").unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o300)).unwrap();
    let result = delete(&source);
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    result.unwrap();
    assert!(fs::symlink_metadata(&source).is_err());
    assert!(staging(&parent).is_empty());
}

#[test]
fn a_permission_error_inside_the_tree_restores_it_unchanged() {
    if running_as_root() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("tree");
    let locked = source.join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::write(locked.join("inside"), b"inside").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let result = delete(&source);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert_eq!(fs::read(locked.join("inside")).unwrap(), b"inside");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn claims_cover_the_source_its_staging_and_reject_physical_duplicates() {
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real");
    fs::create_dir(&real).unwrap();
    let source = real.join("selected");
    fs::write(&source, b"x").unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let (_, claims) = select(&source).into_admission();
    let physical = fs::canonicalize(&source).unwrap();
    assert!(claims.iter().any(|claim| claim.path.0 == physical));
    assert!(claims
        .iter()
        .any(|claim| claim.path.0.parent() == physical.parent()
            && is_staging(claim.path.0.file_name().unwrap())));
    let duplicate = unix::prepare_selection(Arc::new(vec![
        source.to_str().unwrap().to_owned(),
        alias.join("selected").to_str().unwrap().to_owned(),
    ]));
    assert!(duplicate.is_err());
    let ancestor = unix::prepare_selection(Arc::new(vec![
        real.to_str().unwrap().to_owned(),
        source.to_str().unwrap().to_owned(),
    ]));
    assert!(ancestor.is_err());
}

#[test]
fn an_alias_request_deletes_the_physical_entry_under_its_requested_spelling() {
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("selected"), b"x").unwrap();
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let requested = alias.join("selected");
    let mut selection = select(&requested);
    execute(&mut selection, &requested, no_hook).unwrap();
    assert!(fs::symlink_metadata(real.join("selected")).is_err());
    assert!(fs::symlink_metadata(&alias).unwrap().is_symlink());
    assert!(staging(&real).is_empty());
}

#[test]
fn a_missing_entry_fails_without_effects() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("missing");
    let mut selection = select(&source);
    let result = execute(&mut selection, &source, no_hook);
    assert!(result.is_err() && !is_uncertain(&result), "{result:?}");
    assert!(staging(root.path()).is_empty());
}

#[test]
fn execution_must_follow_the_prepared_order() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("selected");
    fs::write(&source, b"x").unwrap();
    let mut selection = select(&source);
    let other = root.path().join("other");
    let result = execute(&mut selection, &other, no_hook);
    assert!(
        matches!(result, Err(AppError::WorkerFailed(_))),
        "{result:?}"
    );
    assert_eq!(fs::read(&source).unwrap(), b"x");
}

/// Staging costs one mkdir, rename and rmdir per selected entry. Run with
/// `cargo test --release --lib permanent_delete::tests::bulk -- --ignored --nocapture`.
#[test]
#[ignore = "timing report, not a contract"]
fn bulk_selection_cost_against_plain_unlink() {
    const COUNT: usize = 5_000;
    let root = tempfile::tempdir().unwrap();
    let staged = root.path().join("staged");
    let plain = root.path().join("plain");
    fs::create_dir(&staged).unwrap();
    fs::create_dir(&plain).unwrap();
    let mut paths = Vec::with_capacity(COUNT);
    for index in 0..COUNT {
        fs::write(staged.join(index.to_string()), b"x").unwrap();
        fs::write(plain.join(index.to_string()), b"x").unwrap();
        paths.push(staged.join(index.to_string()).to_str().unwrap().to_owned());
    }
    let started = std::time::Instant::now();
    let mut selection = unix::prepare_selection(Arc::new(paths.clone())).unwrap();
    let prepared = started.elapsed();
    for path in &paths {
        selection.execute_next(path).unwrap();
    }
    let staged_total = started.elapsed();
    let started = std::time::Instant::now();
    for index in 0..COUNT {
        crate::files::file_ops::remove_entry_at(&plain.join(index.to_string())).unwrap();
    }
    let plain_total = started.elapsed();
    println!(
        "{COUNT} files: staged {staged_total:?} (prepare {prepared:?}), plain {plain_total:?}"
    );
    assert_eq!(fs::read_dir(&staged).unwrap().count(), 0);
}
