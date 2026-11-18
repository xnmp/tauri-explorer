# Fixed overlays inside islands (#1734)

- A `backdrop-filter` (or `transform`, `filter`, `will-change: transform`)
  on an island makes it the containing block for `position: fixed`
  descendants. The context menu, positioned in viewport coordinates, opened
  offset by the island's own position. The islands' backdrop filters are
  gone: the webview cannot sample the native material anyway.
- Context menus and modal cards are opaque: the flyout tint over
  `--background-solid`, no backdrop filter.
- `clip-path` and `will-change: opacity` are not containing blocks, but they
  do make the island a stacking context. The seamed island (the one under
  the active tab) then trapped its context menus under the preview island
  they overhang. The seamed island gets `z-index: 1`: islands never overlap,
  so this only lifts its overlays.
- `main` (z-index 1) is already below the title bar (z-index 2): no menu in
  main can cover the tab strip.

Test: `e2e/context-menu-island-position.spec.ts` (menu at the pointer, above
the preview by hit-testing, opaque; modal cards opaque). It fails with an
island backdrop filter restored (menu 161px off) and without the z-index
(menu under the preview).
