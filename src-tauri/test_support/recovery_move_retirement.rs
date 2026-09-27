//! Real-filesystem contracts for move retirement. Public bytes and recovery
//! availability, rather than in-memory step representation, are the assertions.
use super::*;
use crate::files::recovery::{
    coordinator::Coordinator, forward_move::PreparedMove, model::RecoveryChoice, retirement,
    service,
};
use std::{fs, path::PathBuf, sync::Arc};

const MOVED: &[u8] = b"moved payload";
const OLD: &[u8] = b"overwritten payload";

struct Fixture {
    _base: tempfile::TempDir,
    _shared: Option<tempfile::TempDir>,
    coordinator: Arc<Coordinator>,
    source: PathBuf,
    target: PathBuf,
    roots: Vec<PathBuf>,
    id: String,
}
impl Fixture {
    fn new(cross: bool, overwrite: bool, directory: bool) -> Self {
        Self::build(cross, overwrite, directory, |source| {
            if directory {
                fs::create_dir(source).unwrap();
                fs::write(source.join("entry"), MOVED).unwrap();
            } else {
                fs::write(source, MOVED).unwrap();
            }
        })
    }
    /// `populate` creates the moved source entry; `directory` only shapes an overwritten target.
    fn build(
        cross: bool,
        overwrite: bool,
        directory: bool,
        populate: impl FnOnce(&std::path::Path),
    ) -> Self {
        let base = tempfile::tempdir().unwrap();
        let shared = cross.then(|| tempfile::tempdir_in("/dev/shm").unwrap());
        let source = fs::canonicalize(shared.as_ref().unwrap_or(&base).path())
            .unwrap()
            .join("source");
        let target = fs::canonicalize(base.path()).unwrap().join("target");
        populate(&source);
        if overwrite {
            if directory {
                fs::create_dir(&target).unwrap();
                fs::write(target.join("entry"), OLD).unwrap();
                fs::create_dir(target.join("nested")).unwrap();
            } else {
                fs::write(&target, OLD).unwrap();
            }
        }
        let coordinator =
            Coordinator::open(&fs::canonicalize(base.path()).unwrap().join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        PreparedMove::prepare(&coordinator, &source, &target)
            .unwrap()
            .execute(&mut progress)
            .unwrap();
        let entry = coordinator.inventory().unwrap().entries.remove(0);
        let roots = entry
            .intent
            .operation
            .move_spec()
            .unwrap()
            .roots()
            .map(|root| root.path.0.clone())
            .collect();
        Self {
            _base: base,
            _shared: shared,
            coordinator,
            source,
            target,
            roots,
            id: entry.intent.id,
        }
    }
    fn claim(&self) -> DurableOperation {
        let entry = self.coordinator.inventory().unwrap().entries.remove(0);
        self.coordinator
            .try_claim(&self.id, entry.generation.unwrap())
            .unwrap()
            .unwrap()
    }
    fn retirement(&self) -> MoveRetirement {
        MoveRetirement::open(self.claim()).unwrap()
    }
    fn restore(&self) {
        MoveExecution::reopen(self.claim())
            .unwrap()
            .restore_move()
            .unwrap();
    }
    fn assert_retired(&self) {
        assert!(self.coordinator.inventory().unwrap().entries.is_empty());
        assert!(self.roots.iter().all(|root| !root.exists()));
    }
}

/// A process killed at the first `boundary` of a discard: unlike a returned
/// error, nothing reports the failure, so enforcement may resume it.
fn crash_at(f: &Fixture, boundary: &str, mut before: impl FnMut()) {
    let retirement = f.retirement();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        retirement.retire_with(|label| {
            if label == boundary {
                before();
                panic!("process killed at {boundary}");
            }
            Ok(())
        })
    }));
    assert!(outcome.is_err(), "cleanup never reached {boundary}");
}

#[test]
fn all_completed_move_shapes_preserve_undo_until_explicit_discard() {
    for cross in [false, true] {
        for overwrite in [false, true] {
            for directory in [false, true] {
                let f = Fixture::new(cross, overwrite, directory);
                assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 1);
                let before = f.coordinator.inventory().unwrap().entries[0].generation;
                assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 1);
                assert_eq!(
                    f.coordinator.inventory().unwrap().entries[0].generation,
                    before,
                    "measurement must not churn generations"
                );
                assert_eq!(f.retirement().eligibility(), &Eligibility::Discardable);
                f.retirement().retire_with(|_| Ok(())).unwrap();
                f.assert_retired();
                assert_eq!(
                    fs::read(if directory {
                        f.target.join("entry")
                    } else {
                        f.target.clone()
                    })
                    .unwrap(),
                    MOVED
                );
                assert!(!f.source.exists());
            }
        }
    }
}

#[test]
fn restoration_reclaims_only_redundant_regular_payloads_automatically() {
    for cross in [false, true] {
        for overwrite in [false, true] {
            for directory in [false, true] {
                let f = Fixture::new(cross, overwrite, directory);
                f.restore();
                let usage = retirement::enforce(&f.coordinator).unwrap();
                if cross && directory {
                    assert_eq!(usage.records, 1);
                    assert_eq!(f.retirement().eligibility(), &Eligibility::Discardable);
                    f.retirement().retire_with(|_| Ok(())).unwrap();
                } else {
                    assert_eq!(usage.records, 0);
                }
                f.assert_retired();
                assert_eq!(
                    fs::read(if directory {
                        f.source.join("entry")
                    } else {
                        f.source.clone()
                    })
                    .unwrap(),
                    MOVED
                );
                if overwrite {
                    assert_eq!(
                        fs::read(if directory {
                            f.target.join("entry")
                        } else {
                            f.target.clone()
                        })
                        .unwrap(),
                        OLD
                    );
                } else {
                    assert!(!f.target.exists());
                }
            }
        }
    }
}

