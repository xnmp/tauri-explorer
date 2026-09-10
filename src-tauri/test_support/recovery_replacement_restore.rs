use super::*;
use crate::files::{
    file_identity::{of_file, version_from_metadata},
    recovery::{
        model::{LockIdentity, NativePath},
        replacement_artifact::Anchor,
        resources::{capture_requests, Access, Request, Scope},
    },
};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

enum SourceKind {
    File,
    Directory,
    Symlink,
}

struct Fixture {
    _temporary: tempfile::TempDir,
    base: std::path::PathBuf,
    source: std::path::PathBuf,
    target: std::path::PathBuf,
    root_path: std::path::PathBuf,
    intent: DurableIntent,
}

struct NoProgress;

impl crate::files::anchored_copy::CopyProgress for NoProgress {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Ok(())
    }

    fn advance(&mut self, _bytes: u64, _current_file: &Path) -> Result<(), AppError> {
        Ok(())
    }
}

impl Fixture {
    fn new(token: &str, kind: SourceKind) -> Self {
        Self::new_with_original(token, kind, false)
    }

    fn new_with_original(token: &str, kind: SourceKind, directory_original: bool) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let base = fs::canonicalize({
            let path = temporary.path().join("workspace");
            fs::create_dir(&path).unwrap();
            path
        })
        .unwrap();
        let source = base.join("source");
        let target = base.join("target");
        let root_path = base.join(format!(".tauri-explorer-recovery-{token}"));
        match kind {
            SourceKind::File => fs::write(&source, b"new bytes").unwrap(),
            SourceKind::Directory => {
                fs::create_dir(&source).unwrap();
                fs::write(source.join("new-child"), b"new tree").unwrap();
                fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
            }
            SourceKind::Symlink => {
                std::os::unix::fs::symlink("missing-literal", &source).unwrap();
            }
        }
        if directory_original {
            fs::create_dir(&target).unwrap();
            fs::write(target.join("original-child"), b"retained tree bytes").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o750)).unwrap();
        } else {
            fs::write(&target, b"original bytes").unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        }
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
                path: root_path.clone(),
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
                source: NativePath(source.clone()),
                source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap())
                    .unwrap(),
                target: NativePath(target.clone()),
                root: NativePath(root_path.clone()),
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
            root_path,
            intent,
        }
    }

    fn staged(&self) -> (Root, StagedPayload) {
        let root = Anchor::open(&self.intent).unwrap().create().unwrap();
        root.publish_manifest(&self.intent).unwrap();
        let staged = root.copy_payload(&self.intent, &mut NoProgress).unwrap();
        (root, staged)
    }

    fn original(&self) -> EntryVersion {
        let OperationSpec::CopyReplacement(spec) = &self.intent.operation else {
            panic!("expected copy replacement fixture");
        };
        spec.original.clone()
    }
}

fn assert_original_restored(fixture: &Fixture, expected: &EntryVersion) {
    assert_eq!(fs::read(&fixture.target).unwrap(), b"original bytes");
    assert_eq!(
        fs::metadata(&fixture.target).unwrap().permissions().mode() & 0o7777,
        0o640
    );
    assert_eq!(
        version_at(
            &Directory::open(&fixture.base).unwrap(),
            OsStr::new("target")
        )
        .unwrap(),
        *expected
    );
    assert!(!fixture.root_path.join(ORIGINAL).exists());
}

#[test]
fn undisplaced_original_is_already_complete_and_copy_remains_private() {
    let fixture = Fixture::new("undisplaced", SourceKind::File);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();

    assert_eq!(
        root.restore_copy(&fixture.intent, &staged).unwrap(),
        expected
    );
    assert_original_restored(&fixture, &expected);
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn owner_unreadable_publication_can_be_restored_after_reopening_its_root() {
    let fixture = Fixture::new("unreadable-copy", SourceKind::Directory);
    let (root, mut staged) = fixture.staged();
    // Valid recorded modes can lose source ACL/other-owner access when the copy
    // becomes app-owned. Restoration must not require reading the final payload.
    staged.final_mode = Some(0);
    staged.validate().unwrap();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();
    let identity = root.identity();
    drop(root);
    let reopened = Anchor::open(&fixture.intent)
        .unwrap()
        .open_existing(identity)
        .unwrap();
    let restored = reopened.restore_copy(&fixture.intent, &staged);
    if restored.is_err() {
        fs::set_permissions(&fixture.target, fs::Permissions::from_mode(0o700)).unwrap();
    }
    restored.unwrap();
    assert_original_restored(&fixture, &fixture.original());
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION).join("new-child")).unwrap(),
        b"new tree"
    );
    assert_eq!(
        fs::metadata(fixture.root_path.join(PUBLICATION))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o700
    );
}

