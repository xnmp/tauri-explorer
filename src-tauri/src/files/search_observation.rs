//! Recursive cache observation owns its native operations on a separate worker.
//! The directory lease mutex only submits demand; it never waits for this worker.
use super::watch_observation::{Coverage, Observation};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

type Demand = Arc<()>;

struct Desired {
    identity: Demand,
    requests: Vec<Arc<AtomicBool>>,
    retained: bool,
}

impl Desired {
    fn wanted(&self) -> bool {
        self.retained
            || self
                .requests
                .iter()
                .any(|flag| !flag.load(Ordering::Acquire))
    }

    fn reconcile(&mut self) {
        self.requests.retain(|flag| !flag.load(Ordering::Acquire));
        // An unsuccessful registration keeps recovery demand while its search
        // can still cancel. Once an uncancelled search finishes, that demand
        // belongs to the pane, just like successfully installed cache coverage.
        self.retained |= self
            .requests
            .iter_mut()
            .any(|flag| Arc::get_mut(flag).is_some_and(|flag| !*flag.get_mut()));
        if self.retained {
            self.requests.clear();
        }
    }
}

enum Command {
    Ensure(PathBuf, Demand, Arc<AtomicBool>, mpsc::Sender<bool>),
    Remove(PathBuf),
    #[cfg(test)]
    Barrier(mpsc::Sender<()>),
    #[cfg(test)]
    Maintain(Instant, Box<dyn FnOnce() + Send>, mpsc::Sender<()>),
    Stop,
}

#[derive(Default)]
struct State {
    desired: HashMap<PathBuf, Desired>,
    installed: HashMap<PathBuf, Demand>,
    coverage: Option<Coverage>,
}

impl State {
    fn healthy(&self, path: &Path) -> bool {
        self.desired.get(path).is_some_and(|demand| {
            demand.wanted()
                && self
                    .installed
                    .get(path)
                    .is_some_and(|installed| Arc::ptr_eq(&demand.identity, installed))
                && self
                    .coverage
                    .as_ref()
                    .is_some_and(|coverage| coverage.healthy(path))
        })
    }
}

pub(super) struct SearchObservation {
    commands: mpsc::Sender<Command>,
    state: Arc<Mutex<State>>,
}

pub(super) struct Registration {
    receive: mpsc::Receiver<bool>,
    cancelled: Arc<AtomicBool>,
}

