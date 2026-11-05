use super::*;
use std::os::unix::ffi::OsStrExt;

#[test]
fn parses_mount_identity_root_and_non_utf8_paths_losslessly() {
    let table = MountSnapshot::parse(
        b"41 35 8:1 /bound\\040root /mnt/name\\040with\\134slash rw - ext4 /dev/sda1 rw\n\
          42 41 8:1 /bound\\040root/child /mnt/name\\040with\\134slash/child rw - ext4 /dev/sda1 rw\n",
    )
    .expect("mount table");

    assert_eq!(table.mounts[0].id, 41);
    assert_eq!(table.mounts[0].parent_id, 35);
    assert_eq!(table.mounts[0].root.as_os_str().as_bytes(), b"/bound root");
    assert_eq!(
        table.mounts[0].mount_point.as_os_str().as_bytes(),
        b"/mnt/name with\\slash"
    );
    assert_eq!(table.mounts[0].filesystem.as_bytes(), b"ext4");
}

/// The GVfs FUSE bridge is one mount at `$XDG_RUNTIME_DIR/gvfs`; every
/// backend (Google Drive included) lives below it and has no trash (#1508).
#[test]
fn gvfs_fuse_mounts_are_recognized_as_lacking_trash() {
    let table = MountSnapshot::parse(
        b"10 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
          30 10 0:40 / /run/user/1000 rw - tmpfs tmpfs rw\n\
          31 30 0:52 / /run/user/1000/gvfs rw,nosuid,nodev - fuse.gvfsd-fuse gvfsd-fuse rw,user_id=1000,group_id=1000\n",
    )
    .expect("mount table");
    let drive = table
        .resolve_by_path(Path::new(
            "/run/user/1000/gvfs/google-drive:host=gmail.com,user=someone/0AAbc/1XyZ",
        ))
        .expect("gvfs mount");
    assert_eq!(drive.id, 31);
    assert!(drive.lacks_trash() && drive.is_gvfs_fuse());
    let runtime = table
        .resolve_by_path(Path::new("/run/user/1000/other"))
        .expect("tmpfs");
    assert!(!runtime.lacks_trash() && !runtime.is_gvfs_fuse());
}

#[test]
fn bind_mounts_with_one_device_remain_distinct_mount_identities() {
    let table = MountSnapshot::parse(
        b"10 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
          20 10 8:1 /data/team /srv/team rw - ext4 /dev/sda1 rw\n",
    )
    .expect("mount table");

    assert_eq!(
        table
            .resolve_by_path(Path::new("/srv/team/a"))
            .map(|mount| mount.id),
        Some(20)
    );
    assert_eq!(
        table
            .resolve_by_path(Path::new("/data/a"))
            .map(|mount| mount.id),
        Some(10)
    );
}

#[test]
fn fallback_path_resolution_selects_visible_stacked_mount() {
    let table = MountSnapshot::parse(
        b"10 1 8:1 / / rw - ext4 /dev/sda1 rw\n\
          20 10 0:5 / /over rw - tmpfs tmpfs rw\n\
          21 20 0:6 / /over rw - tmpfs tmpfs rw\n",
    )
    .expect("mount table");

    assert_eq!(
        table
            .resolve_by_path(Path::new("/over/item"))
            .map(|mount| mount.id),
        Some(21)
    );
}

#[test]
fn malformed_records_do_not_corrupt_valid_mounts() {
    let table = MountSnapshot::parse(
        b"malformed\n1 1 0:1 / / rw - tmpfs tmpfs rw\n2 nope 0:2 / /bad rw - tmpfs tmpfs rw\n",
    )
    .expect("one valid mount");
    assert_eq!(table.mounts.len(), 1);
    assert_eq!(table.mounts[0].id, 1);
}
