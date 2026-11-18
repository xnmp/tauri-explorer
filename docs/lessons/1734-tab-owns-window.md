# Floating Islands: the active tab owns the window (#1734)

## Design

The active tab is not a card on the strip. It wears the surface of the
island it stands on (`islandUnder` in `domain/tab-seam.ts`, by largest
overlap with the tab's hole), and that island opens its top edge under the
tab. Everything else in the strip is shaded. Inactive tabs paint nothing.

- Content islands (panes, preview, Miller) and the structural island (the
  sidebar) have different surfaces. The tab wears its home kind, opens only
  into islands of that kind, and its edge highlight runs only along them. A
  tab that straddles two kinds leaves a small pocket over the other one;
  that is accepted.
- The fill is inline SVG painted by the title bar (z-index 2, above `main`),
  reaching 2px down into each seamed island. The island cuts a matching
  2px notch with `clip-path` so its own top edge and shadow do not show
  through a translucent fill.
- Island surfaces are flat: a sheen gradient on the island would not match
  a flat tab fill across the seam.
- Light comes from the top left: island and tab shadows fall down-right.

## Gotchas

- The tab bar's fillet backgrounds are Svelte-scoped and outrank a layout
  rule of equal intent. `background: none` from the layout lost, and the
  fillet's 1px ring column (which overlaps the tab by design) painted a
  white sliver up each lower side of the tab in light themes. The layout
  uses `visibility: hidden` instead: the marks still read the fillet's
  width as the resolved `--fillet`.
- Measuring the fillet element is how the marks learn the fillet during a
  slide: `--fillet` is `calc(14px * var(--tab-slide))`, which
  `getComputedStyle` returns unresolved.
- `data-tab-island="none"` (no island under the tab, e.g. a hidden sidebar
  and a tab over the gap) hides the fill: the tab is then a plain hole in
  the shade.

## Tests

`e2e/floating-islands.spec.ts` "Fused active tab": pixel contracts (no
sliver, one surface across the seam, shaded strip) in light/dark, opaque and
simulated macOS material.
