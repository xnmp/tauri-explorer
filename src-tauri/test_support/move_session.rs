//! Behaviour of one ordered native move session against real temp filesystems.
//!
//! A move session is judged on two things a copy session is not: the source
//! must be gone exactly when the destination exists, and a cancelled session
//! must leave the completed prefix committed and separately undoable.
use super::*;
use crate::{
    file_history::{Action, ForwardEffect},
    file_mutation::move_session_outcome,
    files::{
        copy_session::{run, Choice, Control, Decision, Event, ItemOutcome, Outcome, Request},
        recovery::Runtime,
    },
    renderer_owner::Owner,
};
use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn block<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn work(root: &Path) -> MoveWork {
    MoveWork {
        job_id: 4_242,
        recovery: (Runtime::default(), root.join("recovery")),
    }
}

fn request(sources: &[PathBuf], destination: &Path) -> Request {
    Request::new(
        sources
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        destination.to_string_lossy().into_owned(),
    )
    .unwrap()
}

fn spellings(sources: &[PathBuf]) -> Vec<String> {
    sources
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// Drive a session, replying to each conflict with the next decision. A
/// `None` reply cancels the whole session from the renderer side instead.
fn drive(
    request: Request,
    work: MoveWork,
    decisions: Vec<Option<Decision>>,
) -> (Outcome, Vec<Event>) {
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let replies = Arc::new(Mutex::new(decisions.into_iter()));
    let session = Arc::clone(&control);
    let outcome = block(run(request, Arc::clone(&control), work, move |event| {
        recorded.lock().unwrap().push(event.clone());
        if let Event::Conflict {
            item, ref nonce, ..
        } = event
        {
            match replies.lock().unwrap().next().flatten() {
                Some(decision) => session.resolve(&owner, item, nonce, decision).unwrap(),
                None => session.cancel(&owner).unwrap(),
            }
        }
        true
    }));
    let events = Arc::try_unwrap(events).unwrap().into_inner().unwrap();
    (outcome, events)
}

fn overwrite() -> Option<Decision> {
    Some(Decision {
        choice: Choice::Overwrite,
        apply_to_all: false,
    })
}

fn skip() -> Option<Decision> {
    Some(Decision {
        choice: Choice::Skip,
        apply_to_all: false,
    })
}

fn cancel() -> Option<Decision> {
    Some(Decision {
        choice: Choice::Cancel,
        apply_to_all: false,
    })
}

struct Fixture {
    root: tempfile::TempDir,
    from: PathBuf,
    to: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let from = root.path().join("from");
        let to = root.path().join("to");
        fs::create_dir_all(&from).unwrap();
        fs::create_dir_all(&to).unwrap();
        Self { root, from, to }
    }

    fn source(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.from.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn work(&self) -> MoveWork {
        work(self.root.path())
    }
}

fn statuses(outcome: &Outcome) -> Vec<&'static str> {
    outcome
        .items
        .iter()
        .map(|item| match item {
            ItemOutcome::Succeeded { .. } => "succeeded",
            ItemOutcome::Skipped => "skipped",
            ItemOutcome::Failed { .. } => "failed",
            ItemOutcome::Uncertain { .. } => "uncertain",
            ItemOutcome::Unstarted => "unstarted",
        })
        .collect()
}

#[test]
fn an_ordered_move_relocates_every_item_and_vacates_each_source() {
    let fixture = Fixture::new();
    let sources = vec![
        fixture.source("one.txt", b"first"),
        fixture.source("two.txt", b"second"),
    ];
    let (outcome, _) = drive(request(&sources, &fixture.to), fixture.work(), Vec::new());
    assert_eq!(statuses(&outcome), vec!["succeeded", "succeeded"]);
    assert!(!outcome.cancelled);
    for (name, bytes) in [("one.txt", &b"first"[..]), ("two.txt", &b"second"[..])] {
        assert_eq!(fs::read(fixture.to.join(name)).unwrap(), bytes);
        assert!(
            !fixture.from.join(name).exists(),
            "{name} was copied instead of moved"
        );
    }
}

#[test]
fn an_unanswered_conflict_never_overwrites_and_never_removes_the_source() {
    let fixture = Fixture::new();
    let sources = vec![fixture.source("clash.txt", b"incoming")];
    fs::write(fixture.to.join("clash.txt"), b"existing").unwrap();
    let (outcome, events) = drive(request(&sources, &fixture.to), fixture.work(), vec![skip()]);
    assert_eq!(statuses(&outcome), vec!["skipped"]);
    assert!(events
        .iter()
        .any(|event| matches!(event, Event::Conflict { .. })));
    assert_eq!(fs::read(fixture.to.join("clash.txt")).unwrap(), b"existing");
    assert_eq!(fs::read(&sources[0]).unwrap(), b"incoming");
}

