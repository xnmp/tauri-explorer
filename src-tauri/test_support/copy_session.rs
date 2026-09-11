use super::*;
use crate::{files::recovery::Runtime, renderer_owner::Owner};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

fn block<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn native(root: &Path) -> NativeWork {
    native_with_runtime(root, Runtime::default())
}

fn native_with_runtime(root: &Path, runtime: Runtime) -> NativeWork {
    NativeWork {
        app: None,
        job_id: 9_001,
        recovery: (runtime, root.join("recovery")),
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

fn run_with(request: Request, work: impl Work, decisions: Vec<Decision>) -> (Outcome, Vec<Event>) {
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let events = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&events);
    let replies = Arc::new(Mutex::new(decisions.into_iter()));
    let outcome = block(run(request, Arc::clone(&control), work, move |event| {
        recorded.lock().unwrap().push(event.clone());
        if let Event::Conflict {
            item, ref nonce, ..
        } = event
        {
            if let Some(decision) = replies.lock().unwrap().next() {
                control.resolve(&owner, item, nonce, decision).unwrap();
            }
        }
        true
    }));
    let events = Arc::try_unwrap(events).unwrap().into_inner().unwrap();
    (outcome, events)
}

fn overwrite(apply_to_all: bool) -> Decision {
    Decision {
        choice: Choice::Overwrite,
        apply_to_all,
    }
}

fn skip(apply_to_all: bool) -> Decision {
    Decision {
        choice: Choice::Skip,
        apply_to_all,
    }
}

fn cancel() -> Decision {
    Decision {
        choice: Choice::Cancel,
        apply_to_all: false,
    }
}

#[test]
fn real_ordinary_prefix_and_replacement_commit_in_order() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let first = sources.join("first.txt");
    let second = sources.join("second.txt");
    fs::write(&first, b"ordinary").unwrap();
    fs::write(&second, b"replacement").unwrap();
    fs::write(destination.join("second.txt"), b"original").unwrap();

    let (outcome, events) = run_with(
        request(&[first, second], &destination),
        native(root.path()),
        vec![overwrite(false)],
    );

    assert_eq!(
        fs::read(destination.join("first.txt")).unwrap(),
        b"ordinary"
    );
    assert_eq!(
        fs::read(destination.join("second.txt")).unwrap(),
        b"replacement"
    );
    assert!(matches!(outcome.items[0], ItemOutcome::Succeeded { .. }));
    let ItemOutcome::Succeeded { receipt } = &outcome.items[1] else {
        panic!("replacement must succeed")
    };
    assert_eq!(
        receipt.replacement.is_some(),
        cfg!(feature = "durable-copy-recovery")
    );
    if !cfg!(feature = "durable-copy-recovery") {
        assert!(
            receipt.publication.is_some(),
            "staged overwrite retains exact ordinary-copy Undo authority"
        );
    }
    let order: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Event::Completed { item, .. } => Some(*item),
            _ => None,
        })
        .collect();
    assert_eq!(order, [0, 1]);
}

#[cfg(not(feature = "durable-copy-recovery"))]
#[test]
fn repeated_native_overwrites_retire_transient_recovery_records_and_keep_one_inverse() {
    use crate::file_history::{Action, ForwardEffect};

    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let source = sources.join("item.txt");
    let target = destination.join("item.txt");
    fs::write(&target, b"initial target").unwrap();
    let runtime = Runtime::default();

    // One more operation than the bounded journal permits proves completed
    // transient reservations are retired instead of accumulating forever.
    for revision in 0..=1_024_u32 {
        let bytes = revision.to_le_bytes();
        fs::write(&source, bytes).unwrap();
        let (outcome, _) = run_with(
            request(std::slice::from_ref(&source), &destination),
            native_with_runtime(root.path(), runtime.clone()),
            vec![overwrite(false)],
        );
        assert!(
            matches!(outcome.items[0], ItemOutcome::Succeeded { .. }),
            "overwrite {revision} failed: {:?}",
            outcome.items
        );
        let projected = crate::file_mutation::copy_session_outcome(
            outcome,
            destination.to_string_lossy().into_owned(),
        );
        assert!(matches!(projected.effect, ForwardEffect::Changed(Some(_))));
        if revision == 1_024 {
            assert!(matches!(
                projected.effect,
                ForwardEffect::Changed(Some(Action::Copy { .. }))
            ));
        }
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }

    let inventory = block(runtime.list(root.path().join("recovery"))).unwrap();
    assert!(inventory.items.is_empty());
}

