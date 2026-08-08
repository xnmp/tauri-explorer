# ADR 0002: Window-tab teardown owns asynchronous pane work

Status: Accepted

Governs: `src/lib/state/window-tabs.svelte.ts`

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
- It retains cleanup promises for explorers removed by pane close, tab removal,
  or pane collapse until those promises settle.
- `dispose()` waits for all registered and removed-explorer cleanup promises
  and for the initial-load promises pending when disposal begins to settle.
- Repeated `dispose()` calls share the first in-flight teardown, including
  cleanup started by synchronous restore or initialization paths.
- Cleanup failures are propagated only after both groups have settled. The
  first rejected explorer cleanup is rethrown; initial-load failures remain
  settled because their own navigation path owns their user-facing handling.
- Synchronous restore and initialization paths cannot await replaced explorer
  cleanup. They catch and report that failure through the application console
  boundary, so it cannot become an unhandled rejection.

## Consequences

Callers that need deterministic teardown must await `manager.dispose()`.
Vitest registers factory-created managers and drains them after each test, so
legacy tests cannot leave asynchronous explorer work alive when their worker
closes. Disposal may therefore complete later than before, but it cannot leave
sibling cleanup or load work running after a cleanup failure has already been
observed.

The regression tests must hold cleanup and load promises independently, proving
that one rejected cleanup does not make disposal settle before the other work,
including cleanup started by a pane-removal operation.
