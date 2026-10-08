//! Which filesystem a slow directory lives on (#1022).
//!
//! Every lookup here reads the kernel's mount table instead of touching the
//! directory itself: a stat of a hung network or FUSE mount would block the
//! diagnostic exactly when it is needed. Linux parses `/proc/self/mountinfo`,
//! macOS uses `getfsstat(MNT_NOWAIT)` (cached, never contacts the server),
//! and Windows classifies UNC prefixes and `GetDriveTypeW` drive roots.
use serde::{Deserialize, Serialize};

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
        "iso9660" | "udf" | "cd9660" => Category::Removable,
        "" => Category::Unknown,
        _ => Category::Local,
    }
}

/// Filesystem information for `path`, from the mount table only.
pub(crate) fn filesystem_info(path: &str) -> Option<FilesystemInfo> {
    platform::filesystem_info(path)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{classify_fs_type, FilesystemInfo};

    pub(super) fn filesystem_info(path: &str) -> Option<FilesystemInfo> {
        let (fs_type, mount_point) =
            crate::files::mount_for_path_lexically(std::path::Path::new(path))?;
        Some(FilesystemInfo {
            category: classify_fs_type(&fs_type),
            fs_type: Some(fs_type),
            mount_point: Some(mount_point),
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{classify_fs_type, Category, FilesystemInfo};
    use std::ffi::CStr;

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
        let target = std::path::Path::new(path);
        let mount = mounts
            .iter()
            .map(|mount| (mount, field(&mount.f_mntonname)))
            .filter(|(_, mount_point)| target.starts_with(mount_point))
            .max_by_key(|(_, mount_point)| mount_point.len())?;
        let fs_type = field(&mount.0.f_fstypename);
        let local = mount.0.f_flags & (libc::MNT_LOCAL as u32) != 0;
        let category = match classify_fs_type(&fs_type) {
            Category::Local if !local => Category::Network,
            category => category,
        };
        Some(FilesystemInfo {
            fs_type: Some(fs_type),
            mount_point: Some(mount.1),
            category,
        })
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
        assert_eq!(classify_fs_type("iso9660"), Category::Removable);
        assert_eq!(classify_fs_type("ext4"), Category::Local);
        assert_eq!(classify_fs_type("apfs"), Category::Local);
        assert_eq!(classify_fs_type(""), Category::Unknown);
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
