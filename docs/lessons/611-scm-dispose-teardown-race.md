# #611 — teardown must own every async pane lifecycle

`createWindowTabsManager` starts directory loads without blocking pane creation,
and `ExplorerInstance.destroy()` removes persistent directory-listing listeners
asynchronously. Letting either task outlive manager disposal can send diagnostics
through Vitest after its worker RPC has closed, turning an otherwise green run
into an `EnvironmentTeardownError`.

The manager retains initial-load promises and collects every explorer cleanup,
including cleanup started when a pane or tab is removed from the live registry.
If removed-pane cleanup fails before teardown begins, it is reported through
the application error boundary rather than being silently discarded.
Its `dispose()` waits for both groups to settle before propagating a cleanup
failure, so one rejected cleanup cannot let a sibling cleanup or initial load
continue after test teardown. Tests that create a manager must await
`manager.dispose()`. The Vitest setup also centrally drains every initialized
manager, preventing a newly added test from reintroducing the race by omitting
local teardown.

The ordering and cleanup-failure contract is governed by [ADR 0002](../adr/0002-window-tabs-teardown.md).
