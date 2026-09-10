use super::*;
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    recovery::{
        model::{LockIdentity, NativePath, ReplacementSpec},
        resources::{capture_requests, Access, Request, Scope},
    },
};
use std::{fs, os::unix::fs::PermissionsExt};

struct Fixture {
    _temporary: tempfile::TempDir,
    base: PathBuf,
    source: PathBuf,
    target: PathBuf,
    root: PathBuf,
    intent: DurableIntent,
}

impl Fixture {
    fn new(token: &str) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().join("workspace");
        fs::create_dir(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let source = base.join("source");
        let target = base.join("target");
        let root = base.join(format!(".tauri-explorer-recovery-{token}"));
        fs::write(&source, b"new bytes").unwrap();
        fs::write(&target, b"original bytes").unwrap();
        let parent = of_file(&Directory::open(&base).unwrap().file).unwrap();
        let resources = capture_requests(&[
            Request {
                path: source.clone(),
                access: Access::Read,
                scope: Scope::Subtree,
            },
            Request {
                path: target.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
            Request {
                path: root.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            },
        ])
        .unwrap();
        let intent = DurableIntent {
            version: 1,
            id: "a".repeat(64),
            lock: LockIdentity {
                name: format!("{}.lock", "a".repeat(64)),
                object: parent,
                nonce: "b".repeat(64),
            },
            resources,
            operation: OperationSpec::CopyReplacement(ReplacementSpec {
                artifact_token: token.into(),
                source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap())
                    .unwrap(),
                source: NativePath(source.clone()),
                target: NativePath(target.clone()),
                root: NativePath(root.clone()),
                parent,
                original: version_from_metadata(&fs::symlink_metadata(&target).unwrap()).unwrap(),
            }),
        };
        intent.validate().unwrap();
        Self {
            _temporary: temporary,
            base,
            source,
            target,
            root,
            intent,
        }
    }

    fn assert_user_data(&self) {
        assert_eq!(fs::read(&self.source).unwrap(), b"new bytes");
        assert_eq!(fs::read(&self.target).unwrap(), b"original bytes");
    }
}

