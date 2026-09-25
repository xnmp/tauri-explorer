# Native Trash inverse admission — #740

Linux native Copy Undo, Trash Redo and exact restoration now reserve their actual
filesystem effects through the shared prepared-admission coordinator. This patch
is based on deletion PR #741 (`a2890ddb`), not yet merged `dev`.

## Evidence

- Before the fix, three actual `NativeOperations` adapters changed disk contents
  despite conflicting managed claims. The regression fails against that behavior.
- Full Rust library suite with both durable recovery features: **1,281 passed,
  22 ignored, zero failed**. Strict all-target/all-feature Clippy passes.
- Contracts cover disjoint artifacts, conflicting targets/metadata/parents,
  aliases, native non-UTF-8 publications and lossy-name collisions, hardlinks,
  substitutions, partial parent creation and lost waiters. Existing metadata
  failure and exact-artifact tests run against the consolidated restoration engine.
- Real Arch native binary, X11/Xvfb, WebKitGTK 2.52.5: **10 tests in 3 specs pass**.
  Partial deletion and missing-parent restoration check actual content and listing
  refresh. Actual Copy Undo completes after its invoking child is destroyed;
  the surviving main window then performs two exact Redo cycles, with an
  intervening Undo, while the original source remains unchanged.
- The native destruction gate precedes resource admission: that test establishes
  native history lifetime. A separate Rust worker test establishes that an already
  acquired resource claim survives waiter loss through worker completion.
- Frontend and native E2E TypeScript checks pass with zero errors; Svelte reports
  zero warnings. Only the development test probe changes in frontend code.
- Independent GPT-5.6 Sol adversarial source and native-test review found no
  remaining blocker after overlap validation and native-path settlement fixes.

The accompanying JSON records local raw-log and binary hashes. Local logs are
not remotely available artifacts. Committed screenshots show the restored partial
batch result with its Undo toast and the surviving window's restored copy; native
assertions additionally verify the resulting Undo/Redo summary and exact bytes.

## Boundaries

Windows/macOS are not qualified here. This does not establish crash-durable Trash
or atomic identity-conditional protection from arbitrary external processes.
Native rename inverse admission remains #749; permanent-delete external identity
safety remains #739. No startup or general performance improvement is claimed by
this patch. No release or merge is implied by acceptance results.
