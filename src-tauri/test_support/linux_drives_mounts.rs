//! Integration-level coverage for the mount-table drive projection. Moved in
//! from Cargo's auto-discovered `tests/linux_drives_mounts.rs` (#926) so it
//! calls the private production enumeration directly instead of through a
//! `#[doc(hidden)] pub` seam kept only for this test.
use super::*;

fn mounted(mountinfo: &str, sys_block: &std::path::Path) -> Vec<Drive> {
    enumerate_linux_drives(Some(mountinfo), sys_block, std::iter::empty())
}

#[test]
fn removable_mount_table_entry_becomes_a_sidebar_drive_and_disappears_after_unmount() {
    let sys_block = tempfile::tempdir().expect("temporary sysfs block directory");
    let disk = sys_block.path().join("tauriintegration546");
    std::fs::create_dir_all(disk.join("tauriintegration546p1")).expect("partition directory");
    std::fs::write(disk.join("removable"), "1\n").expect("removable flag");

    let mounted_drives = mounted(
        "42 35 8:17 / /mnt/USB\\040BACKUP rw,relatime - ext4 /dev/tauriintegration546p1 rw\n",
        sys_block.path(),
    );

    assert_eq!(mounted_drives.len(), 1);
    assert_eq!(mounted_drives[0].name, "USB BACKUP");
    assert_eq!(mounted_drives[0].path.as_deref(), Some("/mnt/USB BACKUP"));
    assert_eq!(
        serde_json::to_value(&mounted_drives[0].kind).unwrap(),
        "removable"
    );
    assert!(mounted("", sys_block.path()).is_empty());
}

#[test]
fn system_block_mounts_do_not_become_sidebar_drives() {
    let sys_block = tempfile::tempdir().expect("temporary sysfs block directory");
    let disk = sys_block.path().join("taurisystem546");
    std::fs::create_dir_all(disk.join("taurisystem546p1")).expect("partition directory");
    std::fs::write(disk.join("removable"), "0\n").expect("fixed flag");

    let drives = mounted(
        concat!(
            "1 0 8:1 / /boot rw - ext4 /dev/taurisystem546p1 rw\n",
            "2 0 8:1 / /boot/efi rw - vfat /dev/taurisystem546p1 rw\n",
            "3 0 8:1 / /home rw - ext4 /dev/taurisystem546p1 rw\n",
        ),
        sys_block.path(),
    );

    assert!(drives.is_empty());
}