#[cfg(not(feature = "durable-copy-recovery"))]
#[test]
fn native_overwrite_obeys_a_competing_runtime_admission() {
    use crate::files::recovery::{Access, ResourceRequest, Scope};

    for claimed in ["source", "target"] {
        let root = tempfile::tempdir().unwrap();
        let sources = root.path().join("sources");
        let destination = root.path().join("destination");
        fs::create_dir(&sources).unwrap();
        fs::create_dir(&destination).unwrap();
        let source = sources.join("item.txt");
        let target = destination.join("item.txt");
        fs::write(&source, b"new bytes").unwrap();
        fs::write(&target, b"original bytes").unwrap();
        let runtime = Runtime::default();
        let storage = root.path().join("recovery");
        let claimed_path = if claimed == "source" {
            &source
        } else {
            &target
        };
        let _competing = block(runtime.admit(
            storage.clone(),
            vec![ResourceRequest {
                path: claimed_path.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            }],
        ))
        .unwrap();

        let (outcome, _) = run_with(
            request(std::slice::from_ref(&source), &destination),
            native_with_runtime(root.path(), runtime.clone()),
            vec![overwrite(false)],
        );
        assert!(
            matches!(outcome.items[0], ItemOutcome::Failed { .. }),
            "competing {claimed} claim must reject overwrite"
        );
        assert_eq!(fs::read(source).unwrap(), b"new bytes");
        assert_eq!(fs::read(target).unwrap(), b"original bytes");
        assert!(block(runtime.list(storage)).unwrap().items.is_empty());
    }
}

#[test]
fn missing_first_duplicate_basename_does_not_create_a_phantom_conflict() {
    let root = tempfile::tempdir().unwrap();
    let missing_dir = root.path().join("missing-parent");
    let real_dir = root.path().join("real-parent");
    let destination = root.path().join("destination");
    fs::create_dir(&missing_dir).unwrap();
    fs::create_dir(&real_dir).unwrap();
    fs::create_dir(&destination).unwrap();
    let missing = missing_dir.join("same.txt");
    let real = real_dir.join("same.txt");
    fs::write(&real, b"real").unwrap();

    let (outcome, events) = run_with(
        request(&[missing, real], &destination),
        native(root.path()),
        Vec::new(),
    );

    assert!(matches!(outcome.items[0], ItemOutcome::Failed { .. }));
    assert!(matches!(outcome.items[1], ItemOutcome::Succeeded { .. }));
    assert_eq!(fs::read(destination.join("same.txt")).unwrap(), b"real");
    assert!(!events
        .iter()
        .any(|event| matches!(event, Event::Conflict { .. })));
}

#[test]
fn repeated_same_parent_requests_choose_distinct_copy_names() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("directory");
    fs::create_dir(&directory).unwrap();
    let source = directory.join("same.txt");
    fs::write(&source, b"same").unwrap();

    let (outcome, events) = run_with(
        request(&[source.clone(), source], &directory),
        native(root.path()),
        Vec::new(),
    );

    let paths: Vec<_> = outcome
        .items
        .iter()
        .map(|item| match item {
            ItemOutcome::Succeeded { receipt } => receipt.path.clone(),
            _ => panic!("both copies must succeed"),
        })
        .collect();
    assert_ne!(paths[0], paths[1]);
    assert!(paths.iter().all(|path| fs::read(path).unwrap() == b"same"));
    assert!(!events
        .iter()
        .any(|event| matches!(event, Event::Conflict { .. })));
}

