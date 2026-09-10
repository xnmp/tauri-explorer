use super::*;
use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, ModifyKind};
use notify::{Config, Error, Event, EventHandler, RecursiveMode, Watcher, WatcherKind};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
enum Failure {
    Generic,
    Missing,
}

impl Failure {
    fn error(self) -> Error {
        match self {
            Self::Generic => Error::generic("injected observation failure"),
            Self::Missing => Error::path_not_found(),
        }
    }
}

enum DuringWatch {
    Error,
    Event(Event),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum NativeOperation {
    Factory(usize),
    Watch(usize, PathBuf, RecursiveMode),
    Unwatch(usize, PathBuf),
    Drop(usize),
}

#[derive(Default)]
struct NativeState {
    next_generation: usize,
    callbacks: HashMap<usize, Arc<Mutex<Callback>>>,
    registrations: HashMap<usize, HashMap<PathBuf, RecursiveMode>>,
    factory_failures: VecDeque<Failure>,
    watch_failures: HashMap<PathBuf, VecDeque<Failure>>,
    during_watch: HashMap<PathBuf, VecDeque<DuringWatch>>,
    operations: Vec<NativeOperation>,
}

#[derive(Clone, Default)]
struct NativeHarness(Arc<Mutex<NativeState>>);

impl NativeHarness {
    fn factory(&self) -> Factory {
        let shared = Arc::clone(&self.0);
        Box::new(move |callback| {
            let mut state = shared.lock().unwrap();
            let generation = state.next_generation;
            state.next_generation += 1;
            state
                .callbacks
                .insert(generation, Arc::new(Mutex::new(callback)));
            state.registrations.insert(generation, HashMap::new());
            state.operations.push(NativeOperation::Factory(generation));
            if let Some(failure) = state.factory_failures.pop_front() {
                state.registrations.remove(&generation);
                return Err(failure.error());
            }
            drop(state);
            Ok(Box::new(FakeWatcher {
                generation,
                state: Arc::clone(&shared),
            }) as Box<dyn Watcher + Send>)
        })
    }

    fn fail_factory_once(&self, failure: Failure) {
        self.0.lock().unwrap().factory_failures.push_back(failure);
    }

    fn fail_watch_once(&self, path: &Path, failure: Failure) {
        self.0
            .lock()
            .unwrap()
            .watch_failures
            .entry(path.to_path_buf())
            .or_default()
            .push_back(failure);
    }

    fn error_during_watch_once(&self, path: &Path) {
        self.0
            .lock()
            .unwrap()
            .during_watch
            .entry(path.to_path_buf())
            .or_default()
            .push_back(DuringWatch::Error);
    }

    fn event_during_watch_once(&self, path: &Path, event: Event) {
        self.0
            .lock()
            .unwrap()
            .during_watch
            .entry(path.to_path_buf())
            .or_default()
            .push_back(DuringWatch::Event(event));
    }

    fn emit(&self, generation: usize, event: notify::Result<Event>) {
        let callback = self.0.lock().unwrap().callbacks[&generation].clone();
        (callback.lock().unwrap())(event);
    }

    fn latest_generation(&self) -> usize {
        self.0.lock().unwrap().next_generation - 1
    }

    fn generation_count(&self) -> usize {
        self.0.lock().unwrap().next_generation
    }

    fn registrations(&self, generation: usize) -> HashMap<PathBuf, RecursiveMode> {
        self.0
            .lock()
            .unwrap()
            .registrations
            .get(&generation)
            .cloned()
            .unwrap_or_default()
    }

    fn operations(&self) -> Vec<NativeOperation> {
        self.0.lock().unwrap().operations.clone()
    }
}

struct FakeWatcher {
    generation: usize,
    state: Arc<Mutex<NativeState>>,
}

impl Watcher for FakeWatcher {
    fn new<F: EventHandler>(_event_handler: F, _config: Config) -> notify::Result<Self>
    where
        Self: Sized,
    {
        Err(Error::generic("use the injected factory"))
    }

