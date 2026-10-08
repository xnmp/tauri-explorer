//! Ordered, non-blocking persistence of slow-load records (#1022).
//!
//! Records are accepted into a bounded in-memory map under one lock, which
//! also decides precedence, and are then written and logged by one dedicated
//! thread in acceptance order. That thread also identifies the filesystem
//! (mount table, local symlinks) and re-checks precedence against the file
//! already on disk, which outlives the in-memory map. History is read by a
//! second dedicated thread. Neither IPC command touches the disk on the
//! async executor or the shared blocking pool: if the log directory itself
//! sits on a hung mount, only these threads stall, and the report dialog
//! still sees this session's records from memory.
use super::filesystem::{self, FilesystemInfo};
use super::{store, Source, StoredRecord};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

pub(super) const MAX_MEMORY: usize = 20;
/// How long the report dialog waits for the on-disk history before showing
/// only this session's records.
const DISK_READ_TIMEOUT: Duration = Duration::from_secs(2);
/// How long the writer waits to learn the filesystem before writing the
/// record without it.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
static PROBE_BUSY: AtomicBool = AtomicBool::new(false);

enum Job {
    Write {
        dir: PathBuf,
        record: Box<StoredRecord>,
    },
    #[cfg(test)]
    Flush(Sender<()>),
}

struct ReadJob {
    dir: PathBuf,
    limit: usize,
    reply: tokio::sync::oneshot::Sender<Vec<StoredRecord>>,
}

static MEMORY: LazyLock<Mutex<Vec<StoredRecord>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static WORKER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();
static READER: OnceLock<Mutex<Sender<ReadJob>>> = OnceLock::new();

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Whether `next` may replace `existing` for the same trace ID. The frontend
/// record always outranks the coarser native fallback, whatever either
/// outcome: the native command finishing does not mean the pane received
/// its reply. Within one source, a settled outcome is never replaced by a
/// pending capture that arrived late.
pub(super) fn should_replace(existing: Option<&StoredRecord>, next: &StoredRecord) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    match (existing.source, next.source) {
        (Source::Frontend, Source::NativeWatchdog) => false,
        (Source::NativeWatchdog, Source::Frontend) => true,
        _ => {
            let settled = |record: &StoredRecord| record.record.outcome != "pending";
            !(settled(existing) && !settled(next))
        }
    }
}

/// Run `probe` on a helper thread for at most `timeout`, so a probe that
/// blocks (an unforeseen automount, a failing disk) delays this record by
/// the timeout instead of stalling the writer. While one probe is still
/// stuck, later records skip probing rather than piling up threads.
fn probe_bounded(
    path: &str,
    probe: fn(&str) -> Option<FilesystemInfo>,
    busy: &'static AtomicBool,
    timeout: Duration,
) -> Option<FilesystemInfo> {
    if busy.swap(true, Ordering::AcqRel) {
        return None;
    }
    let (send, receive) = mpsc::channel();
    let path = path.to_owned();
    let spawned = std::thread::Builder::new()
        .name("slow-load-fs-probe".into())
        .spawn(move || {
            let info = probe(&path);
            busy.store(false, Ordering::Release);
            let _ = send.send(info);
        });
    if spawned.is_err() {
        busy.store(false, Ordering::Release);
        return None;
    }
    receive.recv_timeout(timeout).ok().flatten()
}

/// Overwrite this session's copy of a record, if it is still held.
fn remember(record: &StoredRecord) {
    let mut memory = lock(&MEMORY);
    if let Some(held) = memory
        .iter_mut()
        .find(|held| held.record.id == record.record.id)
    {
        if held.record.outcome == record.record.outcome && held.source == record.source {
            held.filesystem.clone_from(&record.filesystem);
        } else if !should_replace(Some(record), held) {
            // The file on disk outranks a late capture accepted after the
            // settled record had left the in-memory map.
            *held = record.clone();
        }
    }
}

fn write(dir: &std::path::Path, mut record: StoredRecord) {
    let id = record.record.id.clone();
    if let Some(existing) = store::read_one::<StoredRecord>(dir, &id) {
        if !should_replace(Some(&existing), &record) {
            remember(&existing);
            return;
        }
    }
    if record.filesystem.is_none() {
        record.filesystem = probe_bounded(
            &record.record.path,
            filesystem::filesystem_info,
            &PROBE_BUSY,
            PROBE_TIMEOUT,
        );
        remember(&record);
    }
    super::log_summary(&record);
    if let Err(error) = store::write(dir, &id, &record) {
        log::warn!("slow directory load {id}: failed to persist record: {error}");
    }
}

fn run(jobs: Receiver<Job>) {
    for job in jobs {
        match job {
            Job::Write { dir, record } => write(&dir, *record),
            #[cfg(test)]
            Job::Flush(done) => {
                let _ = done.send(());
            }
        }
    }
}

/// One long-lived thread per job kind. If spawning fails the channel's
/// receiver is dropped and sends fail, which callers already tolerate.
fn dedicated<J: Send + 'static>(
    slot: &'static OnceLock<Mutex<Sender<J>>>,
    name: &str,
    run: fn(Receiver<J>),
) -> Sender<J> {
    let sender = slot.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        if let Err(error) = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || run(receiver))
        {
            log::warn!("{name} thread unavailable: {error}");
        }
        Mutex::new(sender)
    });
    lock(sender).clone()
}

fn worker() -> Option<Sender<Job>> {
    Some(dedicated(&WORKER, "slow-load-diagnostics", run))
}

fn read_history(jobs: Receiver<ReadJob>) {
    for job in jobs {
        let _ = job
            .reply
            .send(store::read_recent::<StoredRecord>(&job.dir, job.limit));
    }
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
    let (reply, receive) = tokio::sync::oneshot::channel();
    // One reusable thread, not the shared blocking pool (which may be
    // saturated by the very listings being diagnosed). If the log directory
    // hangs, later reads queue behind it and each still times out.
    let sent = dedicated(&READER, "slow-load-history", read_history)
        .send(ReadJob { dir, limit, reply })
        .is_ok();
    let disk = if sent {
        tokio::time::timeout(DISK_READ_TIMEOUT, receive)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    } else {
        Vec::new()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::load_diagnostics::filesystem::Category;

    fn info(_: &str) -> Option<FilesystemInfo> {
        Some(FilesystemInfo {
            fs_type: Some("ext4".into()),
            mount_point: Some("/".into()),
            category: Category::Local,
        })
    }

    fn hangs(path: &str) -> Option<FilesystemInfo> {
        std::thread::sleep(Duration::from_millis(400));
        info(path)
    }

    #[test]
    fn a_hung_filesystem_probe_cannot_stall_the_writer() {
        static BUSY: AtomicBool = AtomicBool::new(false);
        let started = std::time::Instant::now();
        assert_eq!(
            probe_bounded("/net/x", hangs, &BUSY, Duration::from_millis(50)),
            None
        );
        // While it is still stuck, the next record does not wait at all.
        assert_eq!(
            probe_bounded("/net/y", hangs, &BUSY, Duration::from_secs(5)),
            None
        );
        assert!(started.elapsed() < Duration::from_millis(300));
        // Once it returns, probing resumes.
        std::thread::sleep(Duration::from_millis(500));
        assert!(probe_bounded("/", info, &BUSY, Duration::from_secs(5)).is_some());
    }
}
