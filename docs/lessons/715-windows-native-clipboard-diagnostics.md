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
