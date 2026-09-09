//! Shared native registration and recovery. Lease ownership lives separately in
//! directory_watches; callbacks never lock that registry or the filesystem service.
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, RwLock,
};
use std::time::{Duration, Instant};

pub(super) type Callback = Box<dyn Fn(notify::Result<Event>) + Send + 'static>;
pub(super) type Factory = Box<dyn Fn(Callback) -> notify::Result<Box<dyn Watcher + Send>> + Send>;
pub(super) type Notify = Arc<dyn Fn(Notice) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Direct,
    Recursive,
}

pub(super) enum Notice {
    Changed { path: PathBuf, names: bool },
    Lost(Vec<PathBuf>),
    Invalidated(Vec<PathBuf>),
    Restored { roots: Vec<PathBuf>, refresh: bool },
    Wake,
}

const ACTIVE: u8 = 1;
const FAULTED: u8 = 2;
const RETIRED: u8 = 4;
const DIRTY: u8 = 8;

struct Source {
    // A new source latches faults before activation. Retired sources reject new
    // callbacks; an already accepted callback may finish conservative invalidation.
    state: AtomicU8,
    // Desired roots, including missing ones: a surviving parent registration
    // must still recognize recreation of an uncovered child.
    roots: RwLock<HashSet<PathBuf>>,
    mode: Mode,
    notify: Notify,
}
impl Source {
    fn new(roots: HashSet<PathBuf>, mode: Mode, notify: Notify) -> Arc<Self> {
        Arc::new(Self {
            state: AtomicU8::new(0),
            roots: RwLock::new(roots),
            mode,
            notify,
        })
    }
    fn healthy(&self) -> bool {
        self.state.load(Ordering::Acquire) == ACTIVE
    }
    fn faulted(&self) -> bool {
        self.state.load(Ordering::Acquire) & FAULTED != 0
    }
    fn retire(&self) {
        self.state.store(RETIRED, Ordering::Release);
    }
    fn activate(&self) -> Option<bool> {
        let mut state = self.state.load(Ordering::Acquire);
        loop {
            if state & (ACTIVE | FAULTED | RETIRED) != 0 {
                return None;
            }
            match self.state.compare_exchange_weak(
                state,
                ACTIVE,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(state & DIRTY != 0),
                Err(current) => state = current,
            }
        }
    }
    /// Preserve relevant callbacks received while native registration is still
    /// being installed. If activation wins the race, deliver the event normally.
    fn defer_change(&self) -> bool {
        let mut state = self.state.load(Ordering::Acquire);
        loop {
            if state & (ACTIVE | FAULTED | RETIRED) != 0 {
                return false;
            }
            match self.state.compare_exchange_weak(
                state,
                state | DIRTY,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(current) => state = current,
            }
        }
    }
    fn fault(&self) {
        let previous = self.state.fetch_or(FAULTED, Ordering::AcqRel);
        if previous == ACTIVE {
            let roots = self.roots.read().unwrap().iter().cloned().collect();
            (self.notify)(Notice::Lost(roots));
            (self.notify)(Notice::Wake);
        }
    }
    fn event(&self, result: notify::Result<Event>) {
        if self.state.load(Ordering::Acquire) & RETIRED != 0 {
            return;
        }
        let event = match result {
            Ok(event) => event,
            Err(error) => {
                log::warn!("Directory observation error: {error}");
                self.fault();
                return;
            }
        };
        log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
            "directory event source={:p} mode={:?} state={} roots={:?} event={:?} rescan={}",
            self, self.mode, self.state.load(Ordering::Acquire),
            self.roots.read().unwrap(), event, event.need_rescan());
        if event.need_rescan() || (event.paths.is_empty() && !event.kind.is_access()) {
            log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                "directory source={:p} classification=fault-rescan-or-empty", self);
            self.fault();
            return;
        }
        if event.kind.is_access() {
            return;
        }
        // Unknown changes may include renames; only explicit content/metadata
        // changes can preserve a name/path cache and the identity of its root.
        let names = !matches!(
            event.kind,
            EventKind::Modify(
                notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Metadata(_)
            )
        );
        let roots = self.roots.read().unwrap();
        if names
            && event.paths.iter().any(|path| {
                roots
                    .iter()
                    .any(|root| root == path || root.parent() == Some(path.as_path()))
            })
        {
            log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                "directory source={:p} classification=fault-root-or-parent", self);
            drop(roots);
            self.fault();
            return;
        }
        if self.mode == Mode::Recursive && !names {
            return;
        }
        let mut changed = HashSet::new();
        for path in &event.paths {
            match self.mode {
                Mode::Direct => {
                    if let Some(parent) = path.parent().filter(|parent| roots.contains(*parent)) {
                        changed.insert(parent.to_path_buf());
                    }
                }
                Mode::Recursive => {
                    if roots.iter().any(|root| path.starts_with(root)) {
                        changed.insert(path.clone());
                    }
                }
            }
        }
        drop(roots);
        if !changed.is_empty() && self.defer_change() {
            log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                "directory source={:p} classification=deferred changed={changed:?}", self);
            return;
        }
        log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
            "directory source={:p} classification=deliver-or-ignore state={} changed={changed:?}",
            self, self.state.load(Ordering::Acquire));
        for path in changed {
            if !self.healthy() {
                break;
            }
            (self.notify)(Notice::Changed { path, names });
        }
    }
}

