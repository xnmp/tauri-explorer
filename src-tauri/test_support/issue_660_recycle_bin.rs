#[cfg(target_os = "linux")]
use super::{linux_trash_files_directory_from, open_linux_recycle_bin_with};
#[cfg(target_os = "linux")]
use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::os::unix::process::ExitStatusExt;
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
fn issue_660_recycle_bin_opens_the_trash_files_directory() {
    let mut launchers = Vec::new();

    let result = open_linux_recycle_bin_with(|launcher| {
        launchers.push((launcher.program, launcher.arguments.clone()));
        Ok(std::process::ExitStatus::from_raw(0))
    });

    assert!(result.is_ok());
    assert_eq!(launchers.len(), 1);
    assert_eq!(launchers[0].0, "xdg-open");
    assert!(launchers[0].1[0]
        .to_string_lossy()
        .ends_with("/Trash/files"));
}

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_returns_an_error_when_the_linux_launcher_fails() {
    let result = open_linux_recycle_bin_with(|_| Ok(std::process::ExitStatus::from_raw(1 << 8)));

    assert!(result.is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_does_not_depend_on_gio() {
    let mut launchers = Vec::new();

    let result = open_linux_recycle_bin_with(|launcher| {
        launchers.push((launcher.program, launcher.arguments.clone()));
        if launcher.program == "gio" {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "gio missing",
            ))
        } else {
            Ok(std::process::ExitStatus::from_raw(0))
        }
    });

    assert!(result.is_ok());
    assert_eq!(launchers.len(), 1);
    assert_eq!(launchers[0].0, "xdg-open");
    assert!(launchers[0].1[0]
        .to_string_lossy()
        .ends_with("/Trash/files"));
}
