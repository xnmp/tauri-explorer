//! The one handle-relative recursive removal behind every Unix delete path:
//! permanent deletion, replacement retirement and move cleanup (#875).
//!
//! These guarantees hold for every caller; a [`Policy`] only sets bounds and
//! resumption, never whether one of them applies:
//! - **No link is followed.** Each directory is opened `O_NOFOLLOW` relative to
//!   its parent's handle and must be the object `fstatat` just observed, so a
//!   swap between observation and open is refused rather than entered.
//! - **Constant descriptors.** Ascending reopens `..` and requires the recorded
//!   parent identity, and a directory is unlinked only while its name still
//!   refers to the object that was emptied. Depth never costs a descriptor.
//! - **One mount.** Every directory shares its container's device, and on Linux
//!   every entry shares its container's mount id, so a bind mount of the same
//!   filesystem is refused as well. A non-directory may report a lower layer's
//!   device (overlayfs), so only its mount id is compared.
//! - **Bounded.** Depth counts the named root as 1, and every observed entry
//!   spends one unit of the caller's entry budget.
//! - **Caller authority.** [`Removal::admit`] sees every entry, from the same
//!   observation the walk acts on, before it is entered or unlinked.
//!
//! No portable call unlinks a leaf by handle, so a leaf name can still be
//! swapped between its observation and `unlinkat`; the kernel itself refuses
//! to unlink a mount point.
use super::{
    entry_version::EntryVersion,
    file_identity::{of_file, version_of_stat},
    native_directory::Directory,
    object_id::ObjectId,
};
use std::{
    ffi::{OsStr, OsString},
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

/// Bounds and resumption for one removal. The guarantees above are fixed.
#[derive(Clone, Copy, Debug)]
pub(super) struct Policy {
    /// Deepest entry the walk may observe; the named root is depth 1.
    pub max_depth: usize,
    pub mount_evidence: MountEvidence,
    pub absent_root: AbsentRoot,
}

/// How to treat a Linux kernel that cannot report mount ids (before 5.8, or
/// with `statx` filtered). Other Unix platforms have no mount ids; there the
/// device is the only boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum MountEvidence {
    /// Refuse: a bind mount of the same filesystem would be invisible.
    Required,
    /// Compare devices only, like every other device-based mount check.
    DeviceFallback,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AbsentRoot {
    /// Resumable cleanup: a root that is already gone was already removed.
    Removed,
    /// The caller just observed the root, so its absence is a failure.
    Refused,
}

/// One observed entry, offered to the caller before any effect on it.
pub(super) struct Entry<'a> {
    /// Path from the container, beginning with the root's name.
    pub relative: &'a Path,
    /// The named root is 1.
    pub depth: usize,
    pub version: &'a EntryVersion,
}

/// A caller's authority over, and effects on, the entries of one removal.
pub(super) trait Removal {
    type Error: From<io::Error>;

    /// Refuse an entry. Called before each entry is entered or unlinked, and
    /// again, freshly observed, before an emptied directory is unlinked.
    fn admit(&mut self, _entry: &Entry<'_>) -> Result<(), Self::Error> {
        Ok(())
    }

    /// Unlink one admitted entry; durability and checkpoints belong here.
    fn unlink(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        is_directory: bool,
    ) -> Result<(), Self::Error> {
        Ok(directory.unlink(name, is_directory)?)
    }

    /// `directory` is now empty and is about to be unlinked.
    fn emptied(&mut self, _directory: &Directory) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// A failed removal, and whether anything was irreversibly unlinked first.
pub(super) struct Partial<E> {
    pub error: E,
    pub removed: bool,
}

/// Remove `name` inside `container`, and everything beneath it.
/// `entries` is the remaining entry budget, shared across calls if the caller
/// wants one bound for several roots.
pub(super) fn remove<R: Removal>(
    container: &Directory,
    name: &OsStr,
    policy: Policy,
    entries: &mut usize,
    removal: &mut R,
) -> Result<(), Partial<R::Error>> {
    let mut walk = Walk {
        policy,
        entries,
        removal,
        path: PathBuf::new(),
        removed: false,
    };
    walk.run(container, name).map_err(|error| Partial {
        error,
        removed: walk.removed,
    })
}

struct Walk<'a, R> {
    policy: Policy,
    entries: &'a mut usize,
    removal: &'a mut R,
    /// Relative path of the directory being emptied.
    path: PathBuf,
    removed: bool,
}

