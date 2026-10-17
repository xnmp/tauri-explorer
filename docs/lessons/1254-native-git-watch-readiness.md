# 1254 — Native Git-watch readiness uses acknowledgement identity

The first failing dev smoke run passed on Linux. The Windows case-outcome
artifact recorded 123 passing cases, four skips, and one failure: Folder Peek
timed out at “nested Git lease was never acknowledged.” The application log
showed successful native registration for that exact nested repository.

The new Folder Peek spec indexed `data-e2e-git-watches` with `path.join`'s native
Windows path. `api/git.ts` publishes that record under `directoryKey`, which
normalizes separators, Windows case and trailing separators. The raw lookup
could never find the acknowledged lease on Windows. The earlier console excerpt
ended in an unrelated passing clipboard spec; retained case outcomes located
the actual failure.

Use `waitForGitWatch` to normalize the runner-side argument before sending it
to `browser.execute`. Imported helpers are unavailable inside WebDriver's
serialized callback. Keep the timeout and positive lease-count requirement.
The native spec still stages the real file and requires its Added badge, then
checks causal directory receipts, watch-cap fallback, pruning and lease retirement.

The regression uses the real API acknowledgement publisher with only native IPC
mocked, then executes the real readiness callback in a separate JavaScript
context. Before normalization, Windows, UNC and WSL acquisitions fail while
POSIX passes. After normalization, they pass; failed acquisitions, final release
and neighboring roots remain rejected. This fixes the diagnostic precondition
without reverting Folder Peek or changing native observation policy (ADR 0009).
