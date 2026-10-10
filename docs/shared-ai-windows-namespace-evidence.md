# Windows artifact durability

Shared AI artifact custody (host Store), Trace publication and provider profile
writes need a directory-entry durability barrier after create, hard-link, rename
and delete. Unix fsyncs the directory. Windows has no directory fsync.

## Decision

`src-tauri/src/durable_dir.rs` (and the identical
`te_plugin_runtime::durable_dir` in TraceExplorer) flushes a **writable directory
handle** on Windows: `CreateFileW` with `GENERIC_READ|GENERIC_WRITE`,
`FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT`, a check that the
handle is a directory without a reparse tag, then `FlushFileBuffers`. Config
replacement keeps `MoveFileExW(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)`.

Basis:

- NTFS journals namespace changes. Flushing a handle forces the log through that
  handle's changes, which includes earlier records such as ancestor creation.
  Trace therefore flushes only the deepest directory on Windows; ordinary users
  cannot open ancestors like a drive root for write.
- Native windows-2022 qualification (tauri-explorer run 38033644731, host
  24622bea) measured a writable directory-handle flush returning success. A
  read-only handle returns `PermissionDenied`, which is why the handle is
  writable.
- A refused flush is returned as an error. Callers fail the operation; nothing
  claims durability it did not get.

Path handling stays on the existing std helpers proven by Trace publication:
final components open with `FILE_FLAG_OPEN_REPARSE_POINT`, and ancestors are
checked with `symlink_metadata`, which reports junctions and symlinks as links.
This does not defend against a same-user process swapping an ancestor between
check and use. The plan already treats same-user native plugins as not
OS-isolated (§9.1), so that race is outside the threat model.

## Superseded candidate

An earlier candidate, `windows_artifact_namespace.rs`, held every ancestor
handle and used handle-relative NT rename and link. It passed 20 standalone
native outcomes, but it was never wired into the Store, Trace or provider. It
was removed in favour of the barrier above, which the integrated native suites
exercise directly:

- the host "Rust platforms" Windows job (Store, `durable_dir`,
  installed-plugin tests);
- TraceExplorer's Windows "Build plugin" job (service-image handoff, restart,
  acquisition, discard and publication tests, plus the provider profile tests).

Its source remains in git history at 24622bea if handle-anchored ancestry is
ever needed.

## Not covered

- Physical power loss. Process-crash tests leave OS caches running.
- FAT/exFAT output folders. If the filesystem refuses the directory flush,
  publication fails closed instead of degrading silently.
