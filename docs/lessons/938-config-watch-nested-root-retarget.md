# Config symlink retargets can remove surviving inotify watches

Registering `/dots/sub` and then unregistering recursive `/dots` does not retain
the nested watch: notify 8's inotify backend removes every watch beneath the old
root. This also affects an unchanged theme root or the config directory itself
when they are nested under the retired root.

The config watcher keeps registration-first handover, then invalidates descendant
registration records after each attempted retirement and restores surviving
coverage after all retirements on Linux/Android inotify. Exact-root backends,
including Windows, keep their surviving watches without duplicate registration.
Failed restorations remain retryable; a partial removal error must also invalidate
surviving descendants while preserving obsolete descendants' individual cleanup
obligations. `WatchNotFound` completes cleanup of that exact root when a prior
removal already removed it; it does not prove descendants were cleaned up.

The regression tests use real inotify with the production plan resolver,
handover, and callback mapping. They complete handover synchronously before
writing canonical targets: a write made earlier can still be observed by the old
ancestor and incorrectly make a broken retarget look successful. Assertions
check config-relative names and the canonical event source, preventing delayed
symlink-entry events from standing in for target writes. Backend contracts in
`src-tauri/test_support/config_watch_registration_contracts.rs` additionally model
exact-root callback ownership and partial native cleanup. See ADR 0004.
