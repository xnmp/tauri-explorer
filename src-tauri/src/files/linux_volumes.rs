//! Linux desktop storage adapter. Mount paths and volume identities are distinct.
use super::drives::Drive;
use crate::error::AppError;
use std::path::Path;

/// Shared native discovery seam; fixtures may supply an isolated D-Bus connection.
#[doc(hidden)]
pub async fn enumerate_with_connection(
    mountinfo: &str,
    sys_block: &Path,
    _labels: &Path,
    _connection: Option<&zbus::Connection>,
) -> Vec<Drive> {
    super::drives::enumerate_linux_drives_for_test(mountinfo, sys_block)
}

/// Mount an identified filesystem through the desktop service.
#[doc(hidden)]
pub async fn mount_with_connection(
    _connection: &zbus::Connection,
    _device_id: &str,
) -> Result<String, AppError> {
    Err(AppError::Other("Volume mounting is not available".into()))
}
