//! One blocking worker owns observers, leases and deadlines. Native callbacks
//! only set coalesced flags and wake its bounded inbox; they never wait on it.
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

use super::target::Target;
use crate::error::AppError;

pub(super) type Observer = Box<dyn Send>;
pub(super) type Callback = Box<dyn Fn(notify::Result<notify::Event>) + Send + 'static>;
pub(super) type Factory = Box<dyn Fn(&Target, Callback) -> Result<Observer, AppError> + Send>;
pub(super) type Emit = Box<dyn Fn(&str) -> Result<(), String> + Send>;

const DIRTY: u8 = 1;
const BROKEN: u8 = 2;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub id: String,
    pub repo_root: String,
}

enum Command {
    Acquire {
        path: String,
        reply: oneshot::Sender<Result<Lease, AppError>>,
    },
    Release {
        id: String,
        reply: oneshot::Sender<()>,
    },
    Wake,
}

struct Entry {
    target: Target,
    observer: Option<Observer>,
    flags: Arc<AtomicU8>,
    leases: HashSet<String>,
    dirty: bool,
    announced: bool,
    last_emit: Option<Instant>,
    retry_at: Option<Instant>,
    failures: u32,
}

#[derive(Clone, Copy)]
pub(super) struct Timing {
    pub debounce: Duration,
    pub retry: Duration,
    pub retry_cap: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            debounce: Duration::from_millis(200),
            retry: Duration::from_millis(250),
            retry_cap: Duration::from_secs(30),
        }
    }
}

pub(super) struct Service {
    sender: mpsc::Sender<Command>,
    stopped: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

fn closed() -> AppError {
    AppError::Other("Git watch service stopped".into())
}

impl Service {
    pub fn spawn(factory: Factory, emit: Emit, timing: Timing) -> Result<Self, AppError> {
        let (sender, receiver) = mpsc::channel(64);
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_sender = sender.clone();
        let worker_stopped = Arc::clone(&stopped);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()?;
        let worker = std::thread::Builder::new()
            .name("git-observation".into())
            .spawn(move || {
                runtime.block_on(
                    Worker {
                        receiver,
                        sender: worker_sender,
                        stopped: worker_stopped,
                        factory,
                        emit,
                        timing,
                        entries: HashMap::new(),
                        leases: HashMap::new(),
                        next_lease: 0,
                    }
                    .run(),
                );
            })?;
        Ok(Self {
            sender,
            stopped,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub async fn acquire(&self, path: String) -> Result<Lease, AppError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(closed());
        }
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Command::Acquire { path, reply })
            .await
            .map_err(|_| closed())?;
        result.await.map_err(|_| closed())?
    }

