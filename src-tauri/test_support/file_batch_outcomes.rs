#![cfg(target_os = "linux")]

use super::{batch, move_multiple_to_trash, restore_entries, BatchPlan};
use crate::{
    error::AppError,
    files::trash_artifact::{RestoreRequest, TrashArtifact},
};
use std::{
    env, fs,
    future::Future,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

const CHILD_CASE: &str = "TAURI_EXPLORER_TRASH_TEST_CASE";
const FIXTURE_ROOT: &str = "TAURI_EXPLORER_TRASH_TEST_ROOT";
const TEST_MODULE: &str = "files::trash::file_batch_outcomes";

struct IsolatedTrash {
    root: PathBuf,
}

impl IsolatedTrash {
    fn file(&self, name: &str, contents: &str) -> PathBuf {
        let files = self.root.join("files");
        fs::create_dir_all(&files).expect("create fixture files directory");
        let path = files.join(name);
        fs::write(&path, contents).expect("write fixture file");
        path
    }

    fn missing_file(&self, name: &str) -> PathBuf {
        self.root.join("files").join(name)
    }
}

struct PermissionGuard {
    path: PathBuf,
    mode: u32,
}

impl PermissionGuard {
    fn deny_writes(path: PathBuf) -> Self {
        let mode = fs::metadata(&path)
            .expect("read owned directory permissions")
            .permissions()
            .mode();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o500))
            .expect("make owned directory read-only");
        Self { path, mode }
    }
}

impl Drop for PermissionGuard {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode))
            .expect("restore owned directory permissions");
    }
}

#[derive(Clone)]
struct ExactTrash {
    requested_path: String,
    artifact: Arc<TrashArtifact>,
}

impl ExactTrash {
    fn request(&self) -> RestoreRequest {
        RestoreRequest {
            path: self.requested_path.clone(),
            artifact: self.artifact.clone(),
        }
    }

    fn payload(&self) -> PathBuf {
        let TrashArtifact::Freedesktop { root, name, .. } = self.artifact.as_ref() else {
            panic!("Linux deletion returned a non-Freedesktop receipt");
        };
        root.join("files").join(name)
    }

    fn info(&self) -> PathBuf {
        let TrashArtifact::Freedesktop { root, name, .. } = self.artifact.as_ref() else {
            panic!("Linux deletion returned a non-Freedesktop receipt");
        };
        let mut info = name.clone();
        info.push(".trashinfo");
        root.join("info").join(info)
    }
}

