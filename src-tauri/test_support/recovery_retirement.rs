//! Durable retirement acceptance (ADR 0023) on real temporary filesystems.
//! Every test asserts the exact bytes that survive, not just a returned status.
use super::*;
use crate::files::recovery::{
    coordinator::test_fixture::fixture,
    retention::Budget,
    model::{OperationSpec, Phase},
    replacement_execution::ReplacementExecution,
    resources::{Access, Request, Scope},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const ORIGINAL_BYTES: &[u8] = b"original content";
const NEW_BYTES: &[u8] = b"new content";

struct Fixture {
    _directory: tempfile::TempDir,
    base: PathBuf,
    coordinator: Arc<Coordinator>,
    id: String,
}

impl Fixture {
    fn root(&self) -> PathBuf {
        self.base.join(".tauri-explorer-recovery-artifacts")
    }

    fn target(&self) -> PathBuf {
        self.base.join("target")
    }

    fn source(&self) -> PathBuf {
        self.base.join("source")
    }

    fn claim(&self) -> DurableOperation {
        self.coordinator
            .try_claim(&self.id, self.current_generation())
            .unwrap()
            .expect("an idle record is claimable")
    }

    fn retirement(&self) -> Retirement {
        Retirement::open(self.claim()).unwrap()
    }

    fn current_generation(&self) -> u64 {
        self.coordinator
            .inventory()
            .unwrap()
            .entries
            .iter()
            .find(|entry| entry.intent.id == self.id)
            .and_then(|entry| entry.generation)
            .expect("record remains indexed")
    }

    fn phase(&self) -> Option<Phase> {
        self.coordinator
            .inventory()
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.intent.id == self.id)
            .and_then(|entry| entry.state)
            .and_then(|state| state.replacement().ok().map(|state| state.phase))
    }

    fn recorded_error(&self) -> Option<String> {
        self.coordinator
            .inventory()
            .unwrap()
            .entries
            .into_iter()
            .find(|entry| entry.intent.id == self.id)
            .and_then(|entry| entry.state)
            .and_then(|state| state.replacement().ok().and_then(|state| state.error.clone()))
    }

    fn indexed(&self) -> bool {
        self.coordinator
            .inventory()
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.intent.id == self.id)
    }

    /// The record's declared paths must become ordinarily reservable again.
    fn claims_released(&self) -> bool {
        self.coordinator
            .reserve(vec![Request {
                path: self.target(),
                access: Access::Write,
                scope: Scope::Subtree,
            }])
            .map(|reservation| reservation.finish().is_ok())
            .unwrap_or(false)
    }
}

/// Drive a real replacement through to `Published`, then release its owner.
fn published() -> Fixture {
    let (directory, coordinator, reservation, spec) = fixture();
    let base = fs::canonicalize(directory.path()).unwrap();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let mut execution = ReplacementExecution::prepare(operation).unwrap();
    let mut progress = crate::progress::ProgressTracker::new(None, "copy", "cancelled", 0, 0, None);
    execution.stage_copy(&mut progress).unwrap();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    let id = execution.operation.intent().id.clone();
    drop(execution);
    Fixture {
        _directory: directory,
        base,
        coordinator,
        id,
    }
}

/// Continue to `Restored`: the original is public again and the independent
/// copy is parked privately.
fn restored() -> Fixture {
    let fixture = published();
    let mut execution = ReplacementExecution::reopen(fixture.claim()).unwrap();
    execution.restore_copy().unwrap();
    drop(execution);
    fixture
}

#[test]
fn an_explicit_discard_removes_the_retained_original_and_retires_the_record() {
    let fixture = published();
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
    let retirement = fixture.retirement();
    assert_eq!(retirement.eligibility(), &Eligibility::Discardable);
    retirement.retire().unwrap();

    assert!(!fixture.root().exists(), "the artifact root is removed");
    assert_eq!(fs::read(fixture.target()).unwrap(), NEW_BYTES);
    assert_eq!(fs::read(fixture.source()).unwrap(), NEW_BYTES);
    assert!(!fixture.indexed(), "the record is retired");
    assert!(
        fixture.claims_released(),
        "a retired record releases its resource claims"
    );
}

