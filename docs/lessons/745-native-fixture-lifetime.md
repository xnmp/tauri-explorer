# 745 — Native E2E fixtures must outlive the app process

## The bug

Most native specs created their own scratch directory with `fs.mkdtempSync`
and removed it synchronously from a Mocha `after`/`afterEach` hook, with no
retry. That hook runs while the driven `tauri-explorer` process is still
alive: the app can still hold an open handle on the directory (or an ancestor
of it) at that exact moment, most plausibly a non-recursive filesystem-watch
handle registered on the fixture's parent for the duration of the session (see
"Refresh policy" and the pane-watch rules in the top-level `CLAUDE.md`). On
Linux, `unlink`/`rmdir` on a directory an open `fd` still references usually
succeeds — the dentry is just unlinked, the inode survives until the last
close. On Windows, `DeleteFile`/`RemoveDirectory` fail outright while any
handle is open unless every open handle was itself opened with
`FILE_SHARE_DELETE`, which a `notify`/`ReadDirectoryChangesW` watch is not
guaranteed to be. That asymmetry is why this only ever showed up as a Windows
smoke-suite flake (EBUSY-equivalent, `ERROR_SHARING_VIOLATION` /
`ERROR_ACCESS_DENIED`) and never locally on Linux — the same code path, same
race window, different OS-level enforcement.

## The fix

`createNativeFixtureDirectory` (`e2e-tauri/native-qualification.ts`) places a
spec's fixture under `TAURI_NATIVE_CLEANUP_STATE_DIRECTORY`, a directory
`wdio.conf.ts` prepares once per run (`onPrepare`) and only removes in
`onComplete`, i.e. after every worker has awaited native process termination
(`stopNativeQualificationProcesses`). A spec that wants a fixture just calls
the helper and never removes it itself; there is nothing left racing a live
process, and the final removal retries transient failures
(`maxRetries`/`retryDelay`) instead of asserting a bare `rmSync`.

A handful of fixtures could not route through the shared root as-is:

- Freedesktop Trash requires the source and its Trash directory to share a
  device; `os.tmpdir()` is frequently a separate tmpfs from `$HOME`. Rather
  than leave every trash-adjacent spec unfixed, the shared cleanup root itself
  is now rooted under `os.homedir()` (`wdio.conf.ts`'s
  `createNativeProcessCleanupHooks({ temporaryRoot: os.homedir() })`), so the
  normal helper serves them too.
- `file-move-recovery.spec.ts`'s cross-device describe still needs one side on
  `/dev/shm` specifically to prove a real filesystem boundary; that one keeps
  its own `mkdtempSync` + immediate `rmSync`, annotated
  `native-fixture-lifetime-allow: <reason>`, and only runs on Linux.
- `git-cache-lifetime.spec.ts` needed a `|` delimiter character in its
  repository path, which the helper's prefix validation
  (`/^[a-zA-Z0-9_-]+$/`) rejects. The delimiter now lives in a nested directory
  name created under a plain-prefixed fixture root instead of in the root's own
  name.

## The regression guard

`tests/contract/native-fixture-lifetime.contract.test.ts` statically scans
every `e2e-tauri/specs/*.spec.ts` for an identifier that was bound to a
`mkdtempSync(...)` call and is later passed to a recursive `fs.rmSync`/`fs.rm`.
It distinguishes a fixture-root removal from a legitimate in-test deletion (a
single file, a non-recursive removal, or a path derived from the root rather
than the root identifier itself — e.g. a watcher test deleting one entry, or a
gate/artifact marker file) by keying only on the *exact identifier* the
`mkdtempSync` call was assigned to. A real exception is exempted with a
`native-fixture-lifetime-allow: <reason>` comment within ~500 characters of the
removal; a second guard test asserts every marker in the specs directory
carries a reason after the colon, so an exemption can't be added silently.
