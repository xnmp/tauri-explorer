//! Read-only counters compiled exclusively into native qualification builds.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
};
static READ_BYTES: AtomicU64 = AtomicU64::new(0);
static READ_CALLS: AtomicU64 = AtomicU64::new(0);
static MAX_CHUNK: AtomicU64 = AtomicU64::new(0);
static CONNECTIONS: AtomicU64 = AtomicU64::new(0);
static RESPONSES: LazyLock<Mutex<VecDeque<ResponseObservation>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
#[derive(Clone, Serialize)]
pub(super) struct ResponseObservation {
    at: u128,
    requested_range: Option<String>,
    head: bool,
    status: u16,
    start: u64,
    length: u64,
    size: u64,
}
#[derive(Serialize)]
pub(super) struct Snapshot {
    pub read_bytes: u64,
    pub read_calls: u64,
    pub max_chunk_bytes: u64,
    pub active_connections: u64,
    pub active_leases: usize,
    pub open_workers: usize,
    pub active_streams: usize,
    pub responses: Vec<ResponseObservation>,
}
pub(super) fn record_response(
    range: Option<&str>,
    head: bool,
    status: u16,
    start: u64,
    length: u64,
    size: u64,
) {
    let mut rows = RESPONSES.lock().unwrap();
    if rows.len() == 32 {
        rows.pop_front();
    }
    rows.push_back(ResponseObservation {
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        requested_range: range.map(|value| value.chars().take(128).collect()),
        head,
        status,
        start,
        length,
        size,
    });
}
pub(super) fn record_read(count: usize) {
    READ_BYTES.fetch_add(count as u64, Ordering::Relaxed);
    READ_CALLS.fetch_add(1, Ordering::Relaxed);
    MAX_CHUNK.fetch_max(count as u64, Ordering::Relaxed);
}
pub(super) struct Connection;
impl Connection {
    pub fn entered() -> Self {
        CONNECTIONS.fetch_add(1, Ordering::Relaxed);
        Self
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        CONNECTIONS.fetch_sub(1, Ordering::Relaxed);
    }
}
pub(super) fn snapshot(service: Option<&super::service::Service>) -> Snapshot {
    let (active_leases, open_workers, active_streams) =
        service.map_or((0, 0, 0), |service| service.counts());
    Snapshot {
        read_bytes: READ_BYTES.load(Ordering::Relaxed),
        read_calls: READ_CALLS.load(Ordering::Relaxed),
        max_chunk_bytes: MAX_CHUNK.load(Ordering::Relaxed),
        active_connections: CONNECTIONS.load(Ordering::Relaxed),
        active_leases,
        open_workers,
        active_streams,
        responses: RESPONSES.lock().unwrap().iter().cloned().collect(),
    }
}
