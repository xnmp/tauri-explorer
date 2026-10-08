use super::*;
use crate::{
    file_history::{Action, ForwardEffect},
    file_mutation::{copy_session_outcome, move_session_outcome},
    renderer_owner::Owner,
};
use std::{
    fs,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Copy, Debug)]
enum Effect {
    Copy,
    Move,
}

fn inverse_targets(action: &Action) -> Vec<String> {
    match action {
        Action::Copy { copied_path, .. } => vec![copied_path.clone()],
        Action::Move { dest_path, .. } => vec![dest_path.clone()],
        Action::Replacement { path, .. } => vec![path.clone()],
        Action::Batch { actions, .. } => actions.iter().flat_map(inverse_targets).collect(),
        other => panic!("unexpected session inverse: {other:?}"),
    }
}

enum NativeSessionWork {
    Copy(NativeWork),
    Move(crate::files::move_session::MoveWork),
}

impl Work for NativeSessionWork {
    async fn inspect(
        &self,
        source: String,
        destination: String,
        remaining: usize,
    ) -> Result<Inspection, AppError> {
        match self {
            Self::Copy(work) => work.inspect(source, destination, remaining).await,
            Self::Move(work) => work.inspect(source, destination, remaining).await,
        }
    }

    async fn apply(
        &self,
        inspection: Inspection,
        overwrite: bool,
        control: Arc<Control>,
        progress: Arc<dyn Fn(crate::progress::ByteProgress) + Send + Sync>,
    ) -> WorkerCompletion<FileMutationReceipt> {
        match self {
            Self::Copy(work) => work.apply(inspection, overwrite, control, progress).await,
            Self::Move(work) => work.apply(inspection, overwrite, control, progress).await,
        }
    }
}

fn boundaries(item: usize) -> [SessionBoundary; 6] {
    [
        SessionBoundary::InspectionCompleted { item },
        SessionBoundary::BeforeStart { item },
        SessionBoundary::StartedPublished { item },
        SessionBoundary::ApplyCompleted { item },
        SessionBoundary::ReceiptRetained { item },
        SessionBoundary::CompletedPublished { item },
    ]
}

fn native_move_work(root: &std::path::Path) -> crate::files::move_session::MoveWork {
    crate::files::move_session::MoveWork {
        job_id: 802,
        runtime: crate::files::admission::Runtime::new(root.join("recovery")),
    }
}

fn native_copy_work(root: &std::path::Path) -> NativeWork {
    let _ = root;
    NativeWork {
        app: None,
        job_id: 802,
        #[cfg(target_os = "linux")]
        runtime: crate::files::recovery::Runtime::new(root.join("recovery")),
    }
}

