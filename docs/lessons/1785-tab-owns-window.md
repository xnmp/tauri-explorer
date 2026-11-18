# #1785 — The active tab owns the whole window

## What changed

Floating Islands' active tab used to fuse with the island under it (#1734):
the island opened its top edge under the tab (`data-tab-seam` plus a per-frame
`clip-path`), squared any corner the tab's foot reached into
(`data-tab-square`), and the tab was filled with that island's colour. Tabs
started over the content islands, so none sat over the sidebar.

Now the tab owns the window body. The tab is only a hole in the strip shade,
and the window body (`[data-region="app"]`'s tint or opaque gradient) shows
through it. That body is the tab's surface:
- It runs edge to edge under every island and the status bar.
- Its top corners are rounded (`--layout-radius`).
- The strip shade wraps round those corners as two pockets below the base
  (`surfacePocketsPath`).

The one outline is a single SVG path: up the left corner, along the
surface's top edge, over the tab, and down the right corner
(`surfaceEdgePath`). Islands keep their own outlines and sit `--layout-gap`
below the strip.

## Gotchas

- **The tab and the gaps are the same surface by construction.** Neither is
  painted separately, so they cannot drift apart in colour. Don't
  reintroduce a tab fill: any fill becomes a second surface that has to
  match the body exactly in every theme, with and without material.
- **The first tab's whole curve must clear the surface's corner.**
  - The strip start is `radius + SURFACE_TAB_GAP + TAB_FILLET`
    (`tabStripPadding`).
  - A narrow window can give that band back to its tabs. When it does,
    `surfaceCorners` narrows the corner to end where the shown foot begins,
    so the foot never lands on an arc.
  - On macOS the traffic-light inset already exceeds the alignment, so the
    12px floor applies.
- **Clip the outline differently above and below the base.**
  - Above the base it is clipped to the tab viewport: a tab half under a
    scroll button is cut there.
  - Below the base it must span the whole width, or the surface's top edge
    would stop at the viewport.
  - It is one path with two subpaths, because WebKit bounds a multi-shape
    clip by its target's geometry.
- **The corner pockets sit half a pixel inside the arc**, so the shade runs
  under the stroke's anti-aliased edge. This is the same trick as the tab
  hole's −0.5 offset.
- **The strip start no longer depends on islands.** `tab-strip-start.ts`
  observes only the title bar and the strip's room box. The old island
  ResizeObserver/MutationObserver chain, and its WebKit ResizeObserver-loop
  hazard, are gone.
