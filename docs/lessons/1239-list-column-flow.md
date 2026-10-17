# List column flow (#1239, phase 2)

List fills fixed 260px columns vertically in 30px slots and scrolls sideways.
Its pure placement snapshot is shared by rendering, reveal and keyboard moves;
the creation sentinel occupies a slot but is excluded from entry indices.
`listViewColumns` and `listColumnMaxWidth` remain readable legacy settings.

Measure height and commit the resulting row count synchronously inside the
ResizeObserver delivery. Never defer painted geometry to a later frame. The
short-pane fallback can add a vertical scrollbar, so observe the CSS-sized
border box rather than feeding content-width changes back into the observer.
After applying the short class, a normal-flow, zero-height width probe gives
the actual fractional content width in the same delivery. Ignore hidden retained
tabs' zero measurements.

Browser helpers that count mounted List entries must await its first geometry
delivery after switching modes. The first option can mount before that delivery:
the four-row setup window contains eight entries while a settled home listing
contains nine. Observe the scrollport once instead of adding a settling timeout.

Virtualization must preserve keyed rename/creation editors, refresh stationary
marquee/drop hit tests after scrolling, and reveal before moving DOM focus.
Home/End select and reveal even when the cursor already names the endpoint;
cursor equality cannot establish that selection or viewport position is settled.
Outgoing views clear reveal/membership bindings by identity: a cold lazy import
can otherwise call a disposed view after navigation. Keep callback reads out of
the parent's reactive dependencies to avoid subscribing to a child being removed.

Every built-in renderer (Details, column List, classic List, Tiles) loads on
demand through one seam, `components/view-loaders.svelte.ts`, to preserve the
startup budget; do not add inline `{#await import(...)}` blocks beside it. A
settled renderer is published reactively and rendered directly. An `{#await}` on
the memoised, already-resolved promise mounted every new pane's view from a
promise reaction (Svelte's await block calls `flushSync` there); a Playwright
`page.evaluate` that split a pane then failed with "Execution context was
destroyed" (CDP: "Promise was collected"), failing 24 `pane-dialogs` cases. Their
stylesheets can arrive after FileList's shared focus chrome. Pointer-focus resets
must exclude `:focus-visible`, renderer chrome uses `:where(...)` so it stays
below the shared ring, and selected keyboard-focus rules must outrank renderer
selection borders regardless of stylesheet order. Verify theme contrast as well
as outline existence.

## Folder Peek toggle

Column flow is part of Folder Peek (`settingsStore.folderPeek`, default on). Off,
List must be the origin/dev row-major `ListView.svelte` with `listViewColumns`/
`listColumnMaxWidth`, the List Columns submenu, `view.setListColumns` (gated by
`when`) and the old keyboard rules (+/-1 horizontally, yazi in a single column).
FileList chooses `ListColumnsView` or `ListView` and swaps them live. Keyboard
dispatch takes an explicit `listLayout: "rows" | "columns"` in
`resolveFileListMove`; do not infer it from the snapshot. Both List renderers
use `.list-scroller`, so e2e code that must tell them apart keys on
`.list-canvas` (column flow only). E2E loops cover both through
`VIEW_VARIANTS`/`ALL_VIEW_VARIANTS` in `e2e/helpers.ts`; `folder-peek-setting.spec.ts`
asserts the live switch.

## Review follow-ups

- `$derived` compares by identity: a derived `{start,end}` object from `listColumnRange` re-created every mounted wrapper on each scroll frame. Derive primitives (`rangeStart`/`rangeEnd`) so scrolling inside the mounted window does no per-item work (`tests/composables/use-list-columns.test.ts`).
- Wheel to scrollLeft needs a sub-pixel carry (`listWheelStep`); browsers round `scrollLeft +=` per direction, so fractional deltas stalled one way. Horizontal-dominant gestures, Ctrl-wheel and range ends must not `preventDefault`.
- Start renderer chunks (`components/view-loaders.svelte.ts`) when the view is known, not after the listing settles. A navigation that settles while the chunk is pending keeps its cursor reveal; the mounted view's first `onlayoutchange` focuses it only if focus is still on the body or the listing (`e2e/folder-peek-renderer.spec.ts`).
- A DOM `dragend` retires drop feedback unless it is positively a stale echo (`domain/drop-feedback.ts`); a sessionless native hover no longer blocks it.