    fn watch(&mut self, path: &Path, mode: RecursiveMode) -> notify::Result<()> {
        let (during, failure, callback) = {
            let mut state = self.state.lock().unwrap();
            state.operations.push(NativeOperation::Watch(
                self.generation,
                path.to_path_buf(),
                mode,
            ));
            let during = state
                .during_watch
                .get_mut(path)
                .and_then(VecDeque::pop_front);
            let failure = state
                .watch_failures
                .get_mut(path)
                .and_then(VecDeque::pop_front);
            let callback = state.callbacks[&self.generation].clone();
            (during, failure, callback)
        };
        match during {
            Some(DuringWatch::Error) => {
                (callback.lock().unwrap())(Err(Error::generic("fault during registration")));
            }
            Some(DuringWatch::Event(event)) => (callback.lock().unwrap())(Ok(event)),
            None => {}
        }
        if let Some(failure) = failure {
            return Err(failure.error());
        }
        self.state
            .lock()
            .unwrap()
            .registrations
            .get_mut(&self.generation)
            .unwrap()
            .insert(path.to_path_buf(), mode);
        Ok(())
    }

    fn unwatch(&mut self, path: &Path) -> notify::Result<()> {
        let mut state = self.state.lock().unwrap();
        state.operations.push(NativeOperation::Unwatch(
            self.generation,
            path.to_path_buf(),
        ));
        if state
            .registrations
            .get_mut(&self.generation)
            .is_some_and(|registrations| registrations.remove(path).is_some())
        {
            Ok(())
        } else {
            Err(Error::watch_not_found())
        }
    }

    fn kind() -> WatcherKind
    where
        Self: Sized,
    {
        WatcherKind::NullWatcher
    }
}

impl Drop for FakeWatcher {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.registrations.remove(&self.generation);
        state
            .operations
            .push(NativeOperation::Drop(self.generation));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RecordedNotice {
    Changed { path: PathBuf, names: bool },
    Lost(Vec<PathBuf>),
    Invalidated(Vec<PathBuf>),
    Restored { roots: Vec<PathBuf>, refresh: bool },
    Wake,
}

fn recorded(notice: Notice) -> RecordedNotice {
    match notice {
        Notice::Changed { path, names } => RecordedNotice::Changed { path, names },
        Notice::Lost(mut roots) => {
            roots.sort();
            RecordedNotice::Lost(roots)
        }
        Notice::Invalidated(mut roots) => {
            roots.sort();
            RecordedNotice::Invalidated(roots)
        }
        Notice::Restored { mut roots, refresh } => {
            roots.sort();
            RecordedNotice::Restored { roots, refresh }
        }
        Notice::Wake => RecordedNotice::Wake,
    }
}

struct Fixture {
    observation: Observation,
    native: NativeHarness,
    notices: Arc<Mutex<Vec<RecordedNotice>>>,
}

fn fixture(mode: Mode) -> Fixture {
    let native = NativeHarness::default();
    let notices = Arc::new(Mutex::new(Vec::new()));
    let collector = Arc::clone(&notices);
    let notify: Notify = Arc::new(move |notice| collector.lock().unwrap().push(recorded(notice)));
    Fixture {
        observation: Observation::new(mode, native.factory(), notify),
        native,
        notices,
    }
}

fn take_notices(notices: &Mutex<Vec<RecordedNotice>>) -> Vec<RecordedNotice> {
    std::mem::take(&mut *notices.lock().unwrap())
}

fn create(path: &Path) -> Event {
    Event::new(EventKind::Create(CreateKind::File)).add_path(path.to_path_buf())
}

#[test]
fn windows_modification_preserves_names_but_renames_and_unknown_events_do_not() {
    assert!(!changes_names(EventKind::Modify(ModifyKind::Any), true));
    assert!(changes_names(EventKind::Modify(ModifyKind::Any), false));
    for kind in [
        EventKind::Any,
        EventKind::Other,
        EventKind::Create(CreateKind::Any),
        EventKind::Remove(notify::event::RemoveKind::Any),
        EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Any)),
    ] {
        assert!(changes_names(kind, true), "{kind:?} must invalidate names");
    }
}

