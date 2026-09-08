//! Owned directory handles; platform implementations retain relative namespace access.
use std::fs::File;

pub(crate) struct Directory {
    pub(crate) file: File,
}

#[cfg(unix)]
#[path = "native_directory/permissions.rs"]
mod permissions;
#[cfg(unix)]
#[path = "native_directory/unix.rs"]
mod unix;
#[cfg(unix)]
pub(crate) use unix::is_name;
#[cfg(all(unix, test))]
pub(crate) use unix::native_name;

#[cfg(windows)]
#[path = "native_directory/windows.rs"]
mod windows;
#[cfg(windows)]
#[path = "native_directory/windows_security.rs"]
mod windows_security;
#[cfg(windows)]
pub(crate) use windows_security::validate_private as validate_private_security;

#[cfg(test)]
#[path = "../../test_support/native_directory_contract.rs"]
mod tests;