impl<R: Removal> Walk<'_, R> {
    fn run(&mut self, container: &Directory, name: &OsStr) -> Result<(), R::Error> {
        let fence = Fence {
            mount: directory_mount(container)?,
            evidence: self.policy.mount_evidence,
        };
        let Some(root) = self.observe(container, name, &fence, 1)? else {
            return match self.policy.absent_root {
                AbsentRoot::Removed => Ok(()),
                AbsentRoot::Refused => Err(missing_root().into()),
            };
        };
        if !root.directory {
            return self.unlink(container, name, false);
        }
        let mut current = enter(container, name, &root, &fence)?;
        let mut current_object = root.object;
        self.path.push(name);
        // Each frame is the parent's identity and this directory's name in it.
        let mut stack: Vec<(ObjectId, OsString)> = Vec::new();
        loop {
            if let Some((child, version)) =
                self.next_directory(&current, &fence, stack.len() + 2)?
            {
                let opened = enter(&current, &child, &version, &fence)?;
                self.path.push(&child);
                stack.push((current_object, child));
                current = opened;
                current_object = version.object;
                continue;
            }
            self.removal.emptied(&current)?;
            self.path.pop();
            let Some((parent_object, child)) = stack.pop() else {
                drop(current);
                return self.unlink_emptied(container, name, current_object, &fence, true);
            };
            let parent = current.open_parent()?;
            if of_file(&parent.file)? != parent_object {
                return Err(invalid("A directory moved while it was being removed").into());
            }
            drop(current);
            self.unlink_emptied(&parent, &child, current_object, &fence, false)?;
            current = parent;
            current_object = parent_object;
        }
    }

    /// Unlink every non-directory in `directory` until it holds none, and
    /// return its first admitted subdirectory. Unlinking during enumeration can
    /// hide later entries on some filesystems, so a directory holds no more
    /// work only after a whole pass observes nothing.
    fn next_directory(
        &mut self,
        directory: &Directory,
        fence: &Fence,
        depth: usize,
    ) -> Result<Option<(OsString, EntryVersion)>, R::Error> {
        let mut seen = true;
        while seen {
            seen = false;
            for name in directory.entries()? {
                let name = name?;
                seen = true;
                let Some(version) = self.observe(directory, &name, fence, depth)? else {
                    continue;
                };
                if version.directory {
                    return Ok(Some((name, version)));
                }
                self.unlink(directory, &name, false)?;
            }
        }
        Ok(None)
    }

    /// Spend the bounds for a newly visited entry, then inspect it.
    fn observe(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        fence: &Fence,
        depth: usize,
    ) -> Result<Option<EntryVersion>, R::Error> {
        if depth > self.policy.max_depth {
            return Err(invalid("Removal exceeds its depth limit").into());
        }
        *self.entries = self
            .entries
            .checked_sub(1)
            .ok_or_else(|| invalid("Removal exceeds its entry limit"))?;
        self.inspect(directory, name, fence, depth)
    }

    /// Observe one entry, fence it to the mount and let the caller admit it.
    /// `None` means it is already gone.
    fn inspect(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        fence: &Fence,
        depth: usize,
    ) -> Result<Option<EntryVersion>, R::Error> {
        let observed = directory.stat(name).and_then(|stat| {
            let version = version_of_stat(&stat)?;
            fence.check(entry_mount(directory, name, &stat)?, version.directory)?;
            Ok(version)
        });
        let version = match observed {
            Ok(version) => version,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        self.path.push(name);
        let admitted = self.removal.admit(&Entry {
            relative: &self.path,
            depth,
            version: &version,
        });
        self.path.pop();
        admitted?;
        Ok(Some(version))
    }

    /// Unlink an emptied directory only while its name still refers to it.
    fn unlink_emptied(
        &mut self,
        parent: &Directory,
        name: &OsStr,
        object: ObjectId,
        fence: &Fence,
        root: bool,
    ) -> Result<(), R::Error> {
        let depth = self.path.components().count() + 1;
        match self.inspect(parent, name, fence, depth)? {
            Some(version) if version.directory && version.object == object => {
                self.unlink(parent, name, true)
            }
            Some(_) => Err(invalid("A directory was replaced while it was being removed").into()),
            // Someone else removed the emptied directory: nothing is left to do.
            None if !root || self.policy.absent_root == AbsentRoot::Removed => Ok(()),
            None => Err(missing_root().into()),
        }
    }

    fn unlink(
        &mut self,
        directory: &Directory,
        name: &OsStr,
        is_directory: bool,
    ) -> Result<(), R::Error> {
        self.removal.unlink(directory, name, is_directory)?;
        self.removed = true;
        Ok(())
    }
}