#[test]
fn edited_endpoints_foreign_children_and_missing_roots_preserve_everything() {
    for attack in [
        "target",
        "source",
        "foreign",
        "manifest",
        "missing-root",
        "parent",
    ] {
        let f = Fixture::new(true, true, false);
        match attack {
            "target" => fs::write(&f.target, b"user edited target").unwrap(),
            "source" => fs::write(&f.source, b"new source entry").unwrap(),
            "foreign" => fs::write(f.roots[0].join("unexpected"), b"foreign bytes").unwrap(),
            "manifest" => fs::write(f.roots[0].join("manifest.intent"), b"corrupt").unwrap(),
            "missing-root" => fs::rename(&f.roots[1], f.roots[1].with_extension("saved")).unwrap(),
            "parent" => {
                // A new directory at the same path is not the recorded native parent.
                let parent = f.source.parent().unwrap();
                fs::rename(parent, parent.with_extension("saved")).unwrap();
                fs::create_dir(parent).unwrap();
            }
            _ => unreachable!(),
        }
        match MoveRetirement::open(f.claim()) {
            Ok(retirement) => {
                assert!(
                    matches!(retirement.eligibility(), Eligibility::Preserved(_)),
                    "{attack}"
                );
                assert!(retirement.retire_with(|_| Ok(())).is_err());
            }
            Err(_) if attack == "parent" => {}
            Err(error) => panic!("unexpected observer error for {attack}: {error}"),
        }
        assert_eq!(f.coordinator.inventory().unwrap().entries.len(), 1);
        if attack != "parent" {
            assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
        }
        if attack != "missing-root" {
            assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
        }
        if attack == "parent" {
            fs::remove_dir(f.source.parent().unwrap()).unwrap();
            fs::rename(
                f.source.parent().unwrap().with_extension("saved"),
                f.source.parent().unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn every_cleanup_checkpoint_can_resume_without_replaying_public_effects() {
    for cross in [false, true] {
        let checkpoints: &[&str] = if cross {
            &[
                "intent",
                "source-intent",
                "payload-removed",
                "manifest-removed",
                "source-removed",
                "source-completed",
                "target-intent",
                "target-removed",
                "target-completed",
                "completed",
            ]
        } else {
            &[
                "intent",
                "target-intent",
                "payload-removed",
                "manifest-removed",
                "target-removed",
                "target-completed",
                "completed",
            ]
        };
        for boundary in checkpoints {
            let f = Fixture::new(cross, true, false);
            crash_at(&f, boundary, || {});
            assert_eq!(fs::read(&f.target).unwrap(), MOVED);
            // A new coordinator uses only durable evidence, not captured handles.
            let coordinator =
                Coordinator::open(&fs::canonicalize(f._base.path()).unwrap().join("recovery"))
                    .unwrap();
            assert_eq!(
                retirement::enforce(&coordinator).unwrap().records,
                0,
                "{boundary}"
            );
            f.assert_retired();
            assert_eq!(fs::read(&f.target).unwrap(), MOVED);
        }
    }
}

#[test]
fn service_offers_restore_and_discard_and_discard_removes_the_record() {
    let f = Fixture::new(true, true, false);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.actions.contains(&RecoveryChoice::Restore));
    assert!(item.actions.contains(&RecoveryChoice::Discard));
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(reply.items.is_empty());
    f.assert_retired();
}

#[test]
fn endpoint_changes_after_journal_intent_still_preserve_retained_bytes() {
    let f = Fixture::new(true, true, false);
    let result = f.retirement().retire_with(|label| {
        if label == "source-intent" {
            fs::write(&f.target, b"changed after classification")?;
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
    assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    assert!(matches!(
        f.retirement().eligibility(),
        Eligibility::Preserved(_)
    ));
}

#[test]
#[ignore = "spawned by the move retirement crash test"]
fn subprocess_retirement() {
    let Ok(base) = std::env::var("EXPLORER_MOVE_RETIRE_BASE") else {
        return;
    };
    let boundary = std::env::var("EXPLORER_MOVE_RETIRE_BOUNDARY").unwrap();
    let occurrence: usize = std::env::var("EXPLORER_MOVE_RETIRE_OCCURRENCE")
        .unwrap()
        .parse()
        .unwrap();
    let base = PathBuf::from(base);
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let entry = coordinator.inventory().unwrap().entries.remove(0);
    let operation = coordinator
        .try_claim(&entry.intent.id, entry.generation.unwrap())
        .unwrap()
        .unwrap();
    let mut seen = 0;
    MoveRetirement::open(operation)
        .unwrap()
        .retire_with(|label| {
            if label == boundary {
                seen += 1;
            }
            if label == boundary && seen == occurrence {
                fs::write(base.join("retirement-ready"), b"ready")?;
                loop {
                    std::thread::park();
                }
            }
            Ok(())
        })
        .unwrap();
    panic!("cleanup never reached the requested interruption");
}

#[test]
fn killed_process_cleanup_resumes_both_roots_from_durable_evidence() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    for directory in [false, true] {
        for (boundary, occurrence) in [
            ("intent", 1),
            ("source-intent", 1),
            ("payload-removed", 1),
            ("entry-removed", 1),
            ("manifest-removed", 1),
            ("source-removed", 1),
            ("source-completed", 1),
            ("target-intent", 1),
            ("payload-removed", 2),
            ("manifest-removed", 2),
            ("target-removed", 1),
            ("target-completed", 1),
            ("completed", 1),
        ] {
            let f = Fixture::new(true, true, directory);
            let base = fs::canonicalize(f._base.path()).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "files::recovery::move_retirement::tests::subprocess_retirement",
                    "--ignored",
                    "--nocapture",
                ])
                .env("EXPLORER_MOVE_RETIRE_BASE", &base)
                .env("EXPLORER_MOVE_RETIRE_BOUNDARY", boundary)
                .env("EXPLORER_MOVE_RETIRE_OCCURRENCE", occurrence.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            while !base.join("retirement-ready").exists() {
                if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("child failed to reach {boundary}:{occurrence}");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(
                fs::read(if directory {
                    f.target.join("entry")
                } else {
                    f.target.clone()
                })
                .unwrap(),
                MOVED
            );
            let reopened = Coordinator::open(&base.join("recovery")).unwrap();
            assert_eq!(
                retirement::enforce(&reopened).unwrap().records,
                0,
                "{boundary}:{occurrence}"
            );
            f.assert_retired();
            assert_eq!(
                fs::read(if directory {
                    f.target.join("entry")
                } else {
                    f.target.clone()
                })
                .unwrap(),
                MOVED
            );
        }
    }
}

#[test]
fn foreign_descendant_after_root_intent_survives_resume() {
    let f = Fixture::new(true, true, true);
    let parked = f.roots[0].join("parked");
    crash_at(&f, "source-intent", || {});
    fs::write(parked.join("foreign"), b"new user bytes").unwrap();
    let usage = retirement::enforce(&f.coordinator).unwrap();
    assert_eq!(usage.records, 1);
    assert_eq!(fs::read(parked.join("foreign")).unwrap(), b"new user bytes");
    assert_eq!(fs::read(parked.join("entry")).unwrap(), MOVED);
}

#[test]
fn preserved_retirement_accounts_for_all_surviving_bytes() {
    for boundary in ["source-intent", "source-completed"] {
        let f = Fixture::new(true, true, false);
        crash_at(&f, boundary, || {
            fs::write(&f.target, b"changed during cleanup").unwrap();
        });
        let usage = retirement::enforce(&f.coordinator).unwrap();
        assert_eq!(usage.records, 1);
        assert!(
            usage.bytes >= OLD.len() as u64 || usage.unmeasured > 0 || usage.unavailable > 0,
            "retained bytes must not disappear from accounting: {usage:?}"
        );
        assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    }
}

#[test]
fn foreign_descendant_after_partial_tree_removal_is_never_adopted() {
    let f = Fixture::new(true, true, true);
    let parked = f.roots[0].join("parked");
    crash_at(&f, "entry-removed", || {});
    assert!(parked.is_dir());
    fs::write(parked.join("foreign"), b"new user bytes").unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 1);
    assert_eq!(fs::read(parked.join("foreign")).unwrap(), b"new user bytes");
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
}

#[test]
fn partial_tree_removal_resumes_without_a_foreign_descendant() {
    let f = Fixture::new(true, true, true);
    crash_at(&f, "entry-removed", || {});
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 0);
    f.assert_retired();
    assert_eq!(fs::read(f.target.join("entry")).unwrap(), MOVED);
}

#[test]
fn measured_moves_still_execute_their_exact_history_inverse() {
    use crate::files::recovery::coordinator::HistoryPosition;
    for cross in [false, true] {
        for overwrite in [false, true] {
            let f = Fixture::new(cross, overwrite, false);
            let entry = f.coordinator.inventory().unwrap().entries.remove(0);
            let revision = entry.state.unwrap().move_state().unwrap().effect_revision;
            retirement::enforce(&f.coordinator).unwrap();
            retirement::enforce(&f.coordinator).unwrap();
            let operation = f
                .coordinator
                .try_claim_history(&f.id, revision, HistoryPosition::Published)
                .unwrap()
                .unwrap();
            MoveExecution::reopen(operation)
                .unwrap()
                .restore_move()
                .unwrap();
            assert_eq!(fs::read(&f.source).unwrap(), MOVED);
            if overwrite {
                assert_eq!(fs::read(&f.target).unwrap(), OLD);
            } else {
                assert!(!f.target.exists());
            }
        }
    }
}

#[test]
fn partial_cleanup_fences_history_and_managed_mutations_until_completion() {
    use crate::files::recovery::{
        coordinator::HistoryPosition,
        resources::{Access, Request, Scope},
    };
    let f = Fixture::new(true, true, false);
    let revision = f.coordinator.inventory().unwrap().entries[0]
        .state
        .as_ref()
        .unwrap()
        .move_state()
        .unwrap()
        .effect_revision;
    crash_at(&f, "source-completed", || {});
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .is_err());
    let request = || {
        vec![Request {
            path: f.target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }]
    };
    assert!(f.coordinator.reserve(request()).is_err());
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 0);
    f.coordinator.reserve(request()).unwrap().finish().unwrap();
}

#[test]
fn edited_planned_descendant_is_preserved_after_interruption() {
    let f = Fixture::new(true, true, true);
    crash_at(&f, "source-intent", || {});
    let child = f.roots[0].join("parked/entry");
    fs::write(&child, b"edited file inside the retained directory").unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 1);
    assert_eq!(
        fs::read(child).unwrap(),
        b"edited file inside the retained directory"
    );
}

#[test]
fn foreign_descendant_in_later_root_is_preserved_after_cross_root_crash() {
    let f = Fixture::new(true, true, true);
    crash_at(&f, "source-completed", || {});
    let foreign = f.roots[1].join("original/nested/foreign");
    fs::write(&foreign, b"new user bytes in pending root").unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 1);
    assert_eq!(
        fs::read(foreign).unwrap(),
        b"new user bytes in pending root"
    );
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
}

#[test]
fn pending_tree_requires_every_planned_child_even_when_parent_metadata_matches() {
    use crate::files::recovery::{model::NativePath, move_cleanup::Plan};
    let f = Fixture::new(true, true, true);
    let root = &f.roots[1];
    let directory = Directory::open(root).unwrap();
    let plan = Plan::capture(&directory, root, Some("original")).unwrap();
    let mut encoded = serde_json::to_value(plan).unwrap();
    let entries = encoded["entries"].as_array_mut().unwrap();
    let mut missing = entries
        .iter()
        .find(|entry| entry["version"]["directory"] == false)
        .unwrap()
        .clone();
    missing["path"] =
        serde_json::to_value(NativePath(root.join("original/missing-planned-file"))).unwrap();
    entries.push(missing);
    let plan: Plan = serde_json::from_value(encoded).unwrap();
    // No directory metadata changed; only complete membership can catch this.
    let error = plan.verify(&directory, root, false).unwrap_err();
    assert!(
        error.to_string().contains("descendants disappeared"),
        "{error}"
    );
    assert!(
        plan.verify(&directory, root, true).is_ok(),
        "removing may have already unlinked a planned child"
    );
}

