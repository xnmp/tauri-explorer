use super::{execution::Operations, NativeOperations};
use crate::files::recovery::{Access, ResourceRequest, Runtime, Scope};
use std::fs;

fn conflicting_rename_claim(destination: bool) {
    tauri::async_runtime::block_on(async {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("before");
        let target = root.path().join("after");
        fs::write(&source, b"original bytes").unwrap();
        let runtime = Runtime::default();
        let storage = root.path().join("recovery");
        let operations = NativeOperations {
            recovery: Some((runtime.clone(), storage.clone())),
        };
        let claim = runtime
            .admit(
                storage,
                vec![ResourceRequest {
                    path: if destination {
                        target.clone()
                    } else {
                        source.clone()
                    },
                    access: Access::Read,
                    scope: Scope::Subtree,
                }],
            )
            .await
            .unwrap();
        let result = operations
            .rename(source.to_str().unwrap().into(), "after".into())
            .await;
        assert!(
            result.result.is_err(),
            "inverse rename must refuse a conflicting claim before effects"
        );
        assert_eq!(fs::read(&source).unwrap(), b"original bytes");
        assert!(!target.exists());
        claim.finish().unwrap();
    });
}

#[test]
fn inverse_rename_excludes_a_managed_source_reader() {
    conflicting_rename_claim(false);
}
#[test]
fn inverse_rename_excludes_a_managed_destination_reader() {
    conflicting_rename_claim(true);
}

fn action(path: &std::path::Path) -> super::Action {
    super::Action::Rename {
        path: path.to_str().unwrap().into(),
        old_name: "before".into(),
        new_name: "after".into(),
    }
}

#[test]
fn inverse_rename_preserves_disjoint_work_and_collision_history() {
    tauri::async_runtime::block_on(async {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("before");
        let renamed = root.path().join("after");
        fs::write(&renamed, b"rename contents").unwrap();
        let runtime = Runtime::default();
        let storage = root.path().join("recovery");
        let operations = NativeOperations {
            recovery: Some((runtime.clone(), storage.clone())),
        };
        let sibling = runtime
            .admit(
                storage.clone(),
                vec![ResourceRequest {
                    path: root.path().join("sibling"),
                    access: Access::Write,
                    scope: Scope::Subtree,
                }],
            )
            .await
            .unwrap();
        fs::write(&original, b"collision").unwrap();
        let failed =
            super::execution::execute(action(&renamed), &operations, super::Direction::Undo).await;
        assert!(failed.error.is_some());
        assert!(failed.remaining.is_some());
        assert!(failed.completed.is_none());
        assert!(failed.opposite.is_none());
        assert_eq!(fs::read(&original).unwrap(), b"collision");
        assert_eq!(fs::read(&renamed).unwrap(), b"rename contents");
        fs::remove_file(&original).unwrap();
        let undo = super::execution::execute(
            failed.remaining.unwrap(),
            &operations,
            super::Direction::Undo,
        )
        .await;
        assert!(undo.error.is_none());
        assert_eq!(fs::read(&original).unwrap(), b"rename contents");
        assert!(!renamed.exists());
        let redo =
            super::execution::execute(undo.opposite.unwrap(), &operations, super::Direction::Redo)
                .await;
        assert!(redo.error.is_none());
        assert_eq!(fs::read(&renamed).unwrap(), b"rename contents");
        assert!(!original.exists());
        assert!(redo.opposite.is_some());
        sibling.finish().unwrap();
    });
}