#[test]
fn an_accepted_conflict_replaces_the_destination_and_vacates_the_source() {
    let fixture = Fixture::new();
    let sources = vec![fixture.source("clash.txt", b"incoming")];
    fs::write(fixture.to.join("clash.txt"), b"existing").unwrap();
    let (outcome, _) = drive(
        request(&sources, &fixture.to),
        fixture.work(),
        vec![overwrite()],
    );
    assert_eq!(statuses(&outcome), vec!["succeeded"]);
    assert_eq!(fs::read(fixture.to.join("clash.txt")).unwrap(), b"incoming");
    assert!(!sources[0].exists());
}

#[test]
fn cancelling_at_a_conflict_retains_the_completed_prefix_and_leaves_the_rest_in_place() {
    let fixture = Fixture::new();
    let sources = vec![
        fixture.source("first.txt", b"first"),
        fixture.source("clash.txt", b"incoming"),
        fixture.source("last.txt", b"last"),
    ];
    fs::write(fixture.to.join("clash.txt"), b"existing").unwrap();
    let (outcome, _) = drive(
        request(&sources, &fixture.to),
        fixture.work(),
        vec![cancel()],
    );
    assert!(outcome.cancelled);
    assert_eq!(
        statuses(&outcome),
        vec!["succeeded", "unstarted", "unstarted"]
    );
    // The completed prefix is committed; nothing after the cancellation moved.
    assert_eq!(fs::read(fixture.to.join("first.txt")).unwrap(), b"first");
    assert!(!fixture.from.join("first.txt").exists());
    assert_eq!(fs::read(fixture.to.join("clash.txt")).unwrap(), b"existing");
    assert_eq!(fs::read(&sources[1]).unwrap(), b"incoming");
    assert_eq!(fs::read(&sources[2]).unwrap(), b"last");

    // And that prefix is separately undoable: one committed item, one inverse.
    let projected = move_session_outcome(
        outcome,
        &spellings(&sources),
        fixture.to.to_string_lossy().into_owned(),
    );
    let ForwardEffect::Changed(Some(inverse)) = projected.effect else {
        panic!("a cancelled session must still offer the prefix inverse");
    };
    assert!(matches!(
        inverse,
        Action::Move { .. } | Action::Replacement { .. }
    ));
}

#[test]
fn a_move_into_the_directory_it_already_occupies_succeeds_without_touching_the_entry() {
    let fixture = Fixture::new();
    let sources = vec![fixture.source("stays.txt", b"unchanged")];
    let before = fs::symlink_metadata(&sources[0]).unwrap();
    let (outcome, _) = drive(request(&sources, &fixture.from), fixture.work(), Vec::new());
    assert_eq!(statuses(&outcome), vec!["succeeded"]);
    assert_eq!(fs::read(&sources[0]).unwrap(), b"unchanged");
    use std::os::unix::fs::MetadataExt;
    assert_eq!(
        fs::symlink_metadata(&sources[0]).unwrap().ino(),
        before.ino(),
        "a same-directory move must not recreate the entry"
    );
    // A no-op has no inverse, and no forward effect at all: recording one
    // would discard the redo stack for an operation that changed nothing.
    let projected = move_session_outcome(
        outcome,
        &spellings(&sources),
        fixture.from.to_string_lossy().into_owned(),
    );
    assert!(matches!(projected.effect, ForwardEffect::Unchanged));
    assert!(projected.affected.is_empty());
}

#[test]
fn a_destination_alias_naming_the_source_directory_is_still_a_no_op() {
    // The requested spelling and the destination spelling can name one
    // directory. Comparing them as strings would mint an inverse that
    // relocates an entry onto itself and fails forever.
    let fixture = Fixture::new();
    let sources = vec![fixture.source("stays.txt", b"unchanged")];
    let alias = fixture.root.path().join("alias");
    std::os::unix::fs::symlink(&fixture.from, &alias).unwrap();
    let (outcome, _) = drive(request(&sources, &alias), fixture.work(), Vec::new());
    assert_eq!(statuses(&outcome), vec!["succeeded"]);
    let projected = move_session_outcome(
        outcome,
        &spellings(&sources),
        alias.to_string_lossy().into_owned(),
    );
    assert!(matches!(projected.effect, ForwardEffect::Unchanged));
    assert_eq!(fs::read(&sources[0]).unwrap(), b"unchanged");
}