fn isolated(case: &str, body: impl FnOnce(IsolatedTrash)) {
    if env::var(CHILD_CASE).as_deref() == Ok(case) {
        let root = env::var_os(FIXTURE_ROOT)
            .map(PathBuf::from)
            .expect("isolated child has a fixture root");
        body(IsolatedTrash { root });
        return;
    }

    let root = tempfile::tempdir().expect("create isolated trash fixture");
    let xdg_data_home = root.path().join("xdg-data");
    fs::create_dir(&xdg_data_home).expect("create isolated XDG data directory");
    let exact_test = format!("{TEST_MODULE}::{case}");
    let output = Command::new(env::current_exe().expect("resolve current test binary"))
        .args(["--exact", &exact_test, "--nocapture", "--test-threads=1"])
        .env(CHILD_CASE, case)
        .env(FIXTURE_ROOT, root.path())
        .env("XDG_DATA_HOME", &xdg_data_home)
        .output()
        .expect("run isolated trash test child");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("running 1 test"),
        "isolated trash test {exact_test} failed or did not run\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}

fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build test runtime")
        .block_on(future)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn assert_known_outcome(
    outcome: &batch::FileBatchOutcome,
    succeeded: &[String],
    failed: &[String],
) {
    assert_eq!(&outcome.succeeded, succeeded);
    assert_eq!(
        outcome
            .failed
            .iter()
            .map(|failure| failure.path.clone())
            .collect::<Vec<_>>(),
        failed
    );
    assert!(outcome
        .failed
        .iter()
        .all(|failure| !failure.error.trim().is_empty()));
    assert!(outcome.uncertain.is_empty());
    assert!(outcome.unstarted.is_empty());
}

fn trash_exact(requested_path: String) -> ExactTrash {
    let outcome = run(move_multiple_to_trash(vec![requested_path.clone()]))
        .expect("trash returns a batch receipt");
    assert_known_outcome(&outcome, std::slice::from_ref(&requested_path), &[]);
    assert!(outcome.warnings.is_empty());
    let artifact = outcome
        .artifacts
        .get(&requested_path)
        .cloned()
        .expect("successful local trash returns exact recovery identity");
    ExactTrash {
        requested_path,
        artifact,
    }
}

fn restore_exact(items: impl IntoIterator<Item = ExactTrash>) -> batch::FileBatchOutcome {
    let requests = items.into_iter().map(|item| item.request()).collect();
    run(restore_entries(requests)).expect("exact restore returns a batch outcome")
}

#[test]
fn bulk_trash_retains_success_and_receipt_when_another_path_is_missing() {
    isolated(
        "bulk_trash_retains_success_and_receipt_when_another_path_is_missing",
        |fixture| {
            let valid = fixture.file("accepted.txt", "accepted");
            let missing = fixture.missing_file("missing.txt");
            let valid_string = path_string(&valid);
            let missing_string = path_string(&missing);
            let outcome = run(move_multiple_to_trash(vec![
                valid_string.clone(),
                valid_string.clone(),
                missing_string.clone(),
            ]))
            .expect("per-file failures remain inside the batch outcome");

            assert!(!valid.exists());
            assert_known_outcome(
                &outcome,
                std::slice::from_ref(&valid_string),
                std::slice::from_ref(&missing_string),
            );
            assert!(outcome.artifacts.contains_key(&valid_string));
            assert!(!outcome.artifacts.contains_key(&missing_string));
        },
    );
}

#[test]
fn double_slash_local_path_uses_an_exact_linux_trash_receipt() {
    isolated(
        "double_slash_local_path_uses_an_exact_linux_trash_receipt",
        |fixture| {
            let path = fixture.file("double-slash-local.txt", "exact local contents");
            let spelling = format!("/{}", path_string(&path));
            assert!(spelling.starts_with("//"));
            let trashed = trash_exact(spelling.clone());
            assert!(!path.exists());
            assert_eq!(
                fs::read(trashed.payload()).unwrap(),
                b"exact local contents"
            );

            let outcome = restore_exact([trashed]);
            assert_eq!(fs::read(&path).unwrap(), b"exact local contents");
            assert_known_outcome(&outcome, &[spelling], &[]);
        },
    );
}

#[test]
fn unwritable_trash_setup_is_a_known_unchanged_failure() {
    isolated(
        "unwritable_trash_setup_is_a_known_unchanged_failure",
        |fixture| {
            let path = fixture.file("trash-setup-failure.txt", "source bytes");
            let requested = path_string(&path);
            let _permissions = PermissionGuard::deny_writes(fixture.root.join("xdg-data"));
            let outcome = run(move_multiple_to_trash(vec![requested.clone()]))
                .expect("setup failure is represented by the batch outcome");

            assert_eq!(fs::read(&path).unwrap(), b"source bytes");
            assert_known_outcome(&outcome, &[], &[requested]);
            assert!(outcome.artifacts.is_empty());
        },
    );
}

#[test]
fn duplicate_exact_restore_request_is_rejected_before_any_payload_moves() {
    isolated(
        "duplicate_exact_restore_request_is_rejected_before_any_payload_moves",
        |fixture| {
            let path = fixture.file("duplicate.txt", "retained payload");
            let trashed = trash_exact(path_string(&path));
            let payload = trashed.payload();
            let error = run(restore_entries(vec![trashed.request(), trashed.request()]))
                .expect_err("one artifact cannot be assigned twice");

            assert!(matches!(error, AppError::InvalidPath(_)));
            assert!(!path.exists());
            assert_eq!(fs::read(payload).unwrap(), b"retained payload");
        },
    );
}

#[test]
fn exact_restore_reports_prior_success_when_a_later_target_collides() {
    isolated(
        "exact_restore_reports_prior_success_when_a_later_target_collides",
        |fixture| {
            let first_path = fixture.file("restored-first.txt", "first contents");
            let collision_path = fixture.file("collision.txt", "trashed contents");
            let first = trash_exact(path_string(&first_path));
            let collision = trash_exact(path_string(&collision_path));
            fs::write(&collision_path, b"existing target").unwrap();
            let outcome = restore_exact([first.clone(), collision.clone()]);

            assert_eq!(fs::read(&first_path).unwrap(), b"first contents");
            assert_eq!(fs::read(&collision_path).unwrap(), b"existing target");
            assert_eq!(fs::read(collision.payload()).unwrap(), b"trashed contents");
            assert_known_outcome(
                &outcome,
                std::slice::from_ref(&first.requested_path),
                std::slice::from_ref(&collision.requested_path),
            );
        },
    );
}

#[test]
fn same_path_versions_restore_by_receipt_instead_of_deletion_timestamp() {
    isolated(
        "same_path_versions_restore_by_receipt_instead_of_deletion_timestamp",
        |fixture| {
            let path = fixture.file("versioned.txt", "older contents");
            let requested = path_string(&path);
            let older = trash_exact(requested.clone());
            fs::write(&path, b"newer contents").unwrap();
            let newer = trash_exact(requested.clone());

            let first = restore_exact([older]);
            assert_known_outcome(&first, std::slice::from_ref(&requested), &[]);
            assert_eq!(fs::read(&path).unwrap(), b"older contents");
            fs::remove_file(&path).unwrap();
            let second = restore_exact([newer]);
            assert_known_outcome(&second, std::slice::from_ref(&requested), &[]);
            assert_eq!(fs::read(path).unwrap(), b"newer contents");
        },
    );
}

#[test]
fn restored_payload_succeeds_when_metadata_cleanup_fails_and_stale_info_is_ignored() {
    isolated(
        "restored_payload_succeeds_when_metadata_cleanup_fails_and_stale_info_is_ignored",
        |fixture| {
            let path = fixture.file("cleanup-failure.txt", "durable contents");
            let requested = path_string(&path);
            let first = trash_exact(requested.clone());
            let stale_info = first.info();
            let permissions = PermissionGuard::deny_writes(
                stale_info.parent().expect("metadata directory").to_owned(),
            );

            let first_outcome = restore_exact([first]);
            assert_known_outcome(&first_outcome, std::slice::from_ref(&requested), &[]);
            assert_eq!(fs::read(&path).unwrap(), b"durable contents");
            assert!(stale_info.exists());
            drop(permissions);

            let second = trash_exact(requested.clone());
            let second_outcome = restore_exact([second]);
            assert_known_outcome(&second_outcome, &[requested], &[]);
            assert_eq!(fs::read(path).unwrap(), b"durable contents");
            assert!(
                stale_info.exists(),
                "exact restore never consumes stale metadata"
            );
        },
    );
}

#[test]
fn broken_symlink_restores_and_an_existing_broken_symlink_is_a_collision() {
    isolated(
        "broken_symlink_restores_and_an_existing_broken_symlink_is_a_collision",
        |fixture| {
            let files = fixture.root.join("files");
            fs::create_dir_all(&files).unwrap();
            let restored_path = files.join("restored-link");
            let collision_path = files.join("collision-link");
            let restored_target = PathBuf::from("missing-restored-target");
            let trashed_target = PathBuf::from("missing-trashed-target");
            let occupant_target = PathBuf::from("missing-existing-target");
            symlink(&restored_target, &restored_path).unwrap();
            symlink(&trashed_target, &collision_path).unwrap();
            let restored = trash_exact(path_string(&restored_path));
            let collision = trash_exact(path_string(&collision_path));
            symlink(&occupant_target, &collision_path).unwrap();

            let outcome = restore_exact([restored.clone(), collision.clone()]);
            assert_eq!(fs::read_link(&restored_path).unwrap(), restored_target);
            assert_eq!(fs::read_link(&collision_path).unwrap(), occupant_target);
            assert_eq!(fs::read_link(collision.payload()).unwrap(), trashed_target);
            assert_known_outcome(
                &outcome,
                std::slice::from_ref(&restored.requested_path),
                std::slice::from_ref(&collision.requested_path),
            );
        },
    );
}

#[test]
fn directory_restore_continues_after_a_sibling_target_collision() {
    isolated(
        "directory_restore_continues_after_a_sibling_target_collision",
        |fixture| {
            let restored_path = fixture.root.join("files/restored-directory");
            let collision_path = fixture.root.join("files/collision-directory");
            fs::create_dir_all(&restored_path).unwrap();
            fs::create_dir_all(&collision_path).unwrap();
            fs::write(restored_path.join("restored.txt"), b"restored child").unwrap();
            fs::write(collision_path.join("trashed.txt"), b"trashed child").unwrap();
            let restored = trash_exact(path_string(&restored_path));
            let collision = trash_exact(path_string(&collision_path));
            fs::create_dir(&collision_path).unwrap();
            fs::write(collision_path.join("existing.txt"), b"existing child").unwrap();

            let outcome = restore_exact([collision.clone(), restored.clone()]);
            assert_eq!(
                fs::read(restored_path.join("restored.txt")).unwrap(),
                b"restored child"
            );
            assert_eq!(
                fs::read(collision_path.join("existing.txt")).unwrap(),
                b"existing child"
            );
            assert!(!collision_path.join("trashed.txt").exists());
            assert_eq!(
                fs::read(collision.payload().join("trashed.txt")).unwrap(),
                b"trashed child"
            );
            assert_known_outcome(
                &outcome,
                std::slice::from_ref(&restored.requested_path),
                std::slice::from_ref(&collision.requested_path),
            );
        },
    );
}

#[test]
fn restore_recreates_missing_parent_hierarchy_and_reports_only_refresh_effects_for_it() {
    isolated(
        "restore_recreates_missing_parent_hierarchy_and_reports_only_refresh_effects_for_it",
        |fixture| {
            let existing = fixture.root.join("existing-ancestor");
            let first = existing.join("recreated-first");
            let second = first.join("recreated-second");
            fs::create_dir_all(&second).unwrap();
            let path = second.join("restored.txt");
            fs::write(&path, b"exact restored bytes").unwrap();
            let trashed = trash_exact(path_string(&path));
            fs::remove_dir(&second).unwrap();
            fs::remove_dir(&first).unwrap();

            let outcome = restore_exact([trashed.clone()]);
            assert_eq!(fs::read(&path).unwrap(), b"exact restored bytes");
            assert_known_outcome(&outcome, std::slice::from_ref(&trashed.requested_path), &[]);
            assert_eq!(
                outcome.refresh_dirs,
                [
                    path_string(&existing),
                    path_string(&first),
                    path_string(&second)
                ]
            );
            assert_eq!(
                outcome.affected_paths().cloned().collect::<Vec<_>>(),
                [trashed.requested_path]
            );
            assert!(serde_json::to_value(&outcome)
                .expect("serialize public outcome")
                .get("refresh_dirs")
                .is_none());
        },
    );
}

#[test]
fn restore_with_existing_parent_has_no_auxiliary_refresh_directories() {
    isolated(
        "restore_with_existing_parent_has_no_auxiliary_refresh_directories",
        |fixture| {
            let path = fixture.file("existing-parent.txt", "exact bytes");
            let trashed = trash_exact(path_string(&path));
            let outcome = restore_exact([trashed.clone()]);

            assert_eq!(fs::read(&path).unwrap(), b"exact bytes");
            assert_known_outcome(&outcome, std::slice::from_ref(&trashed.requested_path), &[]);
            assert!(outcome.refresh_dirs.is_empty());
        },
    );
}

#[test]
fn failed_leaf_publication_retains_exact_payload_and_parent_refreshes() {
    isolated(
        "failed_leaf_publication_retains_exact_payload_and_parent_refreshes",
        |fixture| {
            let existing = fixture.root.join("failure-existing-ancestor");
            let first = existing.join("failure-recreated-first");
            let second = first.join("failure-recreated-second");
            fs::create_dir_all(&second).unwrap();
            let path = second.join("restored.txt");
            fs::write(&path, b"retryable exact bytes").unwrap();
            let trashed = trash_exact(path_string(&path));
            let payload = trashed.payload();
            fs::remove_dir(&second).unwrap();
            fs::remove_dir(&first).unwrap();
            let worker = trashed.request();

            let outcome = run(batch::run_with_effects(
                BatchPlan::new(vec![trashed.requested_path.clone()]).unwrap(),
                move |_, effects| {
                    crate::files::freedesktop_trash::restore_with_before_publish(
                        &worker,
                        effects,
                        || {
                            Err(AppError::PermissionDenied(
                                "injected rejection before leaf publication".into(),
                            ))
                        },
                    )
                },
            ));

            assert_known_outcome(&outcome, &[], std::slice::from_ref(&trashed.requested_path));
            assert_eq!(
                outcome.refresh_dirs,
                [
                    path_string(&existing),
                    path_string(&first),
                    path_string(&second)
                ]
            );
            assert_eq!(fs::read(&payload).unwrap(), b"retryable exact bytes");
            assert!(!path.exists());

            let retry = restore_exact([trashed]);
            assert!(retry.refresh_dirs.is_empty());
            assert_eq!(fs::read(path).unwrap(), b"retryable exact bytes");
        },
    );
}

#[test]
fn publication_panic_retains_parent_effects_and_exact_payload_for_inspection() {
    isolated(
        "publication_panic_retains_parent_effects_and_exact_payload_for_inspection",
        |fixture| {
            let existing = fixture.root.join("panic-existing-ancestor");
            let first = existing.join("panic-recreated-first");
            let second = first.join("panic-recreated-second");
            fs::create_dir_all(&second).unwrap();
            let path = second.join("restored.txt");
            fs::write(&path, b"panic recovery exact bytes").unwrap();
            let trashed = trash_exact(path_string(&path));
            let payload = trashed.payload();
            fs::remove_dir(&second).unwrap();
            fs::remove_dir(&first).unwrap();
            let worker = trashed.request();

            let outcome = run(batch::run_with_effects(
                BatchPlan::new(vec![trashed.requested_path.clone()]).unwrap(),
                move |_, effects| {
                    crate::files::freedesktop_trash::restore_with_before_publish(
                        &worker,
                        effects,
                        || panic!("injected panic before leaf publication"),
                    )
                },
            ));

            assert!(outcome.succeeded.is_empty());
            assert!(outcome.failed.is_empty());
            assert_eq!(outcome.uncertain.len(), 1);
            assert_eq!(outcome.uncertain[0].path, trashed.requested_path);
            assert!(outcome.uncertain[0]
                .error
                .contains("injected panic before leaf publication"));
            assert_eq!(
                outcome.refresh_dirs,
                [
                    path_string(&existing),
                    path_string(&first),
                    path_string(&second)
                ]
            );
            assert_eq!(fs::read(&payload).unwrap(), b"panic recovery exact bytes");
            assert!(!path.exists());

            let recovery = restore_exact([trashed]);
            assert!(recovery.refresh_dirs.is_empty());
            assert_eq!(fs::read(path).unwrap(), b"panic recovery exact bytes");
        },
    );
}
