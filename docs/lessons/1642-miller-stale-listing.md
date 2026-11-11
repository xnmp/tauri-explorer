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
