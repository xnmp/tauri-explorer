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
            let mut hit = false;
            let result = f.retirement().retire_with(|label| {
                if label == *boundary && !hit {
                    hit = true;
                    return Err(invalid("injected interruption"));
                }
                Ok(())
            });
            assert!(hit && result.is_err(), "{boundary}");
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
    assert!(f
        .retirement()
        .retire_with(|label| {
            if label == "source-intent" {
                return Err(invalid("interrupted before any unlink"));
            }
            Ok(())
        })
        .is_err());
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
        assert!(f
            .retirement()
            .retire_with(|label| {
                if label == boundary {
                    fs::write(&f.target, b"changed during cleanup")?;
                    return Err(invalid("interrupted cleanup"));
                }
                Ok(())
            })
            .is_err());
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
    assert!(f
        .retirement()
        .retire_with(|label| {
            if label == "entry-removed" {
                return Err(invalid("interrupted inside tree"));
            }
            Ok(())
        })
        .is_err());
    assert!(parked.is_dir());
    fs::write(parked.join("foreign"), b"new user bytes").unwrap();
    assert_eq!(retirement::enforce(&f.coordinator).unwrap().records, 1);
    assert_eq!(fs::read(parked.join("foreign")).unwrap(), b"new user bytes");
    assert_eq!(fs::read(f.roots[1].join("original/entry")).unwrap(), OLD);
}

#[test]
fn partial_tree_removal_resumes_without_a_foreign_descendant() {
    let f = Fixture::new(true, true, true);
    assert!(f
        .retirement()
        .retire_with(|label| {
            if label == "entry-removed" {
                return Err(invalid("interrupted inside tree"));
            }
            Ok(())
        })
        .is_err());
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
    assert!(f
        .retirement()
        .retire_with(|label| {
            if label == "source-completed" {
                return Err(invalid("interrupt between roots"));
            }
            Ok(())
        })
        .is_err());
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
    assert!(f
        .retirement()
        .retire_with(|label| {
            if label == "source-intent" {
                return Err(invalid("interrupted before unlink"));
            }
            Ok(())
        })
        .is_err());
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
    assert!(f
        .retirement()
        .retire_with(|label| {
            if label == "source-completed" {
                return Err(invalid("interrupted between roots"));
            }
            Ok(())
        })
        .is_err());
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
    // While the committed plan cannot be proven, nothing is offered.
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert_eq!(item.status, "attention", "{}", item.message);
    assert!(item.message.contains("Discard stopped"), "{}", item.message);
    assert!(item.actions.is_empty());
    // Once the user restores it, the failure is still called out, with a retry.
    set_mode(&pkg, 0o755);
    let snapshot = service::inspect(&f.coordinator, &f.id).unwrap();
    let item = &snapshot.items[0];
    assert_eq!(item.status, "attention", "{}", item.message);
    assert!(item.message.contains("Discard stopped"), "{}", item.message);
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
