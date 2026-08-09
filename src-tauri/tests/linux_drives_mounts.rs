#![cfg(target_os = "linux")]

use tauri_explorer_lib::files::drives::parse_linux_block_mounts_for_test;

#[test]
fn removable_mountinfo_entry_becomes_a_sidebar_drive() {
    let sys_block = tempfile::tempdir().expect("temporary sysfs block directory");
    let disk = sys_block.path().join("tauriintegration546");
    std::fs::create_dir_all(disk.join("tauriintegration546p1")).expect("partition directory");
    std::fs::write(disk.join("removable"), "1\n").expect("removable flag");

    let drives = parse_linux_block_mounts_for_test(
        "42 35 8:17 / /mnt/USB\\040BACKUP rw,relatime - ext4 /dev/tauriintegration546p1 rw\n",
        sys_block.path(),
    );

    assert_eq!(drives.len(), 1);
    assert_eq!(drives[0].name, "USB BACKUP");
    assert_eq!(drives[0].path, "/mnt/USB BACKUP");
    assert_eq!(serde_json::to_value(&drives[0].kind).unwrap(), "removable");
}
