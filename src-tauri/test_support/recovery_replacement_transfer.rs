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
    base: PathBuf,
    source: PathBuf,
    target: PathBuf,
    root_path: PathBuf,
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
        let temporary = tempfile::tempdir().unwrap();
        let base = temporary.path().join("workspace");
        fs::create_dir(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let source = base.join("source");
        let target = base.join("target");
        let root_path = base.join(format!(".tauri-explorer-recovery-{token}"));
        match kind {
            SourceKind::File => fs::write(&source, b"new bytes").unwrap(),
            SourceKind::Directory => {
                fs::create_dir(&source).unwrap();
                fs::write(source.join("new-child"), b"new tree bytes").unwrap();
                fs::set_permissions(&source, fs::Permissions::from_mode(0o500)).unwrap();
            }
            SourceKind::Symlink => {
                std::os::unix::fs::symlink("missing-literal", &source).unwrap();
            }
        }
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

    fn original(&self) -> &EntryVersion {
        let OperationSpec::CopyReplacement(spec) = &self.intent.operation else {
            panic!("expected copy replacement fixture");
        };
        &spec.original
    }
}

#[test]
fn file_displacement_and_publication_are_exact_durable_and_repeatable() {
    let fixture = Fixture::new("file-success", SourceKind::File);
    let (root, staged) = fixture.staged();

    root.displace_copy(&fixture.intent, &staged).unwrap();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    assert!(!fixture.target.exists());
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );

    let published = root.publish_copy(&fixture.intent, &staged).unwrap();
    assert_eq!(
        root.publish_copy(&fixture.intent, &staged).unwrap(),
        published
    );
    assert_eq!(fs::read(&fixture.target).unwrap(), b"new bytes");
    assert_eq!(
        version_at(
            &Directory::open(&fixture.base).unwrap(),
            OsStr::new("target")
        )
        .unwrap(),
        published
    );
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
    assert!(!fixture.root_path.join(PUBLICATION).exists());
    assert_eq!(
        version_at(&root.directory, OsStr::new(ORIGINAL)).unwrap(),
        *fixture.original()
    );
}

