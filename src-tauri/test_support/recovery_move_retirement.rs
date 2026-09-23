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
        let base = tempfile::tempdir().unwrap();
        let shared = cross.then(|| tempfile::tempdir_in("/dev/shm").unwrap());
        let source = fs::canonicalize(shared.as_ref().unwrap_or(&base).path())
            .unwrap()
            .join("source");
        let target = fs::canonicalize(base.path()).unwrap().join("target");
        if directory {
            fs::create_dir(&source).unwrap();
            fs::write(source.join("entry"), MOVED).unwrap();
        } else {
            fs::write(&source, MOVED).unwrap();
        }
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
