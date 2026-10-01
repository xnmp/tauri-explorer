//! Bounded, durable entry identities for one retained artifact payload, shared
//! by every recovery kind. Resumption may observe missing planned children; it
//! may never adopt a new child or file.
use super::model::{EntryVersion, NativePath};
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_at},
        native_directory::Directory,
        object_id::ObjectId,
        tree_removal::{self, AbsentRoot, MountEvidence, Policy, Removal},
    },
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::Metadata,
    io,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

const MAX_ENTRIES: usize = 65_536;
const MAX_DEPTH: usize = 256;
/// Journal bytes one discard decision's plans may occupy together: a quarter
/// of the journal, so at most three maximal decisions fit while ordinary
/// operations keep the rest (ADR 0023, ADR 0026).
pub(super) const DECISION_BYTES: usize = super::journal::MAX_TOTAL_BYTES / 4;

/// The share of one decision each of a record's planned roots may encode. A
/// single-root kind (copy replacement) receives the whole decision: 256 bytes
/// for each of `MAX_ENTRIES` entries, which fits the full entry cap whenever
/// names average under about 130 bytes (an entry costs roughly 80 bytes plus
/// 4/3 of its name). Two roots receive half each.
pub(super) fn allowance(roots: usize) -> usize {
    DECISION_BYTES / roots.max(1)
}

/// A resumed cleanup may find planned entries already gone. Linux cleanup
/// requires positive mount identity (see [`mount_ids_match`]).
const REMOVAL: Policy = Policy {
    max_depth: MAX_DEPTH,
    mount_evidence: MountEvidence::Required,
    absent_root: AbsentRoot::Removed,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Entry {
    pub path: NativePath,
    pub version: EntryVersion,
}

/// Preorder entries with absolute paths in memory. The journal encodes the
/// payload path once and each descendant as its parent's index plus its own
/// name, so a plan's size is independent of depth and root location.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Plan {
    entries: Vec<Entry>,
}

/// `EntryVersion` as one positional row: object device and inode, size,
/// modification time, kind (bit 0 directory, bit 1 symlink), mode, uid, gid.
#[derive(Serialize, Deserialize)]
struct Version(u64, u64, u64, i64, u32, u8, u32, u32, u32);

impl Version {
    fn of(version: &EntryVersion) -> io::Result<Self> {
        let (device, inode) = version
            .object
            .unix_parts()
            .ok_or_else(|| invalid("Recovery cleanup entry has a foreign identity"))?;
        Ok(Self(
            device,
            inode,
            version.size,
            version.modified_seconds,
            version.modified_nanos,
            u8::from(version.directory) | (u8::from(version.symlink) << 1),
            version.mode,
            version.uid,
            version.gid,
        ))
    }

    fn decode(self) -> io::Result<EntryVersion> {
        let Self(device, inode, size, seconds, nanos, kind, mode, uid, gid) = self;
        if kind > 0b11 {
            return Err(invalid("Recovery cleanup entry has an unknown kind"));
        }
        let version = EntryVersion {
            object: ObjectId::unix(device, inode),
            size,
            modified_seconds: seconds,
            modified_nanos: nanos,
            directory: kind & 1 != 0,
            symlink: kind & 0b10 != 0,
            mode,
            uid,
            gid,
        };
        version.validate()?;
        Ok(version)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    top: Option<(NativePath, Version)>,
    children: Vec<(usize, String, Version)>,
}

/// The exact encoded size of a plan holding only `top`.
fn top_cost(top: &Path, version: &EntryVersion) -> io::Result<usize> {
    encoded_len(&Wire {
        top: Some((NativePath(top.to_owned()), Version::of(version)?)),
        children: Vec::new(),
    })
}

/// An upper bound on one descendant's encoded size, including its separator:
/// the parent index is charged at the largest index a plan can hold.
fn child_cost(name: &OsStr, version: &EntryVersion) -> io::Result<usize> {
    let row = (MAX_ENTRIES, encode_name(name), Version::of(version)?);
    Ok(encoded_len(&row)? + 1)
}

fn encoded_len(value: &impl Serialize) -> io::Result<usize> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| invalid(&error.to_string()))
}

fn encode_name(name: &OsStr) -> String {
    STANDARD.encode(name.as_encoded_bytes())
}