async fn cancel_at(effect: Effect, target_boundary: SessionBoundary) {
    let root = tempfile::tempdir().unwrap();
    let source_dir = root.path().join("source");
    let destination = root.path().join("destination");
    fs::create_dir(&source_dir).unwrap();
    fs::create_dir(&destination).unwrap();
    let target_item = match target_boundary {
        SessionBoundary::ReadyPublished => 0,
        SessionBoundary::InspectionCompleted { item }
        | SessionBoundary::BeforeStart { item }
        | SessionBoundary::StartedPublished { item }
        | SessionBoundary::ApplyCompleted { item }
        | SessionBoundary::ReceiptRetained { item }
        | SessionBoundary::CompletedPublished { item } => item,
    };
    let count = if target_item == 0 { 1 } else { 3 };
    let sources: Vec<_> = (0..count)
        .map(|item| source_dir.join(format!("item-{item}.txt")))
        .collect();
    let targets: Vec<_> = (0..count)
        .map(|item| destination.join(format!("item-{item}.txt")))
        .collect();
    for (item, source) in sources.iter().enumerate() {
        fs::write(source, format!("payload-{item}")).unwrap();
    }

    let source_spelling: Vec<_> = sources
        .iter()
        .map(|source| source.to_string_lossy().into_owned())
        .collect();
    let destination_spelling = destination.to_string_lossy().into_owned();
    let request = Request::new(source_spelling.clone(), destination_spelling.clone()).unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let (reached, mut boundaries) = mpsc::unbounded_channel();
    let events = Arc::new(Mutex::new(Vec::<(char, usize)>::new()));
    let recorded_events = Arc::clone(&events);
    let work = match effect {
        Effect::Copy => NativeSessionWork::Copy(native_copy_work(root.path())),
        Effect::Move => NativeSessionWork::Move(native_move_work(root.path())),
    };
    let task = tauri::async_runtime::spawn(run_with_observer(
        request,
        Arc::clone(&control),
        work,
        move |event| {
            let observed = match event {
                Event::Started { item, .. } => Some(('S', item)),
                Event::Progress { item, .. } => Some(('P', item)),
                Event::Completed { item, .. } => Some(('C', item)),
                _ => None,
            };
            if let Some(observed) = observed {
                recorded_events.lock().unwrap().push(observed);
            }
            true
        },
        move |boundary| {
            let reached = reached.clone();
            async move {
                let (release, released) = oneshot::channel();
                reached.send((boundary, release)).unwrap();
                released.await.unwrap();
            }
        },
    ));

    let mut cancelled = false;
    while let Some((boundary, release)) = boundaries.recv().await {
        if boundary == target_boundary && !cancelled {
            control.cancel(&owner).unwrap();
            cancelled = true;
        }
        release.send(()).unwrap();
    }
    assert!(cancelled, "session never reached {target_boundary:?}");
    let outcome = task.await.unwrap();
    assert!(outcome.cancelled);

    let committed = matches!(
        target_boundary,
        SessionBoundary::ApplyCompleted { .. }
            | SessionBoundary::ReceiptRetained { .. }
            | SessionBoundary::CompletedPublished { .. }
    );
    assert_eq!(outcome.items.len(), count);
    for (item, (source, target)) in sources.iter().zip(&targets).enumerate() {
        let item_committed = item < target_item || (item == target_item && committed);
        assert_eq!(
            matches!(outcome.items[item], ItemOutcome::Succeeded { .. }),
            item_committed,
            "{effect:?} at {target_boundary:?}, item {item}"
        );
        if item_committed {
            assert_eq!(
                fs::read(target).unwrap(),
                format!("payload-{item}").as_bytes()
            );
        } else {
            assert!(!target.exists(), "unstarted item {item} published late");
            assert!(matches!(outcome.items[item], ItemOutcome::Unstarted));
        }
        let source_remains = !item_committed || matches!(effect, Effect::Copy);
        assert_eq!(
            source.exists(),
            source_remains,
            "source residue at item {item}"
        );
        if source_remains {
            assert_eq!(
                fs::read(source).unwrap(),
                format!("payload-{item}").as_bytes()
            );
        }
    }

    let all_events = events.lock().unwrap().clone();
    assert!(
        all_events.iter().all(|(_, item)| *item <= target_item),
        "suffix published an event after cancellation: {all_events:?}"
    );
    let observed: Vec<_> = all_events
        .into_iter()
        .filter(|(kind, _)| *kind != 'P')
        .collect();
    let mut expected: Vec<_> = (0..target_item)
        .flat_map(|item| [('S', item), ('C', item)])
        .collect();
    if matches!(
        target_boundary,
        SessionBoundary::StartedPublished { .. }
            | SessionBoundary::ApplyCompleted { .. }
            | SessionBoundary::ReceiptRetained { .. }
            | SessionBoundary::CompletedPublished { .. }
    ) {
        expected.push(('S', target_item));
    }
    if committed {
        expected.push(('C', target_item));
    }
    assert_eq!(
        observed, expected,
        "unexpected event publication after cancellation"
    );

    let projected = match effect {
        Effect::Copy => copy_session_outcome(outcome, destination_spelling),
        Effect::Move => move_session_outcome(outcome, &source_spelling, destination_spelling),
    };
    let inverse_paths = match projected.effect {
        ForwardEffect::Unchanged => Vec::new(),
        ForwardEffect::Changed(Some(action)) => inverse_targets(&action),
        _ => panic!("missing inverse for committed session"),
    };
    let expected_paths: Vec<_> = targets
        .iter()
        .take(target_item + usize::from(committed))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        inverse_paths, expected_paths,
        "history must identify exactly the committed filesystem effects"
    );
}

