use super::*;
use crate::files::{
    freedesktop_trash::Context,
    recovery::{ResourceRequest, Runtime},
    trash_mounts::MountSnapshot,
};
use std::{fs, os::unix::fs::symlink};

struct Fixture {
    root: tempfile::TempDir,
    context: Context,
    runtime: Runtime,
    storage: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let context = Context {
            mounts: MountSnapshot::read().unwrap(),
            data_home: root.path().join("data"),
        };
        let storage = root.path().join("recovery");
        Self {
            root,
            context,
            runtime: Runtime::default(),
            storage,
        }
    }
    fn trash(&mut self, relative: &str) -> RestoreRequest {
        let path = self.root.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, relative.as_bytes()).unwrap();
        let artifact = self.context.trash(&path).unwrap().artifact.unwrap();
        RestoreRequest {
            path: path.to_str().unwrap().into(),
            artifact,
        }
    }
    fn admit(
        &self,
        requests: Vec<RestoreRequest>,
    ) -> Result<(PreparedSelection, crate::files::recovery::MutationAdmission), AppError> {
        tauri::async_runtime::block_on(
            self.runtime
                .admit_prepared(self.storage.clone(), move || prepare(&requests)),
        )
    }
    fn claim(
        &self,
        path: &Path,
        access: Access,
        scope: Scope,
    ) -> Result<crate::files::recovery::MutationAdmission, AppError> {
        tauri::async_runtime::block_on(self.runtime.admit(
            self.storage.clone(),
            vec![ResourceRequest {
                path: path.into(),
                access,
                scope,
            }],
        ))
    }
}
fn artifact_paths(request: &RestoreRequest) -> (PathBuf, PathBuf) {
    let TrashArtifact::Freedesktop { root, name, .. } = request.artifact.as_ref() else {
        unreachable!()
    };
    (
        root.join("files").join(name),
        root.join("info").join(info_name(name)),
    )
}

#[test]
fn reserves_exact_payload_metadata_target_and_missing_parent_without_locking_trash_root() {
    let mut f = Fixture::new();
    let request = f.trash("original/missing/item");
    let target = PathBuf::from(&request.path);
    let parent = target.parent().unwrap();
    fs::remove_dir(parent).unwrap();
    let (payload, metadata) = artifact_paths(&request);
    for conflict in [&target, parent, &payload, &metadata] {
        let held = f.claim(conflict, Access::Write, Scope::Subtree).unwrap();
        assert!(
            f.admit(vec![request.clone()]).is_err(),
            "must exclude {}",
            conflict.display()
        );
        assert!(payload.exists());
        assert!(!target.exists());
        held.finish().unwrap();
    }
    let other = f.trash("other/item");
    let (mut first, a) = f.admit(vec![request.clone()]).unwrap();
    let (mut second, b) = f.admit(vec![other.clone()]).unwrap();
    first
        .execute_next(&request.path, &DirectoryEffects::default())
        .unwrap();
    second
        .execute_next(&other.path, &DirectoryEffects::default())
        .unwrap();
    assert_eq!(fs::read(target).unwrap(), b"original/missing/item");
    assert_eq!(fs::read(&other.path).unwrap(), b"other/item");
    a.finish().unwrap();
    b.finish().unwrap();
}

#[test]
fn prepared_restoration_refuses_substituted_objects_before_any_target_effect() {
    for changed in ["payload", "metadata", "parent", "trash"] {
        let mut f = Fixture::new();
        let request = f.trash("original/item");
        let (mut plan, admission) = f.admit(vec![request.clone()]).unwrap();
        let (payload, metadata) = artifact_paths(&request);
        let replaced = match changed {
            "payload" => payload.clone(),
            "metadata" => metadata.clone(),
            "parent" => PathBuf::from(&request.path).parent().unwrap().to_owned(),
            "trash" => payload.parent().unwrap().to_owned(),
            _ => unreachable!(),
        };
        fs::rename(&replaced, f.root.path().join("saved")).unwrap();
        if changed == "parent" || changed == "trash" {
            fs::create_dir(&replaced).unwrap();
        } else {
            fs::write(&replaced, b"foreign occupant").unwrap();
        }
        assert!(
            plan.execute_next(&request.path, &DirectoryEffects::default())
                .is_err(),
            "accepted {changed} replacement"
        );
        assert!(!Path::new(&request.path).exists());
        if changed == "payload" || changed == "metadata" {
            assert_eq!(fs::read(replaced).unwrap(), b"foreign occupant");
        }
        admission.finish().unwrap();
    }
}

