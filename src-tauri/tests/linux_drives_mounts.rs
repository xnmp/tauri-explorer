#![cfg(target_os = "linux")]

use tauri_explorer_lib::files::drives::enumerate_linux_drives_for_test;

#[test]
fn removable_mount_table_entry_becomes_a_sidebar_drive_and_disappears_after_unmount() {
    let sys_block = tempfile::tempdir().expect("temporary sysfs block directory");
    let disk = sys_block.path().join("tauriintegration546");
    std::fs::create_dir_all(disk.join("tauriintegration546p1")).expect("partition directory");
    std::fs::write(disk.join("removable"), "1\n").expect("removable flag");

    let mounted = enumerate_linux_drives_for_test(
        "42 35 8:17 / /mnt/USB\\040BACKUP rw,relatime - ext4 /dev/tauriintegration546p1 rw\n",
        sys_block.path(),
    );

    assert_eq!(mounted.len(), 1);
    assert_eq!(mounted[0].name, "USB BACKUP");
    assert_eq!(mounted[0].path, "/mnt/USB BACKUP");
    assert_eq!(serde_json::to_value(&mounted[0].kind).unwrap(), "removable");
    assert!(enumerate_linux_drives_for_test("", sys_block.path()).is_empty());
}

#[test]
fn system_block_mounts_do_not_become_sidebar_drives() {
    let sys_block = tempfile::tempdir().expect("temporary sysfs block directory");
    let disk = sys_block.path().join("taurisystem546");
    std::fs::create_dir_all(disk.join("taurisystem546p1")).expect("partition directory");
    std::fs::write(disk.join("removable"), "0\n").expect("fixed flag");

    let drives = enumerate_linux_drives_for_test(
        concat!(
            "1 0 8:1 / /boot rw - ext4 /dev/taurisystem546p1 rw\n",
            "2 0 8:1 / /home rw - ext4 /dev/taurisystem546p1 rw\n",
        ),
        sys_block.path(),
    );

    assert!(drives.is_empty());
}