#[test]
fn copy_cancellation_at_every_session_boundary_has_exact_residue_and_history() {
    tauri::async_runtime::block_on(async {
        cancel_at(Effect::Copy, SessionBoundary::ReadyPublished).await;
        for boundary in boundaries(0).into_iter().chain(boundaries(1)) {
            cancel_at(Effect::Copy, boundary).await;
        }
    });
}

#[test]
fn move_cancellation_at_every_session_boundary_has_exact_residue_and_history() {
    tauri::async_runtime::block_on(async {
        cancel_at(Effect::Move, SessionBoundary::ReadyPublished).await;
        for boundary in boundaries(0).into_iter().chain(boundaries(1)) {
            cancel_at(Effect::Move, boundary).await;
        }
    });
}

#[test]
fn native_move_worker_rejects_cancellation_before_entry() {
    let root = tempfile::tempdir().unwrap();
    let source_dir = root.path().join("source");
    let destination = root.path().join("destination");
    fs::create_dir(&source_dir).unwrap();
    fs::create_dir(&destination).unwrap();
    let source = source_dir.join("item.txt");
    let target = destination.join("item.txt");
    fs::write(&source, b"payload").unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    control.cancel(&owner).unwrap();
    let inspection = Inspection {
        source: source.to_string_lossy().into_owned(),
        destination: destination.to_string_lossy().into_owned(),
        presentation: destination.to_string_lossy().into_owned(),
        conflict: None,
        bytes: 7,
        #[cfg(target_os = "linux")]
        observation: None,
    };

    let completion = tauri::async_runtime::block_on(native_move_work(root.path()).apply(
        inspection,
        false,
        control,
        Arc::new(|_| {}),
    ));

    assert!(completion.result.is_err());
    assert_eq!(fs::read(source).unwrap(), b"payload");
    assert!(!target.exists());
}

#[test]
fn native_copy_and_move_cancel_at_the_real_conflict_pause_without_effects() {
    for effect in [Effect::Copy, Effect::Move] {
        let root = tempfile::tempdir().unwrap();
        let source_dir = root.path().join("source");
        let destination = root.path().join("destination");
        fs::create_dir(&source_dir).unwrap();
        fs::create_dir(&destination).unwrap();
        let source = source_dir.join("item.txt");
        let target = destination.join("item.txt");
        fs::write(&source, b"incoming").unwrap();
        fs::write(&target, b"existing").unwrap();
        let request = Request::new(
            vec![source.to_string_lossy().into_owned()],
            destination.to_string_lossy().into_owned(),
        )
        .unwrap();
        let owner = Owner::default();
        let control = Arc::new(Control::new(owner.clone()));
        let session = Arc::clone(&control);
        let work = match effect {
            Effect::Copy => NativeSessionWork::Copy(native_copy_work(root.path())),
            Effect::Move => NativeSessionWork::Move(native_move_work(root.path())),
        };

        let outcome = tauri::async_runtime::block_on(run(request, control, work, move |event| {
            if matches!(event, Event::Conflict { .. }) {
                session.cancel(&owner).unwrap();
            }
            true
        }));

        assert!(outcome.cancelled);
        assert_eq!(fs::read(source).unwrap(), b"incoming");
        assert_eq!(fs::read(target).unwrap(), b"existing");
        assert!(matches!(outcome.items[0], ItemOutcome::Unstarted));
    }
}
