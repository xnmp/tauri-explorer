# ADR 0001 — Window-tab teardown owns asynchronous pane work

**Status:** Accepted

**Governs:** `src/lib/state/window-tabs.svelte.ts`

## Context

Creating a pane starts a directory load without blocking rendering, while
destroying an explorer removes its directory-listing listener asynchronously.
If a test environment closes after `WindowTabsManager.dispose()` returns but
before either task finishes, late diagnostic output can reach a closed Vitest
worker RPC channel and fail an otherwise green run.

## Decision

The window-tab manager owns asynchronous pane work that it starts or destroys:

- It retains each initial `initialLoad` or `navigateTo` promise started while
  registering an explorer.
- `dispose()` waits for all registered explorer cleanup promises and for the
  initial-load promises pending when disposal begins to settle.
- Cleanup failures are propagated only after both groups have settled. The
  first rejected explorer cleanup is rethrown; initial-load failures remain
  settled because their own navigation path owns their user-facing handling.

## Consequences

Callers that need deterministic teardown, particularly tests, must await
`manager.dispose()`. Disposal may therefore complete later than before, but it
cannot leave sibling cleanup or load work running after a cleanup failure has
already been observed.

The regression tests must hold cleanup and load promises independently, proving
that one rejected cleanup does not make disposal settle before the other work.
