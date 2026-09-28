# #715 — Distinguish paste failure from delayed listing publication

The Windows native clipboard smoke intermittently timed out while polling the
rendered file names after Paste. The retained failure did not record whether a
duplicate existed on disk, so it could not distinguish a clipboard or copy
failure from a watcher or renderer-publication failure.

Observe the listing mutation inside the renderer with one asynchronous
WebDriver command. If the expected second matching name does not appear, retain
the directory contents, rendered entry names, runtime metadata, window state
and a screenshot under `e2e-tauri/logs/`. This is diagnostic hardening rather
than evidence of a product defect: the original run did not capture enough
state to attribute the timeout.

The next instrumented Windows run exposed a separate race in the same path:
WebDriver's Copy click returned while the native PowerShell file-list write was
still running. Paste started its clipboard read roughly 180 ms later, before
that write finished; the read returned no paths. The in-app fallback made that
particular run pass. The earlier failed run had no phase logs, so its exact
failure path remains an inference rather than a recorded fact.

A behavioral regression test reproduced the harmful variant: when the OS
clipboard still held a previous file list, Paste immediately after Copy read
that stale list instead of the newly selected file. Keep local clipboard writes
ordered and wait for them before reading the OS clipboard; then compare that
result with the current in-app selection. Close the Copy/Cut context menu when
the click is accepted, because a slow native write must not close a newer menu.
The cross-window ordering case is tracked separately in #835.