    pub async fn release(&self, id: String) -> Result<(), AppError> {
        let (reply, result) = oneshot::channel();
        self.sender
            .send(Command::Release { id, reply })
            .await
            .map_err(|_| closed())?;
        result.await.map_err(|_| closed())
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.sender.try_send(Command::Wake);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Worker {
    receiver: mpsc::Receiver<Command>,
    sender: mpsc::Sender<Command>,
    stopped: Arc<AtomicBool>,
    factory: Factory,
    emit: Emit,
    timing: Timing,
    entries: HashMap<String, Entry>,
    leases: HashMap<String, String>,
    next_lease: u64,
}

impl Worker {
    async fn run(mut self) {
        loop {
            if self.stopped.load(Ordering::Acquire) {
                break;
            }
            self.maintain();
            // A full callback inbox cannot lose a change: its flags are scanned
            // above after every command, including a Wake with no payload.
            let command = match self.next_deadline() {
                Some(deadline) => match tokio::time::timeout(
                    deadline.saturating_duration_since(Instant::now()),
                    self.receiver.recv(),
                )
                .await
                {
                    Ok(command) => command,
                    Err(_) => continue,
                },
                None => self.receiver.recv().await,
            };
            if self.stopped.load(Ordering::Acquire) {
                break;
            }
            match command {
                Some(Command::Acquire { path, reply }) => {
                    if reply.is_closed() {
                        continue;
                    }
                    let result = self.acquire(&path);
                    if self.stopped.load(Ordering::Acquire) {
                        let _ = reply.send(Err(closed()));
                        break;
                    }
                    if let Err(Ok(lease)) = reply.send(result) {
                        self.release(&lease.id);
                    }
                }
                Some(Command::Release { id, reply }) => {
                    self.release(&id);
                    let _ = reply.send(());
                }
                Some(Command::Wake) => {}
                None => break,
            }
        }
        // Drop registrations before rejecting queued work / closing replies.
        self.entries.clear();
        self.receiver.close();
    }

    fn observe(
        factory: &Factory,
        sender: &mpsc::Sender<Command>,
        target: &Target,
    ) -> Result<(Observer, Arc<AtomicU8>), AppError> {
        let flags = Arc::new(AtomicU8::new(0));
        let event_flags = Arc::clone(&flags);
        let sender = sender.clone();
        let watched = target.clone();
        let callback = Box::new(move |event: notify::Result<notify::Event>| {
            let bits = match event {
                Ok(event) if watched.lost_root(&event) => DIRTY | BROKEN,
                Ok(event) if watched.relevant(&event) => DIRTY,
                Ok(_) => return,
                Err(error) => {
                    log::warn!("git watch {}: {error}", watched.key);
                    DIRTY | BROKEN
                }
            };
            if event_flags.fetch_or(bits, Ordering::AcqRel) == 0 {
                let _ = sender.try_send(Command::Wake);
            }
        });
        let observer = factory(target, callback)?;
        if flags.load(Ordering::Acquire) & BROKEN != 0 {
            return Err(AppError::Other(
                "Git observation failed during registration".into(),
            ));
        }
        Ok((observer, flags))
    }

    fn acquire(&mut self, path: &str) -> Result<Lease, AppError> {
        let target = Target::resolve(path)?;
        let key = target.key.clone();
        if let Some(entry) = self.entries.get(&key) {
            if entry.observer.is_none()
                || !entry.announced
                || entry.flags.load(Ordering::Acquire) & BROKEN != 0
            {
                return Err(AppError::Other("Git observation is recovering".into()));
            }
        } else {
            let (observer, flags) = Self::observe(&self.factory, &self.sender, &target)?;
            self.entries.insert(
                key.clone(),
                Entry {
                    target,
                    observer: Some(observer),
                    flags,
                    leases: HashSet::new(),
                    dirty: false,
                    announced: true,
                    last_emit: None,
                    retry_at: None,
                    failures: 0,
                },
            );
        }
        self.next_lease = self
            .next_lease
            .checked_add(1)
            .ok_or_else(|| AppError::Other("Git observation lease IDs exhausted".into()))?;
        let id = self.next_lease.to_string();
        self.entries
            .get_mut(&key)
            .unwrap()
            .leases
            .insert(id.clone());
        self.leases.insert(id.clone(), key.clone());
        Ok(Lease { id, repo_root: key })
    }

    fn release(&mut self, id: &str) {
        let Some(key) = self.leases.remove(id) else {
            return;
        };
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.leases.remove(id);
            if entry.leases.is_empty() {
                self.entries.remove(&key);
            }
        }
    }

    fn maintain(&mut self) {
        let now = Instant::now();
        // The registry is worker-local; callbacks touch only generation flags.
        // Scan in place without allocating/cloning repository keys per event.
        for (key, entry) in &mut self.entries {
            let flags = entry.flags.swap(0, Ordering::AcqRel);
            if flags & DIRTY != 0 {
                entry.dirty = true;
            }
            if flags & BROKEN != 0 && entry.observer.is_some() {
                entry.observer = None;
                entry.announced = false;
                entry.retry_at = Some(now + self.timing.retry);
                entry.failures = 0;
            }
            if entry.retry_at.is_some_and(|deadline| deadline <= now) {
                let recovered = Target::resolve(&entry.target.source).and_then(|target| {
                    if target.key != *key {
                        return Err(AppError::Other(
                            "Git watch identity changed during recovery".into(),
                        ));
                    }
                    Self::observe(&self.factory, &self.sender, &target)
                        .map(|(observer, flags)| (target, observer, flags))
                });
                match recovered {
                    Ok((target, observer, flags)) => {
                        entry.target = target;
                        entry.observer = Some(observer);
                        entry.flags = flags;
                        entry.retry_at = None;
                        entry.failures = 0;
                        entry.dirty = true;
                        entry.last_emit = None; // Publish recovery before acknowledging new coverage.
                    }
                    Err(error) => {
                        entry.failures = entry.failures.saturating_add(1);
                        let delay = self
                            .timing
                            .retry
                            .saturating_mul(1 << entry.failures.min(16))
                            .min(self.timing.retry_cap);
                        entry.retry_at = Some(Instant::now() + delay);
                        log::debug!("Git observation recovery for {key} failed; retrying in {delay:?}: {error}");
                    }
                }
            }
            if entry.dirty
                && entry
                    .last_emit
                    .is_none_or(|last| last + self.timing.debounce <= now)
            {
                match (self.emit)(key) {
                    Ok(()) => {
                        entry.dirty = false;
                        entry.announced = entry.observer.is_some();
                    }
                    Err(error) => {
                        log::debug!("Git invalidation delivery for {key} failed: {error}");
                    }
                }
                entry.last_emit = Some(Instant::now());
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.entries
            .values()
            .flat_map(|entry| {
                let emission = entry.dirty.then(|| {
                    entry
                        .last_emit
                        .map_or_else(Instant::now, |last| last + self.timing.debounce)
                });
                [entry.retry_at, emission].into_iter().flatten()
            })
            .min()
    }
}
