//! Recursive cache observation owns its native operations on a separate worker.
//! The directory lease mutex only submits demand; it never waits for this worker.
use super::watch_observation::{Coverage, Observation};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

type Demand = Arc<()>;

enum Command {
    Ensure(PathBuf, Demand, mpsc::Sender<bool>),
    Remove(PathBuf),
    #[cfg(test)]
    Barrier(mpsc::Sender<()>),
    Stop,
}

#[derive(Default)]
struct State {
    desired: HashMap<PathBuf, Demand>,
    installed: HashMap<PathBuf, Demand>,
    coverage: Option<Coverage>,
}

impl State {
    fn healthy(&self, path: &Path) -> bool {
        self.desired.get(path).is_some_and(|demand| {
            self.installed
                .get(path)
                .is_some_and(|installed| Arc::ptr_eq(demand, installed))
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

pub(super) struct Registration(mpsc::Receiver<bool>);

impl Registration {
    /// Call only after releasing the directory lease mutex.
    pub fn wait(self) -> bool {
        self.0.recv().unwrap_or(false)
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
                let mut reply = None;
                match command {
                    Some(Command::Ensure(path, demand, send)) => {
                        let current = published
                            .lock()
                            .unwrap()
                            .desired
                            .get(&path)
                            .is_some_and(|active| Arc::ptr_eq(active, &demand));
                        if current {
                            #[cfg(feature = "e2e-hooks")]
                            wait_for_native_test_gate(&path);
                            let started = Instant::now();
                            let result = observation.add(&path, true);
                            if started.elapsed() >= Duration::from_secs(1) || result.is_err() {
                                log::warn!("Recursive search watch registration: path={path:?}, elapsed={}ms, result={result:?}", started.elapsed().as_millis());
                            }
                            installed.insert(path.clone(), demand);
                        }
                        reply = Some((path, send));
                    }
                    Some(Command::Remove(path)) => {
                        installed.remove(&path);
                        let _ = observation.remove(&path);
                    }
                    Some(Command::Stop) => break,
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
                    observation.maintain(now);
                    let mut state = published.lock().unwrap();
                    state.coverage = Some(observation.coverage());
                }
            }
        });
        Self { commands, state }
    }

    pub fn prepare(&self, path: &Path) -> Registration {
        let (send, receive) = mpsc::channel();
        let mut state = self.state.lock().unwrap();
        if state.healthy(path) {
            let _ = send.send(true);
        } else {
            let demand = state
                .desired
                .entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(()))
                .clone();
            // Ordering demand changes and sends under this short lock preserves
            // remove/reacquire order even when producers are different threads.
            let _ = self
                .commands
                .send(Command::Ensure(path.to_path_buf(), demand, send));
        }
        Registration(receive)
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
    pub fn settle(&self) {
        let (send, receive) = mpsc::channel();
        self.commands.send(Command::Barrier(send)).unwrap();
        receive.recv_timeout(Duration::from_secs(5)).unwrap();
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
