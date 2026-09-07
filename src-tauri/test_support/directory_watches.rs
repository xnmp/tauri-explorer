use super::{DirectoryWatches, Observer};
use crate::renderer_owner::Owner;
use notify::{Error, Result as NotifyResult};
use std::collections::{HashSet, VecDeque};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
enum Observation {
    Watch(String),
    Unwatch(String),
    Replace(Vec<String>),
    Uncovered(String),
    Callback(String),
}

#[derive(Clone, Copy)]
enum Failure {
    Generic,
    Missing,
}

struct WatchGate {
    entered: mpsc::Sender<()>,
    resume: mpsc::Receiver<()>,
}

#[derive(Default)]
struct FakeObserver {
    registrations: HashSet<String>,
    observations: Vec<Observation>,
    watch_failures: VecDeque<Failure>,
    unwatch_failures: VecDeque<Failure>,
    replace_failures: VecDeque<Failure>,
    watch_gate: Option<WatchGate>,
}

impl FakeObserver {
    fn error(failure: Failure) -> Error {
        match failure {
            Failure::Generic => Error::generic("injected observer failure"),
            Failure::Missing => Error::watch_not_found(),
        }
    }

    fn fail_unwatch(&mut self, count: usize) {
        self.unwatch_failures
            .extend(std::iter::repeat_n(Failure::Generic, count));
    }

    fn callback(&mut self, path: &str) -> bool {
        if !self.registrations.contains(path) {
            return false;
        }
        self.observations.push(Observation::Callback(path.into()));
        true
    }

    fn count(&self, expected: &Observation) -> usize {
        self.observations
            .iter()
            .filter(|observation| *observation == expected)
            .count()
    }
}

impl Observer for FakeObserver {
    fn watch(&mut self, path: &str) -> NotifyResult<()> {
        self.observations.push(Observation::Watch(path.into()));
        if let Some(gate) = self.watch_gate.take() {
            gate.entered.send(()).unwrap();
            gate.resume.recv().unwrap();
        }
        if let Some(failure) = self.watch_failures.pop_front() {
            return Err(Self::error(failure));
        }
        self.registrations.insert(path.into());
        Ok(())
    }

    fn unwatch(&mut self, path: &str) -> NotifyResult<()> {
        self.observations.push(Observation::Unwatch(path.into()));
        if let Some(failure) = self.unwatch_failures.pop_front() {
            if matches!(failure, Failure::Missing) {
                self.registrations.remove(path);
            }
            return Err(Self::error(failure));
        }
        if self.registrations.remove(path) {
            Ok(())
        } else {
            Err(Error::watch_not_found())
        }
    }

    fn replace(&mut self, paths: &[String]) -> NotifyResult<()> {
        self.observations.push(Observation::Replace(paths.to_vec()));
        if let Some(failure) = self.replace_failures.pop_front() {
            return Err(Self::error(failure));
        }
        self.registrations = paths.iter().cloned().collect();
        Ok(())
    }

    fn uncovered(&mut self, path: &str) {
        self.observations.push(Observation::Uncovered(path.into()));
    }
}

fn watches() -> DirectoryWatches<FakeObserver> {
    DirectoryWatches::new(FakeObserver::default())
}