/// Run explicitly inside a new private mount namespace. The backing mount stays
/// reachable to the test so it can verify payloads while the public mount is gone.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn unmounted_endpoint_preserves_both_roots_until_same_volume_returns() {
    use std::{os::unix::fs::MetadataExt, process::Command};
    let parent_namespace = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent_namespace
    );
    let run = |program: &str, args: &[&std::ffi::OsStr]| {
        assert!(
            Command::new(program).args(args).status().unwrap().success(),
            "{program}"
        );
    };
    for source_on_mount in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let backing = base.path().join("backing");
        let visible = base.path().join("visible");
        fs::create_dir(&backing).unwrap();
        fs::create_dir(&visible).unwrap();
        run(
            "mount",
            &[
                "-t".as_ref(),
                "tmpfs".as_ref(),
                "tmpfs".as_ref(),
                backing.as_os_str(),
            ],
        );
        run(
            "mount",
            &["--bind".as_ref(), backing.as_os_str(), visible.as_os_str()],
        );
        assert_ne!(
            fs::metadata(&visible).unwrap().dev(),
            fs::metadata(base.path()).unwrap().dev()
        );
        let source = if source_on_mount {
            visible.join("source")
        } else {
            base.path().join("source")
        };
        let target = if source_on_mount {
            base.path().join("target")
        } else {
            visible.join("target")
        };
        fs::write(&source, MOVED).unwrap();
        fs::write(&target, OLD).unwrap();
        let coordinator = Coordinator::open(&base.path().join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        PreparedMove::prepare(&coordinator, &source, &target)
            .unwrap()
            .execute(&mut progress)
            .unwrap();
        let entry = coordinator.inventory().unwrap().entries.remove(0);
        let roots: Vec<_> = entry
            .intent
            .operation
            .move_spec()
            .unwrap()
            .roots()
            .map(|p| p.path.0.clone())
            .collect();
        assert_eq!(roots.len(), 2);
        let actual_path = |path: &std::path::Path| match path.strip_prefix(&visible) {
            Ok(relative) => backing.join(relative),
            Err(_) => path.to_owned(),
        };
        run("umount", &[visible.as_os_str()]);
        assert!(fs::read_dir(&visible).unwrap().next().is_none());
        let snapshot = service::inspect(&coordinator, &entry.intent.id).unwrap();
        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.items[0].actions.is_empty());
        let refused = service::resolve(
            &coordinator,
            &entry.intent.id,
            snapshot.items[0].generation,
            RecoveryChoice::Discard,
        )
        .unwrap();
        assert!(refused.error.is_some());
        assert_eq!(retirement::enforce(&coordinator).unwrap().records, 1);
        assert_eq!(
            fs::read(actual_path(&roots[0]).join("parked")).unwrap(),
            MOVED
        );
        assert_eq!(
            fs::read(actual_path(&roots[1]).join("original")).unwrap(),
            OLD
        );
        assert_eq!(fs::read(actual_path(&target)).unwrap(), MOVED);
        assert!(!actual_path(&source).exists());
        run(
            "mount",
            &["--bind".as_ref(), backing.as_os_str(), visible.as_os_str()],
        );
        let snapshot = service::inspect(&coordinator, &entry.intent.id).unwrap();
        assert!(snapshot.items[0].actions.contains(&RecoveryChoice::Discard));
        let result = service::resolve(
            &coordinator,
            &entry.intent.id,
            snapshot.items[0].generation,
            RecoveryChoice::Discard,
        )
        .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.items.is_empty());
        assert!(roots.iter().all(|root| !root.exists()));
        assert_eq!(fs::read(&target).unwrap(), MOVED);
        assert!(!source.exists());
        run("umount", &[visible.as_os_str()]);
        run("umount", &[backing.as_os_str()]);
    }
}

fn set_mode(path: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// Root bypasses directory write permission, so the refusal is unobservable.
fn running_as_root() -> bool {
    // SAFETY: geteuid has no preconditions and does not mutate memory.
    unsafe { libc::geteuid() == 0 }
}

/// A moved tree whose `pkg` subdirectory is read-only, as a Go module cache or
/// read-only checkout is. Returns the fixture and its parked payload.
fn read_only_payload(read_only: bool) -> (Fixture, PathBuf) {
    let f = Fixture::build(true, false, true, |source| {
        fs::create_dir_all(source.join("pkg")).unwrap();
        fs::write(source.join("pkg/a"), MOVED).unwrap();
        fs::write(source.join("pkg/b"), MOVED).unwrap();
        if read_only {
            set_mode(&source.join("pkg"), 0o555);
        }
    });
    let parked = f
        .roots
        .iter()
        .map(|root| root.join("parked"))
        .find(|path| path.exists())
        .expect("a cross-volume move parks its source");
    (f, parked)
}

fn release_read_only(f: &Fixture, parked: &std::path::Path) {
    for path in [parked.join("pkg"), f.target.join("pkg")] {
        if path.exists() {
            set_mode(&path, 0o755);
        }
    }
}

#[test]
fn read_only_payload_directory_refuses_discard_before_consuming_undo() {
    if running_as_root() {
        return;
    }
    let (f, parked) = read_only_payload(true);
    let error = f.retirement().retire_with(|_| Ok(())).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("Nothing was removed"), "{message}");
    assert!(message.contains("pkg"), "{message}");
    // Nothing was removed, the decision was not journaled, and Undo survives.
    assert_eq!(fs::read(parked.join("pkg/a")).unwrap(), MOVED);
    assert_eq!(fs::read(parked.join("pkg/b")).unwrap(), MOVED);
    assert_eq!(f.retirement().eligibility(), &Eligibility::Discardable);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(snapshot.items[0].actions.contains(&RecoveryChoice::Restore));
    let refused = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(refused.error.is_some());
    assert_eq!(fs::read(parked.join("pkg/a")).unwrap(), MOVED);
    // The user's permission fix, never ours, makes the same Discard succeed.
    set_mode(&parked.join("pkg"), 0o755);
    f.retirement().retire_with(|_| Ok(())).unwrap();
    f.assert_retired();
    assert_eq!(fs::read(f.target.join("pkg/a")).unwrap(), MOVED);
    release_read_only(&f, &parked);
}

#[test]
fn read_only_payload_refusal_leaves_restoration_available() {
    if running_as_root() {
        return;
    }
    let (f, parked) = read_only_payload(true);
    assert!(f.retirement().retire_with(|_| Ok(())).is_err());
    f.restore();
    assert_eq!(fs::read(f.source.join("pkg/a")).unwrap(), MOVED);
    set_mode(&f.source.join("pkg"), 0o755);
    release_read_only(&f, &parked);
}

#[test]
fn persistent_failure_after_discard_intent_is_reported_for_attention_and_retryable() {
    let (f, parked) = read_only_payload(false);
    let pkg = parked.join("pkg");
    let result = f.retirement().retire_with(|label| {
        if label == "intent" {
            // Changed after the preflight: the committed cleanup must stop.
            set_mode(&pkg, 0o555);
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(pkg.join("a")).unwrap(), MOVED);
    // While the committed plan cannot be proven, only forgetting is offered.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert_eq!(item.status, "attention", "{}", item.message);
    assert!(item.message.contains("Discard stopped"), "{}", item.message);
    assert_eq!(item.actions, vec![RecoveryChoice::Release]);
    // Once the user restores it, the failure is still called out, with a retry.
    set_mode(&pkg, 0o755);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert_eq!(item.status, "attention", "{}", item.message);
    assert!(item.message.contains("Discard stopped"), "{}", item.message);
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Discard, RecoveryChoice::Release]
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
    assert_eq!(fs::read(f.target.join("pkg/a")).unwrap(), MOVED);
}

fn tree(path: &std::path::Path) -> Vec<(PathBuf, Option<Vec<u8>>, u32)> {
    use std::os::unix::fs::PermissionsExt;
    let mut entries = vec![];
    let mut pending = vec![path.to_owned()];
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).unwrap();
        let bytes = if metadata.is_dir() {
            pending.extend(fs::read_dir(&path).unwrap().map(|e| e.unwrap().path()));
            None
        } else {
            Some(fs::read(&path).unwrap())
        };
        entries.push((path, bytes, metadata.permissions().mode()));
    }
    entries.sort();
    entries
}

#[test]
fn rootless_move_can_be_forgotten_after_user_edits_without_deleting_anything() {
    for directory in [false, true] {
        for edit in ["content", "mode", "source-reused"] {
            let f = Fixture::new(false, false, directory);
            assert!(f.roots.is_empty(), "a same-volume rename retains nothing");
            match (edit, directory) {
                ("content", false) => fs::write(&f.target, b"user edit").unwrap(),
                ("content", true) => fs::write(f.target.join("added"), b"user").unwrap(),
                ("mode", _) => set_mode(&f.target, 0o700),
                ("source-reused", _) => fs::write(&f.source, b"new source").unwrap(),
                _ => unreachable!(),
            }
            let target_before = tree(&f.target);
            let source_before = f.source.exists().then(|| tree(&f.source));
            let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
            let item = &snapshot.items[0];
            assert!(
                item.actions.contains(&RecoveryChoice::Discard),
                "{edit}: {}",
                item.message
            );
            let reply = service::resolve(
                &f.coordinator,
                &f.id,
                item.generation,
                RecoveryChoice::Discard,
            )
            .unwrap();
            assert!(reply.error.is_none(), "{edit}: {:?}", reply.error);
            assert!(f.coordinator.inventory().unwrap().entries.is_empty());
            assert_eq!(tree(&f.target), target_before, "{edit}");
            assert_eq!(f.source.exists().then(|| tree(&f.source)), source_before);
        }
    }
}

