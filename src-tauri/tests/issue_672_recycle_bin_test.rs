#![cfg(target_os = "linux")]

use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use tauri_explorer_lib::system::{open_linux_recycle_bin_with_launcher, RecycleBinLauncher};

#[test]
fn issue_672_successful_uri_handler_cannot_skip_the_deleted_files_directory() {
    let deleted_files = OsString::from("/home/alice/.local/share/Trash/files");
    let mut launchers = Vec::new();

    let result = open_linux_recycle_bin_with_launcher(
        |launcher| {
            launchers.push((launcher.program, launcher.arguments.clone()));
            Ok(std::process::ExitStatus::from_raw(0))
        },
        || {
            Ok(RecycleBinLauncher {
                program: "xdg-open",
                arguments: vec![deleted_files.clone()],
            })
        },
    );

    assert!(result.is_ok());
    assert_eq!(
        launchers,
        vec![(
            "xdg-open",
            vec![OsString::from("/home/alice/.local/share/Trash/files")]
        )]
    );
    assert!(launchers
        .iter()
        .flat_map(|(_, arguments)| arguments)
        .all(|argument| argument != "trash:///"));
}

#[test]
fn issue_672_deleted_files_launcher_spawn_failure_is_reported() {
    let result = open_linux_recycle_bin_with_launcher(
        |_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "launcher unavailable",
            ))
        },
        || {
            Ok(RecycleBinLauncher {
                program: "xdg-open",
                arguments: vec![OsString::from("/home/alice/.local/share/Trash/files")],
            })
        },
    );

    assert!(result.is_err());
}

#[test]
fn issue_672_deleted_files_launcher_unsuccessful_exit_is_reported() {
    let result = open_linux_recycle_bin_with_launcher(
        |_| Ok(std::process::ExitStatus::from_raw(1 << 8)),
        || {
            Ok(RecycleBinLauncher {
                program: "xdg-open",
                arguments: vec![OsString::from("/home/alice/.local/share/Trash/files")],
            })
        },
    );

    assert!(result.is_err());
}