#[test]
fn shared_path_has_distinct_authority_and_one_observable_registration() {
    let mut watches = watches();
    let left = Owner::default();
    let right = Owner::default();
    let left_lease = watches.acquire(&left, "/shared".into()).unwrap();
    let right_lease = watches.acquire(&right, "/shared".into()).unwrap();

    assert_ne!(left_lease.id, right_lease.id);
    assert!(watches.covered("/shared"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Watch("/shared".into())),
        1
    );
    assert!(watches.observer.callback("/shared"));

    watches.release(&left, &left_lease.id).unwrap();
    assert!(watches.covered("/shared"));
    assert!(watches.observer.callback("/shared"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/shared".into())),
        0
    );

    watches.release(&right, &right_lease.id).unwrap();
    assert!(!watches.covered("/shared"));
    assert!(!watches.observer.callback("/shared"));
    assert!(!watches.needs_cleanup());
}

#[test]
fn retiring_one_shared_owner_preserves_the_survivors_coverage_and_callbacks() {
    let mut watches = watches();
    let retiring = Owner::default();
    let survivor = Owner::default();
    watches.acquire(&retiring, "/shared-retire".into()).unwrap();
    let live = watches.acquire(&survivor, "/shared-retire".into()).unwrap();

    retiring.retire();
    watches.maintain(Instant::now());
    assert!(watches.covered("/shared-retire"));
    assert!(watches.observer.callback("/shared-retire"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/shared-retire".into())),
        0
    );
    assert_eq!(
        watches
            .observer
            .count(&Observation::Uncovered("/shared-retire".into())),
        0
    );

    watches.release(&survivor, &live.id).unwrap();
    assert!(!watches.covered("/shared-retire"));
}

#[test]
fn foreign_and_unknown_releases_are_idempotent_noops() {
    let mut watches = watches();
    let owner = Owner::default();
    let foreign = Owner::default();
    let lease = watches.acquire(&owner, "/owned".into()).unwrap();

    watches.release(&foreign, &lease.id).unwrap();
    watches.release(&owner, "not-a-lease").unwrap();
    assert!(watches.covered("/owned"));
    assert!(watches.observer.callback("/owned"));

    watches.release(&owner, &lease.id).unwrap();
    assert!(!watches.covered("/owned"));
}

#[test]
fn inactive_owner_cannot_register_a_path() {
    let mut watches = watches();
    let owner = Owner::default();
    owner.retire();

    assert!(watches.acquire(&owner, "/late".into()).is_err());
    assert!(!watches.covered("/late"));
    assert!(watches.observer.registrations.is_empty());
    assert!(watches.observer.observations.is_empty());
}

#[test]
fn retirement_while_watch_is_blocked_drains_before_acknowledgement() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let observer = FakeObserver {
        watch_gate: Some(WatchGate {
            entered: entered_tx,
            resume: resume_rx,
        }),
        ..Default::default()
    };
    let mut watches = DirectoryWatches::new(observer);
    let owner = Owner::default();
    let retiring = owner.clone();

    std::thread::scope(|scope| {
        scope.spawn(move || {
            entered_rx.recv().unwrap();
            retiring.retire();
            resume_tx.send(()).unwrap();
        });
        assert!(watches.acquire(&owner, "/racing".into()).is_err());
    });

    assert!(!watches.covered("/racing"));
    assert!(!watches.needs_cleanup());
    assert!(!watches.observer.registrations.contains("/racing"));
    assert_eq!(
        watches.observer.observations,
        vec![
            Observation::Watch("/racing".into()),
            Observation::Uncovered("/racing".into()),
            Observation::Unwatch("/racing".into()),
        ]
    );
}

#[test]
fn retired_release_cannot_touch_a_replacement_lease() {
    let mut watches = watches();
    let old_owner = Owner::default();
    let old = watches.acquire(&old_owner, "/reused".into()).unwrap();
    old_owner.retire();
    watches.maintain(Instant::now());
    assert!(!watches.covered("/reused"));

    let replacement = Owner::default();
    let current = watches.acquire(&replacement, "/reused".into()).unwrap();
    assert_ne!(old.id, current.id);
    watches.release(&old_owner, &old.id).unwrap();
    assert!(watches.covered("/reused"));
    assert!(watches.observer.callback("/reused"));

    watches.release(&replacement, &current.id).unwrap();
    assert!(!watches.covered("/reused"));
}

#[test]
fn failed_watch_publishes_no_lease_or_coverage_and_can_retry() {
    let mut observer = FakeObserver::default();
    observer.watch_failures.push_back(Failure::Generic);
    let mut watches = DirectoryWatches::new(observer);
    let owner = Owner::default();

    assert!(watches.acquire(&owner, "/retry-watch".into()).is_err());
    assert!(!watches.covered("/retry-watch"));
    assert!(!watches.observer.callback("/retry-watch"));
    assert!(!watches.needs_cleanup());

    let lease = watches.acquire(&owner, "/retry-watch".into()).unwrap();
    assert!(watches.covered("/retry-watch"));
    assert!(watches.observer.callback("/retry-watch"));
    watches.release(&owner, &lease.id).unwrap();
}

#[test]
fn explicit_unwatch_failure_is_fail_closed_until_the_same_authority_retries() {
    let mut watches = watches();
    let owner = Owner::default();
    let lease = watches.acquire(&owner, "/retry-release".into()).unwrap();
    watches.observer.fail_unwatch(1);

    assert!(watches.release(&owner, &lease.id).is_err());
    assert!(!watches.covered("/retry-release"));
    assert!(watches.observer.callback("/retry-release"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Uncovered("/retry-release".into())),
        1,
        "an ambiguous native unwatch must immediately revoke cache eligibility"
    );

    let replacement = Owner::default();
    assert!(watches
        .acquire(&replacement, "/retry-release".into())
        .is_err());
    assert_eq!(
        watches
            .observer
            .count(&Observation::Watch("/retry-release".into())),
        1,
        "pending cleanup must not install a duplicate native registration"
    );

    watches.release(&owner, &lease.id).unwrap();
    assert!(!watches.covered("/retry-release"));
    assert!(!watches.observer.callback("/retry-release"));

    let replacement_lease = watches
        .acquire(&replacement, "/retry-release".into())
        .unwrap();
    assert!(watches.covered("/retry-release"));
    assert!(watches.observer.callback("/retry-release"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Watch("/retry-release".into())),
        2,
        "a completed cleanup must permit a fresh native registration"
    );
    watches
        .release(&replacement, &replacement_lease.id)
        .unwrap();
}

#[test]
fn failed_final_release_retries_without_its_frontend_owner_and_preserves_shared_coverage() {
    let mut watches = watches();
    let releasing = Owner::default();
    let left = Owner::default();
    let right = Owner::default();
    let abandoned = watches.acquire(&releasing, "/abandoned".into()).unwrap();
    let left_shared = watches.acquire(&left, "/shared".into()).unwrap();
    let right_shared = watches.acquire(&right, "/shared".into()).unwrap();
    watches.observer.fail_unwatch(1);
    let start = Instant::now();

    assert!(watches.release(&releasing, &abandoned.id).is_err());
    assert!(releasing.active());
    assert!(!watches.covered("/abandoned"));
    assert!(watches.observer.registrations.contains("/abandoned"));

    watches.maintain(start);
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/abandoned".into())),
        1,
        "cleanup retried before its backoff elapsed"
    );
    watches.maintain(start + Duration::from_secs(60));

    assert!(!watches.observer.registrations.contains("/abandoned"));
    assert!(!watches.covered("/abandoned"));
    assert!(watches.observer.registrations.contains("/shared"));
    assert!(watches.covered("/shared"));
    assert!(watches.observer.callback("/shared"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Watch("/shared".into())),
        1
    );
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/shared".into())),
        0
    );

    watches.release(&left, &left_shared.id).unwrap();
    assert!(watches.covered("/shared"));
    watches.release(&right, &right_shared.id).unwrap();
    assert!(!watches.covered("/shared"));
}