#[test]
fn inverse_rename_binds_the_next_direction_to_its_physical_parent() {
    tauri::async_runtime::block_on(async {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original");
        let other = root.path().join("other");
        let alias = root.path().join("alias");
        fs::create_dir(&original).unwrap();
        fs::create_dir(&other).unwrap();
        fs::write(original.join("after"), b"owned").unwrap();
        fs::write(other.join("before"), b"unrelated").unwrap();
        std::os::unix::fs::symlink(&original, &alias).unwrap();
        let operations = NativeOperations {
            recovery: Some((Runtime::default(), root.path().join("recovery"))),
        };
        let undo = super::execution::execute(
            action(&alias.join("after")),
            &operations,
            super::Direction::Undo,
        )
        .await;
        assert!(undo.error.is_none());
        assert!(undo
            .refresh_dirs
            .contains(&original.to_str().unwrap().into()));
        assert!(undo.refresh_dirs.contains(&alias.to_str().unwrap().into()));
        fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&other, &alias).unwrap();
        let redo =
            super::execution::execute(undo.opposite.unwrap(), &operations, super::Direction::Redo)
                .await;
        assert!(redo.error.is_none());
        assert_eq!(fs::read(original.join("after")).unwrap(), b"owned");
        assert_eq!(fs::read(other.join("before")).unwrap(), b"unrelated");
        assert!(!other.join("after").exists());
    });
}

#[test]
fn unrepresentable_rename_history_does_not_target_a_lossy_collision() {
    use std::os::unix::ffi::OsStringExt;
    tauri::async_runtime::block_on(async {
        let root = tempfile::tempdir().unwrap();
        let native = root
            .path()
            .join(std::ffi::OsString::from_vec(b"native-\xff".to_vec()));
        let lossy = std::path::PathBuf::from(native.to_string_lossy().into_owned());
        let alias = root.path().join("alias");
        fs::create_dir(&native).unwrap();
        fs::create_dir(&lossy).unwrap();
        fs::write(native.join("after"), b"owned").unwrap();
        fs::write(lossy.join("before"), b"unrelated").unwrap();
        std::os::unix::fs::symlink(&native, &alias).unwrap();
        let operations = NativeOperations {
            recovery: Some((Runtime::default(), root.path().join("recovery"))),
        };
        let undo = super::execution::execute(
            action(&alias.join("after")),
            &operations,
            super::Direction::Undo,
        )
        .await;
        assert!(undo.error.is_none());
        assert!(undo.completed.is_some());
        assert!(undo.remaining.is_none());
        assert!(undo.opposite.is_none());
        assert!(undo
            .warnings
            .iter()
            .any(|warning| warning.contains("native path")));
        assert_eq!(fs::read(native.join("before")).unwrap(), b"owned");
        assert_eq!(fs::read(lossy.join("before")).unwrap(), b"unrelated");
    });
}

#[test]
fn partial_inverse_retains_the_refused_suffix_in_history_order() {
    tauri::async_runtime::block_on(async {
        let root = tempfile::tempdir().unwrap();
        let mut actions = Vec::new();
        for name in ["blocked", "allowed"] {
            let directory = root.path().join(name);
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("after"), name.as_bytes()).unwrap();
            actions.push(action(&directory.join("after")));
        }
        let runtime = Runtime::default();
        let storage = root.path().join("recovery");
        let claim = runtime
            .admit(
                storage.clone(),
                vec![ResourceRequest {
                    path: root.path().join("blocked/after"),
                    access: Access::Read,
                    scope: Scope::Subtree,
                }],
            )
            .await
            .unwrap();
        let operations = NativeOperations {
            recovery: Some((runtime, storage)),
        };
        let result = super::execution::execute(
            super::Action::Batch {
                actions,
                label: "two renames".into(),
            },
            &operations,
            super::Direction::Undo,
        )
        .await;
        assert!(result.error.is_some());
        assert!(result.completed.is_some());
        assert!(result.remaining.is_some());
        assert!(result.opposite.is_some());
        assert_eq!(
            fs::read(root.path().join("allowed/before")).unwrap(),
            b"allowed"
        );
        assert!(!root.path().join("allowed/after").exists());
        assert_eq!(
            fs::read(root.path().join("blocked/after")).unwrap(),
            b"blocked"
        );
        assert!(!root.path().join("blocked/before").exists());
        claim.finish().unwrap();
        let retry = super::execution::execute(
            result.remaining.unwrap(),
            &operations,
            super::Direction::Undo,
        )
        .await;
        assert!(retry.error.is_none());
        assert_eq!(
            fs::read(root.path().join("blocked/before")).unwrap(),
            b"blocked"
        );
    });
}
