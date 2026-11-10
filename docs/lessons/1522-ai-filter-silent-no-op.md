# #1522 — AI filter: Alt+Enter looked like it did nothing

**Report:** typing a request in the Ctrl+F box and pressing Alt+Enter showed
nothing at all — no result, no notification, no toast (Linux, v1.21.0).

**What was silent:**

- The only feedback was the box's inline status, a small popup floating under
  the pane toolbar. It is pane-local, positioned inside the toolbar's stacking
  order and easy to miss; it is not a channel a "did anything happen?" outcome
  can rely on.
- An empty box returned without a word.
- A backend `cancelled` error was swallowed even when the user had not
  cancelled (the native owner check can raise it), leaving the box spinning.
- `ai_text_describe` had no deadline (the plugin facade did): a profile check
  that never returns (locked Secret Service, stalled CLI probe) kept the
  request waiting forever.
- A right Alt mapped to AltGraph (common on Linux layouts) reported
  `altKey=false`, so the chord arrived as a plain Enter that nothing handles.

**Fix:** `state/ai-filter.svelte.ts` takes a `notify` sink (the toast store in
production) and raises a toast for every outcome that is not a non-empty
result: empty request, unavailable model (with the backend's reason), backend
failure, malformed reply, and zero matches. Its own cancellation, supersession
and navigation stay silent because `settle` drops them by state identity, so
the explicit `cancelled` early return is gone. `isAiFilterKey` in
`domain/ai-filter.ts` accepts AltGraph. `ai_text_describe` now uses
`describe_owned` (5 s deadline, window owner check).

**Rule:** a keyboard-triggered feature must answer every press with something
the user can see. Pane-local floating hints are decoration, not the feedback
channel; route outcomes through the toast store and unit-test that sink.