#[test]
fn restored_rootless_move_is_reclaimed_after_the_restored_entry_is_edited() {
    let f = Fixture::new(false, false, false);
    f.restore();
    fs::write(&f.source, b"edited after undo").unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 0);
    assert_eq!(fs::read(&f.source).unwrap(), b"edited after undo");
    assert!(!f.target.exists());
}

/// Runs one real move and its discard after the parent prepared every fixture
/// directory, so only recovery-owned creation sees the restrictive umask.
#[test]
#[ignore = "spawned by the restrictive umask test"]
fn subprocess_restrictive_umask() {
    let Ok(base) = std::env::var("EXPLORER_MOVE_UMASK_BASE") else {
        return;
    };
    let base = PathBuf::from(base);
    let shared = PathBuf::from(std::env::var("EXPLORER_MOVE_UMASK_SHARED").unwrap());
    let run =
        |coordinator: &Arc<Coordinator>, source: &std::path::Path, target: &std::path::Path| {
            let mut progress =
                crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
            PreparedMove::prepare(coordinator, source, target)
                .unwrap()
                .execute(&mut progress)
                .unwrap();
            let entry = coordinator.inventory().unwrap().entries.remove(0);
            let snapshot = service::inspect(coordinator, &entry.intent.id).unwrap();
            let reply = service::resolve(
                coordinator,
                &entry.intent.id,
                snapshot.items[0].generation,
                RecoveryChoice::Discard,
            )
            .unwrap();
            assert!(reply.error.is_none(), "{:?}", reply.error);
            assert!(coordinator.inventory().unwrap().entries.is_empty());
        };
    // Existing storage first: probes, move roots, manifests and copies are
    // created on the user volumes while the umask removes owner access.
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    // SAFETY: umask only replaces this child's creation mask.
    unsafe { libc::umask(0o277) };
    run(&coordinator, &shared.join("source"), &base.join("target"));
    run(
        &coordinator,
        &base.join("renamed"),
        &base.join("rename-target"),
    );
    // New recovery storage is itself created under the same mask.
    let fresh = Coordinator::open(&base.join("fresh-recovery")).unwrap();
    run(&fresh, &shared.join("second"), &base.join("second-target"));
}

#[test]
fn restrictive_umask_cannot_break_probes_roots_or_retirement() {
    use std::process::Command;
    let base = tempfile::tempdir().unwrap();
    let shared = tempfile::tempdir_in("/dev/shm").unwrap();
    let base_path = fs::canonicalize(base.path()).unwrap();
    let shared_path = fs::canonicalize(shared.path()).unwrap();
    fs::create_dir(shared_path.join("source")).unwrap();
    fs::write(shared_path.join("source/entry"), MOVED).unwrap();
    fs::write(base_path.join("target"), OLD).unwrap();
    fs::write(base_path.join("renamed"), MOVED).unwrap();
    fs::write(shared_path.join("second"), MOVED).unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::recovery::move_retirement::tests::subprocess_restrictive_umask",
            "--ignored",
            "--nocapture",
        ])
        .env("EXPLORER_MOVE_UMASK_BASE", &base_path)
        .env("EXPLORER_MOVE_UMASK_SHARED", &shared_path)
        .status()
        .unwrap();
    assert!(status.success(), "restrictive umask move failed: {status}");
    assert_eq!(fs::read(base_path.join("target/entry")).unwrap(), MOVED);
    assert_eq!(fs::read(base_path.join("rename-target")).unwrap(), MOVED);
    assert_eq!(fs::read(base_path.join("second-target")).unwrap(), MOVED);
    for parent in [&base_path, &shared_path] {
        let residue: Vec<_> = fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| {
                name.to_string_lossy()
                    .starts_with(".tauri-explorer-recovery-")
            })
            .collect();
        assert!(residue.is_empty(), "{residue:?}");
    }
}

/// A tree whose retirement plan cannot fit the per-root byte budget: long
/// nested names make each recorded path several KiB, so ~2k entries suffice.
fn unplannable_tree(root: &std::path::Path) {
    let mut deepest = root.to_owned();
    for level in 0..8 {
        deepest.push(format!("{level}{}", "d".repeat(200)));
    }
    fs::create_dir_all(&deepest).unwrap();
    for index in 0..2_100 {
        fs::write(deepest.join(format!("{index:05}{}", "f".repeat(200))), b"x").unwrap();
    }
}

fn private_residue(parent: &std::path::Path) -> Vec<std::ffi::OsString> {
    fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .filter(|name| {
            name.to_string_lossy()
                .starts_with(".tauri-explorer-recovery-")
        })
        .collect()
}

#[test]
fn a_payload_that_could_never_be_discarded_is_refused_before_any_record_or_effect() {
    for overwrite_only in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in("/dev/shm").unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        // Cross volume: the source would be parked. Same volume with an
        // overwrite: the displaced destination would be retained.
        let (source, target) = if overwrite_only {
            fs::write(base_path.join("source"), MOVED).unwrap();
            unplannable_tree(&base_path.join("target"));
            (base_path.join("source"), base_path.join("target"))
        } else {
            let shared_path = fs::canonicalize(shared.path()).unwrap();
            unplannable_tree(&shared_path.join("source"));
            (shared_path.join("source"), base_path.join("target"))
        };
        let coordinator = Coordinator::open(&base_path.join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        let result = PreparedMove::prepare(&coordinator, &source, &target)
            .and_then(|prepared| prepared.execute(&mut progress));
        let error = match result {
            Ok(_) => {
                // Admitted: it must then be discardable, or it is stuck forever.
                let entry = coordinator.inventory().unwrap().entries.remove(0);
                let operation = coordinator
                    .try_claim(&entry.intent.id, entry.generation.unwrap())
                    .unwrap()
                    .unwrap();
                let discard = MoveRetirement::open(operation)
                    .unwrap()
                    .retire_with(|_| Ok(()));
                panic!("an unplannable payload was admitted; its discard returned {discard:?}");
            }
            Err(error) => error.to_string(),
        };
        assert!(error.contains("Nothing was moved"), "{error}");
        assert!(coordinator.inventory().unwrap().entries.is_empty());
        assert!(source.exists());
        assert_eq!(overwrite_only, target.exists());
        assert!(private_residue(source.parent().unwrap()).is_empty());
        assert!(private_residue(target.parent().unwrap()).is_empty());
    }
}

fn effect_revision(f: &Fixture) -> u64 {
    f.coordinator.inventory().unwrap().entries[0]
        .state
        .as_ref()
        .unwrap()
        .move_state()
        .unwrap()
        .effect_revision
}

#[test]
fn an_endpoint_change_after_the_discard_decision_withdraws_it_and_keeps_undo() {
    use crate::files::recovery::coordinator::HistoryPosition;
    // Both boundaries follow a journaled decision but precede every unlink.
    for boundary in ["intent", "source-intent"] {
        let f = Fixture::new(true, true, false);
        let revision = effect_revision(&f);
        let result = f.retirement().retire_with(|label| {
            if label == boundary {
                // A foreign entry now occupies the vacated source name.
                fs::write(&f.source, b"new entry at the source name")?;
            }
            Ok(())
        });
        let error = result.unwrap_err().to_string();
        assert!(error.contains("withdrawn"), "{boundary}: {error}");
        assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
        assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
        // The committed decision is gone: history can claim the record again.
        let claimed = f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap_or_else(|error| panic!("{boundary}: Undo was consumed: {error}"))
            .unwrap();
        drop(claimed);
        // Once the name is free again, the same Undo returns both entries.
        fs::remove_file(&f.source).unwrap();
        let operation = f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .unwrap();
        MoveExecution::reopen(operation)
            .unwrap()
            .restore_move()
            .unwrap();
        assert_eq!(fs::read(&f.source).unwrap(), MOVED, "{boundary}");
        assert_eq!(fs::read(&f.target).unwrap(), OLD, "{boundary}");
    }
}

#[test]
fn a_decision_that_already_removed_a_planned_entry_is_never_withdrawn() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, true, true, |source| {
        fs::create_dir(source).unwrap();
        fs::write(source.join("a"), MOVED).unwrap();
        fs::write(source.join("b"), MOVED).unwrap();
    });
    let revision = effect_revision(&f);
    let mut removed = 0;
    let result = f.retirement().retire_with(|label| {
        if label == "entry-removed" {
            removed += 1;
            if removed == 1 {
                fs::write(&f.source, b"new entry at the source name")?;
                return Err(invalid("interrupted after the first unlink"));
            }
        }
        Ok(())
    });
    assert!(result.is_err());
    let parked = f.roots[0].join("parked");
    let survivors = ["a", "b"]
        .iter()
        .filter(|name| parked.join(name).exists())
        .count();
    assert_eq!(survivors, 1, "exactly one planned file was removed");
    // A resumed attempt observes the missing child and must not withdraw.
    assert!(f.retirement().retire_with(|_| Ok(())).is_err());
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .is_err());
    assert!(parked.is_dir());
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
}