impl Registration {
    /// Call only after releasing the directory lease mutex.
    pub fn wait(self) -> bool {
        while !self.cancelled.load(Ordering::Acquire) {
            match self.receive.recv_timeout(Duration::from_millis(20)) {
                Ok(covered) => return covered && !self.cancelled.load(Ordering::Acquire),
                Err(mpsc::RecvTimeoutError::Disconnected) => return false,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        false
    }
}

impl SearchObservation {
    pub fn new(mut observation: Observation) -> Self {
        let (commands, receive) = mpsc::channel();
        let state = Arc::new(Mutex::new(State::default()));
        let published = state.clone();
        std::thread::spawn(move || {
            let mut installed = HashMap::new();
            loop {
                // Callback faults are atomic. Polling their deadlines keeps
                // recovery independent of the direct observer's flush thread.
                let now = Instant::now();
                let timeout = observation
                    .next_work_at(now)
                    .map(|at| at.saturating_duration_since(now))
                    .unwrap_or(Duration::from_millis(100))
                    .min(Duration::from_millis(100));
                let command = match receive.recv_timeout(timeout) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                reconcile(&published, &mut installed, &mut observation);
                let mut reply = None;
                match command {
                    Some(Command::Ensure(path, demand, cancelled, send)) => {
                        let current = published
                            .lock()
                            .unwrap()
                            .desired
                            .get(&path)
                            .is_some_and(|active| Arc::ptr_eq(&active.identity, &demand));
                        if current && !cancelled.load(Ordering::Acquire) {
                            let started = Instant::now();
                            log::info!(
                                "Recursive search watch registration started: path={path:?}"
                            );
                            #[cfg(feature = "e2e-hooks")]
                            wait_for_native_test_gate(&path);
                            #[cfg(test)]
                            super::fs_watcher::change_tests::wait_for_registration(&path);
                            installed.insert(path.clone(), demand.clone());
                            update_admission(&published, &installed, &mut observation);
                            let result = observation.add(&path, true);
                            log::info!("Recursive search watch registration finished: path={path:?}, elapsed={}ms, result={result:?}", started.elapsed().as_millis());
                            if result.is_ok() {
                                if let Some(active) =
                                    published.lock().unwrap().desired.get_mut(&path).filter(
                                        |active| {
                                            Arc::ptr_eq(&active.identity, &demand)
                                                && active.wanted()
                                        },
                                    )
                                {
                                    active.retained = true;
                                    active.requests.clear();
                                }
                            }
                        }
                        reply = Some((path, send));
                    }
                    Some(Command::Remove(path)) => {
                        installed.remove(&path);
                        let _ = observation.remove(&path);
                    }
                    Some(Command::Stop) => break,
                    #[cfg(test)]
                    Some(Command::Maintain(now, before, send)) => {
                        before();
                        observation.maintain(now);
                        reconcile(&published, &mut installed, &mut observation);
                        let mut state = published.lock().unwrap();
                        state.installed = installed.clone();
                        state.coverage = Some(observation.coverage());
                        let _ = send.send(());
                        continue;
                    }
                    #[cfg(test)]
                    Some(Command::Barrier(send)) => {
                        let mut state = published.lock().unwrap();
                        state.installed = installed.clone();
                        state.coverage = Some(observation.coverage());
                        let _ = send.send(());
                        continue;
                    }
                    None => {}
                }
                // Cancellation or final pane release can happen inside a slow
                // add. Reclaim that demand before publishing or retrying it.
                reconcile(&published, &mut installed, &mut observation);
                // No shared-state lock is held during OS registration, rebuild,
                // unwatch or watcher destruction. Late results retain the old
                // demand identity and cannot cover a released/reacquired root.
                let mut state = published.lock().unwrap();
                state.installed = installed.clone();
                state.coverage = Some(observation.coverage());
                if let Some((path, send)) = reply {
                    let _ = send.send(state.healthy(&path));
                }
                drop(state);
                // Due recovery cannot depend on the command queue becoming
                // empty: traffic for a healthy root must not starve a missing
                // sibling. Replies above are delivered before any slow retry.
                let now = Instant::now();
                if observation.next_work_at(now).is_some_and(|at| at <= now) {
                    let roots: Vec<_> = installed.keys().cloned().collect();
                    let started = Instant::now();
                    log::info!("Recursive search watch recovery started: roots={roots:?}");
                    observation.maintain(now);
                    log::info!(
                        "Recursive search watch recovery finished: roots={roots:?}, elapsed={}ms",
                        started.elapsed().as_millis()
                    );
                    reconcile(&published, &mut installed, &mut observation);
                    let mut state = published.lock().unwrap();
                    state.coverage = Some(observation.coverage());
                }
            }
        });
        Self { commands, state }
    }

    #[cfg(test)]
    pub fn prepare(&self, path: &Path) -> Registration {
        self.prepare_cancellable(path, Arc::new(AtomicBool::new(false)))
    }

    pub fn prepare_cancellable(&self, path: &Path, cancelled: Arc<AtomicBool>) -> Registration {
        let (send, receive) = mpsc::channel();
        let mut state = self.state.lock().unwrap();
        if cancelled.load(Ordering::Acquire) {
            let _ = send.send(false);
        } else if state.healthy(path) {
            // Recovery may have installed coverage while the original failed
            // requester was still running. This successful acquisition adopts
            // it independently of that requester's later cancellation.
            let desired = state.desired.get_mut(path).unwrap();
            desired.retained = true;
            desired.requests.clear();
            let _ = send.send(true);
        } else {
            let desired = state
                .desired
                .entry(path.to_path_buf())
                .or_insert_with(|| Desired {
                    identity: Arc::new(()),
                    requests: Vec::new(),
                    retained: false,
                });
            desired.reconcile();
            if !desired.retained {
                desired.requests.push(cancelled.clone());
            }
            let demand = desired.identity.clone();
            // Demand changes and sends share this short lock, preserving the
            // ordering of final release and same-path reacquisition.
            let _ = self.commands.send(Command::Ensure(
                path.to_path_buf(),
                demand,
                cancelled.clone(),
                send,
            ));
        }
        Registration { receive, cancelled }
    }

    pub fn healthy(&self, path: &Path) -> bool {
        self.state.lock().unwrap().healthy(path)
    }

    pub fn remove(&self, path: &Path) {
        let mut state = self.state.lock().unwrap();
        if state.desired.remove(path).is_some() {
            // Eligibility ends now, before the worker can finish a blocked add.
            let _ = self.commands.send(Command::Remove(path.to_path_buf()));
        }
    }

    #[cfg(test)]
    pub fn add(&self, path: &Path, _retain_failed: bool) -> notify::Result<()> {
        if self.prepare(path).wait() {
            Ok(())
        } else {
            Err(notify::Error::generic("Recursive observation unavailable"))
        }
    }

    #[cfg(test)]
    pub fn maintain_for_test(&self, now: Instant) {
        self.maintain_after_for_test(now, || {});
    }

    #[cfg(test)]
    pub fn maintain_after_for_test(&self, now: Instant, before: impl FnOnce() + Send + 'static) {
        let (send, receive) = mpsc::channel();
        self.commands
            .send(Command::Maintain(now, Box::new(before), send))
            .unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[cfg(test)]
    pub fn settle(&self) {
        let (send, receive) = mpsc::channel();
        self.commands.send(Command::Barrier(send)).unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}

/// Snapshot operation identities, but recheck their current demand before each
/// native root. A blocked sibling must not admit a later cancelled/released root.
fn update_admission(
    state: &Arc<Mutex<State>>,
    installed: &HashMap<PathBuf, Demand>,
    observation: &mut Observation,
) {
    let state = state.clone();
    let identities = installed.clone();
    observation.set_registration_admission(move |path| {
        let state = state.lock().unwrap();
        identities.get(path).is_some_and(|identity| {
            state
                .desired
                .get(path)
                .is_some_and(|desired| Arc::ptr_eq(identity, &desired.identity) && desired.wanted())
        })
    });
}

/// Only the worker touches Observation. Retire all obsolete roots together so
/// removing overlapping cancelled roots cannot rebuild one another.
fn reconcile(
    state: &Arc<Mutex<State>>,
    installed: &mut HashMap<PathBuf, Demand>,
    observation: &mut Observation,
) {
    let obsolete = {
        let mut state = state.lock().unwrap();
        state.desired.retain(|_, desired| {
            desired.reconcile();
            desired.wanted()
        });
        installed
            .iter()
            .filter(|(path, demand)| {
                !state
                    .desired
                    .get(*path)
                    .is_some_and(|desired| Arc::ptr_eq(&desired.identity, demand))
            })
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>()
    };
    for path in &obsolete {
        installed.remove(path);
    }
    update_admission(state, installed, observation);
    if !obsolete.is_empty() {
        let _ = observation.remove_recursive_roots(&obsolete);
    }
}

impl Drop for SearchObservation {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
    }
}

/// Hook builds only: acknowledge a pending recursive registration to the
/// private native harness, then wait for its explicit release (bounded).
#[cfg(feature = "e2e-hooks")]
fn wait_for_native_test_gate(path: &Path) {
    let Some(gate) = std::env::var_os("TAURI_EXPLORER_E2E_SEARCH_WATCH_GATE") else {
        return;
    };
    let gate = PathBuf::from(gate);
    let _ = std::fs::write(
        gate.with_extension("entered"),
        path.to_string_lossy().as_bytes(),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    while !gate.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::write(
        gate.with_extension("exited"),
        if gate.exists() { "released" } else { "timeout" },
    );
}
