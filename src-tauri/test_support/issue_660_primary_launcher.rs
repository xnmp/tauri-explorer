#[cfg(target_os = "linux")]
use super::{open_linux_recycle_bin_with_launcher, AppError};

#[cfg(target_os = "linux")]
#[test]
fn issue_660_recycle_bin_does_not_launch_without_an_absolute_trash_path() {
    let result = open_linux_recycle_bin_with_launcher(
        |_| panic!("the launcher must not run without an absolute trash path"),
        || Err(AppError::Other("trash path unavailable".to_string())),
    );

    assert!(result.is_err());
}