#[test]
fn apply_to_all_is_used_only_for_later_real_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let paths: Vec<_> = ["first", "plain", "last"]
        .map(|name| {
            let path = sources.join(format!("{name}.txt"));
            fs::write(&path, name.as_bytes()).unwrap();
            path
        })
        .into_iter()
        .collect();
    fs::write(destination.join("first.txt"), b"old first").unwrap();
    fs::write(destination.join("last.txt"), b"old last").unwrap();

    let (outcome, events) = run_with(
        request(&paths, &destination),
        native(root.path()),
        vec![overwrite(true)],
    );

    assert!(outcome
        .items
        .iter()
        .all(|item| matches!(item, ItemOutcome::Succeeded { .. })));
    let prompts: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            Event::Conflict { item, .. } => Some(*item),
            _ => None,
        })
        .collect();
    assert_eq!(prompts, [0]);
    assert_eq!(fs::read(destination.join("plain.txt")).unwrap(), b"plain");
    assert_eq!(fs::read(destination.join("last.txt")).unwrap(), b"last");
}

#[test]
fn skip_continues_but_cancel_preserves_prefix_and_leaves_suffix_unstarted() {
    for (decision, cancelled) in [(skip(false), false), (cancel(), true)] {
        let root = tempfile::tempdir().unwrap();
        let sources = root.path().join("sources");
        let destination = root.path().join("destination");
        fs::create_dir(&sources).unwrap();
        fs::create_dir(&destination).unwrap();
        let paths: Vec<_> = ["prefix", "conflict", "suffix"]
            .map(|name| {
                let path = sources.join(format!("{name}.txt"));
                fs::write(&path, name.as_bytes()).unwrap();
                path
            })
            .into_iter()
            .collect();
        fs::write(destination.join("conflict.txt"), b"retained").unwrap();
        let (outcome, _) = run_with(
            request(&paths, &destination),
            native(root.path()),
            vec![decision],
        );
        assert!(matches!(outcome.items[0], ItemOutcome::Succeeded { .. }));
        assert!(matches!(
            outcome.items[1],
            ItemOutcome::Skipped | ItemOutcome::Unstarted
        ));
        assert_eq!(outcome.cancelled, cancelled);
        assert_eq!(fs::read(destination.join("prefix.txt")).unwrap(), b"prefix");
        assert_eq!(
            fs::read(destination.join("conflict.txt")).unwrap(),
            b"retained"
        );
        if cancelled {
            assert!(matches!(outcome.items[2], ItemOutcome::Unstarted));
            assert!(!destination.join("suffix.txt").exists());
        } else {
            assert!(matches!(outcome.items[2], ItemOutcome::Succeeded { .. }));
            assert_eq!(fs::read(destination.join("suffix.txt")).unwrap(), b"suffix");
        }
    }
}

#[test]
fn renderer_retirement_while_conflict_is_pending_cancels_without_effects() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let source = sources.join("conflict.txt");
    fs::write(&source, b"new").unwrap();
    fs::write(destination.join("conflict.txt"), b"old").unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let retired = owner.clone();

    let outcome = block(run(
        request(&[source], &destination),
        control,
        native(root.path()),
        move |event| {
            if matches!(event, Event::Conflict { .. }) {
                retired.retire();
            }
            true
        },
    ));

    assert!(outcome.cancelled);
    assert!(matches!(outcome.items[0], ItemOutcome::Unstarted));
    assert_eq!(fs::read(destination.join("conflict.txt")).unwrap(), b"old");
}

#[test]
fn source_change_while_conflict_is_pending_cannot_publish_new_bytes() {
    use std::fs::File;

    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let source = sources.join("conflict.txt");
    let target = destination.join("conflict.txt");
    fs::write(&source, b"observed source").unwrap();
    fs::write(&target, b"original target").unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let reply = Arc::clone(&control);
    let changed = source.clone();
    let reply_owner = owner.clone();

    let outcome =
        block(run(
            request(std::slice::from_ref(&source), &destination),
            control,
            native(root.path()),
            move |event| {
                if let Event::Conflict { item, nonce, .. } = event {
                    fs::write(&changed, b"changed source!").unwrap();
                    File::open(&changed)
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(
                            std::time::UNIX_EPOCH + std::time::Duration::from_secs(42),
                        ))
                        .unwrap();
                    reply
                        .resolve(&reply_owner, item, &nonce, overwrite(false))
                        .unwrap();
                }
                true
            },
        ));

    assert!(matches!(
        outcome.items[0],
        ItemOutcome::Failed { .. } | ItemOutcome::Uncertain { .. }
    ));
    assert_eq!(fs::read(target).unwrap(), b"original target");
    assert_eq!(fs::read(source).unwrap(), b"changed source!");
}