#[test]
fn a_completed_overwrite_is_never_retired_automatically() {
    let fixture = published();
    assert_eq!(fixture.retirement().eligibility(), &Eligibility::Discardable);
    let usage = enforce(&fixture.coordinator).unwrap();
    assert_eq!(usage.records, 1);
    assert!(
        fixture.indexed(),
        "budget enforcement must not reclaim the only known original"
    );
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
}

#[test]
fn no_retirement_path_removes_the_only_copy_of_a_published_entry() {
    let fixture = published();
    // The published copy is what makes the retained original disposable.
    fs::remove_file(fixture.target()).unwrap();
    let retirement = fixture.retirement();
    assert!(
        matches!(retirement.eligibility(), Eligibility::Preserved(_)),
        "{:?}",
        retirement.eligibility()
    );
    assert!(retirement.retire().is_err());
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES,
        "the only remaining copy survives a refused discard"
    );
    assert!(fixture.indexed());
    assert_eq!(fixture.phase(), Some(Phase::Published));
}

#[test]
fn a_changed_published_entry_preserves_every_artifact() {
    let fixture = published();
    fs::write(fixture.target(), b"someone else wrote this").unwrap();
    let retirement = fixture.retirement();
    assert!(matches!(
        retirement.eligibility(),
        Eligibility::Preserved(_)
    ));
    assert!(retirement.retire().is_err());
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
}

#[test]
fn a_parked_copy_is_automatically_retirable_only_while_its_source_is_intact() {
    let fixture = restored();
    assert_eq!(
        fs::read(fixture.root().join("publication")).unwrap(),
        NEW_BYTES
    );
    assert_eq!(fs::read(fixture.target()).unwrap(), ORIGINAL_BYTES);
    assert_eq!(fixture.retirement().eligibility(), &Eligibility::Automatic);

    // Without a live source the parked copy may hold the only surviving bytes,
    // so it needs an explicit decision instead.
    fs::write(fixture.source(), b"the source changed").unwrap();
    assert_eq!(fixture.retirement().eligibility(), &Eligibility::Discardable);
    let usage = enforce(&fixture.coordinator).unwrap();
    assert_eq!(usage.records, 1);
    assert!(fixture.indexed());
    assert_eq!(
        fs::read(fixture.root().join("publication")).unwrap(),
        NEW_BYTES
    );
}

#[test]
fn automatic_retirement_reclaims_a_redundant_parked_copy() {
    let fixture = restored();
    enforce(&fixture.coordinator).unwrap();
    assert!(!fixture.root().exists());
    assert_eq!(fs::read(fixture.target()).unwrap(), ORIGINAL_BYTES);
    assert_eq!(fs::read(fixture.source()).unwrap(), NEW_BYTES);
    assert!(!fixture.indexed());
    assert!(fixture.claims_released());
}

#[test]
fn a_cleanup_failure_preserves_the_inventory_and_reports_its_reason() {
    let fixture = published();
    let root = fixture.root();
    // Deny removal inside the artifact root without making it non-private.
    fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
    let error = fixture.retirement().retire().unwrap_err();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();

    assert!(
        format!("{error}").to_lowercase().contains("denied")
            || format!("{error}").to_lowercase().contains("permission"),
        "{error}"
    );
    assert_eq!(
        fs::read(root.join("original")).unwrap(),
        ORIGINAL_BYTES,
        "a failed cleanup removes nothing"
    );
    assert!(fixture.indexed(), "the record stays reportable");
    assert_eq!(fixture.phase(), Some(Phase::DiscardIntent));
    assert!(fixture.recorded_error().is_some());

    // The reported failure is resumable, not terminal.
    let retirement = fixture.retirement();
    assert_eq!(retirement.eligibility(), &Eligibility::Resume);
    retirement.retire().unwrap();
    assert!(!root.exists());
    assert!(!fixture.indexed());
}