#[test]
fn an_interrupted_decision_resumed_after_an_endpoint_change_withdraws_itself() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::new(true, true, false);
    let revision = effect_revision(&f);
    let interrupted = f.retirement().retire_with(|label| match label {
        "intent" => Err(invalid("interrupted after the decision")),
        _ => Ok(()),
    });
    assert!(interrupted.is_err());
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .is_err());
    fs::write(&f.target, b"edited while the decision was pending").unwrap();
    // The explicit retry proves the change and returns the decision.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    let error = reply.error.unwrap_or_default();
    assert!(error.contains("withdrawn"), "{error}");
    assert_eq!(fs::read(f.roots[0].join("parked")).unwrap(), MOVED);
    assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
}

fn generation(f: &Fixture) -> u64 {
    f.coordinator.inventory().unwrap().entries[0]
        .generation
        .unwrap()
}

/// A cross-volume directory move whose discard removed one planned file and
/// then stopped, as a crash (`crash`) or as a reported failure.
fn partially_retired(crash: bool) -> Fixture {
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir(source).unwrap();
        fs::write(source.join("a"), MOVED).unwrap();
        fs::write(source.join("b"), MOVED).unwrap();
    });
    if crash {
        crash_at(&f, "entry-removed", || {});
    } else {
        let stopped = f.retirement().retire_with(|label| match label {
            "entry-removed" => Err(invalid("stopped after the first unlink")),
            _ => Ok(()),
        });
        assert!(stopped.is_err());
    }
    let parked = f.roots[0].join("parked");
    assert_eq!(
        ["a", "b"]
            .iter()
            .filter(|name| parked.join(name).exists())
            .count(),
        1
    );
    f
}

#[test]
fn a_reported_retirement_failure_is_never_reclaimed_by_enforcement() {
    let f = partially_retired(false);
    let before = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
        assert!(
            !f.coordinator.inventory().unwrap().entries.is_empty(),
            "a reported failure was retried automatically"
        );
    }
    assert_eq!(
        generation(&f),
        before,
        "enforcement churned a reported failure"
    );
    assert!(f.roots[0].join("parked").is_dir());
    // Only the user's explicit retry finishes the committed decision.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert_eq!(
        snapshot.items[0].actions,
        vec![RecoveryChoice::Discard, RecoveryChoice::Release]
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}

#[test]
fn an_interrupted_retirement_that_cannot_resume_is_claimed_at_most_once() {
    let f = partially_retired(true);
    // The public endpoint no longer proves the committed plan.
    fs::write(&f.source, b"foreign entry at the vacated source").unwrap();
    retirement::enforce(&f.coordinator).unwrap();
    let after_first = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert_eq!(
        generation(&f),
        after_first,
        "enforcement re-claims every pass"
    );
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(
        snapshot.items[0].message.contains("Discard stopped"),
        "{}",
        snapshot.items[0].message
    );
    assert!(f.roots[0].join("parked").is_dir());
}

#[test]
fn a_decision_the_journal_cannot_hold_with_headroom_is_refused_before_consuming_undo() {
    use crate::files::recovery::{coordinator::HistoryPosition, journal::MAX_TOTAL_BYTES};
    let f = Fixture::new(true, true, true);
    let revision = effect_revision(&f);
    let before = generation(&f);
    // No journal can grow a record while leaving all of itself free.
    let error = f
        .retirement()
        .leaving(MAX_TOTAL_BYTES)
        .retire_with(|_| Ok(()))
        .unwrap_err()
        .to_string();
    assert!(error.contains("too many unfinished discards"), "{error}");
    assert!(error.contains("Undo is kept"), "{error}");
    assert_eq!(fs::read(f.roots[0].join("parked/entry")).unwrap(), MOVED);
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
    // Only the claim itself advanced the generation; no decision was journaled.
    assert_eq!(generation(&f), before + 1);
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
}

fn write_claim(f: &Fixture) -> Result<(), AppError> {
    use crate::files::recovery::resources::{Access, Request, Scope};
    f.coordinator
        .reserve(vec![Request {
            path: f.target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])?
        .finish()
}

#[test]
fn a_stranded_discard_can_be_forgotten_without_touching_any_file() {
    let f = partially_retired(false);
    // The vacated source is reused, so the committed plan can never finish.
    fs::write(&f.source, b"foreign entry at the vacated source").unwrap();
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = snapshot.items[0].clone();
    assert!(
        item.actions.contains(&RecoveryChoice::Release),
        "{:?}: {}",
        item.actions,
        item.message
    );
    assert!(
        write_claim(&f).is_err(),
        "the stranded record locks the moved entry"
    );
    let before = tree(&f.roots[0]);
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Release,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(
        tree(&f.roots[0]),
        before,
        "forgetting removed or changed a file"
    );
    assert_eq!(
        fs::read(&f.source).unwrap(),
        b"foreign entry at the vacated source"
    );
    write_claim(&f).expect("forgetting released the record's locks");
}

#[test]
fn a_discard_whose_volume_changed_identity_can_still_be_forgotten() {
    let f = partially_retired(true);
    // The source volume's parent is replaced: nothing can be observed there.
    let parent = f.roots[0].parent().unwrap().to_owned();
    let away = parent.with_extension("away");
    fs::rename(&parent, &away).unwrap();
    fs::create_dir(&parent).unwrap();
    let before = tree(&away);
    retirement::enforce(&f.coordinator).unwrap();
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = snapshot.items[0].clone();
    assert_eq!(
        item.actions,
        vec![RecoveryChoice::Release],
        "{}",
        item.message
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Release,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert!(f.coordinator.inventory().unwrap().entries.is_empty());
    assert_eq!(tree(&away), before);
    fs::remove_dir(&parent).unwrap();
    fs::rename(&away, &parent).unwrap();
}

#[test]
fn only_a_stopped_discard_can_be_forgotten() {
    use crate::files::recovery::coordinator::HistoryPosition;
    for cross in [false, true] {
        let f = Fixture::new(cross, true, false);
        let revision = effect_revision(&f);
        let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
        assert!(!snapshot.items[0].actions.contains(&RecoveryChoice::Release));
        let reply = service::resolve(
            &f.coordinator,
            &f.id,
            snapshot.items[0].generation,
            RecoveryChoice::Release,
        )
        .unwrap();
        assert!(reply.error.is_some(), "a settled move was forgotten");
        assert!(f
            .coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .is_some());
    }
    // A resumable interruption offers only the retry that finishes it.
    let f = Fixture::new(true, true, false);
    crash_at(&f, "source-completed", || {});
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert_eq!(snapshot.items[0].actions, vec![RecoveryChoice::Discard]);
}

/// Two bind mounts of one filesystem share st_dev, yet rename(2) between them
/// fails with EXDEV. Requires the isolated namespace documented for
/// `unmounted_endpoint_preserves_both_roots_until_same_volume_returns`.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn bind_mounted_endpoints_on_one_device_are_refused_before_any_record() {
    use std::{os::unix::fs::MetadataExt, process::Command};
    let parent_namespace = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent_namespace
    );
    for overwrite in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        let (left, right) = (base_path.join("left"), base_path.join("right"));
        fs::create_dir(&left).unwrap();
        fs::create_dir(&right).unwrap();
        let alias = base_path.join("alias");
        fs::create_dir(&alias).unwrap();
        assert!(Command::new("mount")
            .args(["--bind".as_ref(), right.as_os_str(), alias.as_os_str()])
            .status()
            .unwrap()
            .success());
        assert_eq!(
            fs::metadata(&left).unwrap().dev(),
            fs::metadata(&alias).unwrap().dev(),
            "a bind mount keeps its device"
        );
        let (source, target) = (left.join("source"), alias.join("target"));
        fs::write(&source, MOVED).unwrap();
        if overwrite {
            fs::write(&target, OLD).unwrap();
        }
        // The kernel refuses the plain rename the Rename strategy would use.
        let scratch = left.join("scratch");
        fs::write(&scratch, b"").unwrap();
        let exdev = fs::rename(&scratch, alias.join("scratch")).unwrap_err();
        assert_eq!(exdev.raw_os_error(), Some(libc::EXDEV));
        fs::remove_file(&scratch).unwrap();
        let coordinator = Coordinator::open(&base_path.join("recovery")).unwrap();
        let error = PreparedMove::prepare(&coordinator, &source, &target)
            .err()
            .expect("a bind-mounted destination was admitted")
            .to_string();
        assert!(error.contains("Nothing was moved"), "{error}");
        assert!(coordinator.inventory().unwrap().entries.is_empty());
        assert_eq!(fs::read(&source).unwrap(), MOVED);
        assert!(private_residue(&left).is_empty() && private_residue(&alias).is_empty());
        assert!(Command::new("umount")
            .arg(&alias)
            .status()
            .unwrap()
            .success());
    }
}

/// Eight nested 200-byte directory names: each recorded path below this costs
/// several KiB of a retirement plan's byte budget, so ~2k entries exhaust it.
fn deep(root: &std::path::Path) -> PathBuf {
    let mut deepest = root.to_owned();
    for level in 0..8 {
        deepest.push(format!("{level}{}", "d".repeat(200)));
    }
    deepest
}

