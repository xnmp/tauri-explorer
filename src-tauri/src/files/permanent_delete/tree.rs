//! Handle-relative removal of a captured payload. Only a constant number of
//! directory descriptors stay open: ascending reopens `..` and verifies the
//! recorded identity instead of retaining one descriptor per level.
use super::Operations;
use crate::files::native_directory::Directory;
use std::{
    ffi::{OsStr, OsString},
    io,
    os::unix::fs::MetadataExt,
};

/// Deeper trees stop with retained residue rather than growing without bound.
const MAX_DEPTH: usize = 32_768;

type Object = (u64, u64);

pub(super) struct Partial {
    pub error: io::Error,
    /// Whether any entry was irreversibly unlinked before `error`.
    pub removed: bool,
}

fn object_of(directory: &Directory) -> io::Result<Object> {
    let metadata = directory.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// Remove `name` inside `container`. A directory is walked without following
/// links, never crosses a device or mount boundary, and each opened child must
/// be the object just observed by `fstatat`. Symlinks and special files are
/// leaves. The caller owns classification and any restoration of residue.
pub(super) fn remove(
    container: &Directory,
    name: &OsStr,
    directory: bool,
    operations: &mut impl Operations,
) -> Result<(), Partial> {
    let mut removed = false;
    walk(container, name, directory, operations, &mut removed)
        .map_err(|error| Partial { error, removed })
}

fn walk(
    container: &Directory,
    name: &OsStr,
    directory: bool,
    operations: &mut impl Operations,
    removed: &mut bool,
) -> io::Result<()> {
    if !directory {
        operations.unlink(container, name, false)?;
        *removed = true;
        return Ok(());
    }
    let root = open_child(container, name)?;
    let device = root.1 .0;
    #[cfg(target_os = "linux")]
    let mount = root.0.mount_id()?;
    // Each frame is the parent's identity and this directory's name in it.
    let mut stack: Vec<(Object, OsString)> = Vec::new();
    let (mut current, mut current_object) = root;
    loop {
        let mut child = None;
        // Unlinking during enumeration may hide later entries on some
        // filesystems, so a directory is empty only after a pass sees nothing.
        let mut seen = true;
        while seen && child.is_none() {
            seen = false;
            for entry in current.entries()? {
                let entry = entry?;
                seen = true;
                let stat = match current.stat(&entry) {
                    Ok(stat) => stat,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
                    operations.unlink(&current, &entry, false)?;
                    *removed = true;
                    continue;
                }
                #[allow(clippy::unnecessary_cast)] // Darwin dev_t is signed.
                if stat.st_dev as u64 != device {
                    return Err(invalid("Deletion does not cross a filesystem boundary"));
                }
                child = Some(entry);
                break;
            }
        }
        if let Some(entry) = child {
            if stack.len() == MAX_DEPTH {
                return Err(invalid("Deletion exceeds its directory depth limit"));
            }
            let (opened, object) = open_child(&current, &entry)?;
            #[cfg(target_os = "linux")]
            if opened.mount_id()? != mount {
                return Err(invalid("Deletion does not cross a mount boundary"));
            }
            stack.push((current_object, entry));
            current = opened;
            current_object = object;
            continue;
        }
        let Some((parent_object, entry)) = stack.pop() else {
            drop(current);
            operations.unlink(container, name, true)?;
            *removed = true;
            return Ok(());
        };
        let parent = current.open_parent()?;
        if object_of(&parent)? != parent_object {
            return Err(invalid("A directory moved while it was being deleted"));
        }
        drop(current);
        operations.unlink(&parent, &entry, true)?;
        *removed = true;
        current = parent;
        current_object = parent_object;
    }
}

/// Open a subdirectory and bind it to the entry `fstatat` observed; a swap
/// between observation and open is refused rather than followed.
fn open_child(parent: &Directory, name: &OsStr) -> io::Result<(Directory, Object)> {
    let stat = parent.stat(name)?;
    let opened = parent.open_existing(name)?;
    let object = object_of(&opened)?;
    #[allow(clippy::unnecessary_cast)] // Darwin dev_t/ino_t differ from Linux.
    if object != (stat.st_dev as u64, stat.st_ino as u64) {
        return Err(invalid("A directory changed while it was being deleted"));
    }
    Ok((opened, object))
}
