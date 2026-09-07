#![cfg(target_os = "linux")]

use super::{move_multiple_to_trash, move_to_trash, restore_from_trash};
use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    future::Future,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};

const CHILD_CASE: &str = "TAURI_EXPLORER_TRASH_TEST_CASE";
const FIXTURE_ROOT: &str = "TAURI_EXPLORER_TRASH_TEST_ROOT";
const TEST_MODULE: &str = "files::trash::file_batch_outcomes";

struct IsolatedTrash {
    root: PathBuf,
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
            .expect("make owned trash metadata directory read-only");
        Self { path, mode }
    }
}

impl Drop for PermissionGuard {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, fs::Permissions::from_mode(self.mode))
            .expect("restore owned trash metadata permissions");
    }
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

fn assert_batch_outcome<T: Serialize>(
    outcome: T,
    expected_succeeded: &[String],
    expected_failed: &[String],
) {
    let serialized = serde_json::to_value(outcome).expect("serialize file batch outcome");
    let succeeded = serialized
        .get("succeeded")
        .and_then(Value::as_array)
        .expect("outcome has succeeded paths");
    let succeeded = succeeded
        .iter()
        .map(|path| {
            path.as_str()
                .expect("succeeded path is a string")
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(succeeded, expected_succeeded);

    let failed = serialized
        .get("failed")
        .and_then(Value::as_array)
        .expect("outcome has failed entries");
    let failed_paths = failed
        .iter()
        .map(|failure| {
            let error = failure
                .get("error")
                .and_then(Value::as_str)
                .expect("failed entry has an error string");
            assert!(!error.trim().is_empty(), "failed entry explains its error");
            failure
                .get("path")
                .and_then(Value::as_str)
                .expect("failed entry has a path string")
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(failed_paths, expected_failed);
}

fn trash(path: &Path) {
    run(move_to_trash(path_string(path))).expect("seed isolated trash fixture");
}

fn owned_trash_items(path: &Path) -> Vec<trash::TrashItem> {
    trash::os_limited::list()
        .expect("list isolated trash")
        .into_iter()
        .filter(|item| item.original_path() == path)
        .collect()
}

fn trashed_payload(item: &trash::TrashItem) -> PathBuf {
    let info_path = Path::new(&item.id);
    let trash_root = info_path
        .parent()
        .and_then(Path::parent)
        .expect("trash info resides below the trash root");
    let payload_name = info_path
        .file_stem()
        .expect("trash info has a payload name");
    trash_root.join("files").join(payload_name)
}

fn set_deletion_date(item: &trash::TrashItem, date: &str) {
    let info_path = Path::new(&item.id);
    let info = fs::read_to_string(info_path).expect("read owned trash metadata");
    let mut replaced = false;
    let rewritten = info
        .lines()
        .map(|line| {
            if line.starts_with("DeletionDate=") {
                replaced = true;
                format!("DeletionDate={date}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(replaced, "owned trash metadata has a deletion date");
    fs::write(info_path, format!("{rewritten}\n")).expect("update owned trash metadata");
}

#[test]
fn bulk_trash_reports_success_when_another_path_is_missing() {
    isolated(
        "bulk_trash_reports_success_when_another_path_is_missing",
        |fixture| {
            let valid = fixture.file("accepted.txt", "accepted");
            let missing = fixture.missing_file("missing.txt");
            let valid_string = path_string(&valid);
            let missing_string = path_string(&missing);

            let result = run(move_multiple_to_trash(vec![
                valid_string.clone(),
                valid_string.clone(),
                missing_string.clone(),
            ]));

            assert!(
                !valid.exists(),
                "the valid file was durably moved despite the sibling failure"
            );
            let outcome = result.expect("per-file failures are returned inside the batch outcome");
            assert_batch_outcome(outcome, &[valid_string], &[missing_string]);
        },
    );
}

#[test]
fn restore_reports_an_unmatched_path_without_discarding_a_valid_restore() {
    isolated(
        "restore_reports_an_unmatched_path_without_discarding_a_valid_restore",
        |fixture| {
            let valid = fixture.file("restorable.txt", "restored contents");
            let missing = fixture.missing_file("never-trashed.txt");
            trash(&valid);
            let valid_string = path_string(&valid);
            let missing_string = path_string(&missing);

            let result = run(restore_from_trash(vec![
                valid_string.clone(),
                missing_string.clone(),
            ]));

            assert_eq!(
                fs::read_to_string(&valid).expect("valid item was restored"),
                "restored contents"
            );
            let outcome = result.expect("an unmatched path is a per-file restore failure");
            assert_batch_outcome(outcome, &[valid_string], &[missing_string]);
        },
    );
}

#[test]
fn restore_reports_prior_success_when_a_later_target_collides() {
    isolated(
        "restore_reports_prior_success_when_a_later_target_collides",
        |fixture| {
            let restored = fixture.file("restored-first.txt", "first contents");
            let collision = fixture.file("collision.txt", "trashed contents");
            trash(&restored);
            trash(&collision);
            fs::write(&collision, "existing target").expect("create restore collision");
            let restored_string = path_string(&restored);
            let collision_string = path_string(&collision);

            let result = run(restore_from_trash(vec![
                restored_string.clone(),
                collision_string.clone(),
            ]));

            assert_eq!(
                fs::read_to_string(&restored).expect("earlier item was restored"),
                "first contents"
            );
            assert_eq!(
                fs::read_to_string(&collision).expect("colliding target remains"),
                "existing target"
            );
            let outcome = result.expect("a restore collision is a per-file failure");
            assert_batch_outcome(outcome, &[restored_string], &[collision_string]);
        },
    );
}

#[test]
fn restore_chooses_the_newest_owned_item_for_an_original_path() {
    isolated(
        "restore_chooses_the_newest_owned_item_for_an_original_path",
        |fixture| {
            let path = fixture.file("versioned.txt", "older contents");
            trash(&path);
            fs::write(&path, "newer contents").expect("write replacement version");
            trash(&path);

            let items = owned_trash_items(&path);
            assert_eq!(items.len(), 2, "both owned versions are in isolated trash");
            for item in &items {
                match fs::read_to_string(trashed_payload(item))
                    .expect("read owned trashed payload")
                    .as_str()
                {
                    "older contents" => set_deletion_date(item, "2001-01-01T00:00:00"),
                    "newer contents" => set_deletion_date(item, "2031-01-01T00:00:00"),
                    contents => panic!("unexpected owned trash payload: {contents}"),
                }
            }
            let path_string = path_string(&path);

            let result = run(restore_from_trash(vec![path_string.clone()]));

            assert_eq!(
                fs::read_to_string(&path).expect("newest item was restored"),
                "newer contents"
            );
            let outcome = result.expect("newest matching item restores successfully");
            assert_batch_outcome(outcome, &[path_string], &[]);
        },
    );
}

#[test]
fn restored_payload_is_success_even_when_trash_metadata_cleanup_fails() {
    isolated(
        "restored_payload_is_success_even_when_trash_metadata_cleanup_fails",
        |fixture| {
            let path = fixture.file("cleanup-failure.txt", "durable contents");
            trash(&path);
            let item = owned_trash_items(&path)
                .into_iter()
                .next()
                .expect("owned item is present in isolated trash");
            let info_dir = Path::new(&item.id)
                .parent()
                .expect("trash metadata has a parent")
                .to_owned();
            let permissions = PermissionGuard::deny_writes(info_dir);
            let path_string = path_string(&path);

            let first_restore = run(restore_from_trash(vec![path_string.clone()]))
                .expect("metadata cleanup failure is represented by the per-file outcome");
            assert_eq!(
                fs::read_to_string(&path).expect("payload was durably restored"),
                "durable contents"
            );
            assert_batch_outcome(first_restore, std::slice::from_ref(&path_string), &[]);

            drop(permissions);
            let redo = run(move_multiple_to_trash(vec![path_string.clone()]))
                .expect("redo trash returns a per-file outcome");
            assert_batch_outcome(redo, std::slice::from_ref(&path_string), &[]);
            let second_restore = run(restore_from_trash(vec![path_string.clone()]))
                .expect("the next restore returns a per-file outcome");
            assert_batch_outcome(second_restore, std::slice::from_ref(&path_string), &[]);
            assert_eq!(
                fs::read_to_string(&path).expect("the next undo restored the payload"),
                "durable contents"
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
            fs::create_dir_all(&files).expect("create fixture files directory");
            let restored = files.join("restored-link");
            let collision = files.join("collision-link");
            let restored_target = PathBuf::from("missing-restored-target");
            let trashed_collision_target = PathBuf::from("missing-trashed-target");
            let existing_collision_target = PathBuf::from("missing-existing-target");
            symlink(&restored_target, &restored).expect("create restorable broken symlink");
            symlink(&trashed_collision_target, &collision)
                .expect("create colliding broken symlink for trash");
            trash(&restored);
            trash(&collision);
            symlink(&existing_collision_target, &collision)
                .expect("create broken symlink at restore target");
            let restored_string = path_string(&restored);
            let collision_string = path_string(&collision);

            let outcome = run(restore_from_trash(vec![
                restored_string.clone(),
                collision_string.clone(),
            ]))
            .expect("symlink restores return a per-file outcome");

            assert!(fs::symlink_metadata(&restored)
                .expect("broken symlink was restored")
                .file_type()
                .is_symlink());
            assert_eq!(
                fs::read_link(&restored).expect("read restored broken symlink"),
                restored_target
            );
            assert_eq!(
                fs::read_link(&collision).expect("read colliding broken symlink"),
                existing_collision_target,
                "no-replace restore preserves the existing link"
            );
            assert_batch_outcome(outcome, &[restored_string], &[collision_string]);
        },
    );
}

#[test]
fn directory_restore_continues_after_a_sibling_target_collision() {
    isolated(
        "directory_restore_continues_after_a_sibling_target_collision",
        |fixture| {
            let restored = fixture.root.join("files/restored-directory");
            let collision = fixture.root.join("files/collision-directory");
            fs::create_dir_all(&restored).expect("create restorable directory");
            fs::create_dir_all(&collision).expect("create colliding directory for trash");
            fs::write(restored.join("restored.txt"), "restored child")
                .expect("write restorable child");
            fs::write(collision.join("trashed.txt"), "trashed child").expect("write trashed child");
            trash(&restored);
            trash(&collision);
            fs::create_dir(&collision).expect("create directory at restore target");
            fs::write(collision.join("existing.txt"), "existing child")
                .expect("write existing collision child");
            let restored_string = path_string(&restored);
            let collision_string = path_string(&collision);

            let outcome = run(restore_from_trash(vec![
                collision_string.clone(),
                restored_string.clone(),
            ]))
            .expect("directory restores return a per-file outcome");

            assert_eq!(
                fs::read_to_string(restored.join("restored.txt"))
                    .expect("directory and its child were restored"),
                "restored child"
            );
            assert_eq!(
                fs::read_to_string(collision.join("existing.txt"))
                    .expect("existing collision directory remains intact"),
                "existing child"
            );
            assert!(
                !collision.join("trashed.txt").exists(),
                "failed restore does not merge the trashed tree into the target"
            );
            assert_batch_outcome(outcome, &[restored_string], &[collision_string]);
        },
    );
}
