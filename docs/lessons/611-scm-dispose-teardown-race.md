# #611 — teardown must own every async pane lifecycle

`createWindowTabsManager` starts directory loads without blocking pane creation,
and `ExplorerInstance.destroy()` removes persistent directory-listing listeners
asynchronously. Letting either task outlive manager disposal can send diagnostics
through Vitest after its worker RPC has closed, turning an otherwise green run
into an `EnvironmentTeardownError`.

The manager retains initial-load promises and collects every explorer cleanup.
Its `dispose()` waits for both groups to settle before propagating a cleanup
failure, so one rejected cleanup cannot let a sibling cleanup or initial load
continue after test teardown. Tests that create a manager must await
`manager.dispose()`.
