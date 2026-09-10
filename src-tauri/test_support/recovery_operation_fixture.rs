use super::*;
use crate::files::{
    file_identity::version_from_metadata,
    recovery::{
        model::{NativePath, OperationSpec, ReplacementSpec},
        resources::{Access, Scope},
    },
};

pub(in crate::files::recovery) fn fixture() -> (
    tempfile::TempDir,
    Arc<Coordinator>,
    Reservation,
    OperationSpec,
) {
    let directory = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(directory.path()).unwrap();
    let source = base.join("source");
    let target = base.join("target");
    let root = base.join(".tauri-explorer-recovery-artifacts");
    fs::write(&source, b"new content").unwrap();
    fs::write(&target, b"original content").unwrap();
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let reservation = coordinator
        .reserve(vec![
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
    let spec = ReplacementSpec {
        artifact_token: "artifacts".into(),
        source_version: version_from_metadata(&fs::symlink_metadata(&source).unwrap()).unwrap(),
        source: NativePath(source),
        target: NativePath(target.clone()),
        root: NativePath(root),
        parent: of_file(&Directory::open(&base).unwrap().file).unwrap(),
        original: version_from_metadata(&fs::symlink_metadata(target).unwrap()).unwrap(),
    };
    (
        directory,
        coordinator,
        reservation,
        OperationSpec::CopyReplacement(spec),
    )
}

pub(super) fn writing(path: &Path) -> Vec<Request> {
    vec![Request {
        path: path.to_owned(),
        access: Access::Write,
        scope: Scope::Subtree,
    }]
}

pub(super) fn injected() -> Result<(), AppError> {
    Err(AppError::Other("injected publication interruption".into()))
}

pub(super) fn assert_user_files_untouched(directory: &Path) {
    assert_eq!(fs::read(directory.join("source")).unwrap(), b"new content");
    assert_eq!(
        fs::read(directory.join("target")).unwrap(),
        b"original content"
    );
    assert!(!directory
        .join(".tauri-explorer-recovery-artifacts")
        .exists());
}