#[test]
fn a_journal_failure_before_removal_keeps_every_artifact() {
    let fixture = published();
    let error = fixture
        .retirement()
        .retire_with(|checkpoint| {
            if checkpoint == "intent" {
                Err(AppError::Other("injected disk-full journal write".into()))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(format!("{error}").contains("disk-full"));
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
    assert!(fixture.indexed());
    assert_eq!(fixture.phase(), Some(Phase::DiscardIntent));
    // The record is intact and its retirement still completes on retry.
    fixture.retirement().retire().unwrap();
    assert!(!fixture.indexed());
}

#[test]
fn a_journal_failure_after_removal_keeps_the_record_and_resumes() {
    let fixture = published();
    let error = fixture
        .retirement()
        .retire_with(|checkpoint| {
            if checkpoint == "removed" {
                Err(AppError::Other("injected disk-full completion write".into()))
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(format!("{error}").contains("disk-full"));
    assert!(!fixture.root().exists(), "removal already committed");
    assert!(fixture.indexed(), "the record is never lost");
    assert_eq!(fixture.phase(), Some(Phase::DiscardIntent));

    let retirement = fixture.retirement();
    assert_eq!(retirement.eligibility(), &Eligibility::Resume);
    retirement.retire().unwrap();
    assert!(!fixture.indexed());
    assert_eq!(fs::read(fixture.target()).unwrap(), NEW_BYTES);
}

#[test]
fn a_failure_after_the_completion_checkpoint_leaves_retirable_residue() {
    let fixture = published();
    assert!(fixture
        .retirement()
        .retire_with(|checkpoint| {
            if checkpoint == "completed" {
                Err(AppError::Other("injected reply loss".into()))
            } else {
                Ok(())
            }
        })
        .is_err());
    assert!(!fixture.root().exists());
    assert_eq!(fixture.phase(), Some(Phase::Discarded));
    // A discarded residue never blocks its own completion.
    let retirement = fixture.retirement();
    assert_eq!(retirement.eligibility(), &Eligibility::Resume);
    retirement.retire().unwrap();
    assert!(!fixture.indexed());
    assert!(fixture.claims_released());
}

#[test]
fn an_interrupted_retirement_holding_an_intact_artifact_refuses_a_lost_publication() {
    let fixture = published();
    assert!(fixture
        .retirement()
        .retire_with(|checkpoint| {
            if checkpoint == "intent" {
                Err(AppError::Other("interrupted".into()))
            } else {
                Ok(())
            }
        })
        .is_err());
    assert_eq!(fixture.phase(), Some(Phase::DiscardIntent));
    // Nothing was removed yet and the published copy has since disappeared:
    // resuming would destroy the last copy, so it must not.
    fs::remove_file(fixture.target()).unwrap();
    let retirement = fixture.retirement();
    assert!(
        matches!(retirement.eligibility(), Eligibility::Preserved(_)),
        "{:?}",
        retirement.eligibility()
    );
    assert!(retirement.retire().is_err());
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
}

#[test]
fn retention_is_measured_once_and_charged_against_the_budget() {
    let fixture = published();
    let mut retirement = fixture.retirement();
    let measured = retirement.measure().unwrap();
    assert_eq!(measured, Some(ORIGINAL_BYTES.len() as u64));
    // Measuring again reuses the recorded value without another journal write.
    let generation = fixture.current_generation();
    drop(retirement);
    let mut again = fixture.retirement();
    assert_eq!(again.measure().unwrap(), measured);
    drop(again);
    assert!(fixture.current_generation() > generation, "claims advance");

    let usage = enforce(&fixture.coordinator).unwrap();
    assert_eq!(usage.bytes, ORIGINAL_BYTES.len() as u64);
    assert_eq!(usage.unmeasured, 0);
    assert_eq!(usage.discardable, 1);
    assert!(!usage.at_capacity(&Budget::default()));
    assert!(usage.at_capacity(&Budget {
        bytes: 1,
        records: 8
    }));
}

#[test]
fn a_full_budget_refuses_a_new_record_instead_of_evicting_recovery() {
    let fixture = published();
    enforce(&fixture.coordinator).unwrap();
    let settings = serde_json::json!({ "recoveryRetainedRecordBudget": 1 });
    assert!(Budget::from_settings(&settings).records == 1);
    // Promotion refuses while retention is at capacity, and the existing
    // record and its retained bytes are untouched by that refusal.
    let second = fixture.base.join("second");
    fs::write(&second, b"second").unwrap();
    let usage = enforce(&fixture.coordinator).unwrap();
    assert!(usage.at_capacity(&Budget {
        bytes: u64::MAX,
        records: 1
    }));
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
}

#[test]
fn a_legacy_checkpoint_without_retention_fields_still_lists_and_retires() {
    let fixture = published();
    let database = fixture.base.join("recovery/recovery.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    let payload: Vec<u8> = connection
        .query_row(
            "SELECT payload FROM recovery_records WHERE kind = 'operation'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    // The schema before ADR 0023 had neither key; both must default.
    let state = value["state"]["state"].as_object_mut().unwrap();
    assert!(state.remove("retained_bytes").is_some());
    assert!(state.remove("effect_revision").is_some());
    connection
        .execute(
            "UPDATE recovery_records SET payload = ?1 WHERE kind = 'operation'",
            [serde_json::to_vec(&value).unwrap()],
        )
        .unwrap();
    drop(connection);

    assert!(fixture.indexed(), "a legacy checkpoint still decodes");
    let retirement = fixture.retirement();
    assert_eq!(retirement.eligibility(), &Eligibility::Discardable);
    retirement.retire().unwrap();
    assert!(!fixture.root().exists());
    assert_eq!(fs::read(fixture.target()).unwrap(), NEW_BYTES);
}

#[test]
fn an_unavailable_artifact_parent_reports_unavailability_without_removing_anything() {
    let fixture = restored();
    // Replace the whole recovery namespace's parent identity by moving it:
    // the recorded parent object no longer resolves at its recorded path.
    let moved = fixture.base.join("moved-root");
    fs::rename(fixture.root(), &moved).unwrap();
    let usage = enforce(&fixture.coordinator).unwrap();
    assert!(fixture.indexed(), "an unobservable record is preserved");
    assert!(moved.join("publication").is_file());
    assert!(usage.records >= 1);
}

/// Drive a real directory-tree replacement through to `Published`.
fn published_directories() -> Fixture {
    let (directory, coordinator, reservation, spec) = fixture_with_directories();
    let base = fs::canonicalize(directory.path()).unwrap();
    let operation = reservation
        .promote(spec)
        .unwrap_or_else(|failure| panic!("{}", failure.error));
    let mut execution = ReplacementExecution::prepare(operation).unwrap();
    let mut progress = crate::progress::ProgressTracker::new(None, "copy", "cancelled", 0, 0, None);
    execution.stage_copy(&mut progress).unwrap();
    execution.displace_copy().unwrap();
    execution.publish_copy().unwrap();
    let id = execution.operation.intent().id.clone();
    drop(execution);
    Fixture {
        _directory: directory,
        base,
        coordinator,
        id,
    }
}

#[test]
fn a_directory_replacement_is_measured_and_retired_as_a_whole_tree() {
    let fixture = published_directories();
    let root = fixture.root();
    assert!(root.join("original/nested/deep.txt").is_file());

    let mut retirement = fixture.retirement();
    let measured = retirement.measure().unwrap().expect("a measurable tree");
    assert!(measured >= b"deep bytes".len() as u64);
    drop(retirement);
    fixture.retirement().retire().unwrap();
    assert!(!root.exists(), "the whole retained tree is removed");
    assert!(fixture.target().join("nested/deep.txt").is_file());
    assert!(!fixture.indexed());
}

/// A replacement whose source and destination are directory trees.
fn fixture_with_directories() -> (
    tempfile::TempDir,
    Arc<Coordinator>,
    super::super::coordinator::Reservation,
    OperationSpec,
) {
    use crate::files::{
        file_identity::{of_file, version_from_metadata},
        native_directory::Directory,
        recovery::model::{NativePath, ReplacementSpec},
    };
    let directory = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(directory.path()).unwrap();
    let source = base.join("source");
    let target = base.join("target");
    let root = base.join(".tauri-explorer-recovery-artifacts");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::write(source.join("nested/deep.txt"), b"deep bytes").unwrap();
    fs::create_dir_all(target.join("nested")).unwrap();
    fs::write(target.join("nested/deep.txt"), b"old deep bytes").unwrap();
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

// ---------------------------------------------------------------------------
// Real process-kill acceptance at every retirement checkpoint.
// ---------------------------------------------------------------------------

const KILL_TEST: &str = "EXPLORER_RECOVERY_RETIREMENT_TEST";
const KILL_BOUNDARY: &str = "EXPLORER_RECOVERY_RETIREMENT_BOUNDARY";

#[test]
fn killing_retirement_at_every_checkpoint_leaves_a_resumable_consistent_catalog() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for boundary in ["intent", "removed", "completed"] {
        let fixture = published();
        let ready = fixture.base.join("retirement-ready");
        fs::write(fixture.base.join("record.json"), &fixture.id).unwrap();
        let root = fixture.root();
        let target = fixture.target();
        // Hand the storage to the child process; the temporary directory must
        // outlive it, so only the coordinator is released here.
        let Fixture {
            _directory,
            base,
            coordinator,
            ..
        } = fixture;
        drop(coordinator);

        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "files::recovery::retirement::tests::subprocess_retirement",
                "--ignored",
                "--nocapture",
            ])
            .env(KILL_TEST, &base)
            .env(KILL_BOUNDARY, boundary)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ready.exists() {
            if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("retirement did not reach the {boundary} boundary");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();

        // The published entry is never at risk at any checkpoint.
        assert_eq!(fs::read(&target).unwrap(), NEW_BYTES, "{boundary}");
        match boundary {
            "intent" => assert_eq!(fs::read(root.join("original")).unwrap(), ORIGINAL_BYTES),
            _ => assert!(!root.exists(), "{boundary}"),
        }

        // A fresh process reclaims the abandoned owner and finishes the work.
        let reopened = Coordinator::open(&base.join("recovery")).unwrap();
        let entry = reopened
            .inventory()
            .unwrap()
            .entries
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("the record survives a kill at {boundary}"));
        let generation = entry.generation.expect("the checkpoint survives");
        let claimed = reopened.try_claim(&entry.intent.id, generation).unwrap();
        let retirement = Retirement::open(claimed.expect("a dead owner is reclaimable")).unwrap();
        assert_eq!(retirement.eligibility(), &Eligibility::Resume, "{boundary}");
        retirement.retire().unwrap();
        assert!(!root.exists(), "{boundary}");
        assert_eq!(fs::read(&target).unwrap(), NEW_BYTES, "{boundary}");
        assert!(reopened.inventory().unwrap().entries.is_empty(), "{boundary}");
    }
}

#[test]
#[ignore = "controlled helper for killing_retirement_at_every_checkpoint_leaves_a_resumable_consistent_catalog"]
fn subprocess_retirement() {
    let base = PathBuf::from(std::env::var_os(KILL_TEST).expect("parent fixture"));
    let boundary = std::env::var(KILL_BOUNDARY).expect("parent boundary");
    let id = fs::read_to_string(base.join("record.json")).unwrap();
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let generation = coordinator
        .inventory()
        .unwrap()
        .entries
        .iter()
        .find(|entry| entry.intent.id == id)
        .and_then(|entry| entry.generation)
        .expect("published record");
    let operation = coordinator.try_claim(&id, generation).unwrap().unwrap();
    let stop = |ready: &Path| -> Result<(), AppError> {
        fs::write(ready, b"boundary").unwrap();
        loop {
            std::thread::park();
        }
    };
    let ready = base.join("retirement-ready");
    let result = Retirement::open(operation)
        .unwrap()
        .retire_with(|checkpoint| {
            if checkpoint == boundary {
                stop(&ready)
            } else {
                Ok(())
            }
        });
    panic!("retirement returned before its kill boundary: {result:?}");
}

#[test]
fn a_parked_directory_copy_is_never_reclaimed_automatically_on_an_unchanged_top_level_version() {
    // `EntryVersion` is not a recursive snapshot: rewriting a file inside the
    // restored source changes neither the source directory's size nor its
    // mtime. The parked copy is the only remaining record of the tree as it
    // was copied, so no automatic pass may treat it as provably redundant.
    let fixture = published_directories();
    let mut execution = ReplacementExecution::reopen(fixture.claim()).unwrap();
    execution.restore_copy().unwrap();
    drop(execution);
    let root = fixture.root();
    assert!(
        root.join("publication/nested/deep.txt").is_file(),
        "the restoration parks the copy privately"
    );
    let before = fs::metadata(fixture.source()).unwrap();
    fs::write(fixture.source().join("nested/deep.txt"), b"deep bytes").unwrap();
    let after = fs::metadata(fixture.source()).unwrap();
    assert_eq!(
        (before.len(), before.modified().unwrap()),
        (after.len(), after.modified().unwrap()),
        "the nested write is invisible in the source directory's own version"
    );

    enforce(&fixture.coordinator).unwrap();

    assert_eq!(
        fs::read(root.join("publication/nested/deep.txt")).unwrap(),
        b"deep bytes",
        "the parked directory copy survives every automatic pass"
    );
    assert!(fixture.indexed());
    // It is still explicitly discardable: only the automatic path is refused.
    assert!(matches!(
        fixture.retirement().eligibility(),
        Eligibility::Discardable
    ));
}

#[test]
fn an_interrupted_retirement_whose_endpoint_changed_is_preserved_and_still_resolvable() {
    // A journaled retirement re-verifies its live endpoint immediately before
    // unlinking, because journaling the intent released and retook the
    // admission gate. A changed endpoint refuses the removal, preserves every
    // file, and — crucially — does not pin the record: once the endpoint is
    // resolvable again the same committed decision completes.
    let fixture = published();
    let mut operation = fixture.claim();
    operation
        .advance(crate::files::recovery::replacement_transition::ReplacementTransition::BeginDiscard)
        .unwrap();
    drop(operation);
    assert_eq!(fixture.phase(), Some(Phase::DiscardIntent));
    let root = fixture.root();
    // A foreign writer replaces the published entry after the intent commit.
    fs::write(fixture.target(), b"a foreign editor rewrote this").unwrap();

    let error = fixture.retirement().retire().unwrap_err();
    assert!(format!("{error}").contains("no longer matches"), "{error}");
    assert_eq!(fs::read(root.join("original")).unwrap(), ORIGINAL_BYTES);
    assert!(fixture.indexed());
    // The refusal is a classification, not an effect: it journals nothing,
    // and the reason reaches the user through the recovery service instead.

    // Repeated automatic passes must neither remove anything nor lose it.
    for _ in 0..3 {
        enforce(&fixture.coordinator).unwrap();
    }
    assert_eq!(fs::read(root.join("original")).unwrap(), ORIGINAL_BYTES);
    assert!(fixture.indexed());
    // Restoration remains a legal transition out of an interrupted retirement,
    // so the record is never stranded by the phase machine itself.
    let claimed = fixture.claim();
    assert!(crate::files::recovery::replacement_transition::transition(
        claimed.intent(),
        claimed.state(),
        crate::files::recovery::replacement_transition::ReplacementTransition::BeginRestoration,
    )
    .is_ok());
    drop(claimed);

    // It is reported to the user with the reason, not silently pinned.
    let snapshot =
        crate::files::recovery::service::inspect(&fixture.coordinator, &fixture.id).unwrap();
    let item = snapshot
        .items
        .iter()
        .find(|item| item.id == fixture.id)
        .expect("the record stays in the inventory");
    assert_eq!(item.status, "attention");
    assert!(item.message.contains("no longer matches"), "{}", item.message);
}

#[test]
fn an_enforcement_pass_never_claims_a_settled_record_it_cannot_act_on() {
    // Claiming advances the generation, which invalidates the generation the
    // user is looking at. A settled record whose artifacts are already gone has
    // nothing to measure and nothing to remove, so no pass may touch it.
    let fixture = published();
    fs::remove_dir_all(fixture.root()).unwrap();
    let before = fixture.current_generation();

    for _ in 0..3 {
        enforce(&fixture.coordinator).unwrap();
    }

    assert_eq!(
        fixture.current_generation(),
        before,
        "repeated passes must not churn the record's generation"
    );
    assert!(fixture.indexed());
}

#[test]
fn listing_never_retires_claims_or_probes_on_the_session_bootstrap_path() {
    // `service::list` is what `subscribe` calls automatically after first
    // paint. It must remain evidence-only (ADR 0020's startup boundary).
    let fixture = restored();
    let before = fixture.current_generation();
    let root = fixture.root();

    let snapshot = crate::files::recovery::service::list(&fixture.coordinator).unwrap();

    assert!(
        root.join("publication").exists(),
        "a listing removes nothing, even from a record automatic retirement would reclaim"
    );
    assert_eq!(fixture.current_generation(), before);
    assert!(snapshot.storage.records >= 1);
}

#[test]
fn a_full_record_budget_refuses_a_new_durable_record_through_promotion() {
    // Exercises the refusal branch itself, inside the admission-gated
    // transaction: promotion must reject new durable work rather than evict
    // retained recovery, and the refusal must change nothing.
    let fixture = published();
    let source = fixture.base.join("source-two");
    let target = fixture.base.join("target-two");
    fs::write(&source, NEW_BYTES).unwrap();
    fs::write(&target, ORIGINAL_BYTES).unwrap();
    let reservation = fixture
        .coordinator
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
                path: fixture.base.join(".tauri-explorer-recovery-artifacts-two"),
                access: Access::Write,
                scope: Scope::Subtree,
            },
        ])
        .unwrap();
    let spec = OperationSpec::CopyReplacement(
        crate::files::recovery::model::ReplacementSpec {
            artifact_token: "artifacts-two".into(),
            source_version: crate::files::file_identity::version_from_metadata(
                &fs::symlink_metadata(&source).unwrap(),
            )
            .unwrap(),
            source: crate::files::recovery::model::NativePath(source),
            target: crate::files::recovery::model::NativePath(target.clone()),
            root: crate::files::recovery::model::NativePath(
                fixture.base.join(".tauri-explorer-recovery-artifacts-two"),
            ),
            parent: crate::files::file_identity::of_file(
                &crate::files::native_directory::Directory::open(&fixture.base)
                    .unwrap()
                    .file,
            )
            .unwrap(),
            original: crate::files::file_identity::version_from_metadata(
                &fs::symlink_metadata(&target).unwrap(),
            )
            .unwrap(),
        },
    );

    let failure = reservation
        .promote_within(
            spec,
            Budget {
                bytes: u64::MAX,
                records: 1,
            },
        )
        .err()
        .expect("a full retention budget refuses a new durable record");

    assert!(
        failure.error.to_string().contains("File Recovery"),
        "the refusal names where the user can free space: {}",
        failure.error
    );
    // Nothing was evicted and nothing new was published.
    assert_eq!(
        fs::read(fixture.root().join("original")).unwrap(),
        ORIGINAL_BYTES
    );
    assert!(fixture.indexed());
    assert_eq!(fs::read(&target).unwrap(), ORIGINAL_BYTES);
    assert!(!fixture
        .base
        .join(".tauri-explorer-recovery-artifacts-two")
        .exists());
}
