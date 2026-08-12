#[cfg(target_os = "linux")]
use super::open_linux_recycle_bin_with;
#[cfg(target_os = "linux")]
use std::os::unix::process::ExitStatusExt;

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_uses_the_trash_files_fallback_after_gio_rejects_the_uri() {
    let mut launchers = Vec::new();

    let result = open_linux_recycle_bin_with(|launcher| {
        launchers.push((launcher.program, launcher.arguments.clone()));
        let status = if launcher.program == "gio" {
            std::process::ExitStatus::from_raw(1 << 8)
        } else {
            std::process::ExitStatus::from_raw(0)
        };
        Ok(status)
    });

    assert!(result.is_ok());
    assert_eq!(launchers.len(), 2);
    assert_eq!(launchers[0].0, "gio");
    assert_eq!(launchers[1].0, "xdg-open");
    assert!(launchers[1].1[0]
        .to_string_lossy()
        .ends_with("/Trash/files"));
}

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_returns_an_error_when_both_linux_launchers_fail() {
    let result = open_linux_recycle_bin_with(|_| {
        Ok(std::process::ExitStatus::from_raw(1 << 8))
    });

    assert!(result.is_err());
}
