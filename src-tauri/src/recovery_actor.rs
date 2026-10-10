//! Bounded ownership of native recovery attempts. No Store, broker, or provider IO.
//! Durable work remains in its original journal; this actor never creates a new
//! operation or renews the first signal's deadline. The dispatcher owns scoped IO.
use std::{
    collections::VecDeque,
    io,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) const WORKERS: usize = 2;
pub(crate) const PENDING_CAPACITY: usize = 512;
pub(crate) const FINAL_TAIL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Task<G> {
    pub generation: G,
    /// The original aggregate deadline, including all queue wait.
    pub deadline: Instant,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Attempt,
    /// Only bounded local retention/cleanup may run; no provider attempt.
    TailOnly,
    /// No OS/RPC work may begin. Original durable evidence remains retained.
    Expired,
}
#[derive(Debug)]
pub(crate) struct Dispatch<G> {
    pub task: Task<G>,
    pub mode: Mode,
    pub attempt_deadline: Instant,
}
impl<G> Dispatch<G> {
    fn at(task: Task<G>, now: Instant) -> Self {
        let attempt_deadline = task
            .deadline
            .checked_sub(FINAL_TAIL)
            .unwrap_or(task.deadline);
        let mode = if now >= task.deadline {
            Mode::Expired
        } else if now >= attempt_deadline {
            Mode::TailOnly
        } else {
            Mode::Attempt
        };
        Self {
            task,
            mode,
            attempt_deadline,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryOutcome {
    Settled,
    /// Retained evidence needs explicit resume/startup policy. No automatic retry.
    Retained,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Enqueue<G> {
    Accepted,
    Duplicate,
    /// Caller still owns this signal. A durable-owner rescan is required.
    Full(Task<G>),
    /// Shutdown did not accept this signal; durable evidence remains untouched.
    Closed(Task<G>),
}

/// Domain bookkeeping: exact generation equality includes all pinned identity.
struct Queue<G> {
    pending: VecDeque<Task<G>>,
    running: Vec<G>,
    closed: bool,
}
impl<G: Clone + Eq> Queue<G> {
    fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            running: Vec::new(),
            closed: false,
        }
    }
    fn enqueue(&mut self, task: Task<G>) -> Enqueue<G> {
        if self.closed {
            return Enqueue::Closed(task);
        }
        if self.running.contains(&task.generation)
            || self.pending.iter().any(|r| r.generation == task.generation)
        {
            return Enqueue::Duplicate;
        }
        if self.pending.len() >= PENDING_CAPACITY {
            return Enqueue::Full(task);
        }
        self.pending.push_back(task);
        Enqueue::Accepted
    }
    fn take(&mut self) -> Option<Task<G>> {
        let task = self.pending.pop_front()?;
        self.running.push(task.generation.clone());
        Some(task)
    }
    fn finish(&mut self, generation: &G) {
        self.running.retain(|g| g != generation);
    }
    fn close(&mut self) -> Vec<Task<G>> {
        self.closed = true;
        self.pending.drain(..).collect()
    }
}
struct Shared<G> {
    queue: Mutex<Queue<G>>,
    wake: Condvar,
    rescan_needed: AtomicBool,
}
pub(crate) struct RecoveryActor<G: Clone + Eq + Send + 'static> {
    shared: Arc<Shared<G>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}
impl<G: Clone + Eq + Send + 'static> RecoveryActor<G> {
    /// Construct once globally. Exactly two workers are created, never per task.
    /// Dispatcher runs without the queue mutex and must retain owned IO until it
    /// actually ends. It enforces mode and the supplied original deadlines.
    pub fn new(
        dispatch: impl Fn(Dispatch<G>) -> RecoveryOutcome + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::<G>::new()),
            wake: Condvar::new(),
            rescan_needed: AtomicBool::new(false),
        });
        let dispatch = Arc::new(dispatch);
        let mut workers = Vec::with_capacity(WORKERS);
        for index in 0..WORKERS {
            let owned = shared.clone();
            let dispatcher = dispatch.clone();
            match thread::Builder::new()
                .name(format!("native-recovery-{index}"))
                .spawn(move || {
                    loop {
                        let task = {
                            let mut queue = owned
                                .queue
                                .lock()
                                .unwrap_or_else(|cause| cause.into_inner());
                            loop {
                                if queue.closed {
                                    return;
                                }
                                if let Some(task) = queue.take() {
                                    break task;
                                }
                                queue = owned
                                    .wake
                                    .wait(queue)
                                    .unwrap_or_else(|cause| cause.into_inner());
                            }
                        };
                        let generation = task.generation.clone();
                        // A callback panic cannot kill a worker or strand its dedup
                        // ownership. Its durable evidence remains; no renewed budget.
                        let _ = catch_unwind(AssertUnwindSafe(|| {
                            dispatcher(Dispatch::at(task, Instant::now()))
                        }));
                        owned
                            .queue
                            .lock()
                            .unwrap_or_else(|cause| cause.into_inner())
                            .finish(&generation);
                    }
                }) {
                Ok(worker) => workers.push(worker),
                Err(cause) => {
                    shared
                        .queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .close();
                    shared.wake.notify_all();
                    for worker in workers {
                        let _ = worker.join();
                    }
                    return Err(cause);
                }
            }
        }
        Ok(Self {
            shared,
            workers: Mutex::new(workers),
        })
    }
    pub fn enqueue(&self, task: Task<G>) -> Enqueue<G> {
        let result = self
            .shared
            .queue
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .enqueue(task);
        match &result {
            Enqueue::Accepted => self.shared.wake.notify_one(),
            Enqueue::Full(_) => {
                self.shared.rescan_needed.store(true, Ordering::Release);
            }
            _ => {}
        }
        result
    }
    /// Only capacity rejection requests a rescan. Expiry/retention/closure never
    /// renew an exhausted recovery budget. Root rescans original durable owners.
    pub fn take_rescan_needed(&self) -> bool {
        self.shared.rescan_needed.swap(false, Ordering::AcqRel)
    }
    /// Stop admission and return every queued signal to the lifecycle owner.
    /// Running callbacks retain their workers until actual return, including IO.
    pub fn begin_shutdown(&self) -> Vec<Task<G>> {
        let queued = self
            .shared
            .queue
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .close();
        self.shared.wake.notify_all();
        queued
    }
    /// Lifecycle owner only, never call from a dispatcher. OS IO cannot safely
    /// be detached: shutdown may wait for it even after its logical deadline.
    pub fn join(&self) {
        for worker in self
            .workers
            .lock()
            .unwrap_or_else(|cause| cause.into_inner())
            .drain(..)
        {
            let _ = worker.join();
        }
    }
}
impl<G: Clone + Eq + Send + 'static> Drop for RecoveryActor<G> {
    fn drop(&mut self) {
        self.begin_shutdown();
        self.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashSet,
        sync::{atomic::AtomicUsize, mpsc},
    };
    fn task(generation: u64) -> Task<u64> {
        Task {
            generation,
            deadline: Instant::now() + Duration::from_secs(60),
        }
    }
    fn gate() -> Arc<(Mutex<bool>, Condvar)> {
        Arc::new((Mutex::new(false), Condvar::new()))
    }
    fn wait(gate: &Arc<(Mutex<bool>, Condvar)>) {
        let (lock, wake) = &**gate;
        let mut open = lock.lock().unwrap();
        while !*open {
            open = wake.wait(open).unwrap();
        }
    }
    fn release(gate: &Arc<(Mutex<bool>, Condvar)>) {
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
    }

    #[test]
    fn fixed_workers_bound_held_io_and_saturation_returns_the_unaccepted_owner() {
        let hold = gate();
        let worker_gate = hold.clone();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let a = active.clone();
        let p = peak.clone();
        let (sent, received) = mpsc::channel();
        let actor = RecoveryActor::new(move |dispatch| {
            let now = a.fetch_add(1, Ordering::AcqRel) + 1;
            p.fetch_max(now, Ordering::AcqRel);
            sent.send((dispatch.task.generation, thread::current().id()))
                .unwrap();
            wait(&worker_gate);
            a.fetch_sub(1, Ordering::AcqRel);
            RecoveryOutcome::Settled
        })
        .unwrap();
        for id in 0..2 {
            assert_eq!(actor.enqueue(task(id)), Enqueue::Accepted);
        }
        let mut threads = HashSet::new();
        let mut dispatched = HashSet::new();
        for _ in 0..2 {
            let (id, thread) = received.recv_timeout(Duration::from_secs(2)).unwrap();
            dispatched.insert(id);
            threads.insert(thread);
        }
        for id in 2..514 {
            assert_eq!(actor.enqueue(task(id)), Enqueue::Accepted);
        }
        let rejected = task(514);
        assert_eq!(actor.enqueue(rejected.clone()), Enqueue::Full(rejected));
        assert!(actor.take_rescan_needed());
        assert!(!actor.take_rescan_needed());
        assert_eq!(actor.enqueue(task(0)), Enqueue::Duplicate);
        assert_eq!(actor.enqueue(task(400)), Enqueue::Duplicate);
        assert_eq!(active.load(Ordering::Acquire), 2);
        release(&hold);
        for _ in 2..514 {
            let (id, thread) = received.recv_timeout(Duration::from_secs(2)).unwrap();
            dispatched.insert(id);
            threads.insert(thread);
        }
        actor.begin_shutdown();
        actor.join();
        assert_eq!(threads.len(), 2);
        assert_eq!(peak.load(Ordering::Acquire), 2);
        assert_eq!(active.load(Ordering::Acquire), 0);
        assert_eq!(dispatched, (0..514).collect());
    }
    #[test]
    fn queue_wait_expires_the_original_deadline_without_automatic_rescan() {
        let hold = gate();
        let worker_gate = hold.clone();
        let (sent, received) = mpsc::channel();
        let actor = RecoveryActor::new(move |dispatch| {
            sent.send((dispatch.task.clone(), dispatch.mode)).unwrap();
            if dispatch.task.generation < 2 {
                wait(&worker_gate);
            }
            RecoveryOutcome::Retained
        })
        .unwrap();
        for id in 0..2 {
            actor.enqueue(task(id));
        }
        for _ in 0..2 {
            received.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        let expires = Task {
            generation: 2,
            deadline: Instant::now() + Duration::from_millis(25),
        };
        assert_eq!(actor.enqueue(expires.clone()), Enqueue::Accepted);
        let later = Task {
            generation: 2,
            deadline: Instant::now() + Duration::from_secs(60),
        };
        assert_eq!(actor.enqueue(later), Enqueue::Duplicate);
        thread::sleep(
            expires.deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(5),
        );
        release(&hold);
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            (expires, Mode::Expired)
        );
        actor.begin_shutdown();
        actor.join();
        assert!(!actor.take_rescan_needed());
    }
    #[test]
    fn a_started_attempt_and_final_tail_share_the_original_aggregate_budget() {
        let (sent, received) = mpsc::channel();
        let actor = RecoveryActor::new(move |dispatch: Dispatch<u64>| {
            sent.send((
                dispatch.task.deadline,
                dispatch.attempt_deadline,
                dispatch.mode,
            ))
            .unwrap();
            RecoveryOutcome::Settled
        })
        .unwrap();
        let overall = Instant::now() + Duration::from_secs(60);
        actor.enqueue(Task {
            generation: 0,
            deadline: overall,
        });
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            (overall, overall - FINAL_TAIL, Mode::Attempt)
        );
        let tail = Instant::now() + Duration::from_secs(4);
        actor.enqueue(Task {
            generation: 1,
            deadline: tail,
        });
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            (tail, tail - FINAL_TAIL, Mode::TailOnly)
        );
        actor.begin_shutdown();
        actor.join();
    }
    #[test]
    fn shutdown_returns_queued_ownership_and_waits_for_actual_running_io() {
        let hold = gate();
        let worker_gate = hold.clone();
        let (sent, received) = mpsc::channel();
        let actor = Arc::new(
            RecoveryActor::new(move |dispatch| {
                sent.send(dispatch.task.generation).unwrap();
                wait(&worker_gate);
                RecoveryOutcome::Retained
            })
            .unwrap(),
        );
        for id in 0..2 {
            actor.enqueue(task(id));
        }
        for _ in 0..2 {
            received.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        let pending = task(2);
        actor.enqueue(pending.clone());
        assert_eq!(actor.begin_shutdown(), vec![pending]);
        let rejected = task(3);
        assert_eq!(actor.enqueue(rejected.clone()), Enqueue::Closed(rejected));
        assert!(!actor.take_rescan_needed());
        let joined = actor.clone();
        let (done, completion) = mpsc::channel();
        let lifecycle = thread::spawn(move || {
            joined.join();
            done.send(()).unwrap();
        });
        assert!(completion.recv_timeout(Duration::from_millis(25)).is_err());
        release(&hold);
        completion.recv_timeout(Duration::from_secs(2)).unwrap();
        lifecycle.join().unwrap();
        assert!(received.try_recv().is_err());
    }
    #[test]
    fn callback_panic_releases_dedup_and_keeps_workers_without_renewing_a_budget() {
        let (sent, received) = mpsc::channel();
        let calls = AtomicUsize::new(0);
        let actor = RecoveryActor::new(move |dispatch| {
            if dispatch.task.generation == 0 && calls.fetch_add(1, Ordering::AcqRel) == 0 {
                panic!("private recovery fixture panic");
            }
            sent.send(dispatch.task.generation).unwrap();
            RecoveryOutcome::Retained
        })
        .unwrap();
        actor.enqueue(task(0));
        actor.enqueue(task(1));
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if actor.enqueue(task(0)) == Enqueue::Accepted {
                break;
            }
            assert!(Instant::now() < until);
            thread::yield_now();
        }
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), 0);
        actor.begin_shutdown();
        actor.join();
        assert!(!actor.take_rescan_needed());
    }
}
