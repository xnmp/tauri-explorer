//! Pure archive-plan contracts: validation, footprint and admission binding.
use super::*;

fn compress(paths: &[&str]) -> Result<CompressRequest, AppError> {
    CompressRequest::new(paths.iter().map(|path| (*path).to_owned()).collect())
}

#[test]
fn compress_names_its_output_after_a_single_selection() {
    let request = compress(&["/home/u/notes.txt"]).unwrap();
    assert_eq!(request.parent(), Path::new("/home/u"));
    assert_eq!(request.base_name(), "notes");
}

#[test]
fn compress_names_a_multiple_selection_archive() {
    let request = compress(&["/home/u/a.txt", "/home/u/b.txt"]).unwrap();
    assert_eq!(request.base_name(), "Archive");
}

#[test]
fn compress_rejects_malformed_selections() {
    assert!(compress(&[]).is_err());
    assert!(compress(&["relative/path"]).is_err());
    assert!(compress(&["/"]).is_err());
    assert!(compress(&["/home/u/../etc/passwd"]).is_err());
    assert!(compress(&["/home/u/nul\0name"]).is_err());
    let huge = format!("/home/{}", "a".repeat(200 * 1024));
    assert!(compress(&[&huge]).is_err());
}

#[test]
fn a_repeated_selection_claims_its_source_once() {
    let request = compress(&["/home/u/a.txt", "/home/u/a.txt", "/home/u/b.txt"]).unwrap();
    let plan = request.plan(PathBuf::from("/home/u/Archive.zip"));
    let Request::Compress { sources } = plan.request() else {
        panic!("compress plan");
    };
    assert_eq!(
        sources,
        &[
            PathBuf::from("/home/u/a.txt"),
            PathBuf::from("/home/u/b.txt")
        ]
    );
}

#[test]
fn extract_here_owns_the_containing_directory() {
    let plan = ExtractRequest::new("/home/u/pack.zip".into())
        .unwrap()
        .here();
    assert_eq!(plan.output(), Path::new("/home/u"));
    // The archive's directory is the changed listing, not its parent.
    assert_eq!(plan.affected_dirs(), vec!["/home/u".to_owned()]);
}

#[test]
fn extract_into_a_folder_publishes_both_directories() {
    let request = ExtractRequest::new("/home/u/pack.zip".into()).unwrap();
    assert_eq!(request.folder_name(), "pack");
    let plan = request.into_folder(PathBuf::from("/home/u/pack"));
    assert_eq!(
        plan.affected_dirs(),
        vec!["/home/u".to_owned(), "/home/u/pack".to_owned()]
    );
}

#[test]
fn compress_publishes_the_output_directory() {
    let plan = compress(&["/home/u/docs/a.txt"])
        .unwrap()
        .plan(PathBuf::from("/home/u/docs/a.zip"));
    assert_eq!(plan.affected_dirs(), vec!["/home/u/docs".to_owned()]);
}

#[cfg(target_os = "linux")]
mod admission {
    use super::*;
    use crate::files::recovery::{Access, Scope};

    #[test]
    fn compress_owns_its_output_and_reads_every_source() {
        let plan = compress(&["/home/u/a.txt", "/home/u/b"])
            .unwrap()
            .plan(PathBuf::from("/home/u/Archive.zip"));
        let resources = plan.resources();
        assert_eq!(resources.len(), 3);
        assert_eq!(resources[0].path, PathBuf::from("/home/u/Archive.zip"));
        assert!(matches!(resources[0].access, Access::Write));
        assert!(matches!(resources[0].scope, Scope::Subtree));
        for resource in &resources[1..] {
            assert!(matches!(resource.access, Access::Read));
            assert!(matches!(resource.scope, Scope::Subtree));
        }
    }

    #[test]
    fn extract_here_writes_the_whole_destination_and_reads_the_archive() {
        let plan = ExtractRequest::new("/home/u/pack.zip".into())
            .unwrap()
            .here();
        let resources = plan.resources();
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[0].path, PathBuf::from("/home/u"));
        assert!(matches!(resources[0].access, Access::Write));
        assert_eq!(resources[1].path, PathBuf::from("/home/u/pack.zip"));
        assert!(matches!(resources[1].access, Access::Read));
    }

    #[test]
    fn execution_binds_the_paths_admission_resolved() {
        let plan = compress(&["/link/a.txt"])
            .unwrap()
            .plan(PathBuf::from("/link/a.zip"));
        let bound = plan
            .resolve(
                [
                    PathBuf::from("/physical/a.zip"),
                    PathBuf::from("/physical/a.txt"),
                ]
                .into_iter(),
            )
            .unwrap();
        assert_eq!(bound.output(), Path::new("/physical/a.zip"));
        let Request::Compress { sources } = bound.request() else {
            panic!("compress plan");
        };
        assert_eq!(sources, &[PathBuf::from("/physical/a.txt")]);
        // Both the requested and the resolved spelling are refreshed.
        assert_eq!(
            bound.affected_dirs(),
            vec!["/link".to_owned(), "/physical".to_owned()]
        );
    }

    #[test]
    fn a_binding_that_renames_the_output_is_rejected() {
        let plan = compress(&["/link/a.txt"])
            .unwrap()
            .plan(PathBuf::from("/link/a.zip"));
        assert!(plan
            .resolve(
                [
                    PathBuf::from("/physical/other.zip"),
                    PathBuf::from("/physical/a.txt"),
                ]
                .into_iter()
            )
            .is_err());
    }

    #[test]
    fn incomplete_or_excess_bindings_are_rejected() {
        let missing = compress(&["/link/a.txt"])
            .unwrap()
            .plan(PathBuf::from("/link/a.zip"));
        assert!(missing
            .resolve([PathBuf::from("/physical/a.zip")].into_iter())
            .is_err());
        let excess = ExtractRequest::new("/home/u/pack.zip".into())
            .unwrap()
            .here();
        assert!(excess
            .resolve(
                [
                    PathBuf::from("/home/u"),
                    PathBuf::from("/home/u/pack.zip"),
                    PathBuf::from("/home/u/extra"),
                ]
                .into_iter()
            )
            .is_err());
    }
}
