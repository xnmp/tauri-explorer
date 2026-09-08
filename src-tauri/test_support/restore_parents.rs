#![cfg(unix)]

use super::{create, create_with};
use crate::files::batch::{run_with_effects, BatchPlan, DirectoryEffects};
use std::{
    collections::HashSet,
    fs, io,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
};

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn plan(path: &Path) -> BatchPlan {
    BatchPlan::new(vec![path_string(path)]).expect("valid batch path")
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

fn assert_refresh_dirs(actual: &[String], expected: &[PathBuf]) {
    assert_eq!(
        actual.len(),
        expected.len(),
        "refresh paths are deduplicated"
    );
    let actual = actual.iter().map(String::as_str).collect::<HashSet<_>>();
    let expected = expected
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<HashSet<_>>();
    assert_eq!(actual, expected.iter().map(String::as_str).collect());
}

#[test]
fn partial_ancestor_creation_retains_every_possible_refresh_after_mkdir_failure() {
    let root = tempfile::tempdir().expect("fixture root");
    let first = root.path().join("first");
    let blocked = first.join("blocked");
    let target = blocked.join("unstarted");
    let request = target.join("payload.txt");
    let blocked_for_worker = blocked.clone();
    let target_for_worker = target.clone();

    let outcome = run(run_with_effects(plan(&request), move |_, effects| {
        create_with(&target_for_worker, effects, |path| {
            if path == blocked_for_worker {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected mkdir failure",
                ));
            }
            fs::create_dir(path)
        })
    }));

    assert!(first.is_dir(), "the earlier ancestor actually committed");
    assert!(!blocked.exists());
    assert!(!target.exists());
    assert!(outcome.succeeded.is_empty());
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(outcome.failed[0].path, path_string(&request));
    assert!(outcome.failed[0].error.contains("injected mkdir failure"));
    assert!(outcome.uncertain.is_empty());
    assert_refresh_dirs(
        &outcome.refresh_dirs,
        &[root.path().to_path_buf(), first, blocked],
    );
}

#[test]
fn panic_after_mkdir_retains_the_external_effect_and_marks_the_active_item_uncertain() {
    let root = tempfile::tempdir().expect("fixture root");
    let created = root.path().join("created-before-panic");
    let target = created.join("unstarted");
    let request = target.join("payload.txt");
    let created_for_worker = created.clone();
    let target_for_worker = target.clone();

    let outcome = run(run_with_effects(plan(&request), move |_, effects| {
        create_with(&target_for_worker, effects, |path| {
            fs::create_dir(path)?;
            if path == created_for_worker {
                panic!("injected panic after mkdir effect");
            }
            Ok(())
        })
    }));

    assert!(created.is_dir(), "the mkdir before the panic committed");
    assert!(!target.exists());
    assert!(outcome.succeeded.is_empty());
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.uncertain.len(), 1);
    assert_eq!(outcome.uncertain[0].path, path_string(&request));
    assert!(outcome.uncertain[0]
        .error
        .contains("injected panic after mkdir effect"));
    assert_refresh_dirs(&outcome.refresh_dirs, &[root.path().to_path_buf(), created]);
}

#[test]
fn a_concurrent_creator_is_success_when_each_requested_path_is_now_a_directory() {
    let root = tempfile::tempdir().expect("fixture root");
    let parent = root.path().join("raced-parent");
    let target = parent.join("raced-leaf");
    let request = target.join("payload.txt");
    let target_for_worker = target.clone();

    let outcome = run(run_with_effects(plan(&request), move |_, effects| {
        create_with(&target_for_worker, effects, |path| {
            fs::create_dir(path)?;
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "concurrent creator won",
            ))
        })
    }));

    assert!(target.is_dir());
    assert_eq!(outcome.succeeded, vec![path_string(&request)]);
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert_refresh_dirs(
        &outcome.refresh_dirs,
        &[root.path().to_path_buf(), parent, target],
    );
}

#[test]
fn files_and_broken_symlinks_remain_exact_obstructions() {
    let root = tempfile::tempdir().expect("fixture root");
    let file = root.path().join("file-obstruction");
    fs::write(&file, b"exact obstruction bytes").expect("file obstruction");
    create(&file.join("child"), &DirectoryEffects::default())
        .expect_err("a file cannot become a parent directory");
    assert_eq!(
        fs::read(&file).expect("file remains"),
        b"exact obstruction bytes"
    );

    let broken = root.path().join("broken-link");
    let missing_target = root.path().join("missing-target");
    symlink(&missing_target, &broken).expect("broken symlink fixture");
    create(&broken.join("child"), &DirectoryEffects::default())
        .expect_err("a broken symlink cannot become a parent directory");
    assert_eq!(
        fs::read_link(&broken).expect("link remains"),
        missing_target
    );
    assert!(!broken.join("child").exists());
}

#[test]
fn an_existing_symlink_to_a_directory_is_a_valid_parent() {
    let root = tempfile::tempdir().expect("fixture root");
    let real = root.path().join("real-parent");
    let link = root.path().join("linked-parent");
    fs::create_dir(&real).expect("real parent");
    symlink(&real, &link).expect("directory symlink");

    create(
        &link.join("created-through-link"),
        &DirectoryEffects::default(),
    )
    .expect("directory symlinks follow create_dir_all semantics");

    assert_eq!(fs::read_link(&link).expect("link remains"), real);
    assert!(link.join("created-through-link").is_dir());
}

#[test]
fn an_extremely_long_component_fails_without_mutating_the_existing_parent() {
    let root = tempfile::tempdir().expect("fixture root");
    let oversized = "x".repeat(8 * 1024 * 1024 + 1);
    let target = root.path().join(oversized);

    create(&target, &DirectoryEffects::default())
        .expect_err("the malformed native path must be rejected");

    assert_eq!(
        fs::read_dir(root.path())
            .expect("list unchanged fixture")
            .count(),
        0
    );
}

#[test]
fn sibling_restores_deduplicate_shared_directory_refreshes() {
    let root = tempfile::tempdir().expect("fixture root");
    let shared = root.path().join("shared");
    let first = shared.join("first");
    let second = shared.join("second");
    let first_request = first.join("payload.txt");
    let second_request = second.join("payload.txt");
    let first_for_worker = first.clone();
    let second_for_worker = second.clone();
    let first_key = path_string(&first_request);

    let plan = BatchPlan::new(vec![first_key.clone(), path_string(&second_request)])
        .expect("valid sibling batch");
    let outcome = run(run_with_effects(plan, move |path, effects| {
        let target = if path == first_key {
            &first_for_worker
        } else {
            &second_for_worker
        };
        create(target, effects)
    }));

    assert!(first.is_dir());
    assert!(second.is_dir());
    assert_eq!(
        outcome.succeeded,
        vec![path_string(&first_request), path_string(&second_request)]
    );
    assert!(outcome.failed.is_empty());
    assert!(outcome.uncertain.is_empty());
    assert_refresh_dirs(
        &outcome.refresh_dirs,
        &[root.path().to_path_buf(), shared, first, second],
    );
}