/// Exactly one normal path component: never empty, `.`, `..` or a separator.
fn decode_name(encoded: &str) -> io::Result<std::ffi::OsString> {
    use std::os::unix::ffi::OsStringExt;
    let name = std::ffi::OsString::from_vec(
        STANDARD
            .decode(encoded)
            .map_err(|_| invalid("Recovery cleanup entry has an invalid name"))?,
    );
    let mut components = Path::new(&name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(part)), None)
            if part == name.as_os_str() && !name.as_encoded_bytes().contains(&0) =>
        {
            Ok(name)
        }
        _ => Err(invalid("Recovery cleanup entry has an invalid name")),
    }
}

impl Serialize for Plan {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error;
        let wire = (|| {
            let mut indices: HashMap<&Path, usize> = HashMap::new();
            let mut children = Vec::new();
            let mut top = None;
            for (index, entry) in self.entries.iter().enumerate() {
                let path = entry.path.0.as_path();
                let version = Version::of(&entry.version)?;
                if index == 0 {
                    top = Some((entry.path.clone(), version));
                } else {
                    let parent = path
                        .parent()
                        .and_then(|parent| indices.get(parent))
                        .ok_or_else(|| invalid("Recovery cleanup entry has no planned parent"))?;
                    let name = path
                        .file_name()
                        .ok_or_else(|| invalid("Recovery cleanup entry has no name"))?;
                    children.push((*parent, encode_name(name), version));
                }
                indices.insert(path, index);
            }
            Ok::<_, io::Error>(Wire { top, children })
        })()
        .map_err(S::Error::custom)?;
        wire.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Plan {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let Wire { top, children } = Wire::deserialize(deserializer)?;
        let Some((path, version)) = top else {
            return if children.is_empty() {
                Ok(Self::default())
            } else {
                Err(D::Error::custom(
                    "Recovery cleanup descendants have no payload",
                ))
            };
        };
        if children.len() >= MAX_ENTRIES {
            return Err(D::Error::custom(
                "Recovery cleanup exceeds its entry budget",
            ));
        }
        let mut entries = vec![Entry {
            path,
            version: version.decode().map_err(D::Error::custom)?,
        }];
        for (parent, name, version) in children {
            // Preorder: a parent always precedes its children.
            let parent = entries
                .get(parent)
                .ok_or_else(|| D::Error::custom("Recovery cleanup entry precedes its parent"))?;
            let path = parent
                .path
                .0
                .join(decode_name(&name).map_err(D::Error::custom)?);
            entries.push(Entry {
                path: NativePath(path),
                version: version.decode().map_err(D::Error::custom)?,
            });
        }
        Ok(Self { entries })
    }
}

impl Plan {
    #[cfg(test)]
    pub(super) fn single(path: NativePath, version: EntryVersion) -> Self {
        Self::of(vec![Entry { path, version }])
    }

    /// Test seam: any entry list, including ones no capture would produce.
    #[cfg(test)]
    pub(super) fn of(entries: Vec<Entry>) -> Self {
        Self { entries }
    }

