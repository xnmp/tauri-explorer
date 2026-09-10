use super::*;
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    native_directory::Directory,
    recovery::{
        model::{EntryVersion, NativePath, ObjectId},
        resources::{capture_requests, Access, Request, Resource, Scope},
    },
};
use std::{fs, path::Path};

const SOURCE_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn object(device: u64, inode: u64) -> ObjectId {
    ObjectId::unix(device, inode)
}

fn version(device: u64, inode: u64) -> EntryVersion {
    EntryVersion {
        object: object(device, inode),
        size: 12,
        modified_seconds: 1_700_000_000,
        modified_nanos: 42,
        directory: false,
        symlink: false,
        mode: 0o100600,
        uid: 1000,
        gid: 1000,
    }
}

fn resource(path: &str, identity: Option<ObjectId>, parent: ObjectId, access: Access) -> Resource {
    let depth = Path::new(path).parent().unwrap().ancestors().count();
    let mut ancestors = vec![parent];
    ancestors.extend((1..depth).map(|index| object(99, index as u64)));
    Resource {
        path: NativePath(path.into()),
        object: identity,
        ancestors,
        access,
        scope: Scope::Subtree,
    }
}

fn root(path: &str, token: &str) -> ArtifactPlan {
    ArtifactPlan {
        path: NativePath(path.into()),
        token: token.into(),
    }
}

fn rootless() -> (MoveSpec, Vec<Resource>) {
    let parent = object(7, 10);
    let source_version = version(7, 11);
    let spec = MoveSpec {
        source: NativePath("/volume/source".into()),
        source_parent: parent,
        source_version: source_version.clone(),
        target: NativePath("/volume/target".into()),
        target_parent: parent,
        target_original: None,
        strategy: Strategy::Rename,
        source_root: None,
        target_root: None,
    };
    let resources = vec![
        resource(
            "/volume/source",
            Some(source_version.object),
            parent,
            Access::Write,
        ),
        resource("/volume/target", None, parent, Access::Write),
    ];
    (spec, resources)
}

fn overwrite() -> (MoveSpec, Vec<Resource>) {
    let (mut spec, mut resources) = rootless();
    let original = version(7, 12);
    spec.target_original = Some(original.clone());
    spec.target_root = Some(root(
        &format!("/volume/.tauri-explorer-recovery-{TARGET_TOKEN}"),
        TARGET_TOKEN,
    ));
    resources[1].object = Some(original.object);
    resources.push(resource(
        &format!("/volume/.tauri-explorer-recovery-{TARGET_TOKEN}"),
        None,
        spec.target_parent,
        Access::Write,
    ));
    (spec, resources)
}

fn cross_volume() -> (MoveSpec, Vec<Resource>) {
    let source_parent = object(7, 10);
    let target_parent = object(8, 20);
    let source_version = version(7, 11);
    let original = version(8, 21);
    let source_root_path = format!("/source-volume/.tauri-explorer-recovery-{SOURCE_TOKEN}");
    let target_root_path = format!("/target-volume/.tauri-explorer-recovery-{TARGET_TOKEN}");
    let spec = MoveSpec {
        source: NativePath("/source-volume/source".into()),
        source_parent,
        source_version: source_version.clone(),
        target: NativePath("/target-volume/target".into()),
        target_parent,
        target_original: Some(original.clone()),
        strategy: Strategy::CopyParked,
        source_root: Some(root(&source_root_path, SOURCE_TOKEN)),
        target_root: Some(root(&target_root_path, TARGET_TOKEN)),
    };
    let resources = vec![
        resource(
            "/source-volume/source",
            Some(source_version.object),
            source_parent,
            Access::Write,
        ),
        resource(
            "/target-volume/target",
            Some(original.object),
            target_parent,
            Access::Write,
        ),
        resource(&source_root_path, None, source_parent, Access::Write),
        resource(&target_root_path, None, target_parent, Access::Write),
    ];
    (spec, resources)
}

#[test]
fn valid_rootless_overwrite_and_cross_volume_plans_roundtrip() {
    for (spec, resources) in [rootless(), overwrite(), cross_volume()] {
        spec.validate(&resources).unwrap();
        let encoded = serde_json::to_vec(&spec).unwrap();
        let decoded: MoveSpec = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, spec);
        decoded.validate(&resources).unwrap();
    }
}

#[test]
fn strategy_and_artifact_layout_must_match_volume_and_overwrite_intent() {
    let (same, resources) = rootless();
    let mut wrong_strategy = same.clone();
    wrong_strategy.strategy = Strategy::CopyParked;
    assert!(wrong_strategy.validate(&resources).is_err());

    let (cross, resources) = cross_volume();
    let mut rename = cross.clone();
    rename.strategy = Strategy::Rename;
    assert!(rename.validate(&resources).is_err());
    let mut no_source_root = cross.clone();
    no_source_root.source_root = None;
    assert!(no_source_root.validate(&resources).is_err());
    let mut no_target_root = cross;
    no_target_root.target_root = None;
    assert!(no_target_root.validate(&resources).is_err());

    let (mut overwrite, resources) = overwrite();
    overwrite.target_root = None;
    assert!(overwrite.validate(&resources).is_err());
}