#[test]
fn displaced_original_is_restored_even_when_the_private_copy_is_missing() {
    let fixture = Fixture::new("missing-copy", SourceKind::File);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.directory
        .unlink(OsStr::new(PUBLICATION), false)
        .unwrap();
    root.directory.sync().unwrap();

    assert_eq!(
        root.restore_copy(&fixture.intent, &staged).unwrap(),
        expected
    );
    assert_original_restored(&fixture, &expected);
    assert!(!fixture.root_path.join(PUBLICATION).exists());
}

#[test]
fn published_file_is_parked_before_the_original_is_restored() {
    let fixture = Fixture::new("published-file", SourceKind::File);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();

    assert_eq!(
        root.restore_copy(&fixture.intent, &staged).unwrap(),
        expected
    );
    assert_original_restored(&fixture, &expected);
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
    assert_eq!(
        root.restore_copy(&fixture.intent, &staged).unwrap(),
        expected
    );
}

#[test]
fn nonempty_directory_original_is_restored_with_its_exact_mode_and_version() {
    let fixture = Fixture::new_with_original("directory-original", SourceKind::File, true);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();

    assert_eq!(
        root.restore_copy(&fixture.intent, &staged).unwrap(),
        expected
    );
    assert_eq!(
        fs::read(fixture.target.join("original-child")).unwrap(),
        b"retained tree bytes"
    );
    assert_eq!(
        fs::metadata(&fixture.target).unwrap().permissions().mode() & 0o7777,
        0o750
    );
    assert_eq!(
        version_at(
            &Directory::open(&fixture.base).unwrap(),
            OsStr::new("target")
        )
        .unwrap(),
        expected
    );
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn protected_original_directory_is_not_made_writable_to_force_displacement() {
    let mut fixture = Fixture::new_with_original("protected-original", SourceKind::File, true);
    fs::set_permissions(&fixture.target, fs::Permissions::from_mode(0o510)).unwrap();
    let OperationSpec::CopyReplacement(spec) = &mut fixture.intent.operation else {
        panic!("expected copy replacement fixture");
    };
    spec.original = version_from_metadata(&fs::metadata(&fixture.target).unwrap()).unwrap();
    let expected = spec.original.clone();
    let (root, staged) = fixture.staged();
    assert!(root.displace_copy(&fixture.intent, &staged).is_err());
    assert_eq!(
        version_from_metadata(&fs::metadata(&fixture.target).unwrap()).unwrap(),
        expected
    );
    assert_eq!(
        fs::read(fixture.target.join("original-child")).unwrap(),
        b"retained tree bytes"
    );
    assert!(!fixture.root_path.join(ORIGINAL).exists());
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
}

#[test]
fn restrictive_published_directory_returns_to_staged_mode_before_parking() {
    let fixture = Fixture::new("published-directory", SourceKind::Directory);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();
    assert_eq!(
        fs::metadata(&fixture.target).unwrap().permissions().mode() & 0o7777,
        0o500
    );
    let mut effects = Vec::new();

    assert_eq!(
        root.restore_copy_with_hook(&fixture.intent, &staged, |effect| {
            effects.push(effect);
            Ok(())
        })
        .unwrap(),
        expected
    );

    assert_eq!(effects, ["permissions", "park", "restore"]);
    assert_original_restored(&fixture, &expected);
    let parked = fixture.root_path.join(PUBLICATION);
    assert_eq!(fs::read(parked.join("new-child")).unwrap(), b"new tree");
    assert_eq!(
        fs::metadata(parked).unwrap().permissions().mode() & 0o7777,
        0o700
    );
}

#[test]
fn substituting_target_after_permissions_is_rejected_before_parking() {
    let fixture = Fixture::new("permissions-target-race", SourceKind::Directory);
    let (root, staged) = fixture.staged();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();
    let target = fixture.target.clone();
    let displaced = fixture.base.join("retained-copy");
    let replace_target = target.clone();
    let retain_copy = displaced.clone();

    assert!(root
        .restore_copy_with_hook(&fixture.intent, &staged, move |effect| {
            if effect == "permissions" {
                fs::rename(&replace_target, &retain_copy).unwrap();
                fs::create_dir(&replace_target).unwrap();
                fs::write(replace_target.join("occupant"), b"racer").unwrap();
            }
            Ok(())
        })
        .is_err());

    assert_eq!(fs::read(target.join("occupant")).unwrap(), b"racer");
    assert_eq!(fs::read(displaced.join("new-child")).unwrap(), b"new tree");
    assert_eq!(
        fs::metadata(&displaced).unwrap().permissions().mode() & 0o7777,
        0o700
    );
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
    assert!(!fixture.root_path.join(PUBLICATION).exists());
}

#[test]
fn changing_original_or_root_after_permissions_prevents_parking() {
    let original = Fixture::new("permissions-original-race", SourceKind::Directory);
    let (original_root, original_staged) = original.staged();
    original_root
        .displace_copy(&original.intent, &original_staged)
        .unwrap();
    original_root
        .publish_copy(&original.intent, &original_staged)
        .unwrap();
    let retained_original = original.root_path.join(ORIGINAL);
    let mutate_original = retained_original.clone();
    assert!(original_root
        .restore_copy_with_hook(&original.intent, &original_staged, move |effect| {
            if effect == "permissions" {
                fs::write(&mutate_original, b"changed original").unwrap();
            }
            Ok(())
        })
        .is_err());
    assert_eq!(fs::read(&retained_original).unwrap(), b"changed original");
    assert_eq!(
        fs::read(original.target.join("new-child")).unwrap(),
        b"new tree"
    );

    let namespace = Fixture::new("permissions-root-race", SourceKind::Directory);
    let (namespace_root, namespace_staged) = namespace.staged();
    namespace_root
        .displace_copy(&namespace.intent, &namespace_staged)
        .unwrap();
    namespace_root
        .publish_copy(&namespace.intent, &namespace_staged)
        .unwrap();
    let root_path = namespace.root_path.clone();
    let held_root = namespace.base.join("held-root");
    let move_root = root_path.clone();
    let retain_root = held_root.clone();
    assert!(namespace_root
        .restore_copy_with_hook(&namespace.intent, &namespace_staged, move |effect| {
            if effect == "permissions" {
                fs::rename(&move_root, &retain_root).unwrap();
                fs::create_dir(&move_root).unwrap();
                fs::set_permissions(&move_root, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Ok(())
        })
        .is_err());
    assert!(root_path.is_dir());
    assert_eq!(
        fs::read(held_root.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
    assert_eq!(
        fs::read(namespace.target.join("new-child")).unwrap(),
        b"new tree"
    );
}

#[test]
fn published_dangling_symlink_is_parked_without_following_it() {
    let fixture = Fixture::new("published-symlink", SourceKind::Symlink);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();

    root.restore_copy(&fixture.intent, &staged).unwrap();

    assert_original_restored(&fixture, &expected);
    assert_eq!(
        fs::read_link(fixture.root_path.join(PUBLICATION)).unwrap(),
        Path::new("missing-literal")
    );
}

#[test]
fn source_deletion_or_replacement_is_irrelevant_to_restoring_owned_evidence() {
    let fixture = Fixture::new("source-irrelevant", SourceKind::File);
    let (root, staged) = fixture.staged();
    let expected = fixture.original();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.publish_copy(&fixture.intent, &staged).unwrap();
    fs::remove_file(&fixture.source).unwrap();
    fs::write(&fixture.source, b"unrelated replacement").unwrap();

    assert_eq!(
        root.restore_copy(&fixture.intent, &staged).unwrap(),
        expected
    );
    assert_original_restored(&fixture, &expected);
    assert_eq!(fs::read(&fixture.source).unwrap(), b"unrelated replacement");
}

#[test]
fn public_and_private_collisions_preserve_every_occupant() {
    let public = Fixture::new("public-collision", SourceKind::File);
    let (public_root, public_staged) = public.staged();
    public_root
        .displace_copy(&public.intent, &public_staged)
        .unwrap();
    fs::write(&public.target, b"public collision").unwrap();
    assert!(public_root
        .restore_copy(&public.intent, &public_staged)
        .is_err());
    assert_eq!(fs::read(&public.target).unwrap(), b"public collision");
    assert_eq!(
        fs::read(public.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
    assert_eq!(
        fs::read(public.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );

    let private = Fixture::new("private-collision", SourceKind::File);
    let (private_root, private_staged) = private.staged();
    private_root
        .displace_copy(&private.intent, &private_staged)
        .unwrap();
    private_root
        .publish_copy(&private.intent, &private_staged)
        .unwrap();
    fs::write(private.root_path.join(PUBLICATION), b"private collision").unwrap();
    assert!(private_root
        .restore_copy(&private.intent, &private_staged)
        .is_err());
    assert_eq!(fs::read(&private.target).unwrap(), b"new bytes");
    assert_eq!(
        fs::read(private.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
    assert_eq!(
        fs::read(private.root_path.join(PUBLICATION)).unwrap(),
        b"private collision"
    );
}

#[test]
fn changed_original_or_parent_authority_is_rejected_before_another_effect() {
    let original = Fixture::new("changed-original", SourceKind::File);
    let (original_root, original_staged) = original.staged();
    original_root
        .displace_copy(&original.intent, &original_staged)
        .unwrap();
    fs::write(original.root_path.join(ORIGINAL), b"changed original").unwrap();
    assert!(original_root
        .restore_copy(&original.intent, &original_staged)
        .is_err());
    assert!(!original.target.exists());
    assert_eq!(
        fs::read(original.root_path.join(ORIGINAL)).unwrap(),
        b"changed original"
    );

    let parent = Fixture::new("changed-parent", SourceKind::File);
    let (parent_root, parent_staged) = parent.staged();
    parent_root
        .displace_copy(&parent.intent, &parent_staged)
        .unwrap();
    let held = parent._temporary.path().join("held-workspace");
    fs::rename(&parent.base, &held).unwrap();
    fs::create_dir(&parent.base).unwrap();
    fs::write(parent.base.join("target"), b"replacement namespace").unwrap();
    assert!(parent_root
        .restore_copy(&parent.intent, &parent_staged)
        .is_err());
    assert_eq!(
        fs::read(parent.base.join("target")).unwrap(),
        b"replacement namespace"
    );
    assert!(!held.join("target").exists());
    assert_eq!(
        fs::read(
            held.join(parent.root_path.file_name().unwrap())
                .join(ORIGINAL)
        )
        .unwrap(),
        b"original bytes"
    );
}

#[test]
fn confirmed_park_and_restore_survive_lost_replies_on_later_retries() {
    let parked = Fixture::new("lost-park", SourceKind::File);
    let (parked_root, parked_staged) = parked.staged();
    let parked_original = parked.original();
    parked_root
        .displace_copy(&parked.intent, &parked_staged)
        .unwrap();
    parked_root
        .publish_copy(&parked.intent, &parked_staged)
        .unwrap();
    assert!(parked_root
        .restore_copy_with_hook(&parked.intent, &parked_staged, |effect| {
            if effect == "park" {
                Err(AppError::Other("lost parked reply".into()))
            } else {
                Ok(())
            }
        })
        .is_err());
    assert!(!parked.target.exists());
    assert_eq!(
        fs::read(parked.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
    assert_eq!(
        parked_root
            .restore_copy(&parked.intent, &parked_staged)
            .unwrap(),
        parked_original
    );
    assert_original_restored(&parked, &parked_original);

    let restored = Fixture::new("lost-restore", SourceKind::File);
    let (restored_root, restored_staged) = restored.staged();
    let restored_original = restored.original();
    restored_root
        .displace_copy(&restored.intent, &restored_staged)
        .unwrap();
    assert!(restored_root
        .restore_copy_with_hook(&restored.intent, &restored_staged, |effect| {
            if effect == "restore" {
                Err(AppError::Other("lost restored reply".into()))
            } else {
                Ok(())
            }
        })
        .is_err());
    assert_original_restored(&restored, &restored_original);
    assert_eq!(
        restored_root
            .restore_copy(&restored.intent, &restored_staged)
            .unwrap(),
        restored_original
    );
}

#[test]
fn target_change_after_restore_hook_is_not_reported_as_success() {
    let fixture = Fixture::new("restore-target-race", SourceKind::File);
    let (root, staged) = fixture.staged();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    let target = fixture.target.clone();

    assert!(root
        .restore_copy_with_hook(&fixture.intent, &staged, move |effect| {
            if effect == "restore" {
                fs::write(&target, b"changed after restore").unwrap();
            }
            Ok(())
        })
        .is_err());

    assert_eq!(fs::read(&fixture.target).unwrap(), b"changed after restore");
    assert!(!fixture.root_path.join(ORIGINAL).exists());
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
}