#[test]
fn newly_created_parents_are_shared_only_by_verified_members_of_the_batch() {
    let mut f = Fixture::new();
    let first = f.trash("parent/nested/first");
    let second = f.trash("parent/nested/second");
    fs::remove_dir_all(f.root.path().join("parent")).unwrap();
    let (mut plan, admission) = f.admit(vec![first.clone(), second.clone()]).unwrap();
    let effects = DirectoryEffects::default();
    plan.execute_next(&first.path, &effects).unwrap();
    plan.execute_next(&second.path, &effects).unwrap();
    assert_eq!(fs::read(&first.path).unwrap(), b"parent/nested/first");
    assert_eq!(fs::read(&second.path).unwrap(), b"parent/nested/second");
    admission.finish().unwrap();
}

#[test]
fn replacing_a_batch_created_parent_cannot_redirect_a_later_item() {
    let mut f = Fixture::new();
    let first = f.trash("parent/first");
    let second = f.trash("parent/second");
    let parent = f.root.path().join("parent");
    fs::remove_dir(&parent).unwrap();
    let (mut plan, admission) = f.admit(vec![first.clone(), second.clone()]).unwrap();
    plan.execute_next(&first.path, &DirectoryEffects::default())
        .unwrap();
    fs::rename(&parent, f.root.path().join("saved-parent")).unwrap();
    fs::create_dir(&parent).unwrap();
    assert!(plan
        .execute_next(&second.path, &DirectoryEffects::default())
        .is_err());
    assert!(!Path::new(&second.path).exists());
    assert!(artifact_paths(&second).0.exists());
    admission.finish().unwrap();
}

#[test]
fn unexpected_missing_parent_creator_and_symlink_are_not_adopted() {
    for symbolic in [false, true] {
        let mut f = Fixture::new();
        let request = f.trash("parent/item");
        let parent = f.root.path().join("parent");
        fs::remove_dir(&parent).unwrap();
        let (mut plan, admission) = f.admit(vec![request.clone()]).unwrap();
        let outside = f.root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        if symbolic {
            symlink(&outside, &parent).unwrap();
        } else {
            fs::create_dir(&parent).unwrap();
        }
        assert!(plan
            .execute_next(&request.path, &DirectoryEffects::default())
            .is_err());
        assert!(!outside.join("item").exists());
        assert!(!Path::new(&request.path).exists());
        assert!(artifact_paths(&request).0.exists());
        admission.finish().unwrap();
    }
}

#[test]
fn prepared_alias_is_claimed_and_cannot_redirect_execution_after_external_retarget() {
    let mut f = Fixture::new();
    let mut request = f.trash("physical/item");
    let alias = f.root.path().join("alias");
    symlink(f.root.path().join("physical"), &alias).unwrap();
    request.path = alias.join("item").to_str().unwrap().into();
    let (mut plan, admission) = f.admit(vec![request.clone()]).unwrap();
    assert!(f.claim(&alias, Access::Write, Scope::Entry).is_err());
    let foreign = f.root.path().join("foreign");
    fs::create_dir(&foreign).unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&foreign, &alias).unwrap();
    plan.execute_next(&request.path, &DirectoryEffects::default())
        .unwrap();
    assert_eq!(
        fs::read(f.root.path().join("physical/item")).unwrap(),
        b"physical/item"
    );
    assert!(!foreign.join("item").exists());
    admission.finish().unwrap();
}

#[test]
fn distinct_alias_keys_cannot_restore_into_the_same_physical_target() {
    let mut f = Fixture::new();
    let first = f.trash("original/item");
    let alias = f.root.path().join("alias");
    symlink(f.root.path().join("original"), &alias).unwrap();
    let second = RestoreRequest {
        path: alias.join("item").to_str().unwrap().into(),
        artifact: first.artifact.clone(),
    };
    assert!(f.admit(vec![first.clone(), second]).is_err());
    assert!(artifact_paths(&first).0.exists());
    assert!(!Path::new(&first.path).exists());
}