/// A cross-filesystem move whose source cannot be unlinked after publication.
/// The destination exists and the source may still exist: that is uncertain,
/// not success, and it must not become an inverse.
#[test]
fn a_publication_whose_source_removal_failed_is_uncertain_and_offers_no_inverse() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let root = Path::new("/dev/shm");
    if !root.is_dir() {
        eprintln!("SKIPPED incomplete source removal: /dev/shm is unavailable");
        return;
    }
    let other = tempfile::tempdir_in(root).unwrap();
    let fixture = Fixture::new();
    if fs::metadata(fixture.root.path()).unwrap().dev() == fs::metadata(other.path()).unwrap().dev()
    {
        eprintln!("SKIPPED incomplete source removal: one shared device");
        return;
    }
    let tree = other.path().join("tree");
    fs::create_dir_all(&tree).unwrap();
    fs::write(tree.join("leaf.txt"), b"payload").unwrap();
    // Readable and traversable, but its children cannot be unlinked.
    fs::set_permissions(&tree, fs::Permissions::from_mode(0o555)).unwrap();
    let restore = scopeguard(&tree);

    let (outcome, _) = drive(
        request(std::slice::from_ref(&tree), &fixture.to),
        fixture.work(),
        Vec::new(),
    );
    // Both policies must refuse to call this a success. Only the ordinary
    // path can phrase it as an unfinished removal; the durable path retains
    // the record and says so, but neither may mint an inverse.
    assert_eq!(statuses(&outcome), vec!["uncertain"]);
    let ItemOutcome::Uncertain { error } = &outcome.items[0] else {
        unreachable!()
    };
    if cfg!(feature = "durable-move-recovery") {
        assert!(error.contains("File Recovery"), "{error}");
    } else {
        assert!(error.contains("did not finish"), "{error}");
        assert!(error.contains("Inspect both locations"), "{error}");
        assert_eq!(
            fs::read(fixture.to.join("tree/leaf.txt")).unwrap(),
            b"payload"
        );
    }
    // Whatever the policy, the source that could not be removed is intact.
    assert_eq!(fs::read(tree.join("leaf.txt")).unwrap(), b"payload");
    let projected = move_session_outcome(
        outcome,
        &[tree.to_string_lossy().into_owned()],
        fixture.to.to_string_lossy().into_owned(),
    );
    assert!(matches!(projected.effect, ForwardEffect::Changed(None)));
    drop(restore);
}

/// Restore write permission so the fixture directory can be removed.
fn scopeguard(path: &Path) -> impl Drop + use<> {
    struct Restore(PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        }
    }
    Restore(path.to_owned())
}

#[test]
fn a_directory_cannot_be_relocated_into_its_own_subtree() {
    let fixture = Fixture::new();
    let tree = fixture.from.join("tree");
    let inside = tree.join("inside");
    fs::create_dir_all(&inside).unwrap();
    fs::write(tree.join("leaf.txt"), b"leaf").unwrap();
    let (outcome, _) = drive(
        request(std::slice::from_ref(&tree), &inside),
        fixture.work(),
        Vec::new(),
    );
    assert_eq!(statuses(&outcome), vec!["failed"]);
    assert!(tree.is_dir() && inside.is_dir());
    assert_eq!(fs::read(tree.join("leaf.txt")).unwrap(), b"leaf");
}

#[test]
fn a_relocated_directory_arrives_with_its_whole_subtree() {
    let fixture = Fixture::new();
    let tree = fixture.from.join("tree");
    fs::create_dir_all(tree.join("nested")).unwrap();
    fs::write(tree.join("nested/deep.txt"), b"deep").unwrap();
    let (outcome, _) = drive(
        request(std::slice::from_ref(&tree), &fixture.to),
        fixture.work(),
        Vec::new(),
    );
    assert_eq!(statuses(&outcome), vec!["succeeded"]);
    assert!(!tree.exists());
    assert_eq!(
        fs::read(fixture.to.join("tree/nested/deep.txt")).unwrap(),
        b"deep"
    );
}

#[test]
fn every_committed_item_contributes_both_of_its_directories_to_the_refresh_set() {
    let fixture = Fixture::new();
    let sources = vec![fixture.source("one.txt", b"first")];
    let (outcome, _) = drive(request(&sources, &fixture.to), fixture.work(), Vec::new());
    let projected = move_session_outcome(
        outcome,
        &spellings(&sources),
        fixture.to.to_string_lossy().into_owned(),
    );
    for directory in [&fixture.from, &fixture.to] {
        assert!(
            projected
                .affected
                .contains(&directory.to_string_lossy().into_owned()),
            "{} was not refreshed",
            directory.display()
        );
    }
}

#[cfg(feature = "durable-move-recovery")]
#[test]
fn a_durable_receipt_is_its_own_inverse_and_never_gains_a_path_only_action() {
    let fixture = Fixture::new();
    let sources = vec![fixture.source("durable.txt", b"payload")];
    let (outcome, _) = drive(request(&sources, &fixture.to), fixture.work(), Vec::new());
    assert_eq!(statuses(&outcome), vec!["succeeded"]);
    let ItemOutcome::Succeeded { receipt } = &outcome.items[0] else {
        unreachable!()
    };
    assert!(
        receipt.relocation.is_some(),
        "the durable policy must produce a relocation record"
    );
    let projected = move_session_outcome(
        outcome,
        &spellings(&sources),
        fixture.to.to_string_lossy().into_owned(),
    );
    let ForwardEffect::Changed(Some(Action::Replacement { .. })) = projected.effect else {
        panic!("a durable move inverse must be the record, never a path");
    };
}
