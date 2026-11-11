# Miller columns: a slow listing overwrote a newer one

`MillerColumns.svelte` re-read an ancestor column on every watcher event and
local mutation, and published whichever read finished last. A slow first read
that resolved after a re-read replaced fresh entries with the pre-change ones.

The listings now live in `state/miller-columns.svelte.ts`, one request slot
(`domain/request-slot.ts`) per column, so only the newest read can settle.
Watcher events are scheduled through `requestRefresh`; local mutations still
re-read the shown column immediately (#598). The store loads lazily with the
first mount: the startup bundle had no room for it, and the columns and their
reserved width still come from the component on the first frame.

Repro: `tests/state/miller-columns.test.ts` ("a slow listing cannot overwrite
the newer listing that superseded it"), which fails without the slot guard.

Independent review also reproduced late emptiness probes overwriting newer
answers, and hidden columns reusing entries across an unwatched gap. Probes
now carry per-path tokens invalidated with their answers; returning columns
keep their cached display while requesting a new snapshot.

The native regression caught a second cache layer that the injected unit
reader did not model: `fetchDirectory` uses `list_directory`, whose backend
cache lasts five seconds. A change while unwatched can therefore survive a
new frontend read. Ancestor reads use the existing `loadDirectory` fresh
snapshot API, just like pane navigation/reconciliation; no extra refresh gate
or cache-invalidation command is needed.

`e2e-tauri/specs/miller-column-freshness.spec.ts` checks a real external rename
(after a backend-observation-time-qualified watcher receipt), then releases
the ancestor watch, writes while unobserved and returns to the cached column.
The native watch-ready probe tracks active lease IDs and publishes release
only after unwatch IPC acknowledges it; a historical list of ever-watched
paths cannot establish that gap.

Listener registration and native watch admission must both settle before the
first authoritative scan. Starting them in parallel with the scan leaves a
gap after the snapshot and before observation begins. The watch record owns
the admission promise; a hidden, replaced or disposed owner cannot start a
scan when its old admission eventually finishes. Tests exercise both readiness
orders, disposal, rapid hide/reentry and unavailable watches.
