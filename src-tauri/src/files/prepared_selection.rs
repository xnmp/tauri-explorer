//! One protocol for a whole selection prepared on the blocking worker before
//! any effect, then executed item by item under the claims it captured.
//!
//! Preparation observes every requested entry, records its namespace claims in
//! one [`SelectionIndex`], and retains one aligned item (or its per-item
//! preparation failure) per receipt key under a shared memory budget.
//! Admission takes the claims; execution must then consume the items in the
//! prepared order under the same receipt keys. Operation-specific safety —
//! what an item captures, how it verifies identity at execution, and how it
//! reports recovery or partial effects — stays with the item.
use crate::{
    error::AppError,
    files::{
        entry_version::EntryVersion,
        file_identity::version_from_metadata,
        object_id::ObjectId,
        recovery::resources::{self, Access, Resource, Scope, SelectionIndex, SelectionRole},
    },
};
use std::{
    collections::{HashSet, VecDeque},
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Every prepared selection retains at most this many bytes of plans, keys,
/// observations and per-item failure messages until it executes.
pub(in crate::files) const MAX_PLAN_BYTES: usize = 32 * 1024 * 1024;

/// One operation's prepared effect for a single selected entry.
pub(in crate::files) trait SelectionItem {
    /// Names the operation's selection in preparation errors ("Trash").
    const NOUN: &'static str;
    /// Names the operation's execution in alignment errors ("Trash execution").
    const EXECUTION: &'static str;

    /// Bytes this item retains outside its queue slot.
    fn retained_bytes(&self) -> usize;
}

type Slot<I> = Result<I, String>;

pub(crate) struct PreparedSelection<I> {
    paths: Arc<Vec<String>>,
    next: usize,
    items: VecDeque<Slot<I>>,
    resources: Vec<Resource>,
}

/// An entry observed under its captured namespace claims. `version` is `None`
/// when the entry did not exist; its claims are still retained.
pub(in crate::files) struct ObservedSource {
    pub(in crate::files) path: PathBuf,
    pub(in crate::files) version: Option<EntryVersion>,
    pub(in crate::files) parent: ObjectId,
}

/// The selection's conflict index and the claims admission will hold.
#[derive(Default)]
pub(in crate::files) struct Claims {
    index: SelectionIndex,
    resources: HashSet<Resource>,
}

impl Claims {
    /// Record a claim in the selection index. Overlapping sources, aliases and
    /// artifact namespaces refuse the whole selection.
    pub(in crate::files) fn insert(
        &mut self,
        resource: &Resource,
        role: SelectionRole,
    ) -> io::Result<()> {
        self.index.insert(resource, role)?;
        // Containers exclude selected sources internally. Admitting their
        // broad subtree claim would serialize every independent operation.
        if !matches!(role, SelectionRole::Container) {
            self.resources.insert(resource.clone());
        }
        Ok(())
    }
}

/// Accumulates one selection's claims and items before it is sealed.
pub(in crate::files) struct Preparation<I> {
    claims: Claims,
    items: VecDeque<Slot<I>>,
    used: usize,
    maximum: usize,
}

impl<I: SelectionItem> Preparation<I> {
    pub(in crate::files) fn new(maximum: usize) -> Self {
        Self {
            claims: Claims::default(),
            items: VecDeque::new(),
            used: 0,
            maximum,
        }
    }

    /// Account for bytes the preparation retains. Exceeding the budget refuses
    /// the whole selection; nothing has executed yet.
    pub(in crate::files) fn retain(&mut self, bytes: usize) -> Result<(), AppError> {
        self.used = self.used.saturating_add(bytes);
        if self.used > self.maximum {
            return Err(AppError::InvalidPath(format!(
                "{} selection exceeds its prepared memory budget",
                I::NOUN
            )));
        }
        Ok(())
    }

    /// See [`Claims::insert`].
    pub(in crate::files) fn claim(
        &mut self,
        resource: &Resource,
        role: SelectionRole,
    ) -> io::Result<()> {
        self.claims.insert(resource, role)
    }

    /// Capture `path` as a writable subtree source together with the alias
    /// dependencies that resolve it, then observe the physical entry. The
    /// claim and the observation must name the same object.
    // Trash (Linux-only) observes without inspection; permanent deletion
    // uses `observe_with` on every Unix platform.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(in crate::files) fn observe(&mut self, path: &Path) -> Result<ObservedSource, AppError> {
        self.observe_with(path, |_, _| Ok(()))
            .map(|(source, ())| source)
    }

    /// [`Self::observe`], with `inspect` reading operation-specific identity
    /// of the physical entry immediately after its version is observed and
    /// before any claim is recorded.
    pub(in crate::files) fn observe_with<T>(
        &mut self,
        path: &Path,
        inspect: impl FnOnce(&Path, Option<&EntryVersion>) -> Result<T, AppError>,
    ) -> Result<(ObservedSource, T), AppError> {
        let mut claims = resources::capture_requests(&[resources::Request {
            path: path.to_owned(),
            access: Access::Write,
            scope: Scope::Subtree,
        }])?
        .into_iter();
        let source = claims
            .next()
            .expect("capture retains the primary request first");
        let version = match fs::symlink_metadata(&source.path.0) {
            Ok(metadata) => Some(version_from_metadata(&metadata)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if source.object != version.as_ref().map(|version| version.object) {
            return Err(AppError::Other(format!(
                "{} source changed during namespace capture",
                I::NOUN
            )));
        }
        let inspected = inspect(&source.path.0, version.as_ref())?;
        self.claim(
            &source,
            SelectionRole::Source {
                directory: version.as_ref().is_some_and(|version| version.directory),
            },
        )?;
        for dependency in claims {
            self.claim(&dependency, SelectionRole::Shared)?;
        }
        self.retain(source.path.0.capacity())?;
        let observed = ObservedSource {
            parent: *source
                .ancestors
                .first()
                .expect("validated source has a parent identity"),
            path: source.path.0,
            version,
        };
        Ok((observed, inspected))
    }

    /// Append the next item. A preparation failure stays aligned with its key
    /// and is reported when that key executes; its siblings remain runnable.
    pub(in crate::files) fn push(&mut self, item: Result<I, AppError>) -> Result<(), AppError> {
        let slot = match item {
            Ok(item) => {
                self.retain(item.retained_bytes())?;
                Ok(item)
            }
            Err(error) => {
                let message = error.to_string();
                self.retain(message.capacity())?;
                Err(message)
            }
        };
        self.items.push_back(slot);
        Ok(())
    }

    /// Visit every item prepared so far (per-item failures excluded) with
    /// access to the selection's claims, e.g. to claim each item's artifacts.
    // Only trash claims per-item artifacts, and trash is Linux-only.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(in crate::files) fn claim_prepared(
        &mut self,
        mut visit: impl FnMut(&I, &mut Claims) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        for item in self.items.iter().flatten() {
            visit(item, &mut self.claims)?;
        }
        Ok(())
    }

    /// The prepared slots of a keyless preparation, for an immediate effect
    /// that never enters admission (one native path, no receipt key).
    pub(in crate::files) fn into_items(self) -> VecDeque<Slot<I>> {
        self.items
    }
}

impl<I: SelectionItem> PreparedSelection<I> {
    /// Prepare one item per receipt key. The keys and their queue slots are
    /// budgeted before `plan` observes anything, and `plan` must push exactly
    /// one item or per-item failure per key, in key order.
    pub(in crate::files) fn prepare(
        paths: Arc<Vec<String>>,
        maximum: usize,
        plan: impl FnOnce(&mut Preparation<I>, &[String]) -> Result<(), AppError>,
    ) -> Result<Self, AppError> {
        let mut preparation = Preparation::new(maximum);
        preparation.retain(
            paths
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )?;
        preparation.retain(paths.len().saturating_mul(std::mem::size_of::<Slot<I>>()))?;
        for path in paths.iter() {
            preparation.retain(path.capacity())?;
        }
        preparation.items.reserve_exact(paths.len());
        plan(&mut preparation, &paths)?;
        if preparation.items.len() != paths.len() {
            return Err(AppError::WorkerFailed(format!(
                "{} preparation is not aligned with its selection",
                I::NOUN
            )));
        }
        Ok(Self {
            paths,
            next: 0,
            items: preparation.items,
            resources: preparation.claims.resources.into_iter().collect(),
        })
    }

    /// The plan and claims come from the same observations. No caller may
    /// rebind only the paths while retaining these prepared effects.
    // Selections are admitted on Linux only; other Unix platforms run one
    // unadmitted native permanent deletion.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn into_admission(mut self) -> (Self, Vec<Resource>) {
        let resources = std::mem::take(&mut self.resources);
        (self, resources)
    }

    /// Run the next prepared item, which must belong to `requested`. A
    /// mismatched key consumes nothing; a preparation failure is reported for
    /// its own key without affecting later items.
    pub(in crate::files) fn run_next<T>(
        &mut self,
        requested: &str,
        execute: impl FnOnce(I) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        if self.paths.get(self.next).map(String::as_str) != Some(requested) {
            return Err(AppError::WorkerFailed(format!(
                "{} does not match its prepared selection",
                I::EXECUTION
            )));
        }
        let item = self.items.pop_front().ok_or_else(|| {
            AppError::WorkerFailed(format!("{} exceeded its prepared selection", I::EXECUTION))
        })?;
        self.next += 1;
        execute(item.map_err(AppError::Other)?)
    }

    /// Slots not yet executed, in execution order.
    #[cfg(all(test, target_os = "linux"))]
    pub(in crate::files) fn pending(&self) -> impl Iterator<Item = &Result<I, String>> {
        self.items.iter()
    }
}

#[cfg(test)]
#[path = "../../test_support/prepared_selection.rs"]
mod tests;