#[test]
fn successful_final_release_ends_coverage_before_physical_cleanup() {
    let mut watches = watches();
    let owner = Owner::default();
    let lease = watches.acquire(&owner, "/ordered".into()).unwrap();
    watches.observer.observations.clear();

    watches.release(&owner, &lease.id).unwrap();
    assert_eq!(
        watches.observer.observations,
        vec![
            Observation::Uncovered("/ordered".into()),
            Observation::Unwatch("/ordered".into()),
        ],
        "cache eligibility must end before physical observation is removed"
    );
}

#[test]
fn forced_cleanup_obeys_backoff_then_rebuilds_only_survivors() {
    let mut watches = watches();
    let retired_owner = Owner::default();
    let survivor = Owner::default();
    watches.acquire(&retired_owner, "/retired".into()).unwrap();
    watches.acquire(&survivor, "/survivor".into()).unwrap();
    watches.observer.fail_unwatch(3);
    retired_owner.retire();
    let start = Instant::now();

    watches.maintain(start);
    assert!(!watches.covered("/retired"));
    assert!(watches.needs_cleanup());
    assert_eq!(
        watches
            .observer
            .count(&Observation::Uncovered("/retired".into())),
        1
    );
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/retired".into())),
        1
    );

    watches.maintain(start);
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/retired".into())),
        1,
        "cleanup retried before its first backoff elapsed"
    );
    watches.maintain(start + Duration::from_secs(60));
    watches.maintain(start + Duration::from_secs(120));

    assert!(!watches.needs_cleanup());
    assert!(!watches.observer.registrations.contains("/retired"));
    assert!(watches.observer.registrations.contains("/survivor"));
    assert!(watches.covered("/survivor"));
    assert!(watches.observer.callback("/survivor"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Replace(vec!["/survivor".into()])),
        1
    );
}