#[test]
fn creates_only_the_exact_private_root_and_retains_its_namespace() {
    let fixture = Fixture::new("exact-root");
    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();

    assert_eq!(
        root.identity(),
        of_file(&Directory::open(&fixture.root).unwrap().file).unwrap()
    );
    assert_eq!(
        fs::symlink_metadata(&fixture.root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert!(fs::read_dir(&fixture.root).unwrap().next().is_none());
    root.verify_namespace().unwrap();
    fixture.assert_user_data();
}

#[test]
fn creation_is_exclusive_and_never_repairs_an_existing_root() {
    let fixture = Fixture::new("collision");
    fs::create_dir(&fixture.root).unwrap();
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(Anchor::open(&fixture.intent).unwrap().create().is_err());
    assert_eq!(
        fs::symlink_metadata(&fixture.root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    fixture.assert_user_data();
}

#[test]
fn wrong_or_replaced_parent_is_rejected_before_root_creation() {
    let fixture = Fixture::new("parent-check");
    let mut wrong = fixture.intent.clone();
    let OperationSpec::CopyReplacement(spec) = &mut wrong.operation else {
        panic!("expected copy replacement fixture");
    };
    spec.parent = spec.original.object;
    assert!(Anchor::open(&wrong).is_err());
    assert!(!fixture.root.exists());

    let anchor = Anchor::open(&fixture.intent).unwrap();
    let held = fixture._temporary.path().join("held-parent");
    fs::rename(&fixture.base, &held).unwrap();
    fs::create_dir(&fixture.base).unwrap();
    assert!(anchor.create().is_err());
    assert!(!held.join(fixture.root.file_name().unwrap()).exists());
    assert!(!fixture.root.exists());
    assert_eq!(fs::read(held.join("source")).unwrap(), b"new bytes");
    assert_eq!(fs::read(held.join("target")).unwrap(), b"original bytes");
}

#[test]
fn an_open_root_detects_named_root_replacement_without_touching_user_data() {
    let fixture = Fixture::new("root-check");
    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();
    let retained = fixture.base.join("retained-root");
    fs::rename(&fixture.root, &retained).unwrap();
    fs::create_dir(&fixture.root).unwrap();
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).unwrap();

    assert!(root.verify_namespace().is_err());
    assert!(retained.is_dir());
    assert!(fixture.root.is_dir());
    fixture.assert_user_data();
}

#[test]
fn an_existing_root_requires_the_exact_identity_and_private_permissions() {
    let fixture = Fixture::new("existing");
    let created = Anchor::open(&fixture.intent).unwrap().create().unwrap();
    let identity = created.identity();
    drop(created);
    Anchor::open(&fixture.intent)
        .unwrap()
        .open_existing(identity)
        .unwrap();

    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Anchor::open(&fixture.intent)
        .unwrap()
        .open_existing(identity)
        .is_err());
    assert_eq!(
        fs::symlink_metadata(&fixture.root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    fixture.assert_user_data();
}

#[test]
fn manifest_publication_is_durable_exact_and_read_only_on_verification() {
    let fixture = Fixture::new("manifest");
    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();
    root.publish_manifest(&fixture.intent).unwrap();
    let manifest = fixture.root.join("manifest.intent");
    let bytes = fs::read(&manifest).unwrap();

    root.verify_manifest(&fixture.intent).unwrap();
    let evidence = root.catalog().unwrap().records().unwrap().pop().unwrap();
    let decoded: crate::files::recovery::model::LocalManifest =
        serde_json::from_slice(&evidence.payload).unwrap();
    assert_eq!(decoded.intent, fixture.intent);
    assert_eq!(decoded.root, root.identity());
    assert_eq!(fs::read(&manifest).unwrap(), bytes);
    assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 1);
    fixture.assert_user_data();
}

#[test]
fn missing_malformed_and_different_manifests_are_rejected_and_retained() {
    let missing = Fixture::new("missing-manifest");
    let missing_root = Anchor::open(&missing.intent).unwrap().create().unwrap();
    assert!(missing_root.verify_manifest(&missing.intent).is_err());
    assert!(!missing.root.join("manifest.intent").exists());

    let malformed = Fixture::new("malformed-manifest");
    let malformed_root = Anchor::open(&malformed.intent).unwrap().create().unwrap();
    let malformed_path = malformed.root.join("manifest.intent");
    fs::write(&malformed_path, b"not framed recovery evidence").unwrap();
    fs::set_permissions(&malformed_path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(malformed_root.verify_manifest(&malformed.intent).is_err());
    assert_eq!(
        fs::read(&malformed_path).unwrap(),
        b"not framed recovery evidence"
    );

    let different = Fixture::new("different-manifest");
    let different_root = Anchor::open(&different.intent).unwrap().create().unwrap();
    different_root.publish_manifest(&different.intent).unwrap();
    let different_path = different.root.join("manifest.intent");
    let before = fs::read(&different_path).unwrap();
    let mut changed = different.intent.clone();
    changed.lock.nonce = "c".repeat(64);
    assert!(different_root.verify_manifest(&changed).is_err());
    assert!(different_root.publish_manifest(&changed).is_err());
    assert_eq!(fs::read(&different_path).unwrap(), before);

    missing.assert_user_data();
    malformed.assert_user_data();
    different.assert_user_data();
}

#[test]
fn manifest_for_another_planned_root_is_rejected_without_publication() {
    let fixture = Fixture::new("first");
    let other = Fixture::new("second");
    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();

    assert!(root.publish_manifest(&other.intent).is_err());
    assert!(!fixture.root.join("manifest.intent").exists());
    fixture.assert_user_data();
    other.assert_user_data();
}

#[test]
fn same_spec_with_a_different_valid_owner_cannot_use_the_root() {
    let fixture = Fixture::new("owner-bound");
    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();
    let mut other_owner = fixture.intent.clone();
    other_owner.id = "c".repeat(64);
    other_owner.lock.name = format!("{}.lock", other_owner.id);
    other_owner.lock.nonce = "d".repeat(64);
    other_owner.validate().unwrap();

    assert!(root.publish_manifest(&other_owner).is_err());
    let manifest = fixture.root.join("manifest.intent");
    assert!(!manifest.exists());
    root.publish_manifest(&fixture.intent).unwrap();
    let before = fs::read(&manifest).unwrap();
    assert!(root.verify_manifest(&other_owner).is_err());
    assert_eq!(fs::read(&manifest).unwrap(), before);
    fixture.assert_user_data();
}

#[test]
fn changed_valid_claims_cannot_use_an_existing_manifest() {
    let fixture = Fixture::new("claims-bound");
    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();
    let mut changed = fixture.intent.clone();
    changed.resources[0].access = Access::Write;
    changed.validate().unwrap();

    assert!(root.publish_manifest(&changed).is_err());
    let manifest = fixture.root.join("manifest.intent");
    assert!(!manifest.exists());
    root.publish_manifest(&fixture.intent).unwrap();
    let before = fs::read(&manifest).unwrap();
    assert!(root.verify_manifest(&changed).is_err());
    assert_eq!(fs::read(&manifest).unwrap(), before);
    fixture.assert_user_data();
}

#[test]
fn a_valid_target_alias_cannot_rebind_an_existing_root() {
    let fixture = Fixture::new("target-bound");
    let alias = fixture.base.join("target-alias");
    fs::hard_link(&fixture.target, &alias).unwrap();
    let mut aliased = fixture.intent.clone();
    let OperationSpec::CopyReplacement(spec) = &mut aliased.operation else {
        panic!("expected copy replacement fixture");
    };
    spec.target = NativePath(alias.clone());
    spec.original = version_from_metadata(&fs::symlink_metadata(&alias).unwrap()).unwrap();
    aliased.resources = capture_requests(&[
        Request {
            path: fixture.source.clone(),
            access: Access::Read,
            scope: Scope::Subtree,
        },
        Request {
            path: alias.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        },
        Request {
            path: fixture.root.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        },
    ])
    .unwrap();
    aliased.validate().unwrap();

    let root = Anchor::open(&fixture.intent).unwrap().create().unwrap();
    assert!(root.publish_manifest(&aliased).is_err());
    let manifest = fixture.root.join("manifest.intent");
    assert!(!manifest.exists());
    root.publish_manifest(&fixture.intent).unwrap();
    let before = fs::read(&manifest).unwrap();
    assert!(root.verify_manifest(&aliased).is_err());
    assert_eq!(fs::read(&manifest).unwrap(), before);
    assert_eq!(fs::read(alias).unwrap(), b"original bytes");
    fixture.assert_user_data();
}

#[test]
fn malformed_root_name_is_rejected_without_filesystem_effects() {
    let fixture = Fixture::new("valid");
    let mut malformed = fixture.intent.clone();
    let OperationSpec::CopyReplacement(spec) = &mut malformed.operation else {
        panic!("expected copy replacement fixture");
    };
    spec.root = NativePath(fixture.base.join("unexpected-root"));

    assert!(Anchor::open(&malformed).is_err());
    assert!(!fixture.root.exists());
    assert!(!fixture.base.join("unexpected-root").exists());
    fixture.assert_user_data();
}
