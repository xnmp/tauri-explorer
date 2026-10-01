//! Owner-bound directory leases. The adapter owns OS observation and cache
//! coverage; this state machine owns identity, sharing, retirement and retries.
use crate::{error::AppError, renderer_owner::Owner};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, serde::Serialize)]
pub struct Lease {
    pub id: String,
    pub path: String,
}

pub(super) trait Observer {
    fn healthy(&self, path: &str) -> bool;
    fn watch(&mut self, path: &str) -> notify::Result<()>;
    /// Retain observation demand even if initial registration is unavailable.
    /// Recovery must eventually report restoration through the usual events.
    fn observe(&mut self, path: &str) -> notify::Result<()>;
    fn unwatch(&mut self, path: &str) -> notify::Result<()>;
    /// Install all surviving paths before dropping the old watcher.
    fn replace(&mut self, paths: &[String]) -> notify::Result<()>;
    /// End cache eligibility before attempting physical cleanup.
    fn uncovered(&mut self, path: &str);
}

#[derive(Default)]
struct Entry {
    leases: HashMap<String, Owner>,
    /// New observed reads may wait behind committed physical cleanup. Their
    /// identities remain independent of the retired leases being reclaimed.
    waiting: HashMap<String, Owner>,
    retry_at: Option<Instant>,
    failures: u32,
    uncovered: bool,
}

impl Entry {
    fn retry_after_failure(&mut self, now: Instant) -> u32 {
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(now + Duration::from_millis(100 * (1u64 << self.failures.min(8))));
        self.failures
    }
}

pub(super) struct DirectoryWatches<W> {
    pub observer: W,
    entries: HashMap<String, Entry>,
    next_id: u64,
}

impl<W: Observer> DirectoryWatches<W> {
    pub fn new(observer: W) -> Self {
        Self {
            observer,
            entries: HashMap::new(),
            next_id: 0,
        }
    }

    pub fn covered(&self, path: &str) -> bool {
        self.entries.get(path).is_some_and(|entry| {
            !entry.uncovered
                && entry.leases.values().any(Owner::active)
                && self.observer.healthy(path)
        })
    }

