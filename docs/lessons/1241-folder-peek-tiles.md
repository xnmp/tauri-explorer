# Tiles panels (#1241, folder peek phase 4)

With Folder Peek on, Tiles renders through `TilePanelsView` (lazy chunk
`tiles-panels`) even with no panel open, so a tile keeps its DOM node across a
toggle. Off is the untouched classic `TilesView`. Placement, sizing, outlines,
navigation and motion are pure (`domain/tile-panel*.ts`); `useTilePanels` owns
the model, motion frames, panel scroll offsets, the grip preview and reveal.

## One VirtualList item per row group

A grid row and its bands (above, below, stacked) are one variable-height item.
Outlines and ribbons only ever join a row to its own bands, so each group draws
its own SVG with no cross-item overlay. `getItemHeight` reads the displayed
geometry, which motion frames replace, so VirtualList's offsets follow every
frame. Panels virtualize their own rows (window ±1 row, plus a renaming entry).

## Mounted row identity

VirtualList's destructured each item is an object, and Svelte treats an object
derived as changed every time it is re-delivered, so every mounted row re-reads
`tiles.cells(group)` on every scroll frame (407 calls for 86 new rows in 30
frames). Fresh cell objects then updated every mounted tile's props each frame:
with Folder Peek on and no panel open, plain scrolling cost 31% more renderer
task time than classic Tiles in the perf sweep. `cells` now returns one array per
row group for the model's lifetime (a `WeakMap` in a derived keyed by the
model and entries).

That sweep also always measured classic first on a fresh page. The first case
on a page runs markedly slower (warm-up), so the order charged it to classic
and understated the peek renderer: the "+8%" was wrong. Alternate the order
when comparing two renderers in one page. Rendering each grid tile through the
shared tile snippet also cost a snippet block per tile, plus an if block around
its caret. Grid tiles are now written inline, and the caret is the peek cell's
own child placed from the tile layout (`paddingTop` + icon size), so classic
Tiles' shared `TileVisual` carries no peek hook at all. A file row adds one wrapper element and two block anchors to a
classic row. Alternating sweeps on a loaded host, where every swept tile is a
folder with a caret: no panel +9% to +18% task time, panel open +9% to +16%.
The caret's chevron is a masked `::before` like List's. Removing the inline SVG
and the shadow did not measurably change the cost: it is the per-tile reactive
block, not paint.

## Width and columns

C comes from the classic `autoFillColumns(contentWidth - 16, ...)`, so turning
peek on never changes the column count. Panel widths use the inner width W
from VirtualList's probe (`onviewportsize`), committed with `flushSync` in the
ResizeObserver delivery (#1061). While bands exist the scroller is
`overflow-y: scroll`, so the width cannot oscillate with content height, and
`overflow-anchor: none`, so browser scroll anchoring cannot fight the
above-band compensation (`scrollToOffset` every frame).

## Outlines need a real box; axe needs them neutralised

A zero-size `<svg>` with `overflow: visible` paints in WebKit but not in
Chromium (and so WebView2): Chromium skips an empty SVG root, so no contour,
accent, fill, ribbon or parent highlight appeared. Each row group's outline
layer now spans the group, behind the row and panels, with pointer events off.
Only the ribbon's wide transparent stroke takes the pointer (hover emphasis).

axe reports any SVG under text as "contains an image node", whatever its
pointer events. The theme scan therefore replaces the decorative layer with
the fill it composites (on the panels, and a patch behind each open parent
tile), like its other composited layers. A pixel test compares screenshots
with the layer shown and hidden near panel edges in Chromium and WebKit; DOM
assertions could not have caught a layer that renders nothing.

## Thumbnail loads outlive their tile

Panels mount and unmount image tiles quickly. `ThumbnailImage`'s async loaders
compared their key against a component-owned `$derived` after each await,
which warned `derived_inert` once the tile had unmounted. A first fix returned
early once the tile was gone, and so dropped every response in flight at
unmount, in classic Tiles too: its blob URL was neither cached nor revoked,
and scrolling back requested the thumbnail again (8 of 81 paths). The loads now
live in `state/thumbnail-loads.ts`, one per cache key. A tile watches its key
while mounted and on screen. The load publishes what it completes to the cache
whatever its watchers do, and a remount joins a load in flight. Queued work
still starts only for an on-screen watcher (#136).

## Review fixes

- An above panel's anchor keeps the clicked row fixed only while the whole
  panel stays visible. Near the top of the scroll range the scroll stops with
  the panel's top at the viewport's top, applied on every motion frame
  (`anchoredScrollTop`), so the row moves down by the shortfall inside the same
  motion. Before, the row held, then a reveal scrolled the panel back into view.
- Side memory is session state beside panel heights. A plain variable that
  the model derived reassigned was a side effect in a derived (#444). It was
  lost on remount (Details and back), and any layout that did not place a
  folder (another directory) erased the folder's side. The composable merges
  each layout's sides from its pre-effect and reads the memory untracked.
- "Peek into Folder" on a panel's subfolder added a Tiles expansion that was
  never drawn. `canPeekAt` decides which depths a capability can peek, for both
  the command target and `togglePeek`.
- Once panels are open, grid row numbering is inconsistent: label, mini and grip
  rows, and side-by-side panels' interleaved rows. `aria-rowcount`/`rowindex`/
  `colcount` are kept only while no panel is open, and mini tiles have no
  `aria-colindex`.

## Shared with List cards (phase 3 review)

- The grip session lives in the composable (`beginGrip`/`gripKey`), with
  window listeners for its end. A component-local session on the grip
  element stranded the preview when its band scrolled out mid-drag: the
  element, and so its `pointerup`, were gone.
- Reveal follows `stepMotionArm`, not the motion arm. Revealing only while
  armed (1.5s) never revealed a panel whose listing settled later.
- A panel's scroll area needs `tabindex="-1"` (Chrome makes scrollers Tab
  stops). Inside a grid, that focusable element then needs a role: axe's
  `aria-required-children` failed until the scroll area itself became the
  rowgroup.
- Closing a panel never hides the live parent tile. Only the panel's content
  becomes a ghost, so focus stays on the parent, including after Escape steps
  out of a mini tile.

## Tests

- A long-running Vite server that has taken HMR updates serves `?t=` module
  URLs; a `page.evaluate` import of `/src/lib/state/window-tabs.svelte.ts` then
  gets a second module instance (`getActiveExplorer()` undefined). Restart the
  server before trusting such a failure.
- Unit tests of state that read `settingsStore` reactively must compile the
  settings module for the client (`compileSettings`); the SSR build's store
  never notifies, so a `folderPeek` change looked ignored.
- The contract changed: Tiles peeks top-level folders (always with carets), and
  nested peeks are dormant there and return in Details. Tests asserting "Tiles
  stays flat" (state tests, `folder-peek-details`) now assert the panel.
- `/drop-target/` also matches `peek-drop-target`; use a word-boundary regex.
- Preferred heights are rounded to whole pixels: compare grip drags with a
  0.5px tolerance and remembered heights exactly.
- Reduced motion opens in two steps (a Loading row, then the listing), so
  assert at most two distinct heights on open and exactly one on close.
- The theme scan's first mock folder (`Archive`) is empty; open `Documents`
  so the scan covers mini tiles.
