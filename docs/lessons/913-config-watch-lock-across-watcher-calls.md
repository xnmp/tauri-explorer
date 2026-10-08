# Never hold a lock the notify callback takes across `watch`/`unwatch` (#913)

`config_watch::reconcile_watch_plan` held the plan mutex while calling
`watch`/`unwatch` for a retargeted symlink, and the event callback locks the
same mutex to map paths. Every notify backend completes those calls on the
thread that runs the callback: inotify and ReadDirectoryChangesW wait for their
event loop to acknowledge, and FSEvents' `stop()` spins until its run loop is
idle, then joins it. An event arriving during a handover therefore deadlocked
the refresh worker against the backend thread. On macOS the worker spins a
core forever. Config autoreload stops on every platform, and the test
harness's unbounded `join()` hung CI for 60 minutes.

Rules:

- Hold a callback-shared lock only to swap state, never across a watcher call.
  `files/watch_observation.rs` follows the same rule for directory watches.
- Publish the replacement plan before registering its new roots, and restore
  the previous plan if a registration fails. The first event from a new root
  is then already mapped, and events from a retired root are already filtered.
- Bound every teardown that waits on a watcher thread. Record the worker's
  phase, so a stuck teardown names the call it is blocked in
  (`ConfigWatchHarness::shutdown`).
- Pace writers in real-watcher stress tests. An unbroken write storm starves
  inotify's event loop of the watch request itself, which looks like a
  deadlock but is not one.
- Use a condition-variable wait that checks its predicate
  (`wait_timeout_while`). A plain `wait_timeout` misses a stop that is
  requested before the wait begins.
