//! Remove one entry named by a repo-relative path below a trusted root without
//! following a link anywhere on the way to it or inside it (#1618).
//!
//! The root is resolved by path once and opened (its own ancestors only need
//! search permission, as for any path lookup); every ancestor below it is then
//! opened `O_NOFOLLOW | O_DIRECTORY` relative to its parent's handle, so a
//! component swapped for a symlink or a file is refused by the kernel instead
//! of followed. The entry itself is removed by [`tree_removal`], which
//! observes, admits and unlinks each entry relative to an open directory
//! handle. The caller's `admit` sees every entry (the target is depth 1)
//! before it is entered or unlinked, from the same observation the walk acts
//! on; and every entry of a directory is admitted when the directory is
//! entered, before anything in it is unlinked, so a refusal there (a `.git`
//! that appeared after planning) leaves that directory untouched.
//!
//! What remains: the root path itself is resolved once by name, and a leaf
//! name can be swapped between its observation and `unlinkat` (no portable
//! call unlinks by handle). Either way the effect stays inside the directory
//! handle that was reached without following a link.
use super::{
    native_directory::Directory,
    tree_removal::{self, AbsentRoot, MountEvidence, Policy, Removal},
};
use std::{
    ffi::OsStr,
    io,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path},
};

const POLICY: Policy = Policy {
    max_depth: 32_768,
    mount_evidence: MountEvidence::DeviceFallback,
    // The caller observed the entry while planning; if it has gone since,
    // there is nothing left to remove.
    absent_root: AbsentRoot::Removed,
};

/// One entry offered to the caller before it is entered or unlinked.
pub(crate) struct Observed<'a> {
    /// Path from the target's parent, beginning with the target's own name.
    pub relative: &'a Path,
    /// The target is 1.
    pub depth: usize,
    pub directory: bool,
    pub symlink: bool,
}

#[derive(Debug)]
pub(crate) enum ContainedRemovalError {
    /// The ancestor with this many leading components is a symbolic link.
    SymlinkAncestor(usize),
    /// The ancestor with this many leading components is not a directory.
    NonDirectoryAncestor(usize),
    /// The caller's `admit` refused an entry.
    Refused(String),
    Io(io::Error),
}

impl From<io::Error> for ContainedRemovalError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug)]
pub(crate) struct ContainedRemovalFailure {
    pub error: ContainedRemovalError,
    /// Whether anything was unlinked before the failure.
    pub removed: bool,
}

struct Admitting<F> {
    admit: F,
}

impl<F> Removal for Admitting<F>
where
    F: FnMut(&Observed<'_>) -> Result<(), String>,
{
    type Error = ContainedRemovalError;

    fn entering(&mut self, directory: &Directory, relative: &Path) -> Result<(), Self::Error> {
        let depth = relative.components().count() + 1;
        for name in directory.entries()? {
            let name = name?;
            let stat = match directory.stat(&name) {
                Ok(stat) => stat,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            };
            let kind = stat.st_mode & libc::S_IFMT;
            (self.admit)(&Observed {
                relative: &relative.join(&name),
                depth,
                directory: kind == libc::S_IFDIR,
                symlink: kind == libc::S_IFLNK,
            })
            .map_err(ContainedRemovalError::Refused)?;
        }
        Ok(())
    }

    fn admit(&mut self, entry: &tree_removal::Entry<'_>) -> Result<(), Self::Error> {
        (self.admit)(&Observed {
            relative: entry.relative,
            depth: entry.depth,
            directory: entry.version.directory,
            symlink: entry.version.symlink,
        })
        .map_err(ContainedRemovalError::Refused)
    }
}

/// Remove `relative` (normal components only) below `root`, and everything
/// beneath it. An absent target, or an absent ancestor, is not an error.
pub(crate) fn remove_contained<F>(
    root: &Path,
    relative: &Path,
    admit: F,
) -> Result<(), ContainedRemovalFailure>
where
    F: FnMut(&Observed<'_>) -> Result<(), String>,
{
    let fail = |error| ContainedRemovalFailure {
        error,
        removed: false,
    };
    let names = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name),
            _ => Err(fail(ContainedRemovalError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Contained removal needs a normalised relative path",
            )))),
        })
        .collect::<Result<Vec<&OsStr>, _>>()?;
    let Some((target, ancestors)) = names.split_last() else {
        return Err(fail(ContainedRemovalError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Contained removal needs a non-empty path",
        ))));
    };
    let root = std::fs::canonicalize(root).map_err(|e| fail(e.into()))?;
    // By path, not walked from `/` like `Directory::open`: that needs read
    // permission on every ancestor, and a 0711 home directory has none.
    let mut parent = Directory {
        file: std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&root)
            .map_err(|e| fail(e.into()))?,
    };
    for (index, name) in ancestors.iter().enumerate() {
        parent = match parent.open_existing(name) {
            Ok(child) => child,
            Err(open_error) => {
                return match parent.stat(name) {
                    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(fail(e.into())),
                    Ok(stat) => Err(fail(match stat.st_mode & libc::S_IFMT {
                        libc::S_IFLNK => ContainedRemovalError::SymlinkAncestor(index + 1),
                        libc::S_IFDIR => ContainedRemovalError::Io(open_error),
                        _ => ContainedRemovalError::NonDirectoryAncestor(index + 1),
                    })),
                };
            }
        };
    }
    let mut unbounded = usize::MAX;
    tree_removal::remove(
        &parent,
        target,
        POLICY,
        &mut unbounded,
        &mut Admitting { admit },
    )
    .map_err(|partial| ContainedRemovalFailure {
        error: partial.error,
        removed: partial.removed,
    })
}
