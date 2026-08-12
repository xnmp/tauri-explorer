#[cfg(target_os = "linux")]
use super::{open_linux_recycle_bin_with_fallback, AppError};
#[cfg(target_os = "linux")]
use std::os::unix::process::ExitStatusExt;

#[cfg(target_os = "linux")]
#[test]
fn issue_660_primary_recycle_bin_launcher_does_not_require_a_fallback_path() {
    let result = open_linux_recycle_bin_with_fallback(
        |launcher| {
            assert_eq!(launcher.program, "gio");
            Ok(std::process::ExitStatus::from_raw(0))
        },
        || Err(AppError::Other("fallback path unavailable".to_string())),
    );

    assert!(result.is_ok());
}
