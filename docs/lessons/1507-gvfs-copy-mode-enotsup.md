# #1507: Pasting into a GVfs Google Drive mount failed on chmod

Every Linux paste runs the ordered copy session with a `CopyObservation`, so
it copies through `anchored_copy.rs` into a private staging directory beside
the destination. That copier applied the source's Unix mode to each newly
created file and directory with `fchmod` and propagated any failure.

gvfsd-fuse implements `chmod` as `g_file_set_attribute(unix::mode)`. The
Google Drive backend (`gvfsbackendgoogle.c`) implements no `set_attribute`,
so GVfs answers `G_IO_ERROR_NOT_SUPPORTED`, which gvfsd-fuse maps to
`ENOTSUP` (95, identical to `EOPNOTSUPP` on Linux). The very first copied
file therefore failed with "Operation not supported", so no paste could
succeed. The legacy `copy_recursively` path ignored this with `let _ =`; the
anchored copier reintroduced it as a hard error.

Everything else the pipeline needs works on gvfsd-fuse: `mkdir` (it ignores
its own mode-set failure), `O_CREAT|O_EXCL` (`vfs_create` uses
`g_file_create`), `renameat2(RENAME_NOREPLACE)` (`vfs_rename` maps it to a
non-overwriting `g_file_move`, which the Drive backend supports between
folders with a title change), and descriptor `fstat`/`fstatat` (both use
the same open write handle while it exists).

Fix: mode preservation tolerates only `ENOTSUP`/`EOPNOTSUPP`
(`anchored_copy::apply_copied_mode`), for file, directory and root
final-mode changes. The payload keeps the mode the destination synthesizes,
as `cp` does. Versions are still observed after the attempt, so identity
checks describe the real payload. `O_EXCL` creation and no-replace
publication are unchanged (ADR 0020). `EPERM`, `EACCES`, `EROFS`,
`EIO` and `ENOSYS` still fail the copy.

Tests inject the mode primitive through `copy_with`'s `SetMode` seam. They
cover a tree on a filesystem without modes, a refused `EPERM`, and the exact
errno set (`test_support/anchored_copy.rs`). A real gvfs mount cannot run in
CI.

Residual: overwrite and cross-device move finalization of *directories*
(`recovery/replacement_transfer.rs`, `recovery/move_execution.rs`) restore a
recorded final mode through a retained handle and then verify that mode. On
GVfs they can still refuse. Ordinary pastes of files and folders do not use
that path.
