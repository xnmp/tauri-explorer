//! Which filesystem a slow directory lives on (#1022).
//!
//! Every lookup here reads the kernel's mount table instead of touching the
//! directory itself: a stat of a hung network or FUSE mount would block the
//! diagnostic exactly when it is needed. Linux parses `/proc/self/mountinfo`,
//! macOS uses `getfsstat(MNT_NOWAIT)` (cached, never contacts the server),
//! and Windows classifies UNC prefixes and `GetDriveTypeW` drive roots.
//!
//! On Linux and macOS a path is first resolved through symlinks that live on
//! local mounts (`~/nas -> /mnt/nfs`), so a symlinked network folder is not
//! reported as the local filesystem holding the link. Links are read only on
//! local or in-memory mounts, never on the mount being diagnosed. Windows
//! classifies the path as written. Runs on the persistence thread only.
use serde::{Deserialize, Serialize};
#[cfg_attr(windows, allow(unused_imports))]
use std::collections::VecDeque;
#[cfg_attr(windows, allow(unused_imports))]
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Category {
    Local,
    /// Kernel network filesystems (NFS, SMB/CIFS, 9p, AFS, WebDAV, …).
    Network,
    /// Userspace filesystems that reach a network service (sshfs, rclone, gvfs).
    NetworkFuse,
    /// Other FUSE filesystems, including `fuseblk` (e.g. ntfs-3g).
    Fuse,
    Removable,
    Memory,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesystemInfo {
    pub fs_type: Option<String>,
    pub mount_point: Option<String>,
    pub category: Category,
}

/// Classify a mount-table filesystem type name. Pure, so the mapping is
/// testable on every platform. Windows classifies by drive type instead.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn classify_fs_type(fs_type: &str) -> Category {
    let fs_type = fs_type.to_ascii_lowercase();
    let network_fuse = [
        "sshfs",
        "rclone",
        "gvfsd-fuse",
        "s3fs",
        "gcsfuse",
        "davfs",
        "curlftpfs",
        "smbnetfs",
        "goofys",
        "blobfuse",
        "onedriver",
    ];
    if let Some(subtype) = fs_type.strip_prefix("fuse.") {
        return if network_fuse.iter().any(|name| subtype.starts_with(name)) {
            Category::NetworkFuse
        } else {
            Category::Fuse
        };
    }
    match fs_type.as_str() {
        "nfs" | "nfs4" | "cifs" | "smb3" | "smbfs" | "9p" | "afs" | "ceph" | "glusterfs"
        | "lustre" | "afpfs" | "webdav" | "davfs" | "ncpfs" | "virtiofs" | "drvfs" => {
            Category::Network
        }
        "fuse" | "fuseblk" | "macfuse" | "osxfuse" | "fusefs" => Category::Fuse,
        "tmpfs" | "ramfs" | "devtmpfs" => Category::Memory,
        // An automount trap: what is behind it is unknown until mounted.
        "autofs" => Category::Unknown,
        "iso9660" | "udf" | "cd9660" => Category::Removable,
        "" => Category::Unknown,
        _ => Category::Local,
    }
}

/// Filesystem information for `path`, from the mount table and symlinks on
/// local mounts only.
pub(crate) fn filesystem_info(path: &str) -> Option<FilesystemInfo> {
    platform::filesystem_info(path)
}

/// The mount holding a path, as a mount table describes it.
#[cfg_attr(windows, allow(dead_code))]
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MountRow {
    pub fs_type: String,
    pub mount_point: PathBuf,
    pub category: Category,
}

#[cfg_attr(windows, allow(dead_code))]
impl MountRow {
    fn info(self) -> FilesystemInfo {
        FilesystemInfo {
            fs_type: Some(self.fs_type),
            mount_point: Some(self.mount_point.to_string_lossy().into_owned()),
            category: self.category,
        }
    }
}

/// Filesystems whose symlinks can be read without reaching a server or an
/// automount trap. Anything not listed (including unrecognised types that
/// `classify_fs_type` calls local) is taken as written.
#[cfg_attr(windows, allow(dead_code))]
fn safe_to_read_links(mount: &MountRow) -> bool {
    const SAFE: &[&str] = &[
        "ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs", "bcachefs", "jfs", "nilfs2",
        "reiserfs", "overlay", "squashfs", "erofs", "tmpfs", "ramfs", "devtmpfs", "apfs", "hfs",
    ];
    SAFE.contains(&mount.fs_type.to_ascii_lowercase().as_str())
}

