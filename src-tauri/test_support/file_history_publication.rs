use super::{execution::execute, Action, Direction, ForwardEffect, NativeOperations};
use crate::{
    files::{copy_session, file_ops},
    renderer_owner::Owner,
};
use std::{fs, path::Path, process::Command};

#[test]
fn ordinary_copy_history_uses_published_identity_in_real_trash_cycles() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "file_history::publication_tests::publication_history_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("TAURI_TEST_PUBLICATION_ROOT", root.path())
        .env("XDG_DATA_HOME", root.path().join("data"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn mixed_copy_session_history_cycles_real_ordinary_and_replacement_effects() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "file_history::publication_tests::mixed_copy_session_history_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("TAURI_TEST_PUBLICATION_ROOT", root.path())
        .env("XDG_DATA_HOME", root.path().join("data"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn copied(root: &Path, name: &str) -> Action {
    let source = root.join(format!("source-{name}"));
    let dest = root.join(format!("dest-{name}"));
    fs::write(&source, "copied bytes").unwrap();
    fs::create_dir(&dest).unwrap();
    let receipt = file_ops::copy_entry_impl(
        None,
        source.to_string_lossy().into_owned(),
        dest.to_string_lossy().into_owned(),
        None,
        None,
    )
    .unwrap();
    crate::file_mutation::copy_inverse(&receipt).expect("ordinary copy captures native publication")
}

fn path(action: &Action) -> &Path {
    let Action::Copy { copied_path, .. } = action else {
        panic!("copy fixture")
    };
    Path::new(copied_path)
}

#[test]
#[ignore = "subprocess fixture isolates the real native trash environment"]
fn publication_history_fixture() {
    let root = std::path::PathBuf::from(std::env::var_os("TAURI_TEST_PUBLICATION_ROOT").unwrap());
    fs::create_dir(root.join("data")).unwrap();
    tauri::async_runtime::block_on(async {
        let operations = NativeOperations::default();
        let original = copied(&root, "cycle");
        let copied_path = path(&original).to_owned();
        let mut action = original;
        for _ in 0..3 {
            let undo = execute(action, &operations, Direction::Undo).await;
            assert!(undo.error.is_none(), "{:?}", undo.error);
            assert!(!copied_path.exists());
            let redo = execute(
                undo.opposite.expect("usable Redo"),
                &operations,
                Direction::Redo,
            )
            .await;
            assert!(redo.error.is_none(), "{:?}", redo.error);
            assert_eq!(fs::read_to_string(&copied_path).unwrap(), "copied bytes");
            action = redo.opposite.expect("verified Undo survives Redo");
        }

        let alias = root.join("destination-alias");
        let physical = root.join("destination-physical");
        fs::create_dir(&physical).unwrap();
        std::os::unix::fs::symlink(&physical, &alias).unwrap();
        let source = root.join("alias-source");
        fs::write(&source, "alias bytes").unwrap();
        let receipt = file_ops::copy_entry_impl(
            None,
            source.to_string_lossy().into_owned(),
            alias.to_string_lossy().into_owned(),
            None,
            None,
        )
        .unwrap();
        assert!(Path::new(&receipt.path).starts_with(&alias));
        let action = crate::file_mutation::copy_inverse(&receipt).expect("native inverse");
        assert!(path(&action).starts_with(&physical));
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(root.join("data"), &alias).unwrap();
        let undo = execute(action, &operations, Direction::Undo).await;
        assert!(undo.error.is_none(), "{:?}", undo.error);
        assert!(!physical.join("alias-source").exists());
        let redo = execute(
            undo.opposite.expect("alias Redo"),
            &operations,
            Direction::Redo,
        )
        .await;
        assert!(redo.error.is_none(), "{:?}", redo.error);
        assert_eq!(
            fs::read_to_string(physical.join("alias-source")).unwrap(),
            "alias bytes"
        );
        assert!(!root.join("data/alias-source").exists());

        // Redo may recreate the destination parent. Its next inverse must use
        // that actual new parent rather than an observation from before Undo.
        let recreated = copied(&root, "recreated-parent");
        let target = path(&recreated).to_owned();
        let undo = execute(recreated, &operations, Direction::Undo).await;
        assert!(undo.error.is_none(), "{:?}", undo.error);
        let old_parent = target.parent().unwrap();
        fs::rename(old_parent, root.join("retained-empty-parent")).unwrap();
        let redo = execute(
            undo.opposite.expect("parent recreation Redo"),
            &operations,
            Direction::Redo,
        )
        .await;
        assert!(redo.error.is_none(), "{:?}", redo.error);
        assert_eq!(fs::read_to_string(&target).unwrap(), "copied bytes");
        let undo = execute(
            redo.opposite.expect("fresh publication Undo"),
            &operations,
            Direction::Undo,
        )
        .await;
        assert!(
            undo.error.is_none(),
            "Undo after parent recreation must remain usable: {:?}",
            undo.error
        );
        assert!(!target.exists());

        // Keep the previous inode alive so replacement cannot accidentally reuse it.
        let substituted = copied(&root, "substitution");
        let target = path(&substituted).to_owned();
        fs::rename(&target, root.join("retained-original")).unwrap();
        fs::write(&target, "new user file").unwrap();
        let outcome = execute(substituted, &operations, Direction::Undo).await;
        assert!(
            outcome.error.is_some(),
            "Undo must reject a substituted publication"
        );
        assert!(outcome.completed.is_none());
        assert!(outcome.remaining.is_some());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new user file");

        let edited = copied(&root, "edited");
        let target = path(&edited).to_owned();
        fs::write(&target, "later edits have different length").unwrap();
        let outcome = execute(edited, &operations, Direction::Undo).await;
        assert!(
            outcome.error.is_some(),
            "Undo must reject a changed publication"
        );
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "later edits have different length"
        );
    });
}

#[test]
#[ignore = "subprocess fixture isolates native trash and replacement storage"]
fn mixed_copy_session_history_fixture() {
    let root = std::path::PathBuf::from(std::env::var_os("TAURI_TEST_PUBLICATION_ROOT").unwrap());
    fs::create_dir(root.join("data")).unwrap();
    let sources = root.join("sources");
    let destination = root.join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let ordinary_source = sources.join("ordinary.txt");
    let replacement_source = sources.join("replacement.txt");
    let ordinary_target = destination.join("ordinary.txt");
    let replacement_target = destination.join("replacement.txt");
    fs::write(&ordinary_source, b"ordinary copied bytes").unwrap();
    fs::write(&replacement_source, b"replacement copied bytes").unwrap();
    fs::write(&replacement_target, b"replacement original bytes").unwrap();
    let runtime = crate::files::recovery::Runtime::default();
    let storage = root.join("recovery");
    let operations = NativeOperations {
        recovery: Some((runtime.clone(), storage.clone())),
    };
    let owner = Owner::default();
    let registration =
        copy_session::Registration::new("mixed-copy-history".into(), owner.clone()).unwrap();
    let control = registration.control.clone();
    let reply = control.clone();
    let reply_owner = owner.clone();
    let request = copy_session::Request::new(
        vec![
            ordinary_source.to_string_lossy().into_owned(),
            replacement_source.to_string_lossy().into_owned(),
        ],
        destination.to_string_lossy().into_owned(),
    )
    .unwrap();
    let work = copy_session::NativeWork {
        app: None,
        job_id: 41,
        recovery: (runtime, storage),
    };

    tauri::async_runtime::block_on(async move {
        let session = copy_session::run(request, control, work, move |event| {
            if let copy_session::Event::Conflict { item, nonce, .. } = event {
                reply
                    .resolve(
                        &reply_owner,
                        item,
                        &nonce,
                        copy_session::Decision {
                            choice: copy_session::Choice::Overwrite,
                            apply_to_all: false,
                        },
                    )
                    .unwrap();
            }
            true
        })
        .await;
        assert!(session
            .items
            .iter()
            .all(|item| matches!(item, copy_session::ItemOutcome::Succeeded { .. })));
        let projected = crate::file_mutation::copy_session_outcome(
            session,
            destination.to_string_lossy().into_owned(),
        );
        let ForwardEffect::Changed(Some(mut action)) = projected.effect else {
            panic!("mixed confirmed effects require one native inverse")
        };
        assert!(matches!(&action, Action::Batch { actions, .. } if actions.len() == 2));
        fs::remove_file(&ordinary_source).unwrap();
        fs::remove_file(&replacement_source).unwrap();

        for _ in 0..3 {
            let undo = execute(action, &operations, Direction::Undo).await;
            assert!(undo.error.is_none(), "{:?}", undo.error);
            assert!(!ordinary_target.exists());
            if cfg!(feature = "durable-copy-recovery") {
                assert_eq!(
                    fs::read(&replacement_target).unwrap(),
                    b"replacement original bytes"
                );
            } else {
                assert!(
                    !replacement_target.exists(),
                    "ordinary overwrite Undo removes its publication"
                );
            }

            let redo = execute(
                undo.opposite.expect("mixed Redo"),
                &operations,
                Direction::Redo,
            )
            .await;
            assert!(redo.error.is_none(), "{:?}", redo.error);
            assert_eq!(
                fs::read(&ordinary_target).unwrap(),
                b"ordinary copied bytes"
            );
            assert_eq!(
                fs::read(&replacement_target).unwrap(),
                b"replacement copied bytes"
            );
            action = redo.opposite.expect("mixed Undo remains usable");
        }
        drop(registration);
    });
}
