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
