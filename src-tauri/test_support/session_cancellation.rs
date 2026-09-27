use super::*;
use crate::{
    file_history::ForwardEffect,
    file_mutation::{copy_session_outcome, move_session_outcome},
    renderer_owner::Owner,
};
use std::{fs, sync::Arc};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Copy, Debug)]
enum Effect {
    Copy,
    Move,
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

fn boundaries() -> [SessionBoundary; 7] {
    [
        SessionBoundary::ReadyPublished,
        SessionBoundary::InspectionCompleted { item: 0 },
        SessionBoundary::BeforeStart { item: 0 },
        SessionBoundary::StartedPublished { item: 0 },
        SessionBoundary::ApplyCompleted { item: 0 },
        SessionBoundary::ReceiptRetained { item: 0 },
        SessionBoundary::CompletedPublished { item: 0 },
    ]
}

fn native_move_work(root: &std::path::Path) -> crate::files::move_session::MoveWork {
    crate::files::move_session::MoveWork {
        job_id: 802,
        #[cfg(target_os = "linux")]
        recovery: (
            crate::files::recovery::Runtime::default(),
            root.join("recovery"),
        ),
    }
}

fn native_copy_work(root: &std::path::Path) -> NativeWork {
    NativeWork {
        app: None,
        job_id: 802,
        #[cfg(target_os = "linux")]
        recovery: (
            crate::files::recovery::Runtime::default(),
            root.join("recovery"),
        ),
    }
}

async fn cancel_at(effect: Effect, target_boundary: SessionBoundary) {
    let root = tempfile::tempdir().unwrap();
    let source_dir = root.path().join("source");
    let destination = root.path().join("destination");
    fs::create_dir(&source_dir).unwrap();
    fs::create_dir(&destination).unwrap();
    let source = source_dir.join("item.txt");
    let target = destination.join("item.txt");
    fs::write(&source, b"payload").unwrap();

    let source_spelling = source.to_string_lossy().into_owned();
    let destination_spelling = destination.to_string_lossy().into_owned();
    let request =
        Request::new(vec![source_spelling.clone()], destination_spelling.clone()).unwrap();
    let owner = Owner::default();
    let control = Arc::new(Control::new(owner.clone()));
    let (reached, mut boundaries) = mpsc::unbounded_channel();
    let work = match effect {
        Effect::Copy => NativeSessionWork::Copy(native_copy_work(root.path())),
        Effect::Move => NativeSessionWork::Move(native_move_work(root.path())),
    };
    let task = tauri::async_runtime::spawn(run_with_observer(
        request,
        Arc::clone(&control),
        work,
        |_| true,
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
    assert_eq!(
        target.exists(),
        committed,
        "{effect:?} at {target_boundary:?}"
    );
    assert_eq!(
        source.exists(),
        !committed || matches!(effect, Effect::Copy)
    );

    let projected = match effect {
        Effect::Copy => copy_session_outcome(outcome, destination_spelling),
        Effect::Move => move_session_outcome(outcome, &[source_spelling], destination_spelling),
    };
    assert_eq!(
        matches!(projected.effect, ForwardEffect::Changed(Some(_))),
        committed,
        "history must describe exactly the committed filesystem effect"
    );
}

#[test]
fn copy_cancellation_at_every_session_boundary_has_exact_residue_and_history() {
    tauri::async_runtime::block_on(async {
        for boundary in boundaries() {
            cancel_at(Effect::Copy, boundary).await;
        }
    });
}

#[test]
fn move_cancellation_at_every_session_boundary_has_exact_residue_and_history() {
    tauri::async_runtime::block_on(async {
        for boundary in boundaries() {
            cancel_at(Effect::Move, boundary).await;
        }
    });
}

#[test]
fn queued_move_worker_rechecks_cancellation_before_its_native_effect() {
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