#[test]
fn target_subtrees_and_other_artifact_namespaces_cannot_overlap_in_one_restore() {
    let mut f = Fixture::new();
    let child = f.trash("original/child");
    let parent = f.root.path().join("original");
    let directory = f.context.trash(&parent).unwrap();
    let request = RestoreRequest {
        path: parent.to_str().unwrap().into(),
        artifact: directory.artifact.unwrap(),
    };
    assert!(f.admit(vec![request, child.clone()]).is_err());
    assert!(artifact_paths(&child).0.exists());

    let other = f.trash("other/item");
    let mut overlapping = other.clone();
    let native_target = artifact_paths(&child).0;
    let mut altered = other.artifact.as_ref().clone();
    let TrashArtifact::Freedesktop { original_path, .. } = &mut altered else {
        unreachable!()
    };
    *original_path = native_target.clone();
    overlapping.path = native_target.to_str().unwrap().into();
    overlapping.artifact = Arc::new(altered);
    assert!(f.admit(vec![child.clone(), overlapping]).is_err());
    assert!(native_target.exists());
    assert!(artifact_paths(&other).0.exists());
}

#[test]
fn distinct_hardlink_payloads_can_restore_together() {
    let mut f = Fixture::new();
    let first = f.root.path().join("first");
    let second = f.root.path().join("second");
    fs::write(&first, b"shared inode").unwrap();
    fs::hard_link(&first, &second).unwrap();
    let requests: Vec<_> = [&first, &second]
        .into_iter()
        .map(|path| RestoreRequest {
            path: path.to_str().unwrap().into(),
            artifact: f.context.trash(path).unwrap().artifact.unwrap(),
        })
        .collect();
    let (mut plan, admission) = f.admit(requests.clone()).unwrap();
    for request in &requests {
        plan.execute_next(&request.path, &DirectoryEffects::default())
            .unwrap();
    }
    assert_eq!(fs::read(first).unwrap(), b"shared inode");
    assert_eq!(fs::read(second).unwrap(), b"shared inode");
    admission.finish().unwrap();
}

#[test]
fn a_failed_leaf_keeps_created_parents_available_to_later_items() {
    let mut f = Fixture::new();
    let first = f.trash("parent/nested/first");
    let second = f.trash("parent/nested/second");
    fs::remove_dir_all(f.root.path().join("parent")).unwrap();
    let (mut plan, admission) = f.admit(vec![first.clone(), second.clone()]).unwrap();
    let effects = DirectoryEffects::default();
    let result = plan.execute_next_with(&first.path, &effects, || {
        fs::write(&first.path, b"external collision")?;
        Ok(())
    });
    assert!(result.is_err());
    plan.execute_next(&second.path, &effects).unwrap();
    assert_eq!(fs::read(&first.path).unwrap(), b"external collision");
    assert_eq!(fs::read(&second.path).unwrap(), b"parent/nested/second");
    assert!(artifact_paths(&first).0.exists());
    admission.finish().unwrap();
}

#[test]
fn partial_parent_creation_failure_preserves_refresh_effects_and_original_payload() {
    use crate::files::batch::{self, BatchPlan};
    let mut f = Fixture::new();
    let request = f.trash("parent/blocked/deep/item");
    fs::remove_dir_all(f.root.path().join("parent")).unwrap();
    let prepared = Prepared::new(request.clone()).unwrap();
    let mut parents = Some(prepared.parents);
    let outcome = tauri::async_runtime::block_on(batch::run_with_effects(
        BatchPlan::new(vec![request.path.clone()]).unwrap(),
        move |_, effects| {
            parents
                .take()
                .unwrap()
                .open_with(&mut HashMap::new(), effects, |directory, name| {
                    if name == OsStr::new("blocked") {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "injected mkdir failure",
                        ));
                    }
                    directory.create_directory_with_mode(name, 0o777)
                })
                .map(|_| ())
        },
    ));
    assert!(f.root.path().join("parent").is_dir());
    assert!(!f.root.path().join("parent/blocked").exists());
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].error.contains("injected mkdir failure"));
    assert!(outcome.succeeded.is_empty());
    for relative in ["", "parent", "parent/blocked"] {
        let expected = f.root.path().join(relative);
        assert!(
            outcome
                .refresh_dirs
                .iter()
                .any(|path| Path::new(path) == expected),
            "missing refresh for {expected:?}: {:?}",
            outcome.refresh_dirs
        );
    }
    assert!(artifact_paths(&request).0.exists());
}
