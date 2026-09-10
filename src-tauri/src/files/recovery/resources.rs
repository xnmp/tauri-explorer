//! Declared mutation resources. Conflict policy is pure; capture resolves parent
//! aliases without following the entry being copied, renamed or deleted.
use super::model::{NativePath, ObjectId};
use crate::files::file_identity::from_metadata as object;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashMap, HashSet},
    fs, io,
    path::{Component, Path, PathBuf},
    rc::Rc,
};

pub(super) const MAX_DEPTH: usize = 256;
pub(super) const MAX_CLAIMS: usize = 32_768;
pub(super) const MAX_RESOURCE_BYTES: usize = 32 * 1024 * 1024 - 4096;

#[derive(Clone)]
pub(crate) struct Request {
    pub path: PathBuf,
    pub access: Access,
    pub scope: Scope,
}

pub(in crate::files) fn capture_requests(requests: &[Request]) -> io::Result<Vec<Resource>> {
    validate_requests(requests)?;
    let mut total = 0usize;
    let mut resources = Vec::with_capacity(requests.len());
    let mut aliases = Vec::new();
    let mut inspected = AliasWalk::default();
    for request in requests {
        let resource = capture(&request.path, request.access, request.scope)?;
        total = add_budget(total, &resource.path.0, resource.ancestors.len())?;
        if resource.path.0 != request.path {
            capture_parent_aliases(
                request.path.parent().expect("validated parent"),
                &mut inspected,
                &mut aliases,
                &mut total,
                requests.len(),
                0,
            )?;
        }
        resources.push(resource);
    }
    // The leading resources retain request order for execution bindings. Alias
    // reads are additional ownership, never replacement execution paths.
    resources.extend(aliases);
    Ok(resources)
}

#[derive(Default)]
struct AliasWalk {
    seen: HashSet<PathBuf>,
    bytes: usize,
}

impl AliasWalk {
    fn insert(&mut self, path: &Path) -> io::Result<bool> {
        if self.seen.contains(path) {
            return Ok(false);
        }
        self.bytes = self
            .bytes
            .saturating_add(path.as_os_str().len())
            .saturating_add(128);
        if self.bytes > MAX_RESOURCE_BYTES {
            return Err(invalid(
                "Mutation parent dependency walk exceeds its memory budget",
            ));
        }
        self.seen.insert(path.to_path_buf());
        Ok(true)
    }
}

/// Record every symlink traversed through a parent, including aliases inside
/// another link's relative/absolute target. The coordinator revision surrounds
/// this capture, so a managed change invalidates the whole observation. Native
/// external writers remain interference; workers also use resolved paths.
fn capture_parent_aliases(
    path: &Path,
    inspected: &mut AliasWalk,
    aliases: &mut Vec<Resource>,
    total: &mut usize,
    request_count: usize,
    links: usize,
) -> io::Result<()> {
    if links >= MAX_DEPTH
        || path.components().count() > MAX_DEPTH
        || path.as_os_str().len() > 128 * 1024
    {
        return Err(invalid("Mutation parent has too many symlink dependencies"));
    }
    let prefixes: Vec<_> = path.ancestors().collect();
    for prefix in prefixes.into_iter().rev() {
        if !inspected.insert(prefix)? {
            continue;
        }
        let metadata = match fs::symlink_metadata(prefix) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        };
        if !metadata.file_type().is_symlink() {
            continue;
        }
        let parent = fs::canonicalize(
            prefix
                .parent()
                .ok_or_else(|| invalid("Alias requires a parent"))?,
        )?;
        let name = prefix
            .file_name()
            .ok_or_else(|| invalid("Alias requires a name"))?;
        let alias = capture(&parent.join(name), Access::Read, Scope::Entry)?;
        *total = add_budget(*total, &alias.path.0, alias.ancestors.len())?;
        if request_count + aliases.len() >= MAX_CLAIMS {
            return Err(invalid(
                "Mutation resource and alias set exceeds its claim limit",
            ));
        }
        aliases.push(alias);
        let target = fs::read_link(prefix)?;
        // join preserves absolute targets and resolves relative targets from the
        // physical link parent. Do not collapse `..` before following symlinks.
        capture_parent_aliases(
            &parent.join(target),
            inspected,
            aliases,
            total,
            request_count,
            links + 1,
        )?;
    }
    Ok(())
}

pub(super) fn validate_requests(requests: &[Request]) -> io::Result<()> {
    validate_request_refs(requests.iter())
}

fn validate_request_refs<'a>(requests: impl Iterator<Item = &'a Request>) -> io::Result<()> {
    let mut total = 0;
    let mut count = 0;
    for request in requests {
        count += 1;
        if count > MAX_CLAIMS {
            return Err(invalid("Recovery request set has an invalid size"));
        }
        validate_path(&request.path)?;
        total = add_budget(total, &request.path, 0)?;
    }
    if count == 0 {
        return Err(invalid("Recovery request set has an invalid size"));
    }
    Ok(())
}