#[cfg(windows)]
#[test]
fn root_modification_received_before_activation_is_delivered_if_activation_wins() {
    for mode in [Mode::Direct, Mode::Recursive] {
        let root = PathBuf::from(r"C:\registration\racing");
        let notices = Arc::new(Mutex::new(Vec::new()));
        let received = Arc::clone(&notices);
        let source = Source::new(
            HashSet::from([root.clone()]),
            mode,
            Arc::new(move |notice| received.lock().unwrap().push(notice)),
        );
        // The callback captured its receipt state, but activation completed
        // before classification/defer_change. Exercise that exact ordering.
        let receipt_state = source.state.load(Ordering::Acquire);
        assert_eq!(source.activate(), Some(false));
        source.event_received(
            Ok(Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.clone())),
            receipt_state,
        );
        let delivered = notices.lock().unwrap();
        assert!(
            matches!(delivered.as_slice(), [Notice::Changed { path, names: true }] if path == &root)
        );
        drop(delivered);
        notices.lock().unwrap().clear();
        source.retire();
        source.event_received(
            Ok(Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root)),
            receipt_state,
        );
        assert!(notices.lock().unwrap().is_empty());
    }
}

#[cfg(windows)]
#[test]
fn windows_root_modification_during_registration_preserves_coverage_and_catches_up() {
    let root = PathBuf::from(r"C:\registration\quiet");
    let mut fixture = fixture(Mode::Direct);
    fixture.native.event_during_watch_once(
        root.parent().unwrap(),
        Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.clone()),
    );
    fixture.observation.add(&root, true).unwrap();
    assert!(fixture.observation.healthy(&root));
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Invalidated(vec![root.clone()]),
            RecordedNotice::Restored {
                roots: vec![root.clone()],
                refresh: true
            },
        ]
    );

    let generation = fixture.native.latest_generation();
    fixture.native.emit(
        generation,
        Ok(Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.clone())),
    );
    assert!(take_notices(&fixture.notices).is_empty());
    assert!(fixture.observation.healthy(&root));
    fixture.native.emit(
        generation,
        Ok(Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("file.txt"))),
    );
    assert_eq!(
        take_notices(&fixture.notices),
        vec![RecordedNotice::Changed {
            path: root.clone(),
            names: false
        },]
    );
    fixture.native.emit(
        generation,
        Ok(Event::new(EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::From,
        )))
        .add_path(root.clone())),
    );
    assert_eq!(
        take_notices(&fixture.notices),
        vec![RecordedNotice::Lost(vec![root]), RecordedNotice::Wake,]
    );
}

#[test]
fn errors_pathless_events_and_rescans_fail_closed_recover_and_ignore_stale_callbacks() {
    let root = PathBuf::from("/watched");
    let mut fixture = fixture(Mode::Direct);
    fixture.observation.add(&root, true).unwrap();
    take_notices(&fixture.notices);

    let faults = [
        Err(Error::generic("native callback failed")),
        Ok(Event::new(EventKind::Other)),
        Ok(Event::new(EventKind::Any)
            .add_path(root.join("rescan"))
            .set_flag(notify::event::Flag::Rescan)),
    ];
    for fault in faults {
        let stale_generation = fixture.native.latest_generation();
        fixture.native.emit(stale_generation, fault);
        assert!(!fixture.observation.healthy(&root));
        assert!(fixture.observation.needs_work());
        assert_eq!(
            take_notices(&fixture.notices),
            vec![
                RecordedNotice::Lost(vec![root.clone()]),
                RecordedNotice::Wake
            ]
        );

        fixture
            .observation
            .maintain(Instant::now() + Duration::from_secs(60));
        assert!(fixture.observation.healthy(&root));
        assert_eq!(
            take_notices(&fixture.notices),
            vec![
                RecordedNotice::Invalidated(vec![root.clone()]),
                RecordedNotice::Restored {
                    roots: vec![root.clone()],
                    refresh: true,
                },
            ]
        );

        fixture
            .native
            .emit(stale_generation, Ok(create(&root.join("stale"))));
        assert!(take_notices(&fixture.notices).is_empty());
    }
}

