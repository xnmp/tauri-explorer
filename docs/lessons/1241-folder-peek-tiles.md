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

## Width and columns

C comes from the classic `autoFillColumns(contentWidth - 16, ...)`, so turning
peek on never changes the column count. Panel widths use the inner width W
from VirtualList's probe (`onviewportsize`), committed with `flushSync` in the
ResizeObserver delivery (#1061). While bands exist the scroller is
`overflow-y: scroll`, so the width cannot oscillate with content height, and
`overflow-anchor: none`, so browser scroll anchoring cannot fight the
above-band compensation (`scrollToOffset` every frame).

## Outlines must not cover text for axe

A full-size absolutely positioned SVG under the tiles made axe's colour
contrast check report tile and panel text as "contains an image node" in every
theme. The outline layer is now a zero-size `<svg>` with `overflow: visible`:
it paints the same, but nothing hit-tests or stacks under the text. Only the
ribbon's wide transparent stroke takes the pointer (hover emphasis).

## A destroyed tile's thumbnail load read a derived

Panels mount and unmount image tiles quickly. `ThumbnailImage`'s async loaders
compared their key against a component-owned `$derived` after each await,
which warned `derived_inert` once the tile had unmounted (stack attribution:
`loadProgressiveThumbnail`). It predates this phase; the stress test exposed it.
The loaders now check liveness (`onDestroy`) before reading the derived, as
in the #680 rename lesson.

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
