# #1387 — first clicks after page load read as a marquee drag release

`useMarqueeSelection` measured "a drag just ended" as
`performance.now() - dragEndTime < 500` with `dragEndTime = 0`. Since
`performance.now()` counts from navigation start, every click in the first
500 ms after load counted as a drag release, and caret-less Folder Peek
(`shouldToggleOnRowClick`, `wasDrag`) ignored it.

- An "elapsed since the last X" timestamp must start at `-Infinity` (or be
  nullable), never `0`, whenever the clock it is compared against starts near 0.
- It surfaced only on the prebuilt E2E bundle (#1381), whose faster startup put
  the specs' first click inside the window; CI retries hid it as flakiness.
  Instrumenting the toggle decision (`wasDrag=true`) found it in one run.
- Regression: `tests/state/marquee-drag-end.test.ts`.