#[test]
fn callback_fault_during_registration_rejects_coverage_then_recovers() {
    let root = PathBuf::from("/registration/root");
    let mut fixture = fixture(Mode::Direct);
    fixture
        .native
        .error_during_watch_once(root.parent().unwrap());

    assert!(fixture.observation.add(&root, true).is_err());
    assert!(!fixture.observation.healthy(&root));
    assert!(fixture.observation.needs_work());
    let stale_generation = fixture.native.latest_generation();
    assert!(fixture.native.registrations(stale_generation).is_empty());
    assert_eq!(take_notices(&fixture.notices), vec![RecordedNotice::Wake]);

    fixture
        .observation
        .maintain(Instant::now() + Duration::from_secs(60));
    assert!(fixture.observation.healthy(&root));
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Invalidated(vec![root.clone()]),
            RecordedNotice::Restored {
                roots: vec![root.clone()],
                refresh: true,
            },
        ]
    );
    fixture
        .native
        .emit(stale_generation, Ok(create(&root.join("stale"))));
    assert!(take_notices(&fixture.notices).is_empty());
}

#[test]
fn relevant_callback_during_initial_registration_requires_a_refresh() {
    let root = PathBuf::from("/registration/dirty");
    let mut fixture = fixture(Mode::Direct);
    fixture
        .native
        .event_during_watch_once(&root, create(&root.join("created-during-watch")));

    fixture.observation.add(&root, true).unwrap();
    assert!(fixture.observation.healthy(&root));
    assert!(take_notices(&fixture.notices).iter().any(|notice| {
        matches!(notice, RecordedNotice::Restored { roots, refresh: true } if roots == &vec![root.clone()])
    }));
}

#[test]
fn direct_roots_share_the_parent_role_and_final_release_cleans_every_registration() {
    let left = PathBuf::from("/shared/left");
    let right = PathBuf::from("/shared/right");
    let parent = PathBuf::from("/shared");
    let lone = PathBuf::from("/other/only");
    let lone_parent = PathBuf::from("/other");
    let mut fixture = fixture(Mode::Direct);
    fixture.observation.add(&left, true).unwrap();
    fixture.observation.add(&right, true).unwrap();
    fixture.observation.add(&lone, true).unwrap();
    let generation = fixture.native.latest_generation();

    assert_eq!(
        fixture.native.registrations(generation),
        HashMap::from([
            (parent.clone(), RecursiveMode::NonRecursive),
            (left.clone(), RecursiveMode::NonRecursive),
            (right.clone(), RecursiveMode::NonRecursive),
            (lone_parent.clone(), RecursiveMode::NonRecursive),
            (lone.clone(), RecursiveMode::NonRecursive),
        ])
    );
    assert_eq!(
        fixture
            .native
            .operations()
            .iter()
            .filter(|operation| {
                **operation
                    == NativeOperation::Watch(
                        generation,
                        parent.clone(),
                        RecursiveMode::NonRecursive,
                    )
            })
            .count(),
        1
    );

    fixture.observation.remove(&lone).unwrap();
    let registrations = fixture.native.registrations(generation);
    assert!(!registrations.contains_key(&lone));
    assert!(!registrations.contains_key(&lone_parent));
    assert!(registrations.contains_key(&left));
    assert!(registrations.contains_key(&right));
    assert!(registrations.contains_key(&parent));

    fixture.observation.remove(&left).unwrap();
    assert_eq!(
        fixture
            .native
            .registrations(generation)
            .keys()
            .cloned()
            .collect::<HashSet<_>>(),
        HashSet::from([parent, right.clone()])
    );
    fixture.observation.remove(&right).unwrap();
    assert!(fixture.native.registrations(generation).is_empty());
    assert!(fixture
        .native
        .operations()
        .contains(&NativeOperation::Drop(generation)));
    assert!(!fixture.observation.needs_work());
}

