# save_file_copy must compare file identity, not path text (#1588)

`fs::copy` truncates the destination before reading the source. A textual
`src == dst` guard misses a symlink, a hard link, a `..` or symlinked-parent
spelling, or `/proc/self/fd/N`, so the "copy" emptied the original and
reported success.

Final design (`files/video_info.rs`): validate the source from metadata only
(missing → `NotFound`, non-regular → `InvalidPath`, never opened, so a FIFO
cannot block); if the destination exists after following symlinks it must be
a regular file and not the source by `file_identity::of_path` (Unix dev/ino
from metadata; Windows an attribute-only, full-sharing handle with the shared
#793 FAT fallback to volume serial + file index; if identity is still
unavailable, case-insensitive canonical paths); then the unchanged
`fs::copy`. Residual: a concurrent swap of the destination to an alias between
the check and the copy can still truncate the source.

A first attempt staged the copy in a hidden temp file and renamed it over the
destination. A second review withdrew it: atomic replacement was never the
requirement, and it regressed far more than it fixed:
- `FileIdInfo` without the FAT fallback failed every save on FAT32.
- Exclusive-create cleanup could unlink the SOURCE under a parent swap.
- The ENOSPC in-place fallback destroyed a destination that staging would have
  kept.
- ACLs and xattrs were dropped, group access widened, and setuid/setgid bits
  survived onto copies.
- `O_NONBLOCK` opens failed on leased files (EWOULDBLOCK).
- It lost what the platform copy gives for free: mtime, Windows attributes,
  APFS/ReFS clones and SMB server-side copy (`CopyFileExW`/`fclonefileat`).
- kill -9 left a hidden multi-hundred-MB temp file behind.

Lesson: fix the stated invariant ("an aliased destination must not destroy the
source") at the narrowest point and keep the platform primitive. Replacing a
copy primitive silently changes permissions, ownership, metadata, filesystem
support and failure atomicity.

Tests: `cargo test --lib issue_1588` (`test_support/save_file_copy_test.rs`
plus the identity-fallback seam test in `video_info.rs`). The `pin_` tests
pass on both the pre-#1588 code and now. The Windows identity fallback is
compile-checked only; the FAT path needs the FAT32 VHD job.
