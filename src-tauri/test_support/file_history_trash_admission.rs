//! Actual inverse adapters must exclude overlapping managed filesystem work.
use super::{execution::Operations, NativeOperations};
use crate::files::{
    file_ops,
    recovery::{Access, ResourceRequest, Runtime, Scope},
    trash,
    trash_artifact::RestoreRequest,
};
use std::{fs, path::PathBuf, process::Command};

#[test]
fn trash_inverse_adapters_exclude_overlapping_claims() {
    let mut failures = Vec::new();
    for kind in ["redo", "publication", "restore", "native"] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "file_history::trash_admission_tests::inverse_admission_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("TAURI_TEST_INVERSE_ROOT", root.path())
            .env("TAURI_TEST_INVERSE_KIND", kind)
            .env("XDG_DATA_HOME", root.path().join("data"))
            .output()
            .unwrap();
        if !output.status.success() {
            failures.push(format!(
                "{kind}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
#[ignore = "subprocess isolates native trash configuration"]
fn inverse_admission_fixture() {
    let root = PathBuf::from(std::env::var_os("TAURI_TEST_INVERSE_ROOT").unwrap());
    fs::create_dir(root.join("data")).unwrap();
    let file = root.join("item.txt");
    fs::create_dir(root.join("input")).unwrap();
    let source = root.join("input/item.txt");
    fs::write(&source, b"exact original").unwrap();
    let publication = file_ops::copy_entry_impl(
        None,
        source.to_str().unwrap().into(),
        root.to_str().unwrap().into(),
        None,
        None,
    )
    .unwrap()
    .publication
    .unwrap();
    let key = file.to_str().unwrap().to_owned();
    let kind = std::env::var("TAURI_TEST_INVERSE_KIND").unwrap();
    let runtime = Runtime::default();
    let storage = root.join("recovery");
    let operations = NativeOperations {
        recovery: Some((runtime.clone(), storage.clone())),
    };
    tauri::async_runtime::block_on(async {
        if kind == "native" {
            native_copy_cycle(&root, &operations).await;
            return;
        }
        let artifact = if kind == "restore" {
            Some(
                trash::move_multiple_to_trash(vec![key.clone()])
                    .await
                    .unwrap()
                    .artifacts[&key]
                    .clone(),
            )
        } else {
            None
        };
        let claim = runtime
            .admit(
                storage,
                vec![ResourceRequest {
                    path: file.clone(),
                    access: Access::Read,
                    scope: Scope::Subtree,
                }],
            )
            .await
            .unwrap();
        let result = match kind.as_str() {
            "redo" => operations.trash_many(vec![key.clone()]).await,
            "publication" => operations.trash_publication(publication).await,
            "restore" => {
                operations
                    .restore(vec![RestoreRequest {
                        path: key,
                        artifact: artifact.unwrap(),
                    }])
                    .await
            }
            _ => unreachable!(),
        };
        assert!(
            result.is_err(),
            "{kind} must refuse an overlapping managed claim before effects: {result:?}"
        );
        if kind == "restore" {
            assert!(!file.exists());
        } else {
            assert_eq!(fs::read(file).unwrap(), b"exact original");
        }
        claim.finish().unwrap();
    });
}

async fn native_copy_cycle(root: &std::path::Path, operations: &NativeOperations) {
    use super::{execution::execute, Direction};
    use std::os::unix::{ffi::OsStringExt, fs::symlink};
    let physical = root.join(std::ffi::OsString::from_vec(b"native-\xff".to_vec()));
    fs::create_dir(&physical).unwrap();
    let alias = root.join("native-alias");
    symlink(&physical, &alias).unwrap();
    let source = root.join("native-source");
    fs::write(&source, b"native exact bytes").unwrap();
    let receipt = file_ops::copy_entry_impl(
        None,
        source.to_str().unwrap().into(),
        alias.to_str().unwrap().into(),
        None,
        None,
    )
    .unwrap();
    let target = physical.join("native-source");
    let lossy = PathBuf::from(target.to_string_lossy().into_owned());
    fs::create_dir(lossy.parent().unwrap()).unwrap();
    fs::write(&lossy, b"unrelated display-collision").unwrap();
    let mut action = crate::file_mutation::copy_inverse(&receipt).unwrap();
    for _ in 0..2 {
        let undo = execute(action, operations, Direction::Undo).await;
        assert!(undo.error.is_none(), "{:?}", undo.error);
        assert!(!target.exists());
        assert_eq!(fs::read(&lossy).unwrap(), b"unrelated display-collision");
        let redo = execute(undo.opposite.unwrap(), operations, Direction::Redo).await;
        assert!(redo.error.is_none(), "{:?}", redo.error);
        assert_eq!(fs::read(&target).unwrap(), b"native exact bytes");
        assert_eq!(fs::read(&lossy).unwrap(), b"unrelated display-collision");
        action = redo.opposite.unwrap();
    }
}