#[test]
fn target_substitution_while_conflict_is_pending_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let source = sources.join("conflict.txt");
    let target = destination.join("conflict.txt");
    fs::write(&source, b"source").unwrap();
    fs::write(&target, b"observed target").unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let reply = Arc::clone(&control);
    let changed = target.clone();
    let reply_owner = owner.clone();

    let outcome = block(run(
        request(&[source], &destination),
        control,
        native(root.path()),
        move |event| {
            if let Event::Conflict { item, nonce, .. } = event {
                fs::remove_file(&changed).unwrap();
                fs::write(&changed, b"new occupant").unwrap();
                reply
                    .resolve(&reply_owner, item, &nonce, overwrite(false))
                    .unwrap();
            }
            true
        },
    ));

    assert!(matches!(
        outcome.items[0],
        ItemOutcome::Failed { .. } | ItemOutcome::Uncertain { .. }
    ));
    assert_eq!(fs::read(target).unwrap(), b"new occupant");
}

#[test]
fn control_rejects_stale_item_nonce_duplicate_and_wrong_owner_replies() {
    let owner = Owner::default();
    let wrong = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let tested = Arc::clone(&control);
    let expected_owner = owner.clone();
    let decision = block(control.decide(
        4,
        Conflict {
            file_name: "x".into(),
            source_path: "/source/x".into(),
            remaining: 0,
            source_size: 1,
            source_modified: String::new(),
            dest_size: 1,
            dest_modified: String::new(),
        },
        &move |event| {
            let Event::Conflict { item, nonce, .. } = event else {
                return false;
            };
            assert!(tested
                .resolve(&wrong, item, &nonce, overwrite(false))
                .is_err());
            assert!(tested
                .resolve(&expected_owner, item + 1, &nonce, overwrite(false))
                .is_err());
            assert!(tested
                .resolve(&expected_owner, item, "0", overwrite(false))
                .is_err());
            tested
                .resolve(&expected_owner, item, &nonce, skip(false))
                .unwrap();
            assert!(tested
                .resolve(&expected_owner, item, &nonce, overwrite(false))
                .is_err());
            true
        },
    ));
    assert_eq!(decision.choice, Choice::Skip);
}

#[test]
fn reused_request_id_cannot_accept_the_previous_controls_nonce() {
    let owner = Owner::default();
    let first = Registration::new("reused-request".into(), owner.clone()).unwrap();
    let old_control = Arc::clone(&first.control);
    let old_nonce = Arc::new(Mutex::new(String::new()));
    let observed = Arc::clone(&old_nonce);
    let first_owner = owner.clone();
    let _ = block(first.control.decide(0, conflict(), &move |event| {
        let Event::Conflict { item, nonce, .. } = event else {
            return false;
        };
        *observed.lock().unwrap() = nonce.clone();
        old_control
            .resolve(&first_owner, item, &nonce, skip(false))
            .unwrap();
        true
    }));
    drop(first);
    let second = Registration::new("reused-request".into(), owner.clone()).unwrap();
    assert!(second
        .control
        .resolve(&owner, 0, &old_nonce.lock().unwrap(), overwrite(false))
        .is_err());
}

fn conflict() -> Conflict {
    Conflict {
        file_name: "x".into(),
        source_path: "/source/x".into(),
        remaining: 0,
        source_size: 1,
        source_modified: String::new(),
        dest_size: 1,
        dest_modified: String::new(),
    }
}

#[derive(Clone)]
struct PanicAfterFirst {
    native: NativeWork,
    copies: Arc<AtomicUsize>,
}

impl Work for PanicAfterFirst {
    async fn inspect(
        &self,
        source: String,
        destination: String,
        remaining: usize,
    ) -> Result<Inspection, AppError> {
        self.native.inspect(source, destination, remaining).await
    }