    pub fn acquire(&mut self, owner: &Owner, path: String) -> Result<Lease, AppError> {
        if !owner.active() {
            return Err(closed());
        }
        self.maintain(Instant::now());
        if self
            .entries
            .get(&path)
            .is_some_and(|entry| entry.uncovered || entry.leases.is_empty())
        {
            return Err(AppError::Other(format!(
                "Directory watch cleanup is pending: {path}"
            )));
        }
        if self.entries.contains_key(&path) && !self.observer.healthy(&path) {
            return Err(AppError::Other(format!(
                "Directory observation is recovering: {path}"
            )));
        }
        let next = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| AppError::Other("Directory watch lease IDs exhausted".into()))?;
        let id = self.next_id.to_string();
        self.next_id = next;
        if !self.entries.contains_key(&path) {
            self.observer
                .watch(&path)
                .map_err(|error| watch_error(&path, error))?;
        }
        self.entries
            .entry(path.clone())
            .or_default()
            .leases
            .insert(id.clone(), owner.clone());
        if !owner.active() {
            self.maintain(Instant::now());
            return Err(closed());
        }
        Ok(Lease { id, path })
    }

    /// Browsing owns demand, not a promise that the OS watcher is healthy.
    /// Unlike strict acquisition, transient observation failure cannot make a
    /// readable directory inaccessible. Coverage still checks actual health.
    pub fn observe(&mut self, owner: &Owner, path: String) -> Result<Lease, AppError> {
        if !owner.active() {
            return Err(closed());
        }
        self.maintain(Instant::now());
        let next = self
            .next_id
            .checked_add(1)
            .ok_or_else(|| AppError::Other("Directory watch lease IDs exhausted".into()))?;
        let id = self.next_id.to_string();
        self.next_id = next;
        if !self.entries.contains_key(&path) {
            if let Err(error) = self.observer.observe(&path) {
                log::warn!("Directory observation will retry for {path}: {error}");
            }
        }
        let entry = self.entries.entry(path.clone()).or_default();
        let leases = if entry.uncovered {
            &mut entry.waiting
        } else {
            &mut entry.leases
        };
        leases.insert(id.clone(), owner.clone());
        if !owner.active() {
            self.maintain(Instant::now());
            return Err(closed());
        }
        Ok(Lease { id, path })
    }

    pub fn release(&mut self, owner: &Owner, id: &str) -> Result<(), AppError> {
        for entry in self.entries.values_mut() {
            if entry.waiting.get(id).is_some_and(|held| held.same(owner)) {
                entry.waiting.remove(id);
                return Ok(());
            }
        }
        let Some(path) = self.entries.iter().find_map(|(path, entry)| {
            entry
                .leases
                .get(id)
                .filter(|held| held.same(owner))
                .map(|_| path.clone())
        }) else {
            return Ok(());
        };
        let entry = &self.entries[&path];
        if entry.leases.len() == 1 {
            // Failed release retains authority for retry, but cannot advertise
            // known cache coverage after an ambiguous native unwatch failure.
            if !entry.uncovered {
                self.observer.uncovered(&path);
                self.entries.get_mut(&path).unwrap().uncovered = true;
            }
            if let Err(error) = self.unwatch(&path) {
                self.entries
                    .get_mut(&path)
                    .unwrap()
                    .retry_after_failure(Instant::now());
                return Err(watch_error(&path, error));
            }
            self.complete_cleanup(&path);
        } else {
            self.entries.get_mut(&path).unwrap().leases.remove(id);
        }
        Ok(())
    }

    /// A canceled acquisition must not leave a lease that no renderer received.
    pub fn abandon(&mut self, id: &str) {
        for entry in self.entries.values_mut() {
            if entry.leases.remove(id).is_some() || entry.waiting.remove(id).is_some() {
                break;
            }
        }
        self.maintain(Instant::now());
    }

    #[cfg(test)]
    pub fn needs_cleanup(&self) -> bool {
        self.next_cleanup_at(Instant::now()).is_some()
    }

    pub fn next_cleanup_at(&self, now: Instant) -> Option<Instant> {
        self.entries
            .values()
            .filter(|entry| entry.uncovered || entry.leases.is_empty())
            .map(|entry| entry.retry_at.unwrap_or(now))
            .min()
    }

    pub fn maintain(&mut self, now: Instant) {
        for (path, entry) in &mut self.entries {
            entry.leases.retain(|_, owner| owner.active());
            entry.waiting.retain(|_, owner| owner.active());
            if entry.leases.is_empty() && !entry.uncovered {
                self.observer.uncovered(path);
                entry.uncovered = true;
            }
        }
        let due: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.uncovered && entry.retry_at.is_none_or(|at| at <= now))
            .map(|(path, _)| path.clone())
            .collect();
        for path in due {
            if !self.entries.contains_key(&path) {
                continue;
            }
            match self.unwatch(&path) {
                Ok(()) => {
                    self.complete_cleanup(&path);
                }
                Err(error) => {
                    let entry = self.entries.get_mut(&path).unwrap();
                    let failures = entry.retry_after_failure(now);
                    log::warn!("Directory watch cleanup failed for {path}: {error}");
                    if failures >= 3 {
                        let surviving: Vec<String> = self
                            .entries
                            .iter()
                            .filter(|(_, entry)| !entry.uncovered)
                            .map(|(path, _)| path.clone())
                            .collect();
                        match self.observer.replace(&surviving) {
                            Ok(()) => {
                                let cleaned: Vec<_> = self
                                    .entries
                                    .iter()
                                    .filter(|(_, entry)| entry.uncovered)
                                    .map(|(path, _)| path.clone())
                                    .collect();
                                for path in cleaned {
                                    self.complete_cleanup(&path);
                                }
                            }
                            Err(error) => log::warn!("Directory watcher rebuild failed: {error}"),
                        }
                    }
                }
            }
        }
    }

    fn unwatch(&mut self, path: &str) -> notify::Result<()> {
        match self.observer.unwatch(path) {
            Err(error) if matches!(error.kind, notify::ErrorKind::WatchNotFound) => Ok(()),
            result => result,
        }
    }

    fn complete_cleanup(&mut self, path: &str) {
        let Some(mut entry) = self.entries.remove(path) else {
            return;
        };
        entry.waiting.retain(|_, owner| owner.active());
        if entry.waiting.is_empty() {
            return;
        }
        if let Err(error) = self.observer.observe(path) {
            log::warn!("Directory observation will retry for {path}: {error}");
        }
        self.entries.insert(
            path.into(),
            Entry {
                leases: entry.waiting,
                ..Entry::default()
            },
        );
    }
}

fn closed() -> AppError {
    AppError::Other("Native resource renderer was replaced".into())
}
fn watch_error(path: &str, error: notify::Error) -> AppError {
    AppError::Other(format!("Directory observation failed for {path}: {error}"))
}

#[cfg(test)]
#[path = "../../test_support/directory_watches.rs"]
mod tests;