#[test]
fn read_only_directory_is_finalized_through_its_retained_handle() {
    let fixture = Fixture::new("directory", SourceKind::Directory);
    let (root, staged) = fixture.staged();
    assert_eq!(staged.final_mode, Some(0o500));

    root.displace_copy(&fixture.intent, &staged).unwrap();
    let target = fixture.target.clone();
    let published = root
        .publish_copy_with(&fixture.intent, &staged, move || {
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
                0o700
            );
            Err(AppError::Other("lost result before finalization".into()))
        })
        .unwrap();

    assert_eq!(
        fs::read(fixture.target.join("new-child")).unwrap(),
        b"new tree bytes"
    );
    assert_eq!(
        fs::metadata(&fixture.target).unwrap().permissions().mode() & 0o7777,
        0o500
    );
    assert_eq!(published.mode & 0o7777, 0o500);
    assert_eq!(
        root.publish_copy(&fixture.intent, &staged).unwrap(),
        published
    );
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn finalized_directory_publication_can_complete_after_reopening_its_root() {
    for mode in [0o000, 0o100, 0o200, 0o400, 0o500, 0o700] {
        let fixture = Fixture::new("finalized-retry", SourceKind::Directory);
        let (root, mut staged) = fixture.staged();
        // Access to a source through another owner or an ACL need not survive
        // copying into an app-owned directory. Exercise the recorded final mode.
        staged.final_mode = Some(mode);
        root.displace_copy(&fixture.intent, &staged).unwrap();
        let published = root.publish_copy(&fixture.intent, &staged).unwrap();
        let identity = root.identity();
        drop(root);

        let reopened = Anchor::open(&fixture.intent)
            .unwrap()
            .open_existing(identity)
            .unwrap();
        assert_eq!(
            reopened.publish_copy(&fixture.intent, &staged).unwrap(),
            published,
            "retry must preserve the final version for mode {mode:o}"
        );
        assert_eq!(
            version_at(&reopened.parent, OsStr::new("target")).unwrap(),
            published
        );
        assert_eq!(
            version_at(&reopened.directory, OsStr::new(ORIGINAL)).unwrap(),
            *fixture.original()
        );
        assert_eq!(
            fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
            b"original bytes"
        );
        assert!(!fixture.root_path.join(PUBLICATION).exists());
        fs::set_permissions(&fixture.target, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            fs::read(fixture.target.join("new-child")).unwrap(),
            b"new tree bytes"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn interrupted_directory_reopening_preserves_a_recognizable_publication() {
    let fixture = Fixture::new("reopen-interrupted", SourceKind::Directory);
    let (root, mut staged) = fixture.staged();
    staged.final_mode = Some(0o000);
    root.displace_copy(&fixture.intent, &staged).unwrap();
    let published = root.publish_copy(&fixture.intent, &staged).unwrap();
    let identity = root.identity();
    assert!(root
        .publish_copy_with_preparation(
            &fixture.intent,
            &staged,
            || Ok(()),
            || {
                assert_eq!(
                    version_at(&root.parent, OsStr::new("target"))?,
                    staged.version
                );
                Err(AppError::Other(
                    "interrupted after permission preparation".into(),
                ))
            }
        )
        .is_err());
    drop(root);

    let reopened = Anchor::open(&fixture.intent)
        .unwrap()
        .open_existing(identity)
        .unwrap();
    assert_eq!(
        reopened.publish_copy(&fixture.intent, &staged).unwrap(),
        published
    );
    assert_eq!(
        version_at(&reopened.parent, OsStr::new("target")).unwrap(),
        published
    );
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
    fs::set_permissions(&fixture.target, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        fs::read(fixture.target.join("new-child")).unwrap(),
        b"new tree bytes"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn changed_authority_during_directory_reopening_stops_finalization() {
    for changed in ["source", "original", "root", "target", "publication"] {
        let fixture = Fixture::new(changed, SourceKind::Directory);
        let (root, mut staged) = fixture.staged();
        staged.final_mode = Some(0o000);
        root.displace_copy(&fixture.intent, &staged).unwrap();
        root.publish_copy(&fixture.intent, &staged).unwrap();
        let held_target = fixture.base.join("held-target");
        let result = root.publish_copy_with_preparation(
            &fixture.intent,
            &staged,
            || Ok(()),
            || {
                match changed {
                    "source" => {
                        fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o700))?
                    }
                    "original" => fs::write(fixture.root_path.join(ORIGINAL), b"changed original")?,
                    "root" => {
                        fs::rename(&fixture.root_path, fixture.base.join("held-root"))?;
                        fs::create_dir(&fixture.root_path)?;
                    }
                    "target" => {
                        fs::rename(&fixture.target, &held_target)?;
                        fs::write(&fixture.target, b"new occupant")?;
                    }
                    "publication" => {
                        fs::write(fixture.root_path.join(PUBLICATION), b"private occupant")?
                    }
                    _ => unreachable!(),
                }
                Ok(())
            },
        );
        assert!(result.is_err(), "changed {changed} must stop finalization");
        let copy = if changed == "target" {
            &held_target
        } else {
            &fixture.target
        };
        assert_eq!(
            fs::metadata(copy).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        assert_eq!(fs::read(copy.join("new-child")).unwrap(), b"new tree bytes");
        if changed == "target" {
            assert_eq!(fs::read(&fixture.target).unwrap(), b"new occupant");
        }
        if changed == "publication" {
            assert_eq!(
                fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
                b"private occupant"
            );
        }
    }
}

#[test]
fn dangling_symlink_is_published_as_literal_data() {
    let fixture = Fixture::new("symlink", SourceKind::Symlink);
    let (root, staged) = fixture.staged();

    root.displace_copy(&fixture.intent, &staged).unwrap();
    let published = root.publish_copy(&fixture.intent, &staged).unwrap();

    assert_eq!(
        fs::read_link(&fixture.target).unwrap(),
        Path::new("missing-literal")
    );
    assert!(published.symlink);
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
}

#[test]
fn displacement_collision_preserves_the_public_original_and_private_collision() {
    let fixture = Fixture::new("displace-collision", SourceKind::File);
    let (root, staged) = fixture.staged();
    fs::write(fixture.root_path.join(ORIGINAL), b"private collision").unwrap();

    assert!(root.displace_copy(&fixture.intent, &staged).is_err());
    assert_eq!(fs::read(&fixture.target).unwrap(), b"original bytes");
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"private collision"
    );
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
}

#[test]
fn publication_collision_preserves_both_user_and_recovery_data() {
    let fixture = Fixture::new("publish-collision", SourceKind::File);
    let (root, staged) = fixture.staged();
    root.displace_copy(&fixture.intent, &staged).unwrap();
    fs::write(&fixture.target, b"new occupant").unwrap();

    assert!(root.publish_copy(&fixture.intent, &staged).is_err());
    assert_eq!(fs::read(&fixture.target).unwrap(), b"new occupant");
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
}

#[test]
fn changed_source_is_rejected_before_displacing_the_original() {
    let fixture = Fixture::new("changed-source", SourceKind::File);
    let (root, staged) = fixture.staged();
    fs::write(&fixture.source, b"changed after staging").unwrap();

    assert!(root.displace_copy(&fixture.intent, &staged).is_err());
    assert_eq!(fs::read(&fixture.target).unwrap(), b"original bytes");
    assert!(!fixture.root_path.join(ORIGINAL).exists());
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"new bytes"
    );
}

#[test]
fn replaced_parent_namespace_is_rejected_without_redirecting_effects() {
    let fixture = Fixture::new("parent-replaced", SourceKind::File);
    let (root, staged) = fixture.staged();
    let held = fixture._temporary.path().join("held-workspace");
    fs::rename(&fixture.base, &held).unwrap();
    fs::create_dir(&fixture.base).unwrap();
    fs::write(fixture.base.join("target"), b"replacement namespace").unwrap();

    assert!(root.displace_copy(&fixture.intent, &staged).is_err());
    assert_eq!(
        fs::read(fixture.base.join("target")).unwrap(),
        b"replacement namespace"
    );
    assert_eq!(fs::read(held.join("target")).unwrap(), b"original bytes");
    assert!(!held
        .join(fixture.root_path.file_name().unwrap())
        .join(ORIGINAL)
        .exists());
}

#[test]
fn exact_moved_endpoints_adopt_errors_reported_after_real_renames() {
    let fixture = Fixture::new("lost-result", SourceKind::File);
    let (root, staged) = fixture.staged();

    root.displace_copy_with(&fixture.intent, &staged, || {
        Err(AppError::Other("lost displacement result".into()))
    })
    .unwrap();
    assert!(!fixture.target.exists());
    root.displace_copy(&fixture.intent, &staged).unwrap();

    let published = root
        .publish_copy_with(&fixture.intent, &staged, || {
            Err(AppError::Other("lost publication result".into()))
        })
        .unwrap();
    assert_eq!(fs::read(&fixture.target).unwrap(), b"new bytes");
    assert_eq!(
        root.publish_copy(&fixture.intent, &staged).unwrap(),
        published
    );
    assert_eq!(
        fs::read(fixture.root_path.join(ORIGINAL)).unwrap(),
        b"original bytes"
    );
}

#[test]
fn changed_staged_payload_is_rejected_before_either_user_effect() {
    let fixture = Fixture::new("changed-staged", SourceKind::File);
    let (root, staged) = fixture.staged();
    fs::write(fixture.root_path.join(PUBLICATION), b"substitute").unwrap();

    assert!(root.displace_copy(&fixture.intent, &staged).is_err());
    assert_eq!(fs::read(&fixture.target).unwrap(), b"original bytes");
    assert_eq!(
        fs::read(fixture.root_path.join(PUBLICATION)).unwrap(),
        b"substitute"
    );
    assert!(!fixture.root_path.join(ORIGINAL).exists());
}

#[test]
fn hardlinked_source_cannot_impersonate_an_independent_copy_payload() {
    let fixture = Fixture::new("source-alias", SourceKind::File);
    let (root, _) = fixture.staged();
    let publication = fixture.root_path.join(PUBLICATION);
    fs::remove_file(&publication).unwrap();
    fs::hard_link(&fixture.source, &publication).unwrap();
    let forged = StagedPayload {
        version: version_from_metadata(&fs::symlink_metadata(&publication).unwrap()).unwrap(),
        final_mode: None,
    };

    assert!(root.displace_copy(&fixture.intent, &forged).is_err());
    assert_eq!(fs::read(&fixture.target).unwrap(), b"original bytes");
    assert!(!fixture.root_path.join(ORIGINAL).exists());
    assert_eq!(fs::read(&fixture.source).unwrap(), b"new bytes");
    assert_eq!(fs::read(&publication).unwrap(), b"new bytes");
}

#[test]
fn changed_authority_after_publication_stops_permission_finalization() {
    for changed in ["source", "original", "root"] {
        let fixture = Fixture::new(changed, SourceKind::Directory);
        let (root, staged) = fixture.staged();
        root.displace_copy(&fixture.intent, &staged).unwrap();

        let result = root.publish_copy_with(&fixture.intent, &staged, || {
            match changed {
                "source" => {
                    fs::set_permissions(&fixture.source, fs::Permissions::from_mode(0o700))?
                }
                "original" => fs::write(fixture.root_path.join(ORIGINAL), b"changed original")?,
                "root" => {
                    fs::rename(&fixture.root_path, fixture.base.join("held-root"))?;
                    fs::create_dir(&fixture.root_path)?;
                }
                _ => unreachable!(),
            }
            Ok(())
        });
        assert!(result.is_err(), "changed {changed} authority must fail");
        assert_eq!(
            fs::metadata(&fixture.target).unwrap().permissions().mode() & 0o7777,
            0o700,
            "changed {changed} authority must stop the next metadata effect"
        );
        assert_eq!(
            fs::read(fixture.target.join("new-child")).unwrap(),
            b"new tree bytes"
        );
    }
}
