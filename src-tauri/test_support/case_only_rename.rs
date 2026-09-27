//! Case-only renames and case-variant destinations through the production
//! rename and move paths (#798, W5.2).
//!
//! Each test decides the temporary volume's case sensitivity at run time and
//! asserts that volume's semantics instead of skipping: where the volume folds
//! case (default APFS, NTFS) a case variant names the same object, and where it
//! does not (Linux ext4, btrfs, tmpfs) it is an unrelated name. The OS alone
//! does not decide this: APFS and NTFS volumes can be case-sensitive too.
use super::{
    copy_session::{self, Choice, Conflict, Control, Decision, Event, ItemOutcome, Request},
    entry_execution,
    entry_plan::EntryPlan,
    file_identity,
    move_execution,
    move_plan::MovePlan,
    move_session::MoveWork,
    object_id::ObjectId,
};
use crate::{error::AppError, renderer_owner::Owner};
use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const PAYLOAD: &[u8] = b"case-only payload";

/// Whether `directory`'s volume folds case: create an entry, then look it up
/// under a second spelling. Shared by the admission and native-directory tests.
pub(super) fn folds_case(directory: &Path) -> bool {
    let probe = directory.join("case-probe");
    fs::write(&probe, b"probe").unwrap();
    let variant = directory.join("CASE-PROBE");
    let folds = match fs::symlink_metadata(&variant) {
        Ok(_) => {
            assert_eq!(identity(&variant), identity(&probe));
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => panic!("case-sensitivity probe failed: {error}"),
    };
    fs::remove_file(probe).unwrap();
    folds
}

/// The native object a path names, without following a final symlink.
pub(super) fn identity(path: &Path) -> ObjectId {
    #[cfg(unix)]
    {
        file_identity::from_metadata(&fs::symlink_metadata(path).unwrap())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
            .open(path)
            .unwrap();
        file_identity::of_file(&file).unwrap()
    }
}

/// Name which semantics a run asserted. Written past libtest's output capture
/// so that platform CI logs show the branch that executed, not only a pass.
pub(super) fn report(test: &str, folds: bool, detail: &str) {
    use std::io::Write;
    let volume = if folds {
        "case-insensitive"
    } else {
        "case-sensitive"
    };
    let _ = writeln!(io::stderr(), "[#798] {test}: {volume} volume; {detail}");
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// User entries live in `fixture/`; Linux recovery storage lives beside it.
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let fixture = root.path().join("fixture");
    fs::create_dir(&fixture).unwrap();
    (root, fixture)
}

fn native(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// The executor `rename_entry` and native rename inverses dispatch to on this
/// host: admitted through the recovery runtime on Linux, direct elsewhere.
fn rename(root: &Path, path: &Path, name: &str) -> entry_execution::Outcome {
    let plan = EntryPlan::rename(native(path), name.to_owned()).unwrap();
    #[cfg(target_os = "linux")]
    let work = entry_execution::execute(
        plan,
        crate::files::recovery::Runtime::default(),
        root.join("recovery"),
    );
    #[cfg(not(target_os = "linux"))]
    let work = {
        let _ = root;
        entry_execution::execute_owned(plan, ())
    };
    block(work)
}

/// The executor `move_entry` dispatches to on this host. With
/// `durable-move-recovery`, Linux journals the move instead.
fn move_entry(
    root: &Path,
    source: &Path,
    destination: &Path,
    overwrite: bool,
) -> move_execution::Outcome {
    let plan = MovePlan::new(native(source), native(destination), overwrite).unwrap();
    #[cfg(target_os = "linux")]
    let work = move_execution::execute(
        plan,
        crate::files::recovery::Runtime::default(),
        root.join("recovery"),
    );
    #[cfg(not(target_os = "linux"))]
    let work = {
        let _ = root;
        move_execution::execute_owned(plan, ())
    };
    block(work)
}

/// One ordered session as `move_entries` runs it (paste and drop). Every
/// conflict prompt is answered with `answer`; the prompts are returned.
fn move_session(
    root: &Path,
    source: &Path,
    destination: &Path,
    answer: Choice,
) -> (copy_session::Outcome, Vec<Conflict>) {
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&prompts);
    let session = Arc::clone(&control);
    #[cfg(not(target_os = "linux"))]
    let _ = root;
    let work = MoveWork {
        job_id: 798,
        #[cfg(target_os = "linux")]
        recovery: (
            crate::files::recovery::Runtime::default(),
            root.join("recovery"),
        ),
    };
    let request = Request::new(vec![native(source)], native(destination)).unwrap();
    let outcome = block(copy_session::run(request, control, work, move |event| {
        if let Event::Conflict {
            item,
            ref nonce,
            ref conflict,
        } = event
        {
            seen.lock().unwrap().push(conflict.clone());
            let decision = Decision {
                choice: answer,
                apply_to_all: false,
            };
            session.resolve(&owner, item, nonce, decision).unwrap();
        }
        true
    }));
    let prompts = std::mem::take(&mut *prompts.lock().unwrap());
    (outcome, prompts)
}

/// After a case-only rename the old spelling still names the object where the
/// volume folds case, and names nothing where it does not.
fn assert_old_spelling(folds: bool, old: &Path, object: ObjectId) {
    match fs::symlink_metadata(old) {
        Ok(_) if folds => assert_eq!(identity(old), object),
        Err(error) if !folds && error.kind() == io::ErrorKind::NotFound => {}
        other => panic!("old spelling {} observed {other:?}", old.display()),
    }
}

#[test]
fn case_only_file_rename_keeps_its_object_through_the_rename_path() {
    let (root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let original = fixture.join("readme.txt");
    let renamed = fixture.join("README.txt");
    fs::write(&original, PAYLOAD).unwrap();
    let object = identity(&original);

    let outcome = rename(root.path(), &original, "README.txt");
    let receipt = outcome
        .completion
        .result
        .expect("a case-only rename is not refused as an existing destination");
    assert_eq!(
        Path::new(&receipt.path).file_name(),
        Some(OsStr::new("README.txt"))
    );
    assert_eq!(
        outcome.rename,
        Some(("readme.txt".to_owned(), "README.txt".to_owned())),
        "history records the case change"
    );
    assert_eq!(names(&fixture), ["README.txt"]);
    assert_eq!(identity(&renamed), object, "the rename kept the object");
    assert_eq!(fs::read(&renamed).unwrap(), PAYLOAD);
    assert_old_spelling(folds, &original, object);

    // Undo is the same executor in the other direction.
    rename(root.path(), &renamed, "readme.txt")
        .completion
        .result
        .expect("the inverse case-only rename");
    assert_eq!(names(&fixture), ["readme.txt"]);
    assert_eq!(identity(&original), object);
    assert_eq!(fs::read(&original).unwrap(), PAYLOAD);
    report(
        "case_only_file_rename",
        folds,
        "readme.txt -> README.txt -> readme.txt kept one object",
    );
}

#[test]
fn case_only_directory_rename_keeps_the_directory_and_its_children() {
    let (root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let original = fixture.join("Docs");
    let renamed = fixture.join("docs");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("notes.txt"), PAYLOAD).unwrap();
    let object = identity(&original);
    let child = identity(&original.join("notes.txt"));

    let outcome = rename(root.path(), &original, "docs");
    let receipt = outcome
        .completion
        .result
        .expect("a case-only directory rename is not refused");
    assert_eq!(
        Path::new(&receipt.path).file_name(),
        Some(OsStr::new("docs"))
    );
    assert_eq!(names(&fixture), ["docs"]);
    assert_eq!(identity(&renamed), object, "the rename kept the directory");
    assert_eq!(names(&renamed), ["notes.txt"]);
    assert_eq!(identity(&renamed.join("notes.txt")), child);
    assert_eq!(fs::read(renamed.join("notes.txt")).unwrap(), PAYLOAD);
    assert_old_spelling(folds, &original, object);

    rename(root.path(), &renamed, "Docs")
        .completion
        .result
        .expect("the inverse case-only directory rename");
    assert_eq!(names(&fixture), ["Docs"]);
    assert_eq!(identity(&original), object);
    assert_eq!(identity(&original.join("notes.txt")), child);
    report(
        "case_only_directory_rename",
        folds,
        "Docs -> docs -> Docs kept the directory and its child",
    );
}

/// The case-only exception must not reach a different object: a case variant
/// of another entry is an occupied name wherever the volume folds case.
#[test]
fn a_case_variant_of_another_entry_is_an_existing_destination() {
    let (root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let occupant = fixture.join("readme.txt");
    let source = fixture.join("notes.txt");
    fs::write(&occupant, b"occupant").unwrap();
    fs::write(&source, PAYLOAD).unwrap();
    let (occupant_object, source_object) = (identity(&occupant), identity(&source));

    let result = rename(root.path(), &source, "README.TXT").completion.result;
    if folds {
        assert!(
            matches!(result, Err(AppError::AlreadyExists(_))),
            "{result:?}"
        );
        assert_eq!(names(&fixture), ["notes.txt", "readme.txt"]);
        assert_eq!(identity(&source), source_object);
    } else {
        result.expect("a distinct name on a case-sensitive volume");
        assert_eq!(names(&fixture), ["README.TXT", "readme.txt"]);
        assert_eq!(identity(&fixture.join("README.TXT")), source_object);
    }
    assert_eq!(identity(&occupant), occupant_object);
    assert_eq!(fs::read(&occupant).unwrap(), b"occupant");
    report(
        "case_variant_of_another_entry",
        folds,
        if folds {
            "refused as an existing destination"
        } else {
            "renamed to a distinct name"
        },
    );
}

/// `move_entry` keeps its source name, so its only case-variant hazard is a
/// destination spelled as a case variant of the source's own parent. Where
/// the volume folds case that destination IS the source: an overwrite must
/// recognise it rather than displace the entry it is moving.
#[test]
fn single_move_into_a_case_variant_of_its_own_parent_never_displaces_it() {
    let (root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let parent = fixture.join("Docs");
    let variant = fixture.join("docs");
    let source = parent.join("readme.txt");
    fs::create_dir(&parent).unwrap();
    fs::write(&source, PAYLOAD).unwrap();
    let object = identity(&source);

    if folds {
        let refused = move_entry(root.path(), &source, &variant, false)
            .completion
            .result;
        assert!(
            matches!(refused, Err(AppError::AlreadyExists(_))),
            "{refused:?}"
        );
        let overwrite = move_entry(root.path(), &source, &variant, true)
            .completion
            .result;
        assert!(
            matches!(&overwrite, Err(AppError::InvalidPath(message)) if message.contains("same")),
            "an overwrite must recognise the source itself: {overwrite:?}"
        );
        assert_eq!(names(&fixture), ["Docs"]);
        assert_eq!(names(&parent), ["readme.txt"]);
        assert_eq!(identity(&source), object);
    } else {
        fs::create_dir(&variant).unwrap();
        move_entry(root.path(), &source, &variant, false)
            .completion
            .result
            .expect("a move to a distinct directory");
        assert!(!names(&parent).contains(&"readme.txt".to_owned()));
        assert_eq!(identity(&variant.join("readme.txt")), object);
    }
    let current = if folds { source } else { variant.join("readme.txt") };
    assert_eq!(fs::read(current).unwrap(), PAYLOAD);
    report(
        "single_move_into_case_variant_parent",
        folds,
        if folds {
            "recognised as the source itself; nothing displaced"
        } else {
            "moved to a distinct directory"
        },
    );
}

/// Paste and drop: a session into a case variant of the source's own parent
/// is a same-directory move where the volume folds case, so it succeeds
/// without a conflict prompt and without touching the entry.
#[test]
fn a_move_session_into_a_case_variant_of_its_own_parent_changes_nothing() {
    let (root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let parent = fixture.join("Docs");
    let variant = fixture.join("docs");
    let source = parent.join("readme.txt");
    fs::create_dir(&parent).unwrap();
    fs::write(&source, PAYLOAD).unwrap();
    let object = identity(&source);
    if !folds {
        fs::create_dir(&variant).unwrap();
    }

    let (outcome, prompts) = move_session(root.path(), &source, &variant, Choice::Cancel);
    assert!(prompts.is_empty(), "no conflict prompt: {prompts:?}");
    let [ItemOutcome::Succeeded { receipt }] = outcome.items.as_slice() else {
        panic!("one succeeded item: {:?}", outcome.items)
    };
    assert_eq!(receipt.unchanged, folds, "{receipt:?}");
    let current = if folds {
        assert_eq!(names(&fixture), ["Docs"]);
        assert_eq!(names(&parent), ["readme.txt"]);
        source
    } else {
        assert!(!names(&parent).contains(&"readme.txt".to_owned()));
        variant.join("readme.txt")
    };
    assert_eq!(identity(&current), object);
    assert_eq!(fs::read(current).unwrap(), PAYLOAD);
    report(
        "move_session_into_case_variant_parent",
        folds,
        if folds {
            "unchanged success without a prompt"
        } else {
            "moved to a distinct directory"
        },
    );
}

/// The same-directory exception must not reach a different object: moving
/// `Docs` beside an unrelated `docs` is a conflict where the volume folds case.
#[test]
fn a_move_session_prompts_for_a_case_variant_of_another_entry() {
    let (root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let (from, to) = (fixture.join("from"), fixture.join("to"));
    let source = from.join("Docs");
    let occupant = to.join("docs");
    for directory in [&source, &occupant] {
        fs::create_dir_all(directory).unwrap();
    }
    fs::write(source.join("a.txt"), b"moved").unwrap();
    fs::write(occupant.join("b.txt"), b"occupant").unwrap();
    let (source_object, occupant_object) = (identity(&source), identity(&occupant));

    let (outcome, prompts) = move_session(root.path(), &source, &to, Choice::Skip);
    if folds {
        assert_eq!(prompts.len(), 1, "{prompts:?}");
        assert_eq!(prompts[0].file_name, "Docs");
        assert!(
            matches!(outcome.items.as_slice(), [ItemOutcome::Skipped]),
            "{:?}",
            outcome.items
        );
        assert_eq!(names(&from), ["Docs"]);
        assert_eq!(names(&to), ["docs"]);
        assert_eq!(identity(&source), source_object);
        assert_eq!(names(&source), ["a.txt"]);
    } else {
        assert!(prompts.is_empty(), "{prompts:?}");
        assert!(
            matches!(outcome.items.as_slice(), [ItemOutcome::Succeeded { .. }]),
            "{:?}",
            outcome.items
        );
        assert_eq!(names(&to), ["Docs", "docs"]);
        assert_eq!(identity(&to.join("Docs")), source_object);
    }
    assert_eq!(identity(&occupant), occupant_object);
    assert_eq!(names(&occupant), ["b.txt"]);
    report(
        "move_session_case_variant_of_another_entry",
        folds,
        if folds {
            "prompted as a conflict and skipped"
        } else {
            "moved beside a distinct name"
        },
    );
}

// TEMPORARY (#798 CI discovery, removed before review): record each native
// primitive's case-only behaviour on every platform runner without failing.
#[test]
fn zz_probe_platform_case_semantics() {
    use super::native_directory::Directory;
    use std::fmt::Debug;
    let (_root, fixture) = fixture();
    let folds = folds_case(&fixture);
    let line = |what: &str, value: &dyn Debug| {
        report("zz_probe", folds, &format!("{what}: {value:?}"));
    };
    let fresh = |name: &str, directory: bool| {
        let path = fixture.join(name);
        if directory {
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, b"probe").unwrap();
        }
        path
    };
    let docs = fresh("Docs", true);
    line(
        "canonicalize(fixture/docs)",
        &fs::canonicalize(fixture.join("docs")),
    );
    line("canonicalize(fixture/Docs)", &fs::canonicalize(&docs));
    fs::remove_dir(&docs).unwrap();

    let a = fresh("a.txt", false);
    line(
        "publication::rename_noreplace(a.txt -> A.txt)",
        &super::publication::rename_noreplace(&a, &fixture.join("A.txt")),
    );
    line("names after path no-replace", &names(&fixture));
    for name in names(&fixture) {
        fs::remove_file(fixture.join(name)).unwrap();
    }

    let directory = Directory::open(&fixture).unwrap();
    fresh("b.txt", false);
    line(
        "Directory::rename_to(b.txt -> B.txt)",
        &directory.rename_to(OsStr::new("b.txt"), &directory, OsStr::new("B.txt")),
    );
    line("names after handle rename (file)", &names(&fixture));
    for name in names(&fixture) {
        fs::remove_file(fixture.join(name)).unwrap();
    }
    fresh("Dir", true);
    line(
        "Directory::rename_to(Dir -> dir)",
        &directory.rename_to(OsStr::new("Dir"), &directory, OsStr::new("dir")),
    );
    line("names after handle rename (dir)", &names(&fixture));
    for name in names(&fixture) {
        fs::remove_dir(fixture.join(name)).unwrap();
    }
    let e = fresh("E", true);
    line(
        "fs::rename(E -> e) directory",
        &fs::rename(&e, fixture.join("e")),
    );
    line("names after fs::rename (dir)", &names(&fixture));
}
