//! Bounded, durable entry identities for one move artifact payload. Resumption
//! may observe missing planned children; it may never adopt a new child or file.
use super::model::{EntryVersion, NativePath};
use crate::{
    error::AppError,
    files::{
        file_identity::{of_file, version_at},
        native_directory::Directory,
    },
};
use serde::{Deserialize, Serialize};
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
// Conservative encoded-size bound, leaving journal space for immutable authority.
const MAX_PLAN_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Entry {
    pub path: NativePath,
    pub version: EntryVersion,
}
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Plan {
    entries: Vec<Entry>,
}

impl Plan {
    #[cfg(test)]
    pub(super) fn single(path: NativePath, version: EntryVersion) -> Self {
        Self {
            entries: vec![Entry { path, version }],
        }
    }

    /// Preorder makes parent authority explicit and keeps validation linear.
    pub(super) fn validate(
        &self,
        root: &Path,
        payload: Option<(&str, &[EntryVersion])>,
    ) -> io::Result<()> {
        if self.entries.len() > MAX_ENTRIES {
            return Err(invalid("Move cleanup exceeds its entry budget"));
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
                "Move cleanup payload differs from immutable move evidence",
            ));
        }
        let mut parents: HashMap<&Path, &EntryVersion> = HashMap::new();
        let mut bytes = MAX_PLAN_BYTES;
        for entry in &self.entries {
            spend_bytes(&entry.path.0, &mut bytes)?;
            entry.version.validate()?;
            if !entry.version.object.same_volume(versions[0].object) {
                return Err(invalid(
                    "Move cleanup cannot traverse another mounted volume",
                ));
            }
            let relative = entry
                .path
                .0
                .strip_prefix(root)
                .map_err(|_| invalid("Move cleanup escaped its root"))?;
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
                    "Move cleanup has invalid or duplicate child authority",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn capture(
        directory: &Directory,
        root: &Path,
        payload: Option<&str>,
    ) -> Result<Self, AppError> {
        let mut plan = Self::default();
        if let Some(name) = payload {
            let top = root.join(name);
            let mut budget = Budget::new(1);
            walk(
                directory,
                OsStr::new(name),
                Path::new(""),
                1,
                &mut |relative, version| {
                    let path = located(&top, relative);
                    budget.spend(std::slice::from_ref(&path))?;
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

    /// Forward-move admission. Walk a live payload under exactly the bounds
    /// `capture` applies, charging each entry at every private path it may
    /// later occupy, so an admitted payload always has a retirement plan (#760).
    pub(super) fn admit(
        parent: &Directory,
        name: &OsStr,
        destinations: &[std::path::PathBuf],
    ) -> Result<(), AppError> {
        let mut budget = Budget::new(destinations.len());
        walk(parent, name, Path::new(""), 1, &mut |relative, _| {
            let paths: Vec<_> = destinations
                .iter()
                .map(|top| located(top, relative))
                .collect();
            budget.spend(&paths)
        })
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
            .ok_or_else(|| invalid("Move cleanup payload has no name"))?;
        let mut budget = MAX_ENTRIES;
        verify_tree(
            directory,
            name,
            &root.join(name),
            &index,
            1,
            &mut budget,
            removing,
        )?;
        if !removing && MAX_ENTRIES - budget != self.entries.len() {
            return Err(
                invalid("Move cleanup descendants disappeared before removal intent").into(),
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
            .ok_or_else(|| invalid("Move cleanup payload has no name"))?;
        removable_in(directory, root, root)?;
        let mut budget = MAX_ENTRIES;
        preflight_tree(
            directory,
            &directory.metadata()?,
            name,
            &root.join(name),
            root,
            &index,
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
                .ok_or_else(|| invalid("Move cleanup payload has no name"))?;
            let mut budget = MAX_ENTRIES;
            remove_tree(
                directory,
                name,
                &root.join(name),
                &index,
                1,
                &mut budget,
                checkpoint,
            )?;
        }
        Ok(())
    }
}

/// The per-plan bounds shared by capture, admission and validation: entry
/// count and encoded bytes, charged independently for every destination root.
struct Budget {
    entries: usize,
    bytes: Vec<usize>,
}

impl Budget {
    fn new(destinations: usize) -> Self {
        Self {
            entries: MAX_ENTRIES,
            bytes: vec![MAX_PLAN_BYTES; destinations],
        }
    }

    fn spend(&mut self, paths: &[std::path::PathBuf]) -> Result<(), AppError> {
        self.entries = self
            .entries
            .checked_sub(1)
            .ok_or_else(|| invalid("Move cleanup exceeds its entry budget"))?;
        for (path, bytes) in paths.iter().zip(&mut self.bytes) {
            spend_bytes(path, bytes)?;
        }
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
    visit: &mut impl FnMut(&Path, &EntryVersion) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Move cleanup exceeds its depth budget").into());
    }
    let version = version_at(parent, name)?;
    visit(relative, &version)?;
    if version.directory {
        let directory = parent.open_existing(name)?;
        if of_file(&directory.file)? != version.object {
            return Err(invalid("Move cleanup directory changed during capture").into());
        }
        for child in directory.names(MAX_ENTRIES)? {
            walk(
                &directory,
                &child,
                &located(relative, Path::new(&child)),
                depth + 1,
                visit,
            )?;
        }
    }
    if version_at(parent, name)? != version {
        return Err(invalid("Move cleanup entry changed during capture").into());
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
    let expected = index
        .get(path)
        .ok_or_else(|| invalid("Move cleanup found an unplanned descendant"))?;
    let actual = match version_at(parent, name) {
        Ok(actual) => actual,
        Err(error) if removing && error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let matches = if expected.directory && removing {
        actual.directory
            && !actual.symlink
            && actual.object == expected.object
            && actual.mode == expected.mode
            && actual.uid == expected.uid
            && actual.gid == expected.gid
    } else {
        actual == **expected
    };
    if !matches {
        return Err(
            invalid("Move cleanup descendant changed; remaining evidence is preserved").into(),
        );
    }
    Ok(Some(actual))
}

fn walk_budget(depth: usize, budget: &mut usize) -> Result<(), AppError> {
    if depth > MAX_DEPTH {
        return Err(invalid("Move cleanup exceeds its depth budget").into());
    }
    *budget = budget
        .checked_sub(1)
        .ok_or_else(|| invalid("Move cleanup exceeds its entry budget"))?;
    Ok(())
}

fn verify_tree(
    parent: &Directory,
    name: &OsStr,
    path: &Path,
    index: &HashMap<&Path, &EntryVersion>,
    depth: usize,
    budget: &mut usize,
    removing: bool,
) -> Result<(), AppError> {
    walk_budget(depth, budget)?;
    let Some(actual) = observed(parent, name, path, index, removing)? else {
        return Ok(());
    };
    if actual.directory {
        let directory = parent.open_existing(name)?;
        if of_file(&directory.file)? != actual.object {
            return Err(invalid("Move cleanup directory identity changed").into());
        }
        for child in directory.names(MAX_ENTRIES)? {
            verify_tree(
                &directory,
                &child,
                &path.join(&child),
                index,
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
    index: &HashMap<&Path, &EntryVersion>,
    depth: usize,
    budget: &mut usize,
) -> Result<(), AppError> {
    walk_budget(depth, budget)?;
    let Some(actual) = observed(parent, name, path, index, true)? else {
        return Ok(());
    };
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
            return Err(invalid("Move cleanup directory identity changed").into());
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
                    index,
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
         Nothing was removed and this move's recovery record is unchanged; make it writable and retry."
    ))
}

fn remove_tree(
    parent: &Directory,
    name: &OsStr,
    path: &Path,
    index: &HashMap<&Path, &EntryVersion>,
    depth: usize,
    budget: &mut usize,
    checkpoint: &mut impl FnMut(&'static str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    walk_budget(depth, budget)?;
    let Some(actual) = observed(parent, name, path, index, true)? else {
        return Ok(());
    };
    if actual.directory {
        let directory = parent.open_existing(name)?;
        if of_file(&directory.file)? != actual.object {
            return Err(invalid("Move cleanup directory identity changed").into());
        }
        for child in directory.names(MAX_ENTRIES)? {
            remove_tree(
                &directory,
                &child,
                &path.join(&child),
                index,
                depth + 1,
                budget,
                checkpoint,
            )?;
        }
        directory.sync()?;
    }
    // Recheck the named entry after walking and before unlinking. Directory
    // removal itself refuses any new children that raced the bounded walk.
    if observed(parent, name, path, index, true)?.is_some() {
        parent.unlink(name, actual.directory)?;
        parent.sync()?;
        checkpoint("entry-removed")?;
    }
    Ok(())
}
fn spend_bytes(path: &Path, budget: &mut usize) -> io::Result<()> {
    let cost = path
        .as_os_str()
        .as_encoded_bytes()
        .len()
        .checked_mul(2)
        .and_then(|size| size.checked_add(512))
        .ok_or_else(|| invalid("Move cleanup path exceeds its byte budget"))?;
    *budget = budget
        .checked_sub(cost)
        .ok_or_else(|| invalid("Move cleanup exceeds its byte budget"))?;
    Ok(())
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