pub(super) fn validate_request_groups(groups: &[Vec<Request>]) -> io::Result<()> {
    if groups.iter().any(Vec::is_empty) {
        return Err(invalid("Recovery request group is empty"));
    }
    validate_request_refs(groups.iter().flatten())
}

/// Preserve each child's request order and alias dependencies, applying one
/// aggregate budget before retaining the next captured child.
pub(super) fn capture_request_groups(groups: &[Vec<Request>]) -> io::Result<Vec<Vec<Resource>>> {
    validate_request_groups(groups)?;
    let mut captured = Vec::with_capacity(groups.len());
    let mut count = 0usize;
    let mut bytes = 0;
    for group in groups {
        let resources = capture_requests(group)?;
        count += resources.len();
        if count > MAX_CLAIMS {
            return Err(invalid("Recovery resource set has an invalid size"));
        }
        for resource in &resources {
            bytes = add_budget(bytes, &resource.path.0, resource.ancestors.len())?;
        }
        captured.push(resources);
    }
    Ok(captured)
}

// Native paths use base64; identity bounds include the native wire shape. This is a
// conservative upper bound before capture/JSON allocation, including JSON keys.
fn add_budget(total: usize, path: &Path, ancestors: usize) -> io::Result<usize> {
    let next = total
        .saturating_add(path.as_os_str().len().saturating_mul(2))
        .saturating_add(ancestors.saturating_mul(ObjectId::MAX_ENCODED_BYTES + 1))
        .saturating_add(512);
    if next > MAX_RESOURCE_BYTES {
        return Err(invalid(
            "Recovery resource set exceeds its encoded memory budget",
        ));
    }
    Ok(next)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Access {
    Read,
    Write,
}

/// Queries scale with resource depth and indexed lookup, not the product of two
/// batch sizes. Read-only claims query only writers; writers query both groups.
#[derive(Default)]
pub(super) struct ConflictIndex {
    readers: Claims,
    writers: Claims,
}

#[derive(Default)]
struct Claims {
    paths: PathClaims,
    namespaces: HashMap<ObjectId, PathClaims>,
    objects: HashSet<ObjectId>,
    subtree_objects: HashSet<ObjectId>,
    ancestors: HashSet<ObjectId>,
}

impl ConflictIndex {
    pub(super) fn insert(&mut self, resource: &Resource) {
        let claims = match resource.access {
            Access::Read => &mut self.readers,
            Access::Write => &mut self.writers,
        };
        claims.insert(resource);
    }

    pub(super) fn conflicts(&self, resource: &Resource) -> bool {
        let path = PathKey::new(&resource.path.0);
        self.writers.conflicts(resource, &path)
            || resource.access == Access::Write && self.readers.conflicts(resource, &path)
    }
}

impl Claims {
    fn insert(&mut self, resource: &Resource) {
        let path = PathKey::new(&resource.path.0);
        self.paths.insert(path.clone(), resource.scope);
        for (ancestor, suffix) in path.namespaces(&resource.ancestors) {
            self.namespaces
                .entry(ancestor)
                .or_default()
                .insert(suffix, resource.scope);
        }
        self.objects.extend(resource.object);
        self.ancestors.extend(&resource.ancestors);
        if resource.scope == Scope::Subtree {
            self.subtree_objects.extend(resource.object);
        }
    }

    fn conflicts(&self, resource: &Resource, path: &PathKey) -> bool {
        resource
            .object
            .is_some_and(|object| self.objects.contains(&object))
            || self.namespace_conflicts(resource, path)
    }

    fn namespace_conflicts(&self, resource: &Resource, path: &PathKey) -> bool {
        self.paths.conflicts(path, resource.scope)
            || path
                .namespaces(&resource.ancestors)
                .any(|(ancestor, suffix)| {
                    self.namespaces
                        .get(&ancestor)
                        .is_some_and(|paths| paths.conflicts(&suffix, resource.scope))
                })
            || resource
                .ancestors
                .iter()
                .any(|object| self.subtree_objects.contains(object))
            || resource.scope == Scope::Subtree
                && resource
                    .object
                    .is_some_and(|object| self.ancestors.contains(&object))
    }
}

/// Roles within one intent differ from inter-operation writer exclusion:
/// distinct hardlink sources and shared layout directories may coexist, while
/// destination names remain exclusive. Containers additionally exclude sources
/// anywhere inside an artifact root without serializing all of its children.
#[derive(Clone, Copy)]
pub(in crate::files) enum SelectionRole {
    Source { directory: bool },
    Exclusive,
    Shared,
    Container,
}

#[derive(Default)]
pub(in crate::files) struct SelectionIndex {
    sources: Claims,
    non_directory_sources: HashSet<ObjectId>,
    exclusive: Claims,
    shared: Claims,
    containers: Claims,
    shared_observations: HashSet<Resource>,
    container_observations: HashSet<Resource>,
    count: usize,
    bytes: usize,
}

impl SelectionIndex {
    pub(in crate::files) fn insert(
        &mut self,
        resource: &Resource,
        role: SelectionRole,
    ) -> io::Result<()> {
        resource.validate()?;
        let valid_scope = match role {
            SelectionRole::Source { .. } | SelectionRole::Container => {
                resource.scope == Scope::Subtree
            }
            SelectionRole::Shared => resource.scope == Scope::Entry,
            SelectionRole::Exclusive => true,
        };
        if !valid_scope {
            return Err(invalid(
                "File selection role has an incompatible resource scope",
            ));
        }
        let repeated = match role {
            SelectionRole::Shared => self.shared_observations.contains(resource),
            SelectionRole::Container => self.container_observations.contains(resource),
            _ => false,
        };
        if repeated {
            return Ok(());
        }
        if self.count == MAX_CLAIMS {
            return Err(invalid("File selection exceeds its resource count limit"));
        }
        let bytes = add_budget(self.bytes, &resource.path.0, resource.ancestors.len())?;
        let path = PathKey::new(&resource.path.0);
        let conflict = match role {
            SelectionRole::Source { directory } => {
                self.sources.namespace_conflicts(resource, &path)
                    || resource.object.is_some_and(|object| {
                        self.sources.objects.contains(&object)
                            && (directory || !self.non_directory_sources.contains(&object))
                    })
                    || self.exclusive.conflicts(resource, &path)
                    || self.shared.conflicts(resource, &path)
                    || self.containers.conflicts(resource, &path)
            }
            SelectionRole::Exclusive => {
                self.sources.conflicts(resource, &path)
                    || self.exclusive.conflicts(resource, &path)
                    || self.shared.conflicts(resource, &path)
            }
            SelectionRole::Shared => {
                self.sources.conflicts(resource, &path) || self.exclusive.conflicts(resource, &path)
            }
            SelectionRole::Container => self.sources.conflicts(resource, &path),
        };
        if conflict {
            return Err(invalid(
                "File selection contains overlapping source or artifact namespaces",
            ));
        }
        match role {
            SelectionRole::Source { directory } => {
                self.sources.insert(resource);
                if !directory {
                    self.non_directory_sources.extend(resource.object);
                }
            }
            SelectionRole::Exclusive => self.exclusive.insert(resource),
            SelectionRole::Shared => {
                self.shared.insert(resource);
                self.shared_observations.insert(resource.clone());
            }
            SelectionRole::Container => {
                self.containers.insert(resource);
                self.container_observations.insert(resource.clone());
            }
        }
        self.count += 1;
        self.bytes = bytes;
        Ok(())
    }
}

/// The same component-wise overlap policy serves logical paths and paths
/// relative to a captured physical directory. Keys share one encoding per claim.
#[derive(Default)]
struct PathClaims {
    paths: BTreeSet<PathKey>,
    // Minimal covering subtrees: no member is an ancestor of another. Their
    // disjoint component-prefix ranges allow one predecessor lookup per query.
    subtrees: BTreeSet<PathKey>,
}

impl PathClaims {
    fn insert(&mut self, path: PathKey, scope: Scope) {
        self.paths.insert(path.clone());
        if scope == Scope::Subtree && !self.covered_by_subtree(&path) {
            while let Some(descendant) = self
                .subtrees
                .range(path.clone()..)
                .next()
                .filter(|entry| entry.starts_with(&path))
                .cloned()
            {
                self.subtrees.remove(&descendant);
            }
            self.subtrees.insert(path);
        }
    }

    fn conflicts(&self, path: &PathKey, scope: Scope) -> bool {
        self.paths.contains(path)
            || self.covered_by_subtree(path)
            || scope == Scope::Subtree
                && self
                    .paths
                    .range(path.clone()..)
                    .next()
                    .is_some_and(|entry| entry.starts_with(path))
    }

    fn covered_by_subtree(&self, path: &PathKey) -> bool {
        self.subtrees
            .range(..=path.clone())
            .next_back()
            .is_some_and(|ancestor| path.starts_with(ancestor))
    }
}

/// Component-delimited keys preserve path equality and subtree prefixes without
/// reparsing long shared prefixes during every ordered comparison. Native names
/// cannot contain NUL. Every component includes its delimiter, so `a` never owns
/// `a-more`. One shared allocation backs the absolute key and all ancestor suffixes.
#[derive(Clone)]
struct PathKey {
    bytes: Rc<[u8]>,
    offset: usize,
}

impl PathKey {
    fn new(path: &Path) -> Self {
        let mut bytes = Vec::with_capacity(path.as_os_str().len());
        for component in path.components() {
            if let Component::Normal(name) = component {
                bytes.extend_from_slice(name.as_encoded_bytes());
                bytes.push(0);
            }
        }
        Self {
            bytes: bytes.into(),
            offset: 0,
        }
    }

    fn suffix(&self) -> &[u8] {
        &self.bytes[self.offset..]
    }

    fn starts_with(&self, parent: &Self) -> bool {
        self.suffix().starts_with(parent.suffix())
    }

    // Index every existing ancestor: another capture may observe that a missing
    // intermediate directory now exists. Canonicalize alone retains bind aliases.
    fn namespaces<'a>(
        &'a self,
        ancestors: &'a [ObjectId],
    ) -> impl Iterator<Item = (ObjectId, Self)> + 'a {
        let mut path = self.clone();
        ancestors.iter().rev().copied().map(move |identity| {
            let suffix = path.clone();
            path.offset += path
                .suffix()
                .iter()
                .position(|byte| *byte == 0)
                .map_or(0, |end| end + 1);
            (identity, suffix)
        })
    }
}

