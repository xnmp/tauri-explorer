# #1729 — Ctrl+T dropped the selection highlight and preview for a frame

A new tab (or split pane) at the same folder is seeded with the source pane's
rows so it renders at once, but its selection was only chosen when its own
listing settled. Until then the seeded rows showed no highlight (most visible
in Tiles) and the preview pane, which follows the active pane's selection,
flashed "Select a file to preview".

Fix, in two independent parts:

- `createExplorerState` selects the seeded pane's first displayed row at
  creation — the row its listing would pick. `navigateInternal` snapshots the
  selection revision when the listing starts, which is after creation, so the
  seed still counts as "no user selection": a click before the listing settles
  wins, and an untouched pane still takes the listing's own first row.
- Explorers expose `awaitingFirstListing` (true until a listing settles, ok or
  error; a superseded listing does not settle it). The pure
  `previewFileFor` in `domain/preview-kind.ts` keeps the already-shown file while
  the active pane awaits its first listing and has selected nothing. This covers
  unseeded panes (Toggle Dual Pane opens the parent folder, so it has no seed).

Testing: a seeded selection race needs a held listing in the Vitest explorer
suite. Frame-level regressions need a rAF sampler started before the keypress
plus artificial listing latency (`__mockControl.latency` on every listing
command); a single post-hoc DOM assertion lands after the listing and passes
on the broken code. `e2e/new-tab-selection.spec.ts` counts selected rows per
frame in all three view modes; `e2e/new-tab-preview.spec.ts` samples the
preview and isolates the hold with the unseeded split.

Carried over unchanged: the new tab selects its first row, not the source
tab's selection.