#[test]
fn exact_objects_parents_and_write_authority_are_required() {
    let (spec, resources) = overwrite();
    for index in 0..resources.len() {
        let mut missing = resources.clone();
        missing.remove(index);
        assert!(spec.validate(&missing).is_err());

        let mut read_only = resources.clone();
        read_only[index].access = Access::Read;
        assert!(spec.validate(&read_only).is_err());

        let mut wrong_object = resources.clone();
        wrong_object[index].object = Some(object(7, 80 + index as u64));
        assert!(spec.validate(&wrong_object).is_err());

        let mut wrong_parent = resources.clone();
        wrong_parent[index].ancestors[0] = object(7, 90 + index as u64);
        assert!(spec.validate(&wrong_parent).is_err());
    }

    let (mut wrong_source_parent, resources) = rootless();
    wrong_source_parent.source_parent = object(8, 10);
    assert!(wrong_source_parent.validate(&resources).is_err());
    let (mut wrong_target_parent, resources) = overwrite();
    wrong_target_parent.target_parent = object(8, 10);
    assert!(wrong_target_parent.validate(&resources).is_err());
    let (mut wrong_target_volume, resources) = overwrite();
    wrong_target_volume.target_original.as_mut().unwrap().object = object(8, 12);
    assert!(wrong_target_volume.validate(&resources).is_err());
}

#[test]
fn source_target_overlap_and_real_hardlink_alias_are_rejected() {
    let (mut nested, mut resources) = rootless();
    nested.target = NativePath("/volume/source/child".into());
    nested.target_parent = nested.source_version.object;
    resources[1] = resource(
        "/volume/source/child",
        None,
        nested.target_parent,
        Access::Write,
    );
    assert!(nested.validate(&resources).is_err());

    let temporary = tempfile::tempdir().unwrap();
    let base = temporary.path().canonicalize().unwrap();
    let source = base.join("source");
    let target = base.join("target");
    fs::write(&source, b"same object").unwrap();
    fs::hard_link(&source, &target).unwrap();
    let resources = capture_requests(&[
        Request {
            path: source.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        },
        Request {
            path: target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        },
    ])
    .unwrap();
    let parent = of_file(&Directory::open(&base).unwrap().file).unwrap();
    let spec = MoveSpec {
        source: NativePath(source.clone()),
        source_parent: parent,
        source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap()).unwrap(),
        target: NativePath(target.clone()),
        target_parent: parent,
        target_original: Some(
            version_from_metadata(&fs::symlink_metadata(&target).unwrap()).unwrap(),
        ),
        strategy: Strategy::Rename,
        source_root: None,
        target_root: Some(root(
            &base
                .join(format!(".tauri-explorer-recovery-{TARGET_TOKEN}"))
                .to_string_lossy(),
            TARGET_TOKEN,
        )),
    };
    let mut resources = resources;
    resources.extend(
        capture_requests(&[Request {
            path: spec.target_root.as_ref().unwrap().path.0.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])
        .unwrap(),
    );
    assert!(spec.validate(&resources).is_err());
}

#[test]
fn artifact_tokens_namespaces_and_vacancy_are_exact() {
    let (spec, resources) = cross_volume();
    for token in ["short", &"g".repeat(64)] {
        let mut malformed = spec.clone();
        malformed.source_root.as_mut().unwrap().token = token.into();
        assert!(malformed.validate(&resources).is_err());
    }
    let mut shared = spec.clone();
    shared.target_root.as_mut().unwrap().token = SOURCE_TOKEN.into();
    shared.target_root.as_mut().unwrap().path =
        NativePath(format!("/target-volume/.tauri-explorer-recovery-{SOURCE_TOKEN}").into());
    let mut shared_resources = resources.clone();
    shared_resources[3] = resource(
        &format!("/target-volume/.tauri-explorer-recovery-{SOURCE_TOKEN}"),
        None,
        shared.target_parent,
        Access::Write,
    );
    assert!(shared.validate(&shared_resources).is_err());
    let mut wrong_namespace = spec.clone();
    wrong_namespace.source_root.as_mut().unwrap().path =
        NativePath("/source-volume/private".into());
    assert!(wrong_namespace.validate(&resources).is_err());

    let mut occupied = resources.clone();
    occupied[2].object = Some(object(7, 60));
    assert!(spec.validate(&occupied).is_err());
}

#[test]
fn unknown_serialized_fields_are_rejected() {
    let (spec, _) = rootless();
    let mut value = serde_json::to_value(spec).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .insert("futureAuthority".into(), true.into());
    assert!(serde_json::from_value::<MoveSpec>(value).is_err());
}
