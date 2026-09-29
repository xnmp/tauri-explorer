#[cfg(target_os = "linux")]
use super::{is_graphical_file_manager, linux_trash_files_directory_from};
#[cfg(target_os = "linux")]
use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_uses_only_an_absolute_xdg_data_home() {
    assert_eq!(
        linux_trash_files_directory_from(Some(OsString::from("/var/user-data")), None).unwrap(),
        PathBuf::from("/var/user-data/Trash/files"),
    );
    assert_eq!(
        linux_trash_files_directory_from(Some(OsString::new()), Some(PathBuf::from("/home/alice")))
            .unwrap(),
        PathBuf::from("/home/alice/.local/share/Trash/files"),
    );
    assert_eq!(
        linux_trash_files_directory_from(
            Some(OsString::from("relative/data")),
            Some(PathBuf::from("/home/alice"))
        )
        .unwrap(),
        PathBuf::from("/home/alice/.local/share/Trash/files"),
    );
}

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_errors_without_an_absolute_xdg_or_home_directory() {
    assert!(linux_trash_files_directory_from(Some(OsString::from("relative/data")), None).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn issue_757_terminal_directory_handler_is_not_a_graphical_file_manager() {
    // Arch can register kitty-open.desktop as the default for directories.
    // Selecting it for Trash opens a terminal even though dispatch succeeds.
    assert!(!is_graphical_file_manager(
        Some("System;TerminalEmulator;"),
        false
    ));
    assert!(!is_graphical_file_manager(Some("FileManager;"), true));
    assert!(is_graphical_file_manager(
        Some("System;FileTools;FileManager;"),
        false
    ));
    assert!(!is_graphical_file_manager(Some("NotAFileManager;"), false));
}