#[test]
fn missing_direct_root_recovers_without_disabling_its_healthy_sibling() {
    let healthy = PathBuf::from("/roots/healthy");
    let missing = PathBuf::from("/roots/missing");
    let mut fixture = fixture(Mode::Direct);
    fixture.observation.add(&healthy, true).unwrap();
    fixture.native.fail_watch_once(&missing, Failure::Missing);
    let start = Instant::now();

    assert!(fixture.observation.add(&missing, true).is_err());
    assert!(fixture.observation.healthy(&healthy));
    assert!(!fixture.observation.healthy(&missing));
    assert!(fixture.observation.needs_work());
    take_notices(&fixture.notices);
    let generation = fixture.native.latest_generation();
    fixture.native.emit(
        generation,
        Ok(
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
                .add_path(healthy.join("file")),
        ),
    );
    assert_eq!(
        take_notices(&fixture.notices),
        vec![RecordedNotice::Changed {
            path: healthy.clone(),
            names: false,
        }]
    );

    fixture.observation.maintain(start);
    assert!(!fixture.observation.healthy(&missing));
    fixture
        .observation
        .maintain(start + Duration::from_secs(60));
    assert!(fixture.observation.healthy(&healthy));
    assert!(fixture.observation.healthy(&missing));
    assert_eq!(fixture.native.latest_generation(), generation);
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Invalidated(vec![missing.clone()]),
            RecordedNotice::Restored {
                roots: vec![missing],
                refresh: true,
            },
        ]
    );
}

#[test]
fn recursive_watch_failures_recover_siblings_then_retry_only_the_failed_root() {
    for failure in [Failure::Generic, Failure::Missing] {
        let healthy = PathBuf::from("/recursive/healthy");
        let failed = PathBuf::from("/recursive/failed");
        let mut fixture = fixture(Mode::Recursive);
        fixture.observation.add(&healthy, true).unwrap();
        fixture.native.fail_watch_once(&failed, failure);
        fixture.native.fail_watch_once(&failed, failure);
        let start = Instant::now();

        assert!(fixture.observation.add(&failed, true).is_err());
        assert!(!fixture.observation.healthy(&healthy));
        fixture
            .observation
            .maintain(start + Duration::from_secs(60));
        assert!(fixture.observation.healthy(&healthy));
        assert!(!fixture.observation.healthy(&failed));
        assert!(fixture.observation.needs_work());
        let partial_generation = fixture.native.latest_generation();
        take_notices(&fixture.notices);

        fixture
            .observation
            .maintain(start + Duration::from_secs(120));
        assert!(fixture.observation.healthy(&healthy));
        assert!(fixture.observation.healthy(&failed));
        assert_eq!(fixture.native.latest_generation(), partial_generation);
        let retry_notices = take_notices(&fixture.notices);
        assert!(retry_notices.iter().any(|notice| {
            matches!(notice, RecordedNotice::Restored { roots, refresh: true } if roots == &vec![failed.clone()])
        }));
        assert!(!retry_notices.iter().any(|notice| {
            matches!(notice, RecordedNotice::Lost(_))
                || matches!(notice, RecordedNotice::Restored { roots, .. } if roots.contains(&healthy))
        }));
    }
}