    async fn apply(
        &self,
        inspection: Inspection,
        overwrite: bool,
        control: Arc<Control>,
        progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    ) -> WorkerCompletion<FileMutationReceipt> {
        if self.copies.fetch_add(1, Ordering::SeqCst) == 1 {
            panic!("injected session panic");
        }
        self.native
            .apply(inspection, overwrite, control, progress)
            .await
    }
}

#[test]
fn orchestration_panic_after_a_real_copy_retains_the_completed_receipt() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let paths: Vec<_> = ["first", "second"]
        .map(|name| {
            let path = sources.join(format!("{name}.txt"));
            fs::write(&path, name.as_bytes()).unwrap();
            path
        })
        .into_iter()
        .collect();
    let work = PanicAfterFirst {
        native: native(root.path()),
        copies: Arc::new(AtomicUsize::new(0)),
    };

    let (outcome, _) = run_with(request(&paths, &destination), work, Vec::new());

    assert!(matches!(outcome.items[0], ItemOutcome::Succeeded { .. }));
    assert!(matches!(outcome.items[1], ItemOutcome::Uncertain { .. }));
    assert_eq!(fs::read(destination.join("first.txt")).unwrap(), b"first");
    assert!(!destination.join("second.txt").exists());
    assert!(outcome
        .warnings
        .iter()
        .any(|warning| warning.contains("session was interrupted")));
}

#[derive(Clone)]
struct InspectionFailures;

impl Work for InspectionFailures {
    async fn inspect(
        &self,
        source: String,
        _destination: String,
        _remaining: usize,
    ) -> Result<Inspection, AppError> {
        Err(AppError::Other(format!(
            "{source}: {}",
            "diagnostic-🧪".repeat(512)
        )))
    }

    async fn apply(
        &self,
        _inspection: Inspection,
        _overwrite: bool,
        _control: Arc<Control>,
        _progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    ) -> WorkerCompletion<FileMutationReceipt> {
        unreachable!("failed inspections cannot start copy work")
    }
}

#[test]
fn aggregate_item_diagnostics_are_bounded_and_report_omission() {
    let sources = (0..1_024)
        .map(|index| PathBuf::from(format!("/source/{index}")))
        .collect::<Vec<_>>();
    let (outcome, _) = run_with(
        request(&sources, Path::new("/destination")),
        InspectionFailures,
        Vec::new(),
    );

    let error_bytes = outcome
        .items
        .iter()
        .map(|item| match item {
            ItemOutcome::Failed { error } => error.len(),
            _ => panic!("every injected inspection must fail"),
        })
        .sum::<usize>();
    assert!(error_bytes <= 64 * 1_024);
    assert!(outcome
        .warnings
        .iter()
        .any(|warning| warning.contains("omitted")));
    assert!(!serde_json::to_vec(&outcome).unwrap().is_empty());
}

