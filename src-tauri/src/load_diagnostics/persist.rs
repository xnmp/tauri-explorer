//! Ordered, non-blocking persistence of slow-load records (#1022).
//!
//! Records are accepted into a bounded in-memory map under one lock, which
//! also decides precedence, and are then written and logged by one dedicated
//! thread in acceptance order. Neither IPC command touches the disk on the
//! async executor or the shared blocking pool: if the log directory itself
//! sits on a hung mount, only this worker stalls, and the report dialog still
//! sees this session's records from memory.
use super::{store, Source, StoredRecord};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

pub(super) const MAX_MEMORY: usize = 20;
/// How long the report dialog waits for the on-disk history before showing
/// only this session's records.
const DISK_READ_TIMEOUT: Duration = Duration::from_secs(2);

enum Job {
    Write {
        dir: PathBuf,
        record: Box<StoredRecord>,
    },
    #[cfg(test)]
    Flush(Sender<()>),
}

static MEMORY: LazyLock<Mutex<Vec<StoredRecord>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static WORKER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Whether `next` may replace `existing` for the same trace ID. A settled
/// outcome is never replaced by a pending capture that arrived late, and the
/// frontend record is never replaced by the coarser native fallback.
pub(super) fn should_replace(existing: Option<&StoredRecord>, next: &StoredRecord) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    let settled = |record: &StoredRecord| record.record.outcome != "pending";
    if settled(existing) && !settled(next) {
        return false;
    }
    !(existing.source == Source::Frontend && next.source == Source::NativeWatchdog)
}

fn run(jobs: Receiver<Job>) {
    for job in jobs {
        match job {
            Job::Write { dir, record } => {
                super::log_summary(&record);
                if let Err(error) = store::write(&dir, &record.record.id, &record) {
                    log::warn!(
                        "slow directory load {}: failed to persist record: {error}",
                        record.record.id
                    );
                }
            }
            #[cfg(test)]
            Job::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}

fn worker() -> Option<Sender<Job>> {
    let sender = WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        if let Err(error) = std::thread::Builder::new()
            .name("slow-load-diagnostics".into())
            .spawn(move || run(receiver))
        {
            log::warn!("slow-load diagnostics worker unavailable: {error}");
        }
        Mutex::new(sender)
    });
    Some(lock(sender).clone())
}

/// Accept a record if it takes precedence, then queue its write. Returns
/// whether it was accepted.
pub(super) fn submit(dir: PathBuf, record: StoredRecord) -> bool {
    let mut memory = lock(&MEMORY);
    let index = memory
        .iter()
        .position(|existing| existing.record.id == record.record.id);
    if !should_replace(index.map(|index| &memory[index]), &record) {
        return false;
    }
    match index {
        Some(index) => memory[index] = record.clone(),
        None => memory.push(record.clone()),
    }
    memory.sort_by(|a, b| b.record.id.cmp(&a.record.id));
    memory.truncate(MAX_MEMORY);
    // Queue while holding the lock so write order equals precedence order.
    if let Some(worker) = worker() {
        let _ = worker.send(Job::Write {
            dir,
            record: Box::new(record),
        });
    }
    true
}

/// Records kept on disk (any session) overlaid with this session's newer
/// in-memory state, newest first.
pub(super) fn merge_recent(
    memory: Vec<StoredRecord>,
    disk: Vec<StoredRecord>,
    limit: usize,
) -> Vec<StoredRecord> {
    let mut merged = memory;
    for record in disk {
        if !merged
            .iter()
            .any(|existing| existing.record.id == record.record.id)
        {
            merged.push(record);
        }
    }
    merged.sort_by(|a, b| b.record.id.cmp(&a.record.id));
    merged.truncate(limit);
    merged
}

pub(super) async fn recent(dir: PathBuf, limit: usize) -> Vec<StoredRecord> {
    let memory = lock(&MEMORY).clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    // A plain thread: the shared blocking pool may be saturated by the very
    // hung listings being diagnosed.
    let spawned = std::thread::Builder::new()
        .name("slow-load-history".into())
        .spawn(move || {
            let _ = send.send(store::read_recent::<StoredRecord>(&dir, limit));
        });
    let disk = match spawned {
        Ok(_) => tokio::time::timeout(DISK_READ_TIMEOUT, receive)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    merge_recent(memory, disk, limit)
}

#[cfg(test)]
pub(super) fn flush() {
    let (done, wait) = mpsc::channel();
    if let Some(worker) = worker() {
        let _ = worker.send(Job::Flush(done));
        let _ = wait.recv_timeout(Duration::from_secs(10));
    }
}