/// Matches the kernel's `ELOOP` limit.
#[cfg_attr(windows, allow(dead_code))]
const MAX_SYMLINK_HOPS: usize = 40;

/// Resolve symlinks in absolute `path` without touching any mount that could
/// hang. A component is read with `read_link` only when its parent lies on a
/// known local-disk or in-memory filesystem ([`safe_to_read_links`]) and it is
/// not itself a mount point; anything else is taken as written. Relative paths and symlink loops yield `path`
/// unchanged, so the caller falls back to the lexical lookup.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn resolve_on_local_mounts(
    path: &Path,
    mount_for: impl Fn(&Path) -> Option<MountRow>,
    read_link: impl Fn(&Path) -> std::io::Result<PathBuf>,
) -> PathBuf {
    if !path.is_absolute() {
        return path.to_path_buf();
    }
    let owned = |component: Component| PathBuf::from(component.as_os_str());
    let mut rest: VecDeque<PathBuf> = path.components().map(owned).collect();
    let mut resolved = PathBuf::new();
    let mut hops = 0;
    while let Some(part) = rest.pop_front() {
        match part.components().next() {
            Some(Component::Prefix(_) | Component::RootDir) => resolved.push(&part),
            Some(Component::ParentDir) => {
                resolved.pop();
            }
            Some(Component::Normal(name)) => {
                let candidate = resolved.join(name);
                let parent_is_local =
                    mount_for(&resolved).is_some_and(|mount| safe_to_read_links(&mount));
                let is_mount_point =
                    mount_for(&candidate).is_some_and(|mount| mount.mount_point == candidate);
                let target = (parent_is_local && !is_mount_point)
                    .then(|| read_link(&candidate).ok())
                    .flatten();
                let Some(target) = target else {
                    resolved = candidate;
                    continue;
                };
                hops += 1;
                if hops > MAX_SYMLINK_HOPS {
                    return path.to_path_buf();
                }
                if target.is_absolute() {
                    resolved = PathBuf::new();
                }
                for component in target.components().rev() {
                    rest.push_front(owned(component));
                }
            }
            Some(Component::CurDir) | None => {}
        }
    }
    resolved
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{classify_fs_type, resolve_on_local_mounts, FilesystemInfo, MountRow};
    use std::path::Path;

    pub(super) fn filesystem_info(path: &str) -> Option<FilesystemInfo> {
        let table = crate::files::MountTable::read()?;
        let mount_for = |path: &Path| {
            table
                .mount_for(path)
                .map(|(fs_type, mount_point)| MountRow {
                    category: classify_fs_type(&fs_type),
                    fs_type,
                    mount_point,
                })
        };
        let resolved =
            resolve_on_local_mounts(Path::new(path), mount_for, |path| std::fs::read_link(path));
        mount_for(&resolved).map(MountRow::info)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{classify_fs_type, resolve_on_local_mounts, Category, FilesystemInfo, MountRow};
    use std::ffi::CStr;
    use std::path::{Path, PathBuf};

    fn field(raw: &[libc::c_char]) -> String {
        // SAFETY: the kernel NUL-terminates these fixed-size statfs fields.
        unsafe { CStr::from_ptr(raw.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    }

    pub(super) fn filesystem_info(path: &str) -> Option<FilesystemInfo> {
        // MNT_NOWAIT returns cached statistics without contacting a server.
        // SAFETY: a null buffer asks only for the mount count.
        let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
        if count <= 0 {
            return None;
        }
        let capacity = count as usize + 8;
        let mut mounts: Vec<libc::statfs> = Vec::with_capacity(capacity);
        let bytes = (capacity * std::mem::size_of::<libc::statfs>()) as libc::c_int;
        // SAFETY: the buffer holds `capacity` statfs records of `bytes` total.
        let filled = unsafe { libc::getfsstat(mounts.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
        if filled <= 0 {
            return None;
        }
        // SAFETY: getfsstat initialized `filled` records.
        unsafe { mounts.set_len((filled as usize).min(capacity)) };
        let rows: Vec<MountRow> = mounts
            .iter()
            .map(|mount| {
                let fs_type = field(&mount.f_fstypename);
                let local = mount.f_flags & (libc::MNT_LOCAL as u32) != 0;
                let category = match classify_fs_type(&fs_type) {
                    Category::Local if !local => Category::Network,
                    category => category,
                };
                MountRow {
                    fs_type,
                    mount_point: PathBuf::from(field(&mount.f_mntonname)),
                    category,
                }
            })
            .collect();
        let mount_for = |path: &Path| {
            rows.iter()
                .filter(|row| path.starts_with(&row.mount_point))
                .max_by_key(|row| row.mount_point.components().count())
                .cloned()
        };
        let resolved =
            resolve_on_local_mounts(Path::new(path), mount_for, |path| std::fs::read_link(path));
        mount_for(&resolved).map(MountRow::info)
    }
}

#[cfg(windows)]
mod platform {
    use super::{Category, FilesystemInfo};

    pub(super) fn filesystem_info(path: &str) -> Option<FilesystemInfo> {
        if path.starts_with("\\\\") || path.starts_with("//") {
            return Some(FilesystemInfo {
                fs_type: None,
                mount_point: None,
                category: Category::Network,
            });
        }
        let drive = path.get(..2).filter(|prefix| prefix.ends_with(':'))?;
        let root = format!("{drive}\\");
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 drive root. GetDriveTypeW
        // reads the volume manager's classification, not the volume itself.
        let kind = unsafe {
            windows::Win32::Storage::FileSystem::GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr()))
        };
        // DRIVE_* values from WinBase.h.
        let category = match kind {
            2 | 5 => Category::Removable,
            3 => Category::Local,
            4 => Category::Network,
            6 => Category::Memory,
            _ => Category::Unknown,
        };
        Some(FilesystemInfo {
            fs_type: None,
            mount_point: Some(root),
            category,
        })
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    pub(super) fn filesystem_info(_path: &str) -> Option<super::FilesystemInfo> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_network_fuse_and_local_mounts() {
        assert_eq!(classify_fs_type("fuse.sshfs"), Category::NetworkFuse);
        assert_eq!(classify_fs_type("fuse.rclone"), Category::NetworkFuse);
        assert_eq!(classify_fs_type("fuse.gvfsd-fuse"), Category::NetworkFuse);
        assert_eq!(classify_fs_type("fuse.portal"), Category::Fuse);
        assert_eq!(classify_fs_type("fuseblk"), Category::Fuse);
        assert_eq!(classify_fs_type("nfs4"), Category::Network);
        assert_eq!(classify_fs_type("CIFS"), Category::Network);
        assert_eq!(classify_fs_type("smbfs"), Category::Network);
        assert_eq!(classify_fs_type("9p"), Category::Network);
        assert_eq!(classify_fs_type("tmpfs"), Category::Memory);
        assert_eq!(classify_fs_type("autofs"), Category::Unknown);
        assert_eq!(classify_fs_type("iso9660"), Category::Removable);
        assert_eq!(classify_fs_type("ext4"), Category::Local);
        assert_eq!(classify_fs_type("apfs"), Category::Local);
        assert_eq!(classify_fs_type(""), Category::Unknown);
    }

    #[cfg(unix)]
    fn row(fs_type: &str, mount_point: &str) -> MountRow {
        MountRow {
            fs_type: fs_type.into(),
            mount_point: PathBuf::from(mount_point),
            category: classify_fs_type(fs_type),
        }
    }

    #[cfg(unix)]
    /// `/` is ext4, `/mnt/nfs` is NFS, `/net` an automount trap and
    /// `/run/user` is tmpfs.
    fn fake_mounts(path: &Path) -> Option<MountRow> {
        [
            row("nfs4", "/mnt/nfs"),
            row("autofs", "/net"),
            row("tmpfs", "/run/user"),
            row("ext4", "/"),
        ]
        .into_iter()
        .find(|mount| path.starts_with(&mount.mount_point))
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_on_a_local_mount_resolves_to_the_network_mount_it_names() {
        let read = std::cell::RefCell::new(Vec::new());
        let links = |path: &Path| {
            read.borrow_mut().push(path.to_path_buf());
            match path.to_str() {
                Some("/home/u/nas") => Ok(PathBuf::from("/mnt/nfs")),
                Some("/home/u/rel") => Ok(PathBuf::from("../u/nas/share")),
                _ => Err(std::io::Error::other("not a link")),
            }
        };
        let resolved =
            resolve_on_local_mounts(Path::new("/home/u/nas/photos/2024"), fake_mounts, links);
        assert_eq!(resolved, PathBuf::from("/mnt/nfs/photos/2024"));
        assert_eq!(fake_mounts(&resolved).unwrap().category, Category::Network);
        // Nothing on, or at, the network mount was read.
        assert!(read
            .borrow()
            .iter()
            .all(|path| !path.starts_with("/mnt/nfs")));
        read.borrow_mut().clear();
        // Relative targets resolve against the link's own folder.
        assert_eq!(
            resolve_on_local_mounts(Path::new("/home/u/rel/x"), fake_mounts, links),
            PathBuf::from("/mnt/nfs/share/x")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_resolution_never_reads_inside_a_non_local_mount_and_survives_loops() {
        let reads = std::cell::Cell::new(0);
        let resolved =
            resolve_on_local_mounts(Path::new("/mnt/nfs/a/b"), fake_mounts, |path: &Path| {
                assert!(!path.starts_with("/mnt/nfs"), "read {path:?}");
                reads.set(reads.get() + 1);
                Err(std::io::Error::other("not a link"))
            });
        assert_eq!(resolved, PathBuf::from("/mnt/nfs/a/b"));
        // `/mnt` is local and is read; `/mnt/nfs` is a mount point and is not.
        assert_eq!(reads.get(), 1);

        // Nothing at or below an automount trap is read: path traversal there
        // can wait for an unavailable server to mount.
        let trap = resolve_on_local_mounts(
            Path::new("/net/offline/share"),
            fake_mounts,
            |path: &Path| {
                assert!(!path.starts_with("/net"), "read {path:?}");
                Err(std::io::Error::other("not a link"))
            },
        );
        assert_eq!(trap, PathBuf::from("/net/offline/share"));
        // An unrecognised filesystem is not assumed safe either.
        let odd = |path: &Path| {
            Some(row(
                "somefs",
                if path.starts_with("/x") { "/x" } else { "/" },
            ))
        };
        resolve_on_local_mounts(Path::new("/x/a/b"), odd, |path: &Path| {
            assert!(!path.starts_with("/x/"), "read {path:?}");
            Err(std::io::Error::other("not a link"))
        });

        let looping =
            resolve_on_local_mounts(Path::new("/home/loop/x"), fake_mounts, |path: &Path| {
                if path == Path::new("/home/loop") {
                    Ok(PathBuf::from("/home/loop"))
                } else {
                    Err(std::io::Error::other("not a link"))
                }
            });
        assert_eq!(
            looping,
            PathBuf::from("/home/loop/x"),
            "a loop falls back lexically"
        );
        assert_eq!(
            resolve_on_local_mounts(Path::new("relative/dir"), fake_mounts, |_: &Path| {
                Ok(PathBuf::from("/mnt/nfs"))
            }),
            PathBuf::from("relative/dir")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_real_symlink_to_another_mount_reports_that_mount() {
        // /dev/shm (tmpfs) is a distinct mount from the temp dir on most
        // systems; skip where it is not.
        let Some(shm) = filesystem_info("/dev/shm")
            .filter(|info| info.mount_point.as_deref() == Some("/dev/shm"))
        else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("shm-link");
        std::os::unix::fs::symlink("/dev/shm", &link).unwrap();
        let via_link = filesystem_info(&link.join("sub").to_string_lossy()).unwrap();
        let local = filesystem_info(&dir.path().to_string_lossy()).unwrap();
        if local.mount_point == shm.mount_point {
            return;
        }
        assert_eq!(via_link, shm);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_root_resolves_to_a_mount_without_touching_the_directory() {
        let info = filesystem_info("/").expect("root is always mounted");
        assert_eq!(info.mount_point.as_deref(), Some("/"));
        assert!(info.fs_type.is_some());
        // A path that does not exist still resolves lexically to its mount.
        let missing = filesystem_info("/definitely/not/a/real/dir/1022").unwrap();
        assert!(missing.mount_point.is_some());
    }
}