#[test]
fn recursive_recovery_excludes_multiple_failed_roots_without_rewalking_healthy_trees() {
    let healthy = [
        PathBuf::from("/recursive-many/a-healthy"),
        PathBuf::from("/recursive-many/c-healthy"),
    ];
    let failed = [
        PathBuf::from("/recursive-many/b-failed"),
        PathBuf::from("/recursive-many/d-failed"),
    ];
    let mut fixture = fixture(Mode::Recursive);
    for root in healthy.iter().chain(failed.iter()) {
        fixture.observation.add(root, true).unwrap();
    }
    let old_generation = fixture.native.latest_generation();
    take_notices(&fixture.notices);
    for root in &failed {
        fixture.native.fail_watch_once(root, Failure::Generic);
    }

    fixture.native.emit(
        old_generation,
        Err(Error::generic("force multi-root recovery")),
    );
    take_notices(&fixture.notices);
    let operation_start = fixture.native.operations().len();
    fixture
        .observation
        .maintain(Instant::now() + Duration::from_secs(60));

    for root in &healthy {
        assert!(fixture.observation.healthy(root));
    }
    for root in &failed {
        assert!(!fixture.observation.healthy(root));
    }
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Invalidated(healthy.to_vec()),
            RecordedNotice::Restored {
                roots: healthy.to_vec(),
                refresh: true,
            },
            RecordedNotice::Wake,
        ]
    );

    let operations = fixture.native.operations();
    let recovery = &operations[operation_start..];
    for root in &healthy {
        let attempts = recovery
            .iter()
            .filter(|operation| {
                matches!(operation, NativeOperation::Watch(_, path, RecursiveMode::Recursive) if path == root)
            })
            .count();
        assert!((1..=2).contains(&attempts));
    }
    assert!(!recovery
        .iter()
        .any(|operation| matches!(operation, NativeOperation::Unwatch(_, _))));

    let final_generation = fixture.native.latest_generation();
    let discarded: Vec<_> = recovery
        .iter()
        .filter_map(|operation| match operation {
            NativeOperation::Factory(generation) if *generation != final_generation => {
                Some(*generation)
            }
            _ => None,
        })
        .collect();
    assert_eq!(discarded.len(), failed.len());
    for generation in &discarded {
        assert!(recovery.contains(&NativeOperation::Drop(*generation)));
        fixture
            .native
            .emit(*generation, Err(Error::generic("late discarded error")));
    }
    assert!(take_notices(&fixture.notices).is_empty());
    for root in &healthy {
        assert!(fixture.observation.healthy(root));
    }
}

#[test]
fn factory_failure_obeys_backoff_and_recovers_without_accepting_stale_callbacks() {
    let root = PathBuf::from("/factory/root");
    let mut fixture = fixture(Mode::Direct);
    fixture.native.fail_factory_once(Failure::Generic);
    assert!(fixture.observation.add(&root, true).is_err());
    assert_eq!(fixture.native.generation_count(), 1);
    assert!(!fixture.observation.healthy(&root));
    let observed = Instant::now();
    let deadline = fixture.observation.next_work_at(observed).unwrap();
    assert!(deadline > observed);
    fixture
        .observation
        .maintain(deadline.checked_sub(Duration::from_nanos(1)).unwrap());
    assert_eq!(fixture.native.generation_count(), 1);

    fixture.observation.maintain(deadline);
    assert_eq!(fixture.native.generation_count(), 2);
    assert!(fixture.observation.healthy(&root));
    take_notices(&fixture.notices);
    fixture.native.emit(0, Ok(create(&root.join("stale"))));
    assert!(take_notices(&fixture.notices).is_empty());
}

#[test]
fn removing_an_overlapping_recursive_root_rebuilds_survivors_with_a_fresh_generation() {
    let parent = PathBuf::from("/recursive");
    let child = parent.join("child");
    let mut fixture = fixture(Mode::Recursive);
    fixture.observation.add(&parent, true).unwrap();
    fixture.observation.add(&child, true).unwrap();
    let old_generation = fixture.native.latest_generation();
    take_notices(&fixture.notices);

    fixture.observation.remove(&parent).unwrap();
    let new_generation = fixture.native.latest_generation();
    assert_ne!(old_generation, new_generation);
    assert!(fixture.native.registrations(old_generation).is_empty());
    assert_eq!(
        fixture.native.registrations(new_generation),
        HashMap::from([(child.clone(), RecursiveMode::Recursive)])
    );
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Lost(vec![child.clone()]),
            RecordedNotice::Wake,
            RecordedNotice::Invalidated(vec![child.clone()]),
            RecordedNotice::Restored {
                roots: vec![child.clone()],
                refresh: false,
            },
        ]
    );

    fixture
        .native
        .emit(old_generation, Ok(create(&child.join("stale"))));
    assert!(take_notices(&fixture.notices).is_empty());
    let fresh = child.join("fresh");
    fixture.native.emit(new_generation, Ok(create(&fresh)));
    assert_eq!(
        take_notices(&fixture.notices),
        vec![RecordedNotice::Changed {
            path: fresh,
            names: true,
        }]
    );
}

