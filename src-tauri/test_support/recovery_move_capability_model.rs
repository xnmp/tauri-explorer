//! Pure capability classification, compiled on every Unix target so macOS
//! errno spellings are checked where they differ from Linux.
use super::*;

#[test]
fn every_platform_spelling_of_unsupported_exclusive_rename_is_a_capability_result() {
    for errno in [libc::ENOSYS, libc::ENOTSUP, libc::EOPNOTSUPP, libc::EINVAL] {
        assert!(unsupported_exclusive_rename(errno), "errno {errno}");
    }
    // Ordinary failures never prove that the primitive itself is unsupported.
    for errno in [
        libc::EXDEV,
        libc::EACCES,
        libc::EPERM,
        libc::EROFS,
        libc::EEXIST,
        libc::ENOSPC,
        libc::EIO,
        libc::ENOENT,
    ] {
        assert!(!unsupported_exclusive_rename(errno), "errno {errno}");
    }
}
