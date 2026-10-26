# 1228 — Native Trash rows: resolve by identity, not by cached handles

`e2e-tauri/specs/trash-view.spec.ts` failed after the first Restore on
Arch/WebKitGTK although the restore itself succeeded (exact bytes back at the
original path, row removed). The application was correct; the test helper was
not.

`trashRow(name)` enumerated `$$(".pane-tree:not(.retained) .entry-item")` and
then queried each handle's `.entry-name`. A Restore refreshes the Trash
listing, so a handle enumerated before that refresh can name a removed row.
WebdriverIO recovers a stale `$$` element by re-running the selector and taking
the same **index**. That has two failure modes:

- An index past the shorter refreshed list waits the whole `waitforTimeout`
  (15 s) and then throws `Index out of bounds! $$(...) returned only N
  elements`. The removal wait walks every row looking for an absent name, so it
  always reaches the trailing handles. Mounted-volume Trash rows (an isolated
  XDG profile does not empty them) make the list longer and the window wider;
  chained re-fetches can run to the 60 s Mocha timeout.
- A shifted index silently re-binds the handle to a *different* row.

Reproduced with an uncommitted spec that enumerated handles, restored rows
through the real backend, then walked the old handles: the walk for the
restored name blocked 15.3 s and threw `Index out of bounds`, while a fresh
snapshot resolved the remaining row in ~50 ms. The unchanged original spec
also failed on this host with that same error 21 s into the run.

Fix: read names and `data-path` in one `browser.execute` (an atomic DOM
snapshot), then act on `$(entryPathSelector(path, ".pane-tree:not(.retained)
.entry-item"))`. Trash row paths are `trash://<id>` built from the native
entry ID, which is stable across listings (`domain/trash.ts`,
`trash_inventory::entry_id`), so the selector re-resolves to the same item at
each action. Row-absence checks use the snapshot too. All outcome assertions,
timeouts and application code are unchanged; 5/5 consecutive native runs passed
(~4 s each) under Xvfb with a private D-Bus session and XDG profile.

General rule: in native specs, never carry `$$` element handles across an
action that can refresh the list. Snapshot inside the page and re-resolve by a
stable attribute.