fn populate_deep(deepest: &std::path::Path, files: std::ops::Range<usize>) {
    for index in files {
        fs::write(deepest.join(format!("{index:05}{}", "f".repeat(200))), b"x").unwrap();
    }
}

fn trim_deep(deepest: &std::path::Path, files: std::ops::Range<usize>) {
    for index in files {
        fs::remove_file(deepest.join(format!("{index:05}{}", "f".repeat(200)))).unwrap();
    }
}

/// A cross-volume move of a tree that fits its retirement plans at admission.
fn plannable_deep_move() -> Fixture {
    Fixture::build(true, false, false, |source| {
        let deepest = deep(source);
        fs::create_dir_all(&deepest).unwrap();
        populate_deep(&deepest, 0..1_200);
    })
}

fn history_undo(f: &Fixture, revision: u64) -> Result<(), AppError> {
    use crate::files::recovery::model::{ReplacementDirection, ReplacementHistory};
    crate::files::recovery::history::execute(
        &f.coordinator,
        ReplacementHistory {
            id: f.id.clone(),
            revision,
            refresh_dirs: vec![],
        },
        ReplacementDirection::Restore,
    )
    .map(drop)
}

#[test]
fn undo_refuses_a_destination_grown_past_any_retirement_plan_and_keeps_it() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = plannable_deep_move();
    let revision = effect_revision(&f);
    // The user keeps working deep inside the moved destination.
    populate_deep(&deep(&f.target), 1_200..2_600);
    let error = history_undo(&f, revision)
        .expect_err("Undo retained a destination no discard could ever remove");
    // A refusal before any durable effect keeps the Undo entry itself.
    assert!(!matches!(error, AppError::MutationUncertain(_)), "{error}");
    assert!(error.to_string().contains("Nothing was changed"), "{error}");
    assert_eq!(fs::read_dir(deep(&f.target)).unwrap().count(), 2_600);
    assert!(!f.source.exists(), "the source stayed parked");
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
    // Once the destination fits again, the same Undo succeeds, and the
    // publication it retains can still be discarded.
    trim_deep(&deep(&f.target), 1_200..2_600);
    history_undo(&f, revision).unwrap();
    assert_eq!(fs::read_dir(deep(&f.source)).unwrap().count(), 1_200);
    assert!(!f.target.exists());
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}

#[test]
fn a_refused_undo_leaves_discard_able_to_keep_the_grown_destination() {
    let f = plannable_deep_move();
    let revision = effect_revision(&f);
    populate_deep(&deep(&f.target), 1_200..2_600);
    assert!(history_undo(&f, revision).is_err());
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(
        snapshot.items[0].actions.contains(&RecoveryChoice::Discard),
        "{:?}",
        snapshot.items[0].actions
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
    assert_eq!(fs::read_dir(deep(&f.target)).unwrap().count(), 2_600);
    assert!(!f.source.exists());
}

#[test]
fn a_destination_grown_while_undo_runs_is_kept_public_and_retryable() {
    let f = plannable_deep_move();
    let deepest = deep(&f.target);
    let grown = deepest.clone();
    // Grows after Undo admitted the destination but before it is parked.
    let result = MoveExecution::reopen(f.claim())
        .unwrap()
        .with_boundary(Box::new(move |label| {
            if label == "restore-intent" {
                populate_deep(&grown, 1_200..2_600);
            }
            Ok(())
        }))
        .restore_move();
    assert!(result.is_err(), "a grown destination was parked");
    assert_eq!(fs::read_dir(&deepest).unwrap().count(), 2_600);
    // The retry File Recovery offers succeeds once the destination fits.
    trim_deep(&deepest, 1_200..2_600);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    assert!(
        snapshot.items[0].actions.contains(&RecoveryChoice::Restore),
        "{:?}: {}",
        snapshot.items[0].actions,
        snapshot.items[0].message
    );
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Restore,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    assert_eq!(fs::read_dir(deep(&f.source)).unwrap().count(), 1_200);
    assert!(!f.target.exists());
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}

/// `mount`/`umount` inside the documented isolated namespace only (see
/// `unmounted_endpoint_preserves_both_roots_until_same_volume_returns`).
fn isolated_mount(program: &str, args: &[&std::ffi::OsStr]) {
    let parent_namespace = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent_namespace
    );
    assert!(
        std::process::Command::new(program)
            .args(args)
            .status()
            .unwrap()
            .success(),
        "{program} {args:?}"
    );
}

fn refused_move(
    source: &std::path::Path,
    target: &std::path::Path,
    base: &std::path::Path,
) -> String {
    let coordinator = Coordinator::open(&base.join("recovery")).unwrap();
    let mut progress = crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
    let error = match PreparedMove::prepare(&coordinator, source, target)
        .and_then(|prepared| prepared.execute(&mut progress))
    {
        Ok(_) => panic!("the move was admitted"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("Nothing was moved"), "{error}");
    assert!(coordinator.inventory().unwrap().entries.is_empty());
    assert!(private_residue(source.parent().unwrap()).is_empty());
    assert!(private_residue(target.parent().unwrap()).is_empty());
    error
}

/// A payload with a submount inside it could be captured by admission's walk
/// and later never validated as a retirement plan. Requires the isolated
/// namespace documented in e2e-tauri/README.md.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn a_payload_that_crosses_into_another_mount_is_refused_before_any_record() {
    for overwrite_only in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in("/dev/shm").unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        // Cross volume: the source tree would be parked. Same volume with an
        // overwrite: the displaced destination tree would be retained.
        let (source, target) = if overwrite_only {
            (base_path.join("source"), base_path.join("target"))
        } else {
            let shared_path = fs::canonicalize(shared.path()).unwrap();
            (shared_path.join("source"), base_path.join("target"))
        };
        let tree = if overwrite_only { &target } else { &source };
        if overwrite_only {
            fs::write(&source, MOVED).unwrap();
        }
        fs::create_dir_all(tree.join("inner")).unwrap();
        fs::write(tree.join("entry"), OLD).unwrap();
        isolated_mount(
            "mount",
            &[
                "-t".as_ref(),
                "tmpfs".as_ref(),
                "tmpfs".as_ref(),
                tree.join("inner").as_os_str(),
            ],
        );
        fs::write(tree.join("inner/mounted"), OLD).unwrap();
        let error = refused_move(&source, &target, &base_path);
        assert!(error.contains("another mounted volume"), "{error}");
        assert_eq!(fs::read(tree.join("inner/mounted")).unwrap(), OLD);
        assert_eq!(fs::read(tree.join("entry")).unwrap(), OLD);
        isolated_mount("umount", &[tree.join("inner").as_os_str()]);
    }
}

/// rename(2) of a mount point is EBUSY; a bind mount point even keeps its
/// parent's device, so only its mount id reveals it.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn mount_point_endpoints_are_refused_before_any_record() {
    for destination in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        let (left, right, elsewhere) = (
            base_path.join("left"),
            base_path.join("right"),
            base_path.join("elsewhere"),
        );
        for directory in [&left, &right, &elsewhere] {
            fs::create_dir(directory).unwrap();
        }
        fs::write(elsewhere.join("entry"), OLD).unwrap();
        let (source, target) = (left.join("source"), right.join("target"));
        let mounted = if destination { &target } else { &source };
        if destination {
            fs::write(&source, MOVED).unwrap();
        }
        fs::create_dir(mounted).unwrap();
        isolated_mount(
            "mount",
            &[
                "--bind".as_ref(),
                elsewhere.as_os_str(),
                mounted.as_os_str(),
            ],
        );
        let error = refused_move(&source, &target, &base_path);
        assert!(error.contains("is a mount point"), "{error}");
        assert_eq!(fs::read(mounted.join("entry")).unwrap(), OLD);
        if destination {
            assert_eq!(fs::read(&source).unwrap(), MOVED);
        } else {
            assert!(!target.exists());
        }
        isolated_mount("umount", &[mounted.as_os_str()]);
    }
}

#[test]
fn an_automatic_retirement_that_cannot_start_is_reported_once_and_left_for_a_retry() {
    if running_as_root() {
        return;
    }
    let f = Fixture::new(true, false, false);
    f.restore();
    // Undo retained the published copy; its root no longer permits removal.
    let root = f.roots[1].clone();
    assert!(root.join("publication").exists());
    set_mode(&root, 0o500);
    retirement::enforce(&f.coordinator).unwrap();
    let after_first = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    let after_passes = generation(&f);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    set_mode(&root, 0o700);
    assert_eq!(
        after_passes, after_first,
        "enforcement re-claimed an automatic retirement that cannot start"
    );
    let item = &snapshot.items[0];
    assert!(item.message.contains("could not start"), "{}", item.message);
    assert!(
        item.message.contains("Permission denied"),
        "{}",
        item.message
    );
    assert_eq!(item.actions, vec![RecoveryChoice::Discard]);
    assert!(root.join("publication").exists());
    // The user's explicit retry, after the condition is fixed, finishes it.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
    assert_eq!(fs::read(&f.source).unwrap(), MOVED);
}

