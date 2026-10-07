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
`src-tauri/test_support/config_watch_registration_contracts_test.rs` additionally model
exact-root callback ownership and partial native cleanup. See ADR 0004.

`src-tauri/tests/config_watch_nested_root_test.rs` exercises the public watcher
and real refresh worker, including when the entire implementation file is
reverted. It waits for the ancestor inode to leave `/proc/self/fdinfo`, then
receives a first-ever bookmarks event as a barrier for the native removal's
callback thread before probing the canonical nested target. No fixed refresh
sleep or symlink-entry callback can substitute for completed ancestor retirement.

A failed unregister is ambiguous: it can leave a native watch active or report
an error after removing it. Keep pending removals separate from confirmed active
coverage. If the symlink returns to that root before cleanup succeeds, resolve
the cleanup and establish fresh coverage rather than trusting the old map entry.
When returning-ancestor cleanup invalidates the previous plan's descendants,
restore their native coverage if registration fails and the plan rolls back.
`src-tauri/test_support/config_watch_cleanup_return_test.rs` checks one callback
after returning under both failure models, cleanup retry, and rollback coverage.
