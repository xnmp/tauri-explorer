# 772 — The Rust suite had never run on macOS or Windows

CI ran `cargo test --lib` only on ubuntu. macOS compiled the `cfg(unix)`
recovery and `native_directory` code but tested none of it, and Windows ran
eight filtered contract families. The first full runs failed in these ways.

## Test environments
- **Temporary directories are not canonical.** macOS puts them under
  `/var -> /private/var` and Windows under `RUNNER~1`. Handle walks require
  canonical paths, and watchers report canonical ones. Both platform jobs set
  a canonical temp directory, and test plans key paths as production does
  (canonicalized first).
- **Git on the Windows runner defaults to `core.autocrlf=true`.** Test
  repositories that assert contents byte for byte pin it to `false`.
- **8.3 short names depend on the volume.** A short-name alias test finds a
  temporary volume that generates them instead of trusting `TMP`.
- **BSD `find` spawns but rejects GNU flags.** Probe with `find --version`
  rather than for the binary's presence.

## Platform semantics
- **macOS `fstat` keeps a removed directory's link count nonzero.** The
  "retired directory is not private storage" check is Linux-only. APFS also
  cannot represent case-variant names or names that are not UTF-8.
- **An elevated Windows Server token's default owner is Administrators**, not
  the user. Inherited children of private storage are owned by the token's
  default owner.
- **`ReOpenFile` rejects directory handles with `ERROR_ACCESS_DENIED`**, for
  every access mask and with `FILE_FLAG_BACKUP_SEMANTICS`. A diagnostic proved
  it on plain temporary directories, which ruled out the private DACL.
  `Directory::names` needs an independent cursor, so it opens a second handle
  by the 128-bit file ID (`OpenFileById`). That still resolves after the
  anchor's name is replaced.

## Diagnosing on a remote runner
Cargo captures a passing test's output. A diagnostic test must fail with its
report (`panic!` with the collected lines), or the data never reaches the log.