/// Open a subdirectory bound to the object just observed and admitted.
fn enter(
    parent: &Directory,
    name: &OsStr,
    version: &EntryVersion,
    fence: &Fence,
) -> io::Result<Directory> {
    let opened = parent.open_existing(name)?;
    if of_file(&opened.file)? != version.object {
        return Err(invalid("A directory changed while it was being removed"));
    }
    // The handle's own mount is authoritative: a bind mount of the observed
    // directory itself keeps its device and inode.
    fence.check(directory_mount(&opened)?, true)?;
    Ok(opened)
}

/// Where an observation lives. `id` is `None` wherever no mount id is known.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Mount {
    device: u64,
    id: Option<u64>,
}

/// The mount a removal may not leave.
#[derive(Clone, Copy, Debug)]
struct Fence {
    mount: Mount,
    evidence: MountEvidence,
}

impl Fence {
    fn check(&self, observed: Mount, directory: bool) -> io::Result<()> {
        if directory && observed.device != self.mount.device {
            return Err(invalid("Removal does not cross a filesystem boundary"));
        }
        match (self.mount.id, observed.id) {
            (Some(expected), Some(actual)) if expected != actual => {
                Err(invalid("Removal does not cross a mount boundary"))
            }
            (Some(_), Some(_)) => Ok(()),
            // No mount ids exist here; the device is the boundary.
            _ if !cfg!(target_os = "linux") => Ok(()),
            _ => match self.evidence {
                MountEvidence::Required => Err(invalid(
                    "Removal requires mount identity, which this system does not report",
                )),
                MountEvidence::DeviceFallback => Ok(()),
            },
        }
    }
}

fn directory_mount(directory: &Directory) -> io::Result<Mount> {
    Ok(Mount {
        device: directory.metadata()?.dev(),
        #[cfg(target_os = "linux")]
        id: directory.mount_id()?,
        #[cfg(not(target_os = "linux"))]
        id: None,
    })
}

#[allow(clippy::unnecessary_cast)] // Darwin dev_t is signed.
fn entry_mount(directory: &Directory, name: &OsStr, stat: &libc::stat) -> io::Result<Mount> {
    #[cfg(not(target_os = "linux"))]
    let _ = (directory, name);
    Ok(Mount {
        device: stat.st_dev as u64,
        #[cfg(target_os = "linux")]
        id: directory.entry_mount_id(name)?,
        #[cfg(not(target_os = "linux"))]
        id: None,
    })
}

fn missing_root() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        "The entry to remove no longer exists",
    )
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
#[path = "../../test_support/tree_removal.rs"]
mod tests;