impl PartialEq for PathKey {
    fn eq(&self, other: &Self) -> bool {
        self.suffix() == other.suffix()
    }
}
impl Eq for PathKey {}
impl PartialOrd for PathKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for PathKey {
    fn cmp(&self, other: &Self) -> Ordering {
        self.suffix().cmp(other.suffix())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Scope {
    Entry,
    Subtree,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Resource {
    pub path: NativePath,
    pub object: Option<ObjectId>,
    pub ancestors: Vec<ObjectId>,
    pub access: Access,
    pub scope: Scope,
}

impl Resource {
    pub(super) fn validate(&self) -> io::Result<()> {
        validate_path(&self.path.0)?;
        if self.ancestors.is_empty()
            || self.ancestors.len() > MAX_DEPTH
            || self.ancestors.len() >= self.path.0.ancestors().count()
        {
            return Err(invalid("Recovery resource has an invalid ancestor count"));
        }
        Ok(())
    }
}

pub(super) fn validate(resources: &[Resource]) -> io::Result<()> {
    if resources.is_empty() || resources.len() > MAX_CLAIMS {
        return Err(invalid("Recovery resource set has an invalid size"));
    }
    let mut total = 0;
    for resource in resources {
        resource.validate()?;
        total = add_budget(total, &resource.path.0, resource.ancestors.len())?;
    }
    Ok(())
}

/// Preserve missing suffixes, but resolve every existing parent alias. The leaf
/// is lstat'ed, never canonicalized: deleting a symlink owns the link itself.
pub(in crate::files) fn capture(path: &Path, access: Access, scope: Scope) -> io::Result<Resource> {
    validate_path(path)?;
    let name = path
        .file_name()
        .ok_or_else(|| invalid("Mutation resource requires an entry name"))?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Mutation resource requires a parent"))?;
    let mut existing = parent.to_path_buf();
    let mut missing = Vec::new();
    let resolved_parent = loop {
        match fs::canonicalize(&existing) {
            Ok(path) => break path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(&existing).is_ok() {
                    return Err(invalid(
                        "Mutation parent exists but its target cannot be resolved",
                    ));
                }
                let name = existing.file_name().ok_or(error)?.to_owned();
                missing.push(name);
                existing.pop();
            }
            Err(error) => return Err(error),
        }
    };
    if !fs::metadata(&resolved_parent)?.is_dir() {
        return Err(invalid("Mutation resource parent is not a directory"));
    }
    let mut ancestors = Vec::new();
    for ancestor in resolved_parent.ancestors() {
        if ancestors.len() == MAX_DEPTH {
            return Err(invalid("Resolved resource has too many ancestors"));
        }
        ancestors.push(object(&fs::metadata(ancestor)?));
    }
    let resolved = missing
        .iter()
        .rev()
        .fold(resolved_parent, |path, name| path.join(name))
        .join(name);
    let identity = match fs::symlink_metadata(&resolved) {
        Ok(metadata) => Some(object(&metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let resource = Resource {
        path: NativePath(resolved),
        object: identity,
        ancestors,
        access,
        scope,
    };
    resource.validate()?;
    Ok(resource)
}

fn validate_path(path: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    if !path.is_absolute()
        || bytes.len() > 128 * 1024
        || bytes.contains(&0)
        || path.components().count() > MAX_DEPTH
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(
            "Recovery resource must be a bounded absolute normalized path",
        ));
    }
    Ok(())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "../../../test_support/recovery_resources.rs"]
mod tests;