#[derive(Clone)]
struct Retry {
    at: Instant,
    failures: u32,
}
impl Retry {
    fn after(previous: Option<&Self>, now: Instant) -> Self {
        let failures = previous.map_or(1, |retry| retry.failures.saturating_add(1));
        Self {
            at: now + Duration::from_millis(100 * (1u64 << failures.min(8))),
            failures,
        }
    }
}

pub(super) struct Observation {
    mode: Mode,
    factory: Factory,
    notify: Notify,
    source: Arc<Source>,
    watcher: Option<Box<dyn Watcher + Send>>,
    desired: HashSet<PathBuf>,
    physical: HashSet<PathBuf>,
    covered: HashSet<PathBuf>,
    missing: HashMap<PathBuf, Retry>,
    rebuild_retry: Option<Retry>,
}
impl Observation {
    pub fn new(mode: Mode, factory: Factory, notify: Notify) -> Self {
        Self {
            mode,
            factory,
            source: Source::new(HashSet::new(), mode, notify.clone()),
            notify,
            watcher: None,
            desired: HashSet::new(),
            physical: HashSet::new(),
            covered: HashSet::new(),
            missing: HashMap::new(),
            rebuild_retry: None,
        }
    }
    pub fn healthy(&self, path: &Path) -> bool {
        self.source.healthy() && self.covered.contains(path)
    }
    #[cfg(test)]
    pub fn needs_work(&self) -> bool {
        self.next_work_at(Instant::now()).is_some()
    }
    pub fn next_work_at(&self, now: Instant) -> Option<Instant> {
        if self.desired.is_empty() {
            return None;
        }
        if self.source.faulted() || self.watcher.is_none() {
            return Some(self.rebuild_retry.as_ref().map_or(now, |retry| retry.at));
        }
        self.missing.values().map(|retry| retry.at).min()
    }
    pub fn add(&mut self, path: &Path, retain_failed: bool) -> notify::Result<()> {
        let new = self.desired.insert(path.to_path_buf());
        self.source
            .roots
            .write()
            .unwrap()
            .insert(path.to_path_buf());
        let now = Instant::now();
        let result = if self.healthy(path) {
            Ok(())
        } else if self.watcher.is_none() || self.source.faulted() {
            if self
                .rebuild_retry
                .as_ref()
                .is_some_and(|retry| retry.at > now)
            {
                Err(unavailable(path))
            } else {
                self.rebuild(now, self.source.faulted()).and_then(|()| {
                    if self.healthy(path) {
                        Ok(())
                    } else {
                        Err(unavailable(path))
                    }
                })
            }
        } else if self.missing.get(path).is_some_and(|retry| retry.at > now) {
            Err(unavailable(path))
        } else {
            self.install(path, now, false)
        };
        if result.is_err() && new && !retain_failed {
            let _ = self.remove(path);
        }
        result
    }
    fn required(&self, root: &Path) -> Vec<(PathBuf, RecursiveMode)> {
        match self.mode {
            Mode::Direct => root
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .into_iter()
                .chain(std::iter::once(root))
                .map(|path| (path.to_path_buf(), RecursiveMode::NonRecursive))
                .collect(),
            Mode::Recursive => vec![(root.to_path_buf(), RecursiveMode::Recursive)],
        }
    }
    fn install(&mut self, path: &Path, now: Instant, refresh: bool) -> notify::Result<()> {
        for (physical, mode) in self.required(path) {
            if self.physical.contains(&physical) {
                continue;
            }
            let result = self.watcher.as_mut().unwrap().watch(&physical, mode);
            log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                "directory install source={:p} root={path:?} physical={physical:?} mode={mode:?} state={} result={result:?}",
                Arc::as_ptr(&self.source), self.source.state.load(Ordering::Acquire));
            if let Err(error) = result {
                let retry = Retry::after(self.missing.get(path), now);
                self.missing.insert(path.to_path_buf(), retry);
                // Recursive installation can fail after installing descendants.
                // Reconstruct the shared watcher rather than advertise partial coverage.
                if self.mode == Mode::Recursive {
                    self.source.fault();
                }
                (self.notify)(Notice::Wake);
                return Err(error);
            }
            self.physical.insert(physical);
        }
        if self.source.faulted() {
            return Err(unavailable(path));
        }
        (self.notify)(Notice::Invalidated(vec![path.to_path_buf()]));
        self.covered.insert(path.to_path_buf());
        self.missing.remove(path);
        (self.notify)(Notice::Restored {
            roots: vec![path.to_path_buf()],
            refresh,
        });
        Ok(())
    }
    pub fn remove(&mut self, path: &Path) -> notify::Result<()> {
        let removed = self.desired.remove(path);
        if !removed && self.mode == Mode::Recursive {
            return Ok(());
        }
        self.source.roots.write().unwrap().remove(path);
        self.covered.remove(path);
        self.missing.remove(path);
        if self.desired.is_empty() {
            self.source.retire();
            self.watcher = None;
            self.physical.clear();
            self.rebuild_retry = None;
            return Ok(());
        }
        if self.mode == Mode::Recursive {
            // notify's overlapping recursive registrations share descendant OS
            // watches. Rebuild every survivor, advancing each coverage epoch.
            self.source.fault();
            return self.rebuild(Instant::now(), false);
        }
        let needed: HashSet<PathBuf> = self
            .desired
            .iter()
            .flat_map(|root| self.required(root))
            .map(|(path, _)| path)
            .collect();
        let obsolete: Vec<PathBuf> = self.physical.difference(&needed).cloned().collect();
        for path in obsolete {
            match self.watcher.as_mut().unwrap().unwatch(&path) {
                Ok(()) => {
                    self.physical.remove(&path);
                }
                Err(error) if matches!(error.kind, notify::ErrorKind::WatchNotFound) => {
                    self.physical.remove(&path);
                }
                Err(error) => {
                    self.source.fault();
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    pub fn maintain(&mut self, now: Instant) {
        if self.source.faulted() || self.watcher.is_none() {
            if self
                .rebuild_retry
                .as_ref()
                .is_none_or(|retry| retry.at <= now)
            {
                let _ = self.rebuild(now, true);
            }
            return;
        }
        let due: Vec<PathBuf> = self
            .missing
            .iter()
            .filter(|(_, retry)| retry.at <= now)
            .map(|(path, _)| path.clone())
            .collect();
        for path in due {
            let _ = self.install(&path, now, true);
            if self.source.faulted() {
                break;
            }
        }
    }
    pub fn reset(&mut self, roots: &[String]) -> notify::Result<()> {
        self.desired = roots.iter().map(PathBuf::from).collect();
        self.source.fault();
        self.rebuild(Instant::now(), true)
    }
    fn rebuild(&mut self, now: Instant, refresh: bool) -> notify::Result<()> {
        if self.desired.is_empty() {
            self.source.retire();
            self.watcher = None;
            self.physical.clear();
            self.covered.clear();
            self.missing.clear();
            self.rebuild_retry = None;
            return Ok(());
        }
        // A failed recursive add can leave partial descendants. Discard that
        // candidate, exclude its failing root, and recover healthy siblings on a
        // fresh watcher. Each restart excludes one root, bounding the work.
        let mut excluded = HashMap::new();
        let mut attempted = HashSet::new();
        loop {
            let source = Source::new(self.desired.clone(), self.mode, self.notify.clone());
            log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                "directory rebuild source={:p} previous={:p} mode={:?} desired={:?} refresh={refresh}",
                Arc::as_ptr(&source), Arc::as_ptr(&self.source), self.mode, self.desired);
            let callback_source = source.clone();
            let built = (self.factory)(Box::new(move |event| callback_source.event(event)));
            let mut watcher = match built {
                Ok(watcher) => watcher,
                Err(error) => {
                    source.retire();
                    self.defer_rebuild(now);
                    return Err(error);
                }
            };
            let mut physical = HashSet::new();
            let mut covered = HashSet::new();
            let mut missing = excluded.clone();
            let mut roots: Vec<_> = self
                .desired
                .iter()
                .filter(|root| !excluded.contains_key(*root))
                .collect();
            // Try untested roots before rewalking successful trees. With stable
            // registration outcomes, each successful tree is revisited only in
            // the final candidate. Changing failures can require further walks.
            roots.sort_by_key(|root| {
                (
                    attempted.contains(*root),
                    !self.missing.contains_key(*root),
                    *root,
                )
            });
            let mut partial = None;
            for root in roots {
                let mut complete = true;
                for (path, mode) in self.required(root) {
                    if physical.contains(&path) {
                        continue;
                    }
                    let result = watcher.watch(&path, mode);
                    log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                        "directory register source={:p} root={root:?} physical={path:?} mode={mode:?} state={} result={result:?}",
                        Arc::as_ptr(&source), source.state.load(Ordering::Acquire));
                    if let Err(error) = result {
                        log::warn!(
                            "Directory observation registration failed for {}: {error}",
                            root.display()
                        );
                        // Even PathNotFound may refer to a descendant removed
                        // after part of a recursive tree was installed.
                        if self.mode == Mode::Recursive {
                            partial = Some(root.clone());
                            break;
                        }
                        complete = false;
                        break;
                    }
                    physical.insert(path);
                }
                if partial.is_some() {
                    break;
                }
                if complete {
                    attempted.insert(root.clone());
                    covered.insert(root.clone());
                } else {
                    missing.insert(root.clone(), Retry::after(self.missing.get(root), now));
                }
            }
            if let Some(root) = partial {
                source.retire();
                drop(watcher);
                let retry = Retry::after(self.missing.get(&root), now);
                excluded.insert(root, retry);
                continue;
            }
            if source.faulted() {
                source.retire();
                self.defer_rebuild(now);
                return Err(notify::Error::generic("Observation failed during recovery"));
            }
            // Epochs advance before coverage becomes visible; callbacks during
            // installation request a catch-up refresh after successful activation.
            (self.notify)(Notice::Invalidated(covered.iter().cloned().collect()));
            let Some(dirty) = source.activate() else {
                log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                    "directory activation failed source={:p} state={}",
                    Arc::as_ptr(&source), source.state.load(Ordering::Acquire));
                source.retire();
                self.defer_rebuild(now);
                return Err(notify::Error::generic(
                    "Observation failed during activation",
                ));
            };
            self.source.retire();
            self.source = source;
            self.watcher = Some(watcher);
            self.physical = physical;
            self.covered = covered;
            self.missing = missing;
            self.rebuild_retry = None;
            log::debug!(target: "tauri_explorer_lib::native_watch_diagnostics",
                "directory restored source={:p} covered={:?} missing={:?} refresh={refresh} dirty={dirty}",
                Arc::as_ptr(&self.source), self.covered, self.missing.keys());
            (self.notify)(Notice::Restored {
                roots: self.covered.iter().cloned().collect(),
                refresh: refresh || dirty,
            });
            if !self.missing.is_empty() {
                (self.notify)(Notice::Wake);
            }
            return Ok(());
        }
    }
    fn defer_rebuild(&mut self, now: Instant) {
        self.rebuild_retry = Some(Retry::after(self.rebuild_retry.as_ref(), now));
        (self.notify)(Notice::Wake);
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        self.source.retire();
    }
}
fn unavailable(path: &Path) -> notify::Error {
    notify::Error::generic(&format!("Observation unavailable for {}", path.display()))
}

#[cfg(test)]
#[path = "../../test_support/watch_observation.rs"]
mod tests;
