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
  - A seed must be the source's *listing* (`ownEntries`), not its presentation
    (`ownDisplayEntries`): a filtered source seeded only the matching rows and
    selected one of them, then the new pane's listing (which drops the filter)
    jumped to the folder's real first row.
  - Seeding is skipped when the order can still change after creation: Details
    sorts by asynchronously resolved keys (length, lineage prompt, Date opened)
    or an active lineage grouping. Those panes keep the old behaviour.
- Explorers expose `awaitingFirstListing` (true until a listing settles, ok or
  error; a superseded listing does not settle it). The pure
  `previewFileFor` in `domain/preview-kind.ts` keeps the already-shown file while
  the active pane awaits its first listing with nothing selected — but only a
  file of that pane's own directory. An unbounded hold showed a file from
  another folder for as long as a slow mount or restored tab loaded.
  `state/preview-file-hold.ts` owns the previous-value input, so the component
  holds no state of its own.

Testing: a seeded selection race needs a held listing in the Vitest explorer
suite. Frame-level regressions need a rAF sampler started before the keypress
plus artificial listing latency (`__mockControl.latency` on every listing
command); a single post-hoc DOM assertion lands after the listing and passes
on the broken code. End the sampling window by frame count as well as time
(at least N frames *and* the listing latency): CI's WebKit runner draws so few
rAF frames that a wall-clock window recorded under six of them. `e2e/new-tab-selection.spec.ts` counts selected rows per
frame in all three view modes; `e2e/new-tab-preview.spec.ts` samples the
preview, including the cross-folder split (empty state, never the old file).
The filtered-source case runs against the mock backend in
`tests/state/window-tabs-seed.test.ts`.

Carried over unchanged: the new tab selects its first row, not the source
tab's selection.