#[test]
fn concurrent_native_sessions_with_the_same_job_id_keep_progress_request_local() {
    let root = tempfile::tempdir().unwrap();
    let source_a = root.path().join("source-a");
    let source_b = root.path().join("source-b");
    let destination_a = root.path().join("destination-a");
    let destination_b = root.path().join("destination-b");
    fs::create_dir(&source_a).unwrap();
    fs::create_dir(&source_b).unwrap();
    fs::create_dir(&destination_a).unwrap();
    fs::create_dir(&destination_b).unwrap();
    let a = source_a.join("a.bin");
    let b0 = source_b.join("b0.bin");
    let b1 = source_b.join("b1.bin");
    fs::write(&a, vec![b'a'; 2 * 1_024 * 1_024]).unwrap();
    fs::write(&b0, vec![b'b'; 2 * 1_024 * 1_024]).unwrap();
    fs::write(&b1, vec![b'c'; 2 * 1_024 * 1_024]).unwrap();
    let events_a = Arc::new(Mutex::new(Vec::new()));
    let events_b = Arc::new(Mutex::new(Vec::new()));
    let recorded_a = events_a.clone();
    let recorded_b = events_b.clone();
    let control_a = Arc::new(Control::new(Owner::default()));
    let control_b = Arc::new(Control::new(Owner::default()));

    let (outcome_a, outcome_b) = block(async {
        tokio::join!(
            run(
                request(&[a], &destination_a),
                control_a,
                native(root.path()),
                move |event| {
                    recorded_a.lock().unwrap().push(event);
                    true
                }
            ),
            run(
                request(&[b0, b1], &destination_b),
                control_b,
                native(root.path()),
                move |event| {
                    recorded_b.lock().unwrap().push(event);
                    true
                }
            ),
        )
    });

    assert!(outcome_a
        .items
        .iter()
        .all(|item| matches!(item, ItemOutcome::Succeeded { .. })));
    assert!(outcome_b
        .items
        .iter()
        .all(|item| matches!(item, ItemOutcome::Succeeded { .. })));
    let progress_items = |events: &Mutex<Vec<Event>>| {
        events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                Event::Progress { item, progress } => {
                    assert_eq!(progress.job_id, 9_001);
                    Some(*item)
                }
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let a_items = progress_items(&events_a);
    let b_items = progress_items(&events_b);
    assert!(!a_items.is_empty() && a_items.iter().all(|item| *item == 0));
    assert!(b_items.contains(&0) && b_items.contains(&1));
}

#[test]
fn cancellation_from_first_native_progress_discards_active_copy_and_suffix() {
    let root = tempfile::tempdir().unwrap();
    let sources = root.path().join("sources");
    let destination = root.path().join("destination");
    fs::create_dir(&sources).unwrap();
    fs::create_dir(&destination).unwrap();
    let first = sources.join("first.bin");
    let suffix = sources.join("suffix.txt");
    fs::write(&first, vec![7; 4 * 1_024 * 1_024]).unwrap();
    fs::write(&suffix, b"suffix").unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let cancellation = control.clone();
    let cancel_owner = owner.clone();
    let progress_count = Arc::new(AtomicUsize::new(0));
    let observed = progress_count.clone();

    let outcome = block(run(
        request(&[first.clone(), suffix.clone()], &destination),
        control,
        native(root.path()),
        move |event| {
            if matches!(event, Event::Progress { item: 0, .. })
                && observed.fetch_add(1, Ordering::SeqCst) == 0
            {
                cancellation.cancel(&cancel_owner).unwrap();
            }
            true
        },
    ));

    assert!(progress_count.load(Ordering::SeqCst) >= 1);
    assert!(outcome.cancelled);
    assert!(matches!(outcome.items[0], ItemOutcome::Failed { .. }));
    assert!(matches!(outcome.items[1], ItemOutcome::Unstarted));
    assert!(!destination.join("first.bin").exists());
    assert!(!destination.join("suffix.txt").exists());
    assert_eq!(fs::metadata(first).unwrap().len(), 4 * 1_024 * 1_024);
    assert_eq!(fs::read(suffix).unwrap(), b"suffix");
}

#[test]
fn ordinary_tree_copy_preserves_nested_contents_modes_and_symlinks() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("tree");
    let destination = root.path().join("destination");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::create_dir(&destination).unwrap();
    for index in 0..100 {
        fs::write(
            source.join("nested").join(format!("file-{index}")),
            format!("content {index}"),
        )
        .unwrap();
    }
    fs::set_permissions(
        source.join("nested/file-0"),
        fs::Permissions::from_mode(0o751),
    )
    .unwrap();
    symlink("nested/file-0", source.join("link")).unwrap();
    let (outcome, _) = run_with(
        request(std::slice::from_ref(&source), &destination),
        native(root.path()),
        vec![],
    );
    assert!(matches!(outcome.items[0], ItemOutcome::Succeeded { .. }));
    for index in 0..100 {
        assert_eq!(
            fs::read_to_string(
                destination
                    .join("tree/nested")
                    .join(format!("file-{index}"))
            )
            .unwrap(),
            format!("content {index}")
        );
    }
    assert_eq!(
        fs::metadata(destination.join("tree/nested/file-0"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o751
    );
    assert_eq!(
        fs::read_link(destination.join("tree/link")).unwrap(),
        PathBuf::from("nested/file-0")
    );
    assert_eq!(
        fs::read_to_string(source.join("nested/file-0")).unwrap(),
        "content 0"
    );
}
