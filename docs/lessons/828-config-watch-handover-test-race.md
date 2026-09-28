# #828: Observe the replacement source before judging watcher handover

Linux CI for #812 failed the real config-symlink watcher test after an old-target
write. The test waited for one poll interval plus 300 ms, drained pending events,
then treated 400 ms of callback silence as proof that the old target had been
unwatched. Under CI scheduling, a delayed config-entry or native event can arrive
after that drain. The failure did not establish that production handover was
incorrect; the original callback reported only the config name, so the test
could not identify which path produced the event.

The real-watcher test now records the native source path and repeatedly writes
the replacement target until it receives an event from that target. It checks
the watcher's registered-root state and mapping at that point: the new target
must be registered and the old target absent. Teardown is checked by callback
channel disconnection, rather than a short silence window. The public callback
contract still reports only the config name.

For watcher tests, a fixed delay is not a synchronization point. A callback
without source identity cannot prove which registration delivered it. Keep
separate deterministic watcher-operation tests for exact `watch`/`unwatch`
calls, and use sourced native events for the real integration outcome.
