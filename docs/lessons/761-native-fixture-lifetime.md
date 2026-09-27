# 761 — Keep every native fixture until application teardown

Native spec `after` hooks run before the driven application exits. Deleting a
fixture there can race a native watcher or another open handle, including the
Windows EBUSY failures recorded in lesson 745. Retrying inside the spec does
not establish ownership or termination.

Ordinary fixtures now use `createNativeFixtureDirectory`. The launcher's
existing process-cleanup owner prepares its root on the home filesystem so
Linux Trash fixtures retain their required placement. Cross-device move tests
use `createNativeSharedMemoryFixtureDirectory` under a second owned `/dev/shm`
root. They still assert distinct filesystem devices. There is no fallback to
the ordinary root if shared-memory fixture ownership is unavailable.

Workers inherit both root paths. Their teardown stops the application once;
launcher completion removes both roots and aggregates failures rather than
abandoning the second root after the first failure. Partial preparation rolls
back all roots already created. Permission-failure tests repair their own
fixture permissions but leave deletion to launcher completion.

Recovery suites whose parents are supplied by an external harness keep that
explicit owner. The allocation guard requires a reason beside every remaining
hand-written `mkdtempSync`, catching aliases, wrapper-based deletion, and leaked
allocations that the previous direct-assignment/removal regex missed. It is a
source convention check; runtime ownership is covered separately.

Regression evidence: all three new multi-root lifecycle contracts failed before
the shared owner extension. The complete fixture guard and process edge-case
files pass 22 tests afterward, including existing cleanup-failure reporting.
Native TypeScript checking passes. Full native/platform CI remains the merge
acceptance gate; local unit tests do not reproduce Windows sharing locks.

The full default Linux native suite passed after integration with the Windows
spec prerequisites: 88 executed tests passed, 17 gated tests skipped across
40 spec files. Both owned filesystem roots were absent after launcher completion.
Run with the documented DBus/Openbox wrapper, and keep an isolated XDG data
profile on the fixture filesystem: putting XDG_DATA_HOME on a separate tmpfs
changes Trash selection to mount-level Trash and can invalidate these fixtures.
This default run does not qualify the skipped durable-recovery suites.
