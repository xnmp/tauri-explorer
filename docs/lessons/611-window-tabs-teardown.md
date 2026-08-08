# #611 — async teardown must reach the test boundary

`ExplorerInstance.destroy()` removes its persistent directory-listing listener
asynchronously. Calling it from `windowTabsManager.dispose()` without returning
that promise let a Vitest test finish while listener cleanup was still active.
Under load, the late work could log through Vitest after its worker RPC channel
had closed, turning an otherwise green run into an `EnvironmentTeardownError`.

The manager now collects all explorer destruction promises and resolves
`dispose()` only after they settle. Tests that create a window-tabs manager must
therefore `await manager.dispose()` during cleanup. The regression test holds an
explorer cleanup promise open and proves the manager's disposal promise remains
pending until it is released.
