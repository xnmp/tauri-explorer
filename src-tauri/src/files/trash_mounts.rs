//! Lossless Linux mount identities used by Freedesktop trash placement.

use crate::error::AppError;
use std::{
    ffi::{CString, OsString},
    os::unix::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Mount {
    pub id: u64,
    pub parent_id: u64,
    pub root: PathBuf,
    pub mount_point: PathBuf,
    pub filesystem: OsString,
}

#[derive(Clone, Debug)]
pub(super) struct MountSnapshot {
    mounts: Vec<Mount>,
}

impl MountSnapshot {
    pub fn read() -> Result<Self, AppError> {
        let bytes = std::fs::read("/proc/self/mountinfo")?;
        Self::parse(&bytes)
    }

    fn parse(bytes: &[u8]) -> Result<Self, AppError> {
        let mounts: Vec<_> = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .filter_map(parse_mount)
            .collect();
        if mounts.is_empty() {
            return Err(AppError::Other(
                "Linux mount table contained no usable records".into(),
            ));
        }
        Ok(Self { mounts })
    }

    /// Resolve against the kernel mount ID when available. Falling back to
    /// pathname containment is limited to kernels predating STATX_MNT_ID.
    pub fn resolve(&self, path: &Path) -> Result<&Mount, AppError> {
        if let Some(id) = mount_id(path)? {
            return self
                .mounts
                .iter()
                .find(|mount| mount.id == id)
                .ok_or_else(|| {
                    AppError::Other(format!(
                        "Mount namespace changed while preparing trash operation for {}",
                        path.display()
                    ))
                });
        }
        self.resolve_by_path(path)
            .ok_or_else(|| AppError::Other(format!("No Linux mount contains {}", path.display())))
    }

    pub fn resolve_existing_ancestor(&self, path: &Path) -> Result<&Mount, AppError> {
        let existing = path
            .ancestors()
            .find(|ancestor| std::fs::symlink_metadata(ancestor).is_ok())
            .ok_or_else(|| AppError::NotFound(path.display().to_string()))?;
        self.resolve(&std::fs::canonicalize(existing)?)
    }

    fn resolve_by_path(&self, path: &Path) -> Option<&Mount> {
        let max_depth = self
            .mounts
            .iter()
            .filter(|mount| path.starts_with(&mount.mount_point))
            .map(|mount| mount.mount_point.components().count())
            .max()?;
        let candidates: Vec<_> = self
            .mounts
            .iter()
            .filter(|mount| {
                path.starts_with(&mount.mount_point)
                    && mount.mount_point.components().count() == max_depth
            })
            .collect();
        // For stacked mounts at one pathname, the visible mount is not the
        // parent of another candidate at that pathname.
        candidates.iter().copied().find(|candidate| {
            !candidates
                .iter()
                .any(|other| other.parent_id == candidate.id)
        })
    }
}

fn parse_mount(line: &[u8]) -> Option<Mount> {
    let fields: Vec<_> = line
        .split(|byte| *byte == b' ')
        .filter(|field| !field.is_empty())
        .collect();
    let separator = fields.iter().position(|field| *field == b"-")?;
    if separator < 6 || fields.len() <= separator + 2 {
        return None;
    }
    Some(Mount {
        id: std::str::from_utf8(fields[0]).ok()?.parse().ok()?,
        parent_id: std::str::from_utf8(fields[1]).ok()?.parse().ok()?,
        root: path_from_mount_field(fields[3]),
        mount_point: path_from_mount_field(fields[4]),
        filesystem: OsString::from_vec(decode_mount_field(fields[separator + 1])),
    })
}

fn path_from_mount_field(field: &[u8]) -> PathBuf {
    PathBuf::from(OsString::from_vec(decode_mount_field(field)))
}

fn decode_mount_field(field: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(field.len());
    let mut index = 0;
    while index < field.len() {
        let escaped = field.get(index..index + 4).and_then(|bytes| match bytes {
            br"\040" => Some(b' '),
            br"\011" => Some(b'\t'),
            br"\012" => Some(b'\n'),
            br"\134" => Some(b'\\'),
            _ => None,
        });
        if let Some(byte) = escaped {
            decoded.push(byte);
            index += 4;
        } else {
            decoded.push(field[index]);
            index += 1;
        }
    }
    decoded
}

pub(super) fn mount_id(path: &Path) -> Result<Option<u64>, AppError> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| AppError::InvalidPath("Path contains a NUL byte".into()))?;
    let mut stat = std::mem::MaybeUninit::<libc::statx>::zeroed();
    // SAFETY: path is NUL-terminated and stat points to writable storage.
    let result = unsafe {
        libc::statx(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
            libc::STATX_MNT_ID,
            stat.as_mut_ptr(),
        )
    };
    if result == 0 {
        // SAFETY: statx initialized the structure after returning success.
        let stat = unsafe { stat.assume_init() };
        return Ok((stat.stx_mask & libc::STATX_MNT_ID != 0).then_some(stat.stx_mnt_id));
    }
    let error = std::io::Error::last_os_error();
    if error
        .raw_os_error()
        .is_some_and(|code| code == libc::ENOSYS || code == libc::EINVAL)
    {
        Ok(None)
    } else {
        Err(error.into())
    }
}

#[cfg(test)]
#[path = "../../test_support/trash_mounts.rs"]
mod tests;