    /// Preorder makes parent authority explicit and keeps validation linear.
    pub(super) fn validate(
        &self,
        root: &Path,
        payload: Option<(&str, &[EntryVersion])>,
        allowance: usize,
    ) -> io::Result<()> {
        if self.entries.len() > MAX_ENTRIES {
            return Err(invalid("Recovery cleanup exceeds its entry budget"));
        }
        let Some((name, versions)) = payload else {
            return if self.entries.is_empty() {
                Ok(())
            } else {
                Err(invalid("Empty root cannot grant payload removal"))
            };
        };
        let top = root.join(name);
        if !self
            .entries
            .first()
            .is_some_and(|entry| entry.path.0 == top && versions.contains(&entry.version))
        {
            return Err(invalid(
                "Recovery cleanup payload differs from immutable move evidence",
            ));
        }
        let mut parents: HashMap<&Path, &EntryVersion> = HashMap::new();
        let mut budget = Budget::new(allowance);
        budget.top(&top, &self.entries[0].version)?;
        for entry in &self.entries {
            if entry.path.0 != top {
                let name = entry
                    .path
                    .0
                    .file_name()
                    .ok_or_else(|| invalid("Recovery cleanup entry has no name"))?;
                budget.child(name, &entry.version)?;
            }
            entry.version.validate()?;
            on_payload_volume(&entry.version, &versions[0])?;
            let relative = entry
                .path
                .0
                .strip_prefix(root)
                .map_err(|_| invalid("Recovery cleanup escaped its root"))?;
            if relative.components().count() > MAX_DEPTH
                || relative
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
                || !entry.path.0.starts_with(&top)
                || (entry.path.0 != top
                    && !entry
                        .path
                        .0
                        .parent()
                        .and_then(|parent| parents.get(parent))
                        .is_some_and(|version| version.directory && !version.symlink))
                || parents.insert(&entry.path.0, &entry.version).is_some()
            {
                return Err(invalid(
                    "Recovery cleanup has invalid or duplicate child authority",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn capture(
        directory: &Directory,
        root: &Path,
        payload: Option<&str>,
        allowance: usize,
    ) -> Result<Self, AppError> {
        let mut plan = Self::default();
        if let Some(name) = payload {
            let top = root.join(name);
            let mut budget = Budget::new(allowance);
            let payload_mount = payload_mount_id(directory, OsStr::new(name))?;
            walk(
                directory,
                OsStr::new(name),
                Path::new(""),
                1,
                payload_mount,
                &mut |relative, version| {
                    budget.spend(&[top.as_path()], relative, version)?;
                    let path = located(&top, relative);
                    plan.entries.push(Entry {
                        path: NativePath(path),
                        version: version.clone(),
                    });
                    Ok(())
                },
            )?;
        }
        Ok(plan)
    }

    /// Admission of a payload a record is about to retain: at its start,
    /// and for the destination an Undo parks. Walk the live payload under
    /// exactly the rules a plan must satisfy: `capture`'s depth, entry and byte
    /// bounds, charging each entry at every private path it may later occupy,
    /// and `validate`'s refusal to cross into another mounted volume. An
    /// admitted payload therefore always has a retirement plan (#760).
    pub(super) fn admit(
        parent: &Directory,
        name: &OsStr,
        destinations: &[std::path::PathBuf],
        allowance: usize,
    ) -> Result<(), AppError> {
        let destinations: Vec<&Path> = destinations.iter().map(|path| path.as_path()).collect();
        let mut budget = Budget::new(allowance);
        let mut payload: Option<EntryVersion> = None;
        let payload_mount = payload_mount_id(parent, name)?;
        walk(
            parent,
            name,
            Path::new(""),
            1,
            payload_mount,
            &mut |relative, version| {
                // Preorder: the first entry visited is the payload itself.
                on_payload_volume(version, payload.get_or_insert_with(|| version.clone()))?;
                Ok(budget.spend(&destinations, relative, version)?)
            },
        )
    }

    pub(super) fn verify(
        &self,
        directory: &Directory,
        root: &Path,
        removing: bool,
    ) -> Result<(), AppError> {
        let Some(top) = self.entries.first() else {
            return Ok(());
        };
        let index: HashMap<&Path, &EntryVersion> = self
            .entries
            .iter()
            .map(|entry| (entry.path.0.as_path(), &entry.version))
            .collect();
        let name = top
            .path
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery cleanup payload has no name"))?;
        let mut budget = MAX_ENTRIES;
        let payload_mount = if removing {
            existing_payload_mount_id(directory, name)?
        } else {
            payload_mount_id(directory, name)?
        };
        let identity = PayloadIdentity {
            entries: &index,
            mount: payload_mount,
        };
        verify_tree(
            directory,
            name,
            &root.join(name),
            &identity,
            1,
            &mut budget,
            removing,
        )?;
        if !removing && MAX_ENTRIES - budget != self.entries.len() {
            return Err(
                invalid("Recovery cleanup descendants disappeared before removal intent").into(),
            );
        }
        Ok(())
    }

    /// Read-only feasibility check before any removal is journaled: every
    /// planned directory whose entries cleanup unlinks must permit that for
    /// this user. A read-only directory (a Go module cache, a read-only
    /// checkout) would otherwise fail midway after Undo is already consumed.
    /// Walks the retained handles without following links; never changes modes.
    pub(super) fn preflight(&self, directory: &Directory, root: &Path) -> Result<(), AppError> {
        let Some(top) = self.entries.first() else {
            return Ok(());
        };
        let index: HashMap<&Path, &EntryVersion> = self
            .entries
            .iter()
            .map(|entry| (entry.path.0.as_path(), &entry.version))
            .collect();
        let name = top
            .path
            .0
            .file_name()
            .ok_or_else(|| invalid("Recovery cleanup payload has no name"))?;
        removable_in(directory, root, root)?;
        let mut budget = MAX_ENTRIES;
        let payload_mount = existing_payload_mount_id(directory, name)?;
        let identity = PayloadIdentity {
            entries: &index,
            mount: payload_mount,
        };
        preflight_tree(
            directory,
            &directory.metadata()?,
            name,
            &root.join(name),
            root,
            &identity,
            1,
            &mut budget,
        )
    }

    pub(super) fn remove(
        &self,
        directory: &Directory,
        root: &Path,
        checkpoint: &mut impl FnMut(&'static str) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        // Verify the complete remaining namespace before deleting any child.
        self.verify(directory, root, true)?;
        let index: HashMap<&Path, &EntryVersion> = self
            .entries
            .iter()
            .map(|entry| (entry.path.0.as_path(), &entry.version))
            .collect();
        if let Some(top) = self.entries.first() {
            let name = top
                .path
                .0
                .file_name()
                .ok_or_else(|| invalid("Recovery cleanup payload has no name"))?;
            let mut budget = MAX_ENTRIES;
            let mut planned = Planned {
                root,
                entries: &index,
                checkpoint,
            };
            tree_removal::remove(directory, name, REMOVAL, &mut budget, &mut planned)
                .map_err(|partial| partial.error)?;
        }
        Ok(())
    }
}

/// The per-plan bounds shared by capture, admission and validation: entry
/// count and encoded bytes. Only the payload path depends on where the plan
/// will live, so admission charges the longest of its possible locations.
struct Budget {
    entries: usize,
    bytes: usize,
}

impl Budget {
    fn new(allowance: usize) -> Self {
        Self {
            entries: MAX_ENTRIES,
            bytes: allowance,
        }
    }

    /// Charge one walked entry: the payload itself at `relative == ""`.
    fn spend(
        &mut self,
        destinations: &[&Path],
        relative: &Path,
        version: &EntryVersion,
    ) -> io::Result<()> {
        match relative.file_name() {
            None => {
                let mut cost = 0;
                for top in destinations {
                    cost = cost.max(top_cost(top, version)?);
                }
                self.charge(cost)
            }
            Some(name) => self.child(name, version),
        }
    }

    fn top(&mut self, top: &Path, version: &EntryVersion) -> io::Result<()> {
        self.charge(top_cost(top, version)?)
    }

    fn child(&mut self, name: &OsStr, version: &EntryVersion) -> io::Result<()> {
        self.charge(child_cost(name, version)?)
    }

    fn charge(&mut self, cost: usize) -> io::Result<()> {
        self.entries = self
            .entries
            .checked_sub(1)
            .ok_or_else(|| invalid("Recovery cleanup exceeds its entry budget"))?;
        self.bytes = self
            .bytes
            .checked_sub(cost)
            .ok_or_else(|| invalid("Recovery cleanup exceeds its byte budget"))?;
        Ok(())
    }
}

/// `relative` is empty for the payload itself; joining it would add a separator.
fn located(top: &Path, relative: &Path) -> std::path::PathBuf {
    if relative.as_os_str().is_empty() {
        top.to_owned()
    } else {
        top.join(relative)
    }
}

/// Bounded, no-follow preorder walk. The visitor sees each entry's path
/// relative to the payload before its children, as a plan records them.
fn walk(
    parent: &Directory,
    name: &OsStr,
    relative: &Path,
    depth: usize,
    payload_mount: Option<u64>,
    visit: &mut impl FnMut(&Path, &EntryVersion) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Recovery cleanup exceeds its depth budget").into());
    }
    let version = version_at(parent, name)?;
    on_payload_mount(parent, name, relative, payload_mount)?;
    visit(relative, &version)?;
    if version.directory {
        let directory = parent.open_existing(name).map_err(|error| {
            if error.kind() == io::ErrorKind::PermissionDenied {
                let shown = if relative.as_os_str().is_empty() {
                    Path::new(name)
                } else {
                    relative
                };
                AppError::PermissionDenied(format!(
                    "'{}' cannot be read ({error})",
                    shown.display()
                ))
            } else {
                error.into()
            }
        })?;
        if of_file(&directory.file)? != version.object {
            return Err(invalid("Recovery cleanup directory changed during capture").into());
        }
        let children = directory.names(MAX_ENTRIES).map_err(|error| {
            if error.kind() == io::ErrorKind::PermissionDenied {
                let shown = if relative.as_os_str().is_empty() {
                    Path::new(name)
                } else {
                    relative
                };
                AppError::PermissionDenied(format!(
                    "'{}' cannot be read ({error})",
                    shown.display()
                ))
            } else {
                error.into()
            }
        })?;
        for child in children {
            walk(
                &directory,
                &child,
                &located(relative, Path::new(&child)),
                depth + 1,
                payload_mount,
                visit,
            )?;
        }
    }
    if version_at(parent, name)? != version {
        return Err(invalid("Recovery cleanup entry changed during capture").into());
    }
    Ok(())
}

fn observed(
    parent: &Directory,
    name: &OsStr,
    path: &Path,
    index: &HashMap<&Path, &EntryVersion>,
    removing: bool,
) -> Result<Option<EntryVersion>, AppError> {
    // An unplanned name is refused even when it is already gone.
    index
        .get(path)
        .ok_or_else(|| invalid("Recovery cleanup found an unplanned descendant"))?;
    let actual = match version_at(parent, name) {
        Ok(actual) => actual,
        Err(error) if removing && error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    planned(index, path, &actual, removing)?;
    Ok(Some(actual))
}

/// Does `actual` match the plan's authority for `path`? While removing, a
/// directory's size and mtime change as its children go, so only its object,
/// mode and ownership must still match.
fn planned(
    index: &HashMap<&Path, &EntryVersion>,
    path: &Path,
    actual: &EntryVersion,
    removing: bool,
) -> Result<(), AppError> {
    let expected = index
        .get(path)
        .ok_or_else(|| invalid("Recovery cleanup found an unplanned descendant"))?;
    let matches = if expected.directory && removing {
        actual.directory
            && !actual.symlink
            && actual.object == expected.object
            && actual.mode == expected.mode
            && actual.uid == expected.uid
            && actual.gid == expected.gid
    } else {
        actual == *expected
    };
    if !matches {
        return Err(invalid(
            "Recovery cleanup descendant changed; remaining evidence is preserved",
        )
        .into());
    }
    Ok(())
}

fn walk_budget(depth: usize, budget: &mut usize) -> Result<(), AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Recovery cleanup exceeds its depth budget").into());
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| invalid("Recovery cleanup exceeds its entry budget"))?;
    Ok(())
}

struct PayloadIdentity<'a> {
    entries: &'a HashMap<&'a Path, &'a EntryVersion>,
    mount: Option<u64>,
}

fn verify_tree(
    parent: &Directory,
    name: &OsStr,
    path: &Path,
    identity: &PayloadIdentity<'_>,
    depth: usize,
    budget: &mut usize,
    removing: bool,
) -> Result<(), AppError> {
    walk_budget(depth, budget)?;
    let Some(actual) = observed(parent, name, path, identity.entries, removing)? else {
        return Ok(());
    };
    on_payload_mount(parent, name, path, identity.mount)?;
    if actual.directory {
        let directory = parent.open_existing(name)?;
        if of_file(&directory.file)? != actual.object {
            return Err(invalid("Recovery cleanup directory identity changed").into());
        }
        for child in directory.names(MAX_ENTRIES)? {
            verify_tree(
                &directory,
                &child,
                &path.join(&child),
                identity,
                depth + 1,
                budget,
                removing,
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::unnecessary_cast)] // Darwin mode_t is u16.
fn preflight_tree(
    parent: &Directory,
    parent_metadata: &Metadata,
    name: &OsStr,
    path: &Path,
    root: &Path,
    identity: &PayloadIdentity<'_>,
    depth: usize,
    budget: &mut usize,
) -> Result<(), AppError> {
    walk_budget(depth, budget)?;
    let Some(actual) = observed(parent, name, path, identity.entries, true)? else {
        return Ok(());
    };
    on_payload_mount(parent, name, path, identity.mount)?;
    // A sticky directory lets only the entry's or directory's owner unlink it.
    // Root is not exempted: without CAP_FOWNER it obeys the same rule, and a
    // refusal here is always safe because nothing has been journaled yet.
    // SAFETY: geteuid has no preconditions and does not mutate memory.
    let user = unsafe { libc::geteuid() };
    if parent_metadata.mode() & libc::S_ISVTX as u32 != 0
        && user != actual.uid
        && user != parent_metadata.uid()
    {
        return Err(refusal(
            path,
            root,
            io::Error::from_raw_os_error(libc::EPERM),
        ));
    }
    if actual.directory {
        let directory = parent.open_existing(name)?;
        if of_file(&directory.file)? != actual.object {
            return Err(invalid("Recovery cleanup directory identity changed").into());
        }
        let children = directory.names(MAX_ENTRIES)?;
        if !children.is_empty() {
            removable_in(&directory, path, root)?;
            let metadata = directory.metadata()?;
            for child in children {
                preflight_tree(
                    &directory,
                    &metadata,
                    &child,
                    &path.join(&child),
                    root,
                    identity,
                    depth + 1,
                    budget,
                )?;
            }
        }
    }
    Ok(())
}

fn removable_in(directory: &Directory, path: &Path, root: &Path) -> Result<(), AppError> {
    directory
        .permits_entry_removal()
        .map_err(|error| refusal(path, root, error))
}

/// A definite pre-intent refusal: nothing was journaled or removed.
fn refusal(path: &Path, root: &Path, error: io::Error) -> AppError {
    let shown = path.strip_prefix(root).unwrap_or(path);
    let shown = if shown.as_os_str().is_empty() {
        "its recovery folder".to_owned()
    } else {
        format!("'{}'", shown.display())
    };
    AppError::PermissionDenied(format!(
        "Discard cannot remove the retained contents of {shown} ({error}). \
         Nothing was removed and this recovery record is unchanged; make it writable and retry."
    ))
}

/// Removal under a plan: only planned entries, each still matching its
/// recorded authority, and every unlink durable before its checkpoint.
struct Planned<'a, C> {
    root: &'a Path,
    entries: &'a HashMap<&'a Path, &'a EntryVersion>,
    checkpoint: &'a mut C,
}

impl<C: FnMut(&'static str) -> Result<(), AppError>> Removal for Planned<'_, C> {
    type Error = AppError;

    fn admit(&mut self, entry: &tree_removal::Entry<'_>) -> Result<(), AppError> {
        planned(
            self.entries,
            &self.root.join(entry.relative),
            entry.version,
            true,
        )
    }

    fn unlink(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        is_directory: bool,
    ) -> Result<(), AppError> {
        directory.unlink(name, is_directory)?;
        directory.sync()?;
        (self.checkpoint)("entry-removed")
    }

    fn emptied(&mut self, directory: &Directory) -> Result<(), AppError> {
        Ok(directory.sync()?)
    }
}

/// Cleanup unlinks through one volume's handles; a submount inside a payload
/// is someone else's filesystem, never retained evidence.
fn on_payload_volume(entry: &EntryVersion, payload: &EntryVersion) -> io::Result<()> {
    if entry.object.same_volume(payload.object) {
        Ok(())
    } else {
        Err(invalid(
            "Recovery cleanup cannot traverse another mounted volume",
        ))
    }
}

#[cfg(target_os = "linux")]
fn payload_mount_id(parent: &Directory, name: &OsStr) -> io::Result<Option<u64>> {
    let parent_mount = parent.mount_id()?;
    let payload_mount = parent.entry_mount_id(name)?;
    if mount_ids_match(parent_mount, payload_mount) {
        Ok(payload_mount)
    } else {
        Err(invalid(&format!(
            "Recovery cleanup payload root '{}' is a mount point or its mount identity is unavailable",
            Path::new(name).display()
        )))
    }
}

#[cfg(not(target_os = "linux"))]
fn payload_mount_id(_parent: &Directory, _name: &OsStr) -> io::Result<Option<u64>> {
    Ok(None)
}

fn existing_payload_mount_id(parent: &Directory, name: &OsStr) -> io::Result<Option<u64>> {
    if !parent.entry_exists(name)? {
        return Ok(None);
    }
    payload_mount_id(parent, name)
}

#[cfg(target_os = "linux")]
fn on_payload_mount(
    parent: &Directory,
    name: &OsStr,
    path: &Path,
    payload_mount: Option<u64>,
) -> io::Result<()> {
    if mount_ids_match(payload_mount, parent.entry_mount_id(name)?) {
        return Ok(());
    }
    let shown = if path.as_os_str().is_empty() {
        Path::new(name)
    } else {
        path
    };
    Err(invalid(&format!(
        "Recovery cleanup cannot cross mount point '{}'",
        shown.display()
    )))
}

#[cfg(not(target_os = "linux"))]
fn on_payload_mount(
    _parent: &Directory,
    _name: &OsStr,
    _path: &Path,
    _payload_mount: Option<u64>,
) -> io::Result<()> {
    Ok(())
}

/// Linux cleanup requires positive mount-identity evidence. A device match is
/// insufficient because bind mounts retain `st_dev`; unavailable `statx`
/// therefore refuses the operation rather than risking traversal.
pub(super) fn mount_ids_match(payload: Option<u64>, entry: Option<u64>) -> bool {
    matches!((payload, entry), (Some(payload), Some(entry)) if payload == entry)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