#[test]
fn forget_names_the_folders_that_still_hold_files() {
    // Stopped between roots: the source root is gone, the target root keeps
    // the displaced original.
    let f = Fixture::new(true, true, false);
    let stopped = f.retirement().retire_with(|label| match label {
        "source-completed" => Err(invalid("stopped between roots")),
        _ => Ok(()),
    });
    assert!(stopped.is_err());
    assert!(!f.roots[0].exists(), "the source root was removed");
    assert_eq!(fs::read(f.roots[1].join("original")).unwrap(), OLD);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.actions.contains(&RecoveryChoice::Release));
    let target_root = f.roots[1].to_string_lossy().into_owned();
    assert_eq!(item.retained_paths, vec![target_root.clone()]);
    assert_eq!(
        item.retained_path.as_deref(),
        Some(target_root.as_str()),
        "Forget's confirmation names a folder that no longer exists"
    );
    assert!(
        item.message.contains("the listed folder"),
        "{}",
        item.message
    );
    // A root already in Removing is no longer presented as retained. Its
    // cleanup owns that location; Forget names only roots still awaiting it.
    let f = partially_retired(false);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.actions.contains(&RecoveryChoice::Release));
    let target_root = f.roots[1].to_string_lossy().into_owned();
    assert_eq!(item.retained_paths, vec![target_root]);
    assert!(f.roots.iter().all(|root| root.exists()));
    assert!(
        item.message.contains("the listed folder"),
        "{}",
        item.message
    );
}

#[test]
fn an_unobservable_retiring_record_is_never_claimed_by_enforcement() {
    let f = partially_retired(true);
    // The source root's volume directory is replaced by another object, as
    // when a different filesystem is mounted where the recorded one was.
    let parent = f.roots[0].parent().unwrap().to_path_buf();
    let away = parent.with_extension("away");
    fs::rename(&parent, &away).unwrap();
    fs::create_dir(&parent).unwrap();
    let before = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert_eq!(
        generation(&f),
        before,
        "enforcement claimed a retirement whose anchors it could not observe"
    );
    let parked = away.join(f.roots[0].file_name().unwrap()).join("parked");
    assert!(parked.is_dir(), "retained bytes were touched while away");
    // Once the recorded volume is back, the interrupted retirement resumes.
    fs::remove_dir(&parent).unwrap();
    fs::rename(&away, &parent).unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 0);
    f.assert_retired();
}

#[test]
fn a_root_that_drifts_from_its_plan_while_planning_keeps_undo() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("dir/sub")).unwrap();
        fs::write(source.join("dir/sub/planned"), MOVED).unwrap();
    });
    let revision = effect_revision(&f);
    // Deep inside the retained payload, so the payload's own version, which
    // proves the endpoint, is unchanged: only the captured plan can see it.
    let foreign = f.roots[0].join("parked/dir/sub/foreign");
    let result = f.retirement().retire_with(|label| {
        if label == "planned" {
            fs::write(&foreign, b"written while the discard was planned")?;
        }
        Ok(())
    });
    assert!(result.is_err(), "a drifted root was discarded");
    assert_eq!(
        fs::read(&foreign).unwrap(),
        b"written while the discard was planned"
    );
    assert_eq!(
        fs::read(f.roots[0].join("parked/dir/sub/planned")).unwrap(),
        MOVED
    );
    // No decision was journaled, so Undo returns the whole entry.
    let operation = f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap_or_else(|error| panic!("Undo was consumed: {error}"))
        .unwrap();
    MoveExecution::reopen(operation)
        .unwrap()
        .restore_move()
        .unwrap();
    assert_eq!(fs::read(f.source.join("dir/sub/planned")).unwrap(), MOVED);
    assert!(f.source.join("dir/sub/foreign").is_file());
    assert!(!f.target.exists());
}

#[test]
fn a_deferral_recorded_before_its_measurement_still_waits_for_a_retry() {
    let f = Fixture::new(true, false, false);
    f.restore();
    // Deferral and measurement are separate journal writes; this process
    // stopped between them, so nothing records the retained size.
    let mut operation = f.claim();
    operation
        .advance_move(MoveTransition::DeferRetirement(
            "Permission denied (os error 13)".into(),
        ))
        .unwrap();
    drop(operation);
    let before = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert!(
        !f.coordinator.inventory().unwrap().entries.is_empty(),
        "enforcement retried a deferred cleanup without being asked"
    );
    assert_eq!(
        generation(&f),
        before,
        "enforcement claimed a deferred cleanup"
    );
    assert!(f.roots[1].join("publication").exists());
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}

// --- Mount boundaries inside retained payloads (#760, PR #790 review N1) ---

#[test]
fn cleanup_mount_identity_refuses_same_device_bind_mounts_when_statx_is_available() {
    use crate::files::recovery::move_cleanup::mount_ids_match;
    assert!(mount_ids_match(Some(17), Some(17)));
    assert!(!mount_ids_match(Some(17), Some(23)));
    // Unsupported statx falls back to the existing device comparison.
    assert!(mount_ids_match(None, Some(23)));
    assert!(mount_ids_match(Some(17), None));
}

/// Discard the only record, as the File Recovery dialog would.
fn discard_only_record(coordinator: &Arc<Coordinator>) -> Option<String> {
    let id = coordinator.inventory().unwrap().entries[0]
        .intent
        .id
        .clone();
    let snapshot = service::inspect(coordinator, &id).unwrap();
    service::resolve(
        coordinator,
        &id,
        snapshot.items[0].generation,
        RecoveryChoice::Discard,
    )
    .unwrap()
    .error
}

fn device(path: &std::path::Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).unwrap().dev()
}

/// A bind mount of the payload's own filesystem keeps its device, so only its
/// mount id shows that a walk would leave the payload. Admission once walked
/// into it, and Discard then unlinked the bind source's files, outside the
/// payload, before the final rmdir failed with EBUSY. Requires the isolated
/// namespace documented in e2e-tauri/README.md.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn a_bind_mount_inside_a_payload_is_refused_before_any_record() {
    for overwrite_only in [false, true] {
        let base = tempfile::tempdir().unwrap();
        let shared = tempfile::tempdir_in("/dev/shm").unwrap();
        let base_path = fs::canonicalize(base.path()).unwrap();
        let shared_path = fs::canonicalize(shared.path()).unwrap();
        // Cross volume: the source tree would be parked. Same volume with an
        // overwrite: the displaced destination tree would be retained. The
        // bind source always lives on the retained tree's own filesystem.
        let home = if overwrite_only {
            &base_path
        } else {
            &shared_path
        };
        let data = home.join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("precious"), OLD).unwrap();
        let (source, target) = (home.join("source"), base_path.join("target"));
        let tree = if overwrite_only { &target } else { &source };
        if overwrite_only {
            fs::write(&source, MOVED).unwrap();
        }
        fs::create_dir_all(tree.join("inner")).unwrap();
        fs::write(tree.join("entry"), OLD).unwrap();
        let inner = tree.join("inner");
        isolated_mount(
            "mount",
            &["--bind".as_ref(), data.as_os_str(), inner.as_os_str()],
        );
        assert_eq!(
            device(&inner),
            device(tree),
            "a bind mount keeps its device"
        );
        let coordinator = Coordinator::open(&base_path.join("recovery")).unwrap();
        let mut progress =
            crate::progress::ProgressTracker::new(None, "move", "cancelled", 0, 0, None);
        match PreparedMove::prepare(&coordinator, &source, &target)
            .and_then(|prepared| prepared.execute(&mut progress))
        {
            Ok(_) => {
                let discard = discard_only_record(&coordinator);
                panic!(
                    "overwrite_only={overwrite_only}: a payload holding a bind mount was \
                     admitted; after Discard ({discard:?}) the bind source still holds its \
                     file: {}",
                    data.join("precious").exists()
                );
            }
            Err(error) => {
                let error = error.to_string();
                assert!(error.contains("Nothing was moved"), "{error}");
                assert!(error.contains("'inner'"), "{error}");
                assert!(error.contains("mount point"), "{error}");
            }
        }
        assert!(coordinator.inventory().unwrap().entries.is_empty());
        assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
        assert_eq!(fs::read(inner.join("precious")).unwrap(), OLD);
        assert_eq!(fs::read(tree.join("entry")).unwrap(), OLD);
        assert!(private_residue(source.parent().unwrap()).is_empty());
        assert!(private_residue(target.parent().unwrap()).is_empty());
        isolated_mount("umount", &[inner.as_os_str()]);
    }
}

