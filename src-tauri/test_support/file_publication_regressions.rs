use super::{copy_recursively, detached_tracker, perform_move};
use std::fs;

#[test]
fn recursive_copy_refuses_an_existing_file_without_changing_either_entry() {
    let root = tempfile::tempdir().expect("temporary copy root");
    let source = root.path().join("source.txt");
    let target = root.path().join("target.txt");
    fs::write(&source, "source contents").expect("write source");
    fs::write(&target, "retained target").expect("write occupied target");

    let result = copy_recursively(&source, &target, &mut detached_tracker());

    assert_eq!(fs::read_to_string(&source).unwrap(), "source contents");
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "retained target",
        "the occupied target was overwritten",
    );
    assert!(result.is_err(), "an occupied target must reject the copy");
}

#[test]
fn recursive_copy_refuses_an_existing_directory_without_merging_trees() {
    let root = tempfile::tempdir().expect("temporary copy root");
    let source = root.path().join("source");
    let target = root.path().join("target");
    fs::create_dir(&source).expect("create source directory");
    fs::create_dir(&target).expect("create occupied target directory");
    fs::write(source.join("source-only.txt"), "source").expect("write source child");
    fs::write(target.join("retained.txt"), "retained").expect("write target child");

    let result = copy_recursively(&source, &target, &mut detached_tracker());

    assert_eq!(
        fs::read_to_string(source.join("source-only.txt")).unwrap(),
        "source"
    );
    assert_eq!(
        fs::read_to_string(target.join("retained.txt")).unwrap(),
        "retained"
    );
    assert!(
        !target.join("source-only.txt").exists(),
        "the source tree must not be merged into the occupied target",
    );
    assert!(
        result.is_err(),
        "an occupied directory must reject the copy"
    );
}

#[cfg(unix)]
#[test]
fn recursive_directory_copy_refuses_a_symlink_target_without_mutating_its_referent() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("temporary copy root");
    let source = root.path().join("source");
    let protected = root.path().join("protected");
    let target = root.path().join("target-link");
    fs::create_dir(&source).expect("create source directory");
    fs::create_dir(&protected).expect("create protected directory");
    fs::write(source.join("source-only.txt"), "source").expect("write source child");
    fs::write(protected.join("retained.txt"), "retained").expect("write protected child");
    symlink(&protected, &target).expect("create occupied directory symlink");

    let result = copy_recursively(&source, &target, &mut detached_tracker());

    assert_eq!(fs::read_link(&target).unwrap(), protected);
    assert_eq!(
        fs::read_to_string(protected.join("retained.txt")).unwrap(),
        "retained"
    );
    assert!(
        !protected.join("source-only.txt").exists(),
        "copy must not follow the target symlink and merge into its referent",
    );
    assert!(result.is_err(), "an occupied symlink must reject the copy");
}

#[cfg(unix)]
#[test]
fn recursive_symlink_copy_refuses_an_existing_symlink_without_replacing_it() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().expect("temporary copy root");
    let source_referent = root.path().join("source-referent");
    let target_referent = root.path().join("target-referent");
    let source = root.path().join("source-link");
    let target = root.path().join("target-link");
    symlink(&source_referent, &source).expect("create source symlink");
    symlink(&target_referent, &target).expect("create occupied target symlink");

    let result = copy_recursively(&source, &target, &mut detached_tracker());

    assert_eq!(fs::read_link(&source).unwrap(), source_referent);
    assert_eq!(fs::read_link(&target).unwrap(), target_referent);
    assert!(result.is_err(), "an occupied symlink must reject the copy");
}

#[test]
fn perform_move_refuses_an_existing_target_without_changing_either_file() {
    let root = tempfile::tempdir().expect("temporary move root");
    let source_dir = root.path().join("source");
    let destination_dir = root.path().join("destination");
    fs::create_dir(&source_dir).expect("create source directory");
    fs::create_dir(&destination_dir).expect("create destination directory");
    let source = source_dir.join("item.txt");
    let target = destination_dir.join("item.txt");
    fs::write(&source, "source contents").expect("write source");
    fs::write(&target, "retained target").expect("write occupied target");

    let result = perform_move(&source, &destination_dir, &target);

    assert!(
        source.exists(),
        "the occupied move target caused the source to be removed"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), "source contents");
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "retained target",
        "the occupied move target was overwritten",
    );
    assert!(result.is_err(), "an occupied target must reject the move");
}