#[test]
fn failed_rebuild_preserves_registrations_and_later_retry_drains() {
    let mut watches = watches();
    let retired_owner = Owner::default();
    let survivor = Owner::default();
    watches.acquire(&retired_owner, "/retired".into()).unwrap();
    watches.acquire(&survivor, "/survivor".into()).unwrap();
    watches.observer.fail_unwatch(4);
    watches
        .observer
        .replace_failures
        .push_back(Failure::Generic);
    retired_owner.retire();
    let start = Instant::now();

    watches.maintain(start);
    watches.maintain(start + Duration::from_secs(60));
    watches.maintain(start + Duration::from_secs(120));
    assert!(watches.needs_cleanup());
    assert!(watches.observer.registrations.contains("/retired"));
    assert!(watches.observer.registrations.contains("/survivor"));
    assert!(watches.observer.callback("/survivor"));

    watches.maintain(start + Duration::from_secs(180));
    assert!(!watches.needs_cleanup());
    assert!(!watches.observer.registrations.contains("/retired"));
    assert!(watches.observer.registrations.contains("/survivor"));
    assert!(watches.observer.callback("/survivor"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Replace(vec!["/survivor".into()])),
        2
    );
}

#[test]
fn missing_native_watch_completes_release_without_retention() {
    let mut watches = watches();
    let owner = Owner::default();
    let lease = watches.acquire(&owner, "/missing".into()).unwrap();
    watches.observer.registrations.remove("/missing");
    watches
        .observer
        .unwatch_failures
        .push_back(Failure::Missing);

    watches.release(&owner, &lease.id).unwrap();
    assert!(!watches.covered("/missing"));
    assert!(!watches.needs_cleanup());
}

#[test]
fn abandoned_ack_releases_only_its_unique_lease() {
    let mut watches = watches();
    let abandoned_owner = Owner::default();
    let survivor = Owner::default();
    let abandoned = watches
        .acquire(&abandoned_owner, "/shared-abandon".into())
        .unwrap();
    let live = watches
        .acquire(&survivor, "/shared-abandon".into())
        .unwrap();

    watches.abandon(&abandoned.id);
    assert!(watches.covered("/shared-abandon"));
    assert!(watches.observer.callback("/shared-abandon"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Unwatch("/shared-abandon".into())),
        0
    );

    watches.release(&survivor, &live.id).unwrap();
    assert!(!watches.covered("/shared-abandon"));
}

#[test]
fn abandoned_final_ack_drops_registration_and_coverage() {
    let mut watches = watches();
    let owner = Owner::default();
    let lease = watches.acquire(&owner, "/lost-ack".into()).unwrap();

    watches.abandon(&lease.id);
    assert!(!watches.covered("/lost-ack"));
    assert!(!watches.needs_cleanup());
    assert!(!watches.observer.callback("/lost-ack"));
    assert_eq!(
        watches
            .observer
            .count(&Observation::Uncovered("/lost-ack".into())),
        1
    );
}

#[test]
fn abandoned_ack_with_cleanup_error_is_retried_without_restoring_coverage() {
    let mut watches = watches();
    let owner = Owner::default();
    let lease = watches.acquire(&owner, "/lost-ack-retry".into()).unwrap();
    watches.observer.fail_unwatch(1);

    watches.abandon(&lease.id);
    assert!(!watches.covered("/lost-ack-retry"));
    assert!(watches.needs_cleanup());
    assert!(
        watches.observer.callback("/lost-ack-retry"),
        "failed physical cleanup may still deliver callbacks while logical coverage is revoked"
    );
    assert_eq!(
        watches
            .observer
            .count(&Observation::Uncovered("/lost-ack-retry".into())),
        1
    );

    watches.maintain(Instant::now() + Duration::from_secs(60));
    assert!(!watches.needs_cleanup());
    assert!(!watches.observer.registrations.contains("/lost-ack-retry"));
    assert!(!watches.observer.callback("/lost-ack-retry"));
}

#[test]
fn id_exhaustion_never_installs_an_unowned_watch() {
    let mut watches = watches();
    watches.next_id = u64::MAX;
    let owner = Owner::default();

    assert!(watches.acquire(&owner, "/exhausted".into()).is_err());
    assert!(!watches.covered("/exhausted"));
    assert!(watches.observer.registrations.is_empty());
    assert!(watches.observer.observations.is_empty());
}

#[test]
fn owner_retirement_revokes_coverage_before_maintenance_runs() {
    let mut watches = watches();
    let owner = Owner::default();
    watches.acquire(&owner, "/immediate".into()).unwrap();
    assert!(watches.covered("/immediate"));
    owner.retire();

    assert!(!watches.covered("/immediate"));
    assert!(watches.observer.registrations.contains("/immediate"));
    watches.maintain(Instant::now());
    assert!(!watches.observer.registrations.contains("/immediate"));
}