/// A cross-volume move whose destination is bind-mounted into after the move.
/// Undo would park the destination, bind mount and all, as `publication`.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn undo_refuses_a_destination_that_holds_a_bind_mount() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("inner")).unwrap();
        fs::write(source.join("entry"), MOVED).unwrap();
    });
    let data = f.target.parent().unwrap().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("precious"), OLD).unwrap();
    let inner = f.target.join("inner");
    isolated_mount(
        "mount",
        &["--bind".as_ref(), data.as_os_str(), inner.as_os_str()],
    );
    assert_eq!(device(&inner), device(&f.target));
    let revision = effect_revision(&f);
    match history_undo(&f, revision) {
        Ok(()) => {
            let discard = discard_only_record(&f.coordinator);
            panic!(
                "Undo parked a destination holding a bind mount; after Discard \
                 ({discard:?}) the bind source still holds its file: {}",
                data.join("precious").exists()
            );
        }
        Err(error) => {
            assert!(!matches!(error, AppError::MutationUncertain(_)), "{error}");
            let error = error.to_string();
            assert!(error.contains("Nothing was changed"), "{error}");
            assert!(error.contains("'inner'"), "{error}");
            assert!(error.contains("mount point"), "{error}");
            assert!(!error.contains("too large"), "{error}");
        }
    }
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
    assert_eq!(fs::read(inner.join("precious")).unwrap(), OLD);
    assert_eq!(fs::read(f.target.join("entry")).unwrap(), MOVED);
    assert!(!f.source.exists(), "the source stayed parked");
    assert!(f
        .coordinator
        .try_claim_history(&f.id, revision, HistoryPosition::Published)
        .unwrap()
        .is_some());
    // Unmounted, the same Undo succeeds.
    isolated_mount("umount", &[inner.as_os_str()]);
    history_undo(&f, revision).unwrap();
    assert_eq!(fs::read(f.source.join("entry")).unwrap(), MOVED);
    assert!(!f.target.exists());
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
}

/// A mount inside a payload already retained in a private root: at Discard,
/// planning must refuse it; once the decision is journaled, removal must stop
/// before deleting anything beneath it.
#[test]
#[ignore = "requires an isolated user/mount namespace; see e2e-tauri/README.md"]
fn discard_never_removes_files_through_a_mount_inside_a_retained_payload() {
    use crate::files::recovery::coordinator::HistoryPosition;
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("inner")).unwrap();
        fs::write(source.join("inner/planned"), MOVED).unwrap();
    });
    let parked = f.roots[0].join("parked");
    let inner = parked.join("inner");
    // The bind source shares the parked payload's filesystem.
    let data = f.source.parent().unwrap().join("data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("precious"), OLD).unwrap();
    isolated_mount(
        "mount",
        &["--bind".as_ref(), data.as_os_str(), inner.as_os_str()],
    );
    assert_eq!(device(&inner), device(&parked));
    let revision = effect_revision(&f);
    let refused = discard_only_record(&f.coordinator);
    let survived = data.join("precious").exists();
    isolated_mount("umount", &[inner.as_os_str()]);
    assert!(
        survived,
        "Discard deleted the bind source's file ({refused:?})"
    );
    let refused = refused.expect("a payload holding a mount was discarded");
    assert!(refused.contains("mount point"), "{refused}");
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
    assert_eq!(fs::read(inner.join("planned")).unwrap(), MOVED);
    assert!(
        f.coordinator
            .try_claim_history(&f.id, revision, HistoryPosition::Published)
            .unwrap()
            .is_some(),
        "Discard consumed Undo although it removed nothing"
    );
    // A mount that appears after the decision, before this root's removal:
    // here the planned directory bound onto itself, so every recorded
    // identity still matches and only its mount shows the crossing.
    let result = f.retirement().retire_with(|label| {
        if label == "source-intent" {
            isolated_mount(
                "mount",
                &["--bind".as_ref(), inner.as_os_str(), inner.as_os_str()],
            );
        }
        Ok(())
    });
    let beneath = fs::read(inner.join("planned")).ok();
    isolated_mount("umount", &[inner.as_os_str()]);
    assert!(result.is_err(), "removal crossed a mount");
    assert_eq!(
        beneath.as_deref(),
        Some(MOVED),
        "removal deleted files beneath a mount point"
    );
    // Unmounted, the reported discard can be retried to completion.
    assert_eq!(discard_only_record(&f.coordinator), None);
    f.assert_retired();
    assert_eq!(fs::read(data.join("precious")).unwrap(), OLD);
}

// --- Enforcement only claims what it can observe (PR #790 review N5) ---

/// Rename an artifact root's parent away, so its recorded identity can no
/// longer be opened. Returns the path to rename it back from.
fn hide_parent(root: &std::path::Path) -> PathBuf {
    let parent = root.parent().unwrap().to_path_buf();
    let away = parent.with_extension("away");
    fs::rename(&parent, &away).unwrap();
    fs::create_dir(&parent).unwrap();
    away
}

fn restore_parent(root: &std::path::Path, away: &std::path::Path) {
    let parent = root.parent().unwrap();
    fs::remove_dir(parent).unwrap();
    fs::rename(away, parent).unwrap();
}

#[test]
fn enforcement_claims_an_unmeasured_settled_move_only_once_it_can_observe_it() {
    if running_as_root() {
        return;
    }
    for restored in [false, true] {
        let f = Fixture::new(true, false, false);
        if restored {
            f.restore();
        }
        let unmeasured = || {
            f.coordinator.inventory().unwrap().entries[0]
                .state
                .as_ref()
                .unwrap()
                .move_state()
                .unwrap()
                .retained_bytes
                .is_none()
        };
        assert!(unmeasured());
        let before = generation(&f);
        // An artifact root this user cannot open: nothing can be measured or
        // removed, so claiming it would only advance its generation.
        let root = f.roots[1].clone();
        set_mode(&root, 0o000);
        for _ in 0..3 {
            retirement::enforce(&f.coordinator).unwrap();
        }
        let after_unreadable = generation(&f);
        set_mode(&root, 0o700);
        // An artifact parent whose recorded identity is away.
        let away = hide_parent(&f.roots[0]);
        for _ in 0..3 {
            retirement::enforce(&f.coordinator).unwrap();
        }
        let after_away = generation(&f);
        restore_parent(&f.roots[0], &away);
        assert_eq!(
            (after_unreadable, after_away),
            (before, before),
            "restored={restored}: enforcement claimed a record it could not observe"
        );
        assert!(unmeasured());
        // Observable again, it is claimed once: an automatic discard reclaims
        // it, and an explicit-only record is measured and then left alone.
        retirement::enforce(&f.coordinator).unwrap();
        if restored {
            f.assert_retired();
            assert_eq!(fs::read(&f.source).unwrap(), MOVED);
        } else {
            assert!(!unmeasured());
            let measured = generation(&f);
            for _ in 0..3 {
                retirement::enforce(&f.coordinator).unwrap();
            }
            assert_eq!(generation(&f), measured);
        }
    }
}

#[test]
fn a_claimed_automatic_discard_whose_root_cannot_be_opened_waits_for_a_retry() {
    if running_as_root() {
        return;
    }
    let f = Fixture::new(true, false, false);
    f.restore();
    let root = f.roots[1].clone();
    assert!(root.join("publication").exists());
    // The root became unopenable after enforcement chose to claim it.
    set_mode(&root, 0o000);
    let _ = retirement::settle(&f.coordinator, &f.id, generation(&f));
    set_mode(&root, 0o700);
    let claimed = generation(&f);
    for _ in 0..3 {
        retirement::enforce(&f.coordinator).unwrap();
    }
    assert!(
        !f.coordinator.inventory().unwrap().entries.is_empty(),
        "a discard that could not start was retried without being asked"
    );
    assert_eq!(generation(&f), claimed, "enforcement claimed it again");
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert!(item.message.contains("could not start"), "{}", item.message);
    assert!(
        item.message.contains("Permission denied"),
        "{}",
        item.message
    );
    assert_eq!(item.actions, vec![RecoveryChoice::Discard]);
    let reply = service::resolve(
        &f.coordinator,
        &f.id,
        item.generation,
        RecoveryChoice::Discard,
    )
    .unwrap();
    assert!(reply.error.is_none(), "{:?}", reply.error);
    f.assert_retired();
}

// --- Undo names why it cannot keep a destination (PR #790 review N6) ---

#[test]
fn undo_says_why_it_cannot_keep_the_destination() {
    if running_as_root() {
        return;
    }
    // Unreadable: a directory inside the destination this user cannot list.
    let f = Fixture::build(true, false, false, |source| {
        fs::create_dir_all(source.join("locked")).unwrap();
        fs::write(source.join("locked/entry"), MOVED).unwrap();
    });
    let revision = effect_revision(&f);
    set_mode(&f.target.join("locked"), 0o000);
    let unreadable = history_undo(&f, revision).unwrap_err().to_string();
    set_mode(&f.target.join("locked"), 0o700);
    assert!(unreadable.contains("'locked'"), "{unreadable}");
    assert!(unreadable.contains("cannot be read"), "{unreadable}");
    assert!(unreadable.contains("Permission denied"), "{unreadable}");
    assert!(unreadable.contains("Nothing was changed"), "{unreadable}");
    assert!(!unreadable.contains("too large"), "{unreadable}");
    // Grown past any retirement plan.
    let f = plannable_deep_move();
    let revision = effect_revision(&f);
    populate_deep(&deep(&f.target), 1_200..2_600);
    let grown = history_undo(&f, revision).unwrap_err().to_string();
    assert!(grown.contains("grown too large"), "{grown}");
    assert!(grown.contains("Nothing was changed"), "{grown}");
}