#[test]
fn incremental_recursive_add_does_not_invalidate_unchanged_coverage() {
    let root = PathBuf::from("/recursive/root");
    let added = root.join("nested");
    let mut fixture = fixture(Mode::Recursive);
    fixture.observation.add(&root, true).unwrap();
    let generation = fixture.native.latest_generation();
    take_notices(&fixture.notices);

    fixture.observation.add(&added, true).unwrap();
    assert_eq!(fixture.native.latest_generation(), generation);
    assert!(fixture.observation.healthy(&root));
    assert!(fixture.observation.healthy(&added));
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Invalidated(vec![added.clone()]),
            RecordedNotice::Restored {
                roots: vec![added],
                refresh: false,
            },
        ]
    );
}

#[test]
fn final_recursive_release_retires_callbacks_and_drops_native_state() {
    let root = PathBuf::from("/recursive/final");
    let mut fixture = fixture(Mode::Recursive);
    fixture.observation.add(&root, true).unwrap();
    let generation = fixture.native.latest_generation();
    take_notices(&fixture.notices);

    fixture.observation.remove(&root).unwrap();
    assert!(!fixture.observation.healthy(&root));
    assert!(!fixture.observation.needs_work());
    assert!(fixture.native.registrations(generation).is_empty());
    fixture
        .native
        .emit(generation, Ok(create(&root.join("stale"))));
    assert!(take_notices(&fixture.notices).is_empty());
}

#[test]
fn direct_data_and_metadata_changes_refresh_while_access_is_ignored() {
    let root = PathBuf::from("/direct");
    let file = root.join("file");
    let mut fixture = fixture(Mode::Direct);
    fixture.observation.add(&root, true).unwrap();
    let generation = fixture.native.latest_generation();
    take_notices(&fixture.notices);

    fixture.native.emit(
        generation,
        Ok(
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(file.clone()),
        ),
    );
    fixture.native.emit(
        generation,
        Ok(Event::new(EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime,
        )))
        .add_path(file.clone())),
    );
    fixture.native.emit(
        generation,
        Ok(Event::new(EventKind::Access(AccessKind::Read)).add_path(file)),
    );
    assert_eq!(
        take_notices(&fixture.notices),
        vec![
            RecordedNotice::Changed {
                path: root.clone(),
                names: false,
            },
            RecordedNotice::Changed {
                path: root,
                names: false,
            },
        ]
    );
}

#[test]
fn callbacks_complete_while_the_outer_observation_lock_is_held() {
    let root = PathBuf::from("/nonblocking");
    let native = NativeHarness::default();
    let (send, receive) = mpsc::channel();
    let notify: Notify = Arc::new(move |notice| {
        let _ = send.send(recorded(notice));
    });
    let observation = Arc::new(Mutex::new(Observation::new(
        Mode::Direct,
        native.factory(),
        notify,
    )));
    observation.lock().unwrap().add(&root, true).unwrap();
    while receive.try_recv().is_ok() {}
    let generation = native.latest_generation();

    let guard = observation.lock().unwrap();
    let callback = native.0.lock().unwrap().callbacks[&generation].clone();
    let changed = root.clone();
    let thread = std::thread::spawn(move || {
        (callback.lock().unwrap())(Ok(create(&changed.join("file"))));
    });
    assert_eq!(
        receive.recv_timeout(Duration::from_secs(1)).unwrap(),
        RecordedNotice::Changed {
            path: root,
            names: true,
        }
    );
    thread.join().unwrap();
    drop(guard);
}
