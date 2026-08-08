# #611 — teardown must own every async pane lifecycle

`createWindowTabsManager` starts directory loads without blocking pane creation,
and `ExplorerInstance.destroy()` removes persistent directory-listing listeners
asynchronously. Letting either task outlive manager disposal can send diagnostics
through Vitest after its worker RPC has closed, turning an otherwise green run
into an `EnvironmentTeardownError`.

The manager retains initial-load promises and collects every explorer cleanup.
Its `dispose()` waits for both groups to settle before propagating a cleanup
failure, so one rejected cleanup cannot let a sibling cleanup or initial load
continue after test teardown. Vitest drains factory-created managers after each
test, so legacy tests also settle that work before their worker closes.

The ordering and cleanup-failure contract is governed by [ADR 0002](../adr/0002-window-tabs-teardown.md).
