use super::{
    execution::{self, OperationError, Operations},
    execution_affected,
    model::{Action, Direction, Histories},
    operation_error, NativeOperations,
};
use crate::{
    error::AppError,
    files::{run_blocking, trash::FileBatchOutcome},
};
use std::{fs, path::Path};

#[test]
fn move_history_uses_recorded_source_parent_despite_inconsistent_legacy_metadata() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination");
    let unrelated = root.path().join("unrelated");
    for directory in [&source, &destination, &unrelated] {
        fs::create_dir(directory).unwrap();
    }
    fs::write(destination.join("landed.txt"), b"moved payload").unwrap();
    fs::write(unrelated.join("sentinel.txt"), b"unrelated payload").unwrap();
    let action = Action::Move {
        source_path: source.join("original.txt").to_string_lossy().into_owned(),
        dest_path: destination
            .join("landed.txt")
            .to_string_lossy()
            .into_owned(),
        original_dir: unrelated.to_string_lossy().into_owned(),
    };
    // Exercise renderer admission as well as the real native filesystem port.
    let action = super::action::prepare_renderer(action, true)
        .unwrap()
        .unwrap();
    let result = tauri::async_runtime::block_on(execution::execute(
        action,
        &NativeOperations::default(),
        Direction::Undo,
    ));
    assert!(result.error.is_none(), "{:?}", result.error);
    assert!(
        source.join("landed.txt").is_file(),
        "Undo must return the entry to the recorded source parent"
    );
    assert_eq!(
        fs::read(source.join("landed.txt")).unwrap(),
        b"moved payload"
    );
    assert!(!destination.join("landed.txt").exists());
    assert!(!unrelated.join("landed.txt").exists());
    let mut affected = execution_affected(&result);
    affected.sort();
    let mut expected = vec![
        source.to_string_lossy().into_owned(),
        destination.to_string_lossy().into_owned(),
    ];
    expected.sort();
    assert_eq!(affected, expected);
    let result = tauri::async_runtime::block_on(execution::execute(
        result.opposite.expect("Undo retains Redo"),
        &NativeOperations::default(),
        Direction::Redo,
    ));
    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(
        fs::read(destination.join("landed.txt")).unwrap(),
        b"moved payload"
    );
    assert!(!source.join("landed.txt").exists());
    assert!(!unrelated.join("landed.txt").exists());
    assert_eq!(
        fs::read(unrelated.join("sentinel.txt")).unwrap(),
        b"unrelated payload"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn native_move_inverse_obeys_recovery_admission_and_reports_physical_parents() {
    use crate::files::recovery::{Access, ResourceRequest, Runtime, Scope};

    let root = tempfile::tempdir().unwrap();
    let original_parent = root.path().join("original");
    let destination_parent = root.path().join("destination");
    fs::create_dir(&original_parent).unwrap();
    fs::create_dir(&destination_parent).unwrap();
    let original = original_parent.join("moved.txt");
    let destination = destination_parent.join("moved.txt");
    fs::write(&destination, b"moved bytes").unwrap();
    let runtime = Runtime::default();
    let storage = root.path().join("recovery");
    let held = tauri::async_runtime::block_on(runtime.clone().admit(
        storage.clone(),
        vec![ResourceRequest {
            path: destination.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }],
    ))
    .unwrap();
    let operations = NativeOperations {
        recovery: Some((runtime.clone(), storage.clone())),
    };

    let rejected = tauri::async_runtime::block_on(operations.move_entry(
        destination.to_string_lossy().into_owned(),
        original_parent.to_string_lossy().into_owned(),
    ));
    assert!(matches!(rejected.result, Err(OperationError::Unchanged(_))));
    assert!(rejected.affected.is_empty());
    assert!(!original.exists());
    assert_eq!(fs::read(&destination).unwrap(), b"moved bytes");

    held.finish().unwrap();
    let completed = tauri::async_runtime::block_on(operations.move_entry(
        destination.to_string_lossy().into_owned(),
        original_parent.to_string_lossy().into_owned(),
    ));
    assert!(matches!(completed.result, Ok(None)));
    let mut affected = completed.affected;
    affected.sort();
    let mut expected = vec![
        original_parent.to_string_lossy().into_owned(),
        destination_parent.to_string_lossy().into_owned(),
    ];
    expected.sort();
    assert_eq!(affected, expected);
    assert_eq!(fs::read(&original).unwrap(), b"moved bytes");
    assert!(!destination.exists());
}

#[cfg(target_os = "linux")]
#[test]
fn undo_restores_its_own_deletion_when_the_same_path_is_trashed_again_externally() {
    const CASE: &str = "file_history::uncertainty_tests::undo_restores_its_own_deletion_when_the_same_path_is_trashed_again_externally";
    const CHILD: &str = "TAURI_HISTORY_TRASH_IDENTITY_CHILD";
    if std::env::var(CHILD).as_deref() != Ok(CASE) {
        let root = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CASE, "--nocapture", "--test-threads=1"])
            .env(CHILD, CASE)
            .env("XDG_DATA_HOME", root.path().join("data"))
            .env("TAURI_HISTORY_TRASH_IDENTITY_ROOT", root.path())
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("running 1 test"),
            "isolated history identity test failed\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let root =
        std::path::PathBuf::from(std::env::var_os("TAURI_HISTORY_TRASH_IDENTITY_ROOT").unwrap());
    let directory = root.join("files");
    fs::create_dir_all(&directory).unwrap();
    let file = directory.join("same-name.txt");
    let requested = file.to_string_lossy().into_owned();
    fs::write(&file, b"bytes deleted by this history entry").unwrap();
    let deletion = tauri::async_runtime::block_on(
        NativeOperations::default().trash_many(vec![requested.clone()]),
    )
    .unwrap();
    assert_eq!(deletion.succeeded, std::slice::from_ref(&requested));
    let action = Action::Delete {
        recovery: super::model::Recovery::Restore(std::sync::Arc::new(deletion.artifacts)),
        paths: deletion.succeeded,
        parent_dir: directory.to_string_lossy().into_owned(),
    };
    let mut histories = Histories::default();
    histories.register(1);
    histories.push(1, Some(action), false).unwrap();
    let before: std::collections::HashSet<_> = trash::os_limited::list()
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();

    fs::write(&file, b"unrelated newer deletion").unwrap();
    trash::delete(&file).unwrap();
    let external = trash::os_limited::list()
        .unwrap()
        .into_iter()
        .find(|item| item.original_path() == file && !before.contains(&item.id))
        .unwrap();
    // Only the external item's timestamp changes. Make ordering deterministic
    // without sleeping or modifying the original item's identity/metadata.
    let info = Path::new(&external.id);
    let text = fs::read_to_string(info)
        .unwrap()
        .lines()
        .map(|line| {
            if line.starts_with("DeletionDate=") {
                "DeletionDate=2035-01-01T00:00:00"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(info, text).unwrap();

    let reservation = histories
        .begin(1, Direction::Undo, histories.summary(1).undo_id.unwrap())
        .unwrap();
    let result = tauri::async_runtime::block_on(execution::execute(
        reservation.action.clone(),
        &NativeOperations::default(),
        Direction::Undo,
    ));
    assert!(result.error.is_none(), "{:?}", result.error);
    assert_eq!(
        fs::read(&file).unwrap(),
        b"bytes deleted by this history entry",
        "Undo must restore its captured artifact, not the newest matching pathname"
    );
    let payload = info
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("files")
        .join(info.file_stem().unwrap());
    assert_eq!(fs::read(payload).unwrap(), b"unrelated newer deletion");
    histories.finish(reservation, &result);
    assert!(histories.summary(1).redo_id.is_some());
}

#[test]
fn auxiliary_directory_effects_publish_without_completing_a_history_action() {
    let root = tempfile::tempdir().unwrap();
    let action = fixture(root.path(), "remaining");
    let parent = root.path().to_string_lossy().into_owned();
    let child = root.path().join("recreated").to_string_lossy().into_owned();
    let result = super::model::Execution {
        remaining: Some(action),
        refresh_dirs: vec![child.clone(), parent.clone(), child.clone()],
        error: Some("leaf was not restored".into()),
        ..super::model::Execution::default()
    };
    assert_eq!(execution_affected(&result), [parent, child]);
    assert!(result.completed.is_none());
    assert!(result.opposite.is_none());
}

struct PanicAfterRename;
impl Operations for PanicAfterRename {
    async fn rename(&self, path: String, name: String) -> Result<(), OperationError> {
        if !path.ends_with("panic-new.txt") {
            return NativeOperations::default().rename(path, name).await;
        }
        run_blocking(move || -> Result<(), AppError> {
            let source = Path::new(&path);
            fs::rename(source, source.parent().unwrap().join(name))?;
            panic!("injected inverse worker panic after committed rename");
        })
        .await
        .map_err(operation_error)
    }
    async fn move_entry(&self, path: String, destination: String) -> execution::MoveResult {
        NativeOperations::default()
            .move_entry(path, destination)
            .await
    }
    async fn trash_many(&self, paths: Vec<String>) -> Result<FileBatchOutcome, OperationError> {
        NativeOperations::default().trash_many(paths).await
    }
    async fn restore(
        &self,
        requests: Vec<crate::files::trash_artifact::RestoreRequest>,
    ) -> Result<FileBatchOutcome, OperationError> {
        NativeOperations::default().restore(requests).await
    }
}

fn fixture(root: &Path, stem: &str) -> Action {
    let directory = root.join(stem);
    fs::create_dir(&directory).unwrap();
    let path = directory.join(format!("{stem}-new.txt"));
    fs::write(&path, format!("{stem} bytes")).unwrap();
    Action::Rename {
        path: path.to_string_lossy().into_owned(),
        old_name: format!("{stem}-old.txt"),
        new_name: format!("{stem}-new.txt"),
    }
}

#[test]
fn supervisor_panic_after_native_inverse_consumes_history_and_reconciles_planned_parents() {
    for direction in [Direction::Undo, Direction::Redo] {
        let root = tempfile::tempdir().unwrap();
        let action = fixture(root.path(), "supervisor");
        let directory = root.path().join("supervisor");
        let renamed = directory.join("supervisor-new.txt");
        let original = directory.join("supervisor-old.txt");
        let mut histories = Histories::default();
        histories.register(1);
        histories.push(1, Some(action), false).unwrap();
        if direction == Direction::Redo {
            let reservation = histories
                .begin(1, Direction::Undo, histories.summary(1).undo_id.unwrap())
                .unwrap();
            let result = tauri::async_runtime::block_on(execution::execute(
                reservation.action.clone(),
                &NativeOperations::default(),
                Direction::Undo,
            ));
            assert!(result.error.is_none());
            histories.finish(reservation, &result);
        }
        let id = match direction {
            Direction::Undo => histories.summary(1).undo_id,
            Direction::Redo => histories.summary(1).redo_id,
        }
        .unwrap();
        let reservation = histories.begin(1, direction, id).unwrap();
        let prepared = super::plan::Prepared::new(reservation.action.clone(), direction);
        let (result, affected) = tauri::async_runtime::block_on(super::supervise_inverse(
            prepared,
            |prepared| async move {
                let result =
                    execution::execute_prepared(prepared, &NativeOperations::default()).await;
                assert!(result.error.is_none());
                panic!("injected outer supervisor panic after native rename");
            },
        ));
        let (present, absent) = match direction {
            Direction::Undo => (&original, &renamed),
            Direction::Redo => (&renamed, &original),
        };
        assert_eq!(fs::read_to_string(present).unwrap(), "supervisor bytes");
        assert!(!absent.exists());
        assert_eq!(affected, [directory.to_string_lossy().into_owned()]);
        assert!(result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("execution was interrupted")));
        assert!(
            result.remaining.is_none(),
            "interrupted inverse must never be retried automatically"
        );
        assert!(
            result.opposite.is_none(),
            "lost receipts cannot authorize an opposite"
        );
        assert!(
            result.completed.is_none(),
            "panic cannot mint a confirmed receipt"
        );
        histories.finish(reservation, &result);
        let summary = histories.summary(1);
        assert!(!summary.busy);
        assert!(summary.undo_id.is_none());
        assert!(summary.redo_id.is_none());
        assert!(histories.begin(1, direction, id).is_err());
    }
}

#[test]
fn worker_panic_after_inverse_commit_is_not_retryable_and_reconciles_its_parent() {
    let root = tempfile::tempdir().unwrap();
    let action = fixture(root.path(), "panic");
    let mut histories = Histories::default();
    histories.register(1);
    histories.push(1, Some(action.clone()), false).unwrap();
    let id = histories.summary(1).undo_id.unwrap();
    let reservation = histories.begin(1, Direction::Undo, id).unwrap();
    let result = tauri::async_runtime::block_on(execution::execute(
        action.clone(),
        &PanicAfterRename,
        Direction::Undo,
    ));
    assert_eq!(
        fs::read_to_string(root.path().join("panic/panic-old.txt")).unwrap(),
        "panic bytes"
    );
    assert!(!root.path().join("panic/panic-new.txt").exists());
    assert!(result.error.is_some());
    assert!(
        result.remaining.is_none(),
        "the uncertain inverse must not be offered for retry"
    );
    assert!(result.opposite.is_none());
    assert!(
        result.completed.is_none(),
        "uncertainty is not a confirmed effect"
    );
    assert_eq!(result.uncertain, Some(action));
    assert_eq!(
        execution_affected(&result),
        vec![root.path().join("panic").to_string_lossy().into_owned()]
    );
    histories.finish(reservation, &result);
    assert!(histories.summary(1).undo_id.is_none());
    assert!(histories.summary(1).redo_id.is_none());
    assert!(!histories.summary(1).busy);
    assert!(histories.begin(1, Direction::Undo, id).is_err());
}

#[test]
fn uncertain_batch_child_reconciles_while_known_and_unstarted_siblings_keep_their_contracts() {
    let root = tempfile::tempdir().unwrap();
    let untouched = fixture(root.path(), "untouched");
    let uncertain = fixture(root.path(), "panic");
    let completed = fixture(root.path(), "completed");
    let batch = |actions| Action::Batch {
        actions,
        label: "rename batch".into(),
    };
    let result = tauri::async_runtime::block_on(execution::execute(
        batch(vec![
            untouched.clone(),
            uncertain.clone(),
            completed.clone(),
        ]),
        &PanicAfterRename,
        Direction::Undo,
    ));
    assert_eq!(result.completed, Some(batch(vec![completed.clone()])));
    assert_eq!(result.opposite, Some(batch(vec![completed])));
    assert_eq!(result.uncertain, Some(batch(vec![uncertain])));
    assert_eq!(result.remaining, Some(batch(vec![untouched])));
    for stem in ["panic", "completed"] {
        assert_eq!(
            fs::read_to_string(root.path().join(stem).join(format!("{stem}-old.txt"))).unwrap(),
            format!("{stem} bytes")
        );
        assert!(!root
            .path()
            .join(stem)
            .join(format!("{stem}-new.txt"))
            .exists());
    }
    assert_eq!(
        fs::read_to_string(root.path().join("untouched/untouched-new.txt")).unwrap(),
        "untouched bytes"
    );
    assert!(!root.path().join("untouched/untouched-old.txt").exists());
    let mut affected = execution_affected(&result);
    affected.sort();
    assert_eq!(
        affected,
        vec![
            root.path().join("completed").to_string_lossy().into_owned(),
            root.path().join("panic").to_string_lossy().into_owned()
        ]
    );
}
