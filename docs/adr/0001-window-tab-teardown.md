# ADR 0001: Window-tab teardown settlement

Status: Accepted

Governs: `src/lib/state/window-tabs.svelte.ts`, `src/lib/state/explorer.svelte.ts`

## Context

Explorer creation starts directory loads asynchronously. Explorer destruction also
releases directory-listing resources asynchronously. Test and process teardown
must not close their environment while either kind of work can still emit a
diagnostic.

## Decision

`createWindowTabsManager().dispose()` is asynchronous. It starts all explorer
destructions and settles both the destruction group and the manager's tracked
initial-load group before it settles itself. If a destruction fails, `dispose()`
propagates that failure only after both groups have settled.

Synchronous replacement paths may initiate destruction without awaiting it;
their lifecycle does not signal environment teardown. Test cleanup that creates
a manager must await `dispose()`.

## Consequences

The teardown boundary is deterministic for callers that await it: no owned
explorer cleanup or initial load remains in flight after success or failure.
The first cleanup error remains observable without abandoning sibling work.
