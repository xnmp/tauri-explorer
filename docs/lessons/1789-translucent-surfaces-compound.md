# Translucent surfaces compound; fade the opaque window instead (#1789)

Under a window material the active tab, title bar, sidebar, panes and Details
column header were four or five different colours, and the Translucency
Opacity slider seemed to do nothing in the site demo.

- **Stacked translucent layers compound.** The active tab painted
  `--background-card-secondary` over the title bar's card, so it hid more of
  the material than the pane (alpha 0.91 vs 0.82) and drifted toward its own
  colour. The navigation bar did the same over the pane, and the column
  header was opaque `--background-solid`. On an opaque window stacking cannot
  change a colour, which is why nobody saw it there.
- **A shared tint under translucent surfaces cannot keep their
  relationships.** Each surface hid the material by its own card alpha, so
  the light sidebar (0.55) let far more wallpaper through than the pane
  (0.72). The fix paints each surface's opaque stack (fill over the window
  base) on an `::after` layer at one opacity, `--material-surface-coverage`,
  and nothing under it: the window is its opaque self, faded uniformly. An
  exact per-layer alpha cannot be written in CSS, because it needs the card's
  alpha as a number (`color-mix` percentages cannot come from a colour).
- **Dark islands mixed the base toward white**, which turned every dark
  palette grey; an island now paints the theme's own card over its base.
- **The 100% end did not reach opaque** for light flat layouts (window tint
  max 0.4) or for the islands' body, so "most solid" still showed wallpaper.
- **Site demo:** custom host themes made `--background-card` the opaque panel
  colour, so their windows stayed solid at every slider value
  (`panelLayerOver` now derives a translucent layer that shows the panel over
  the paper), and the page's frost behind the iframe was raw saturated
  wallpaper rather than an approximation of the OS material.
- **"It shows my desktop wallpaper, not the page's"** was the page's own
  wallpaper: the host's `.frost` `backdrop-filter` is the only thing behind
  the transparent frame (the app paints no image of its own), so it is the
  page wallpaper at the window's position by construction. A 34px blur under
  a large window that hid the picture's subject (the Aurora sky) made it read
  as some other image, and the Aurora theme's starfield canvas added sharp
  specks on top. Prove alignment rather than eyeballing it: screenshot the
  frost alone and the bare wallpaper, blur the latter by the same radius, and
  correlate at offset zero against shifted offsets.
- Raising the slider's top half moved the island-alpha curve, so the
  Windows Backdrop Opacity migration (#1757) lands on a different slider
  value for the same alpha. Its tests assert the preserved alpha, not a
  hard-coded slider number.

Measure surfaces by screenshotting over a black and a white backdrop: alpha
`= 1 - (white - black) / 255`, colour `= black / alpha`
(`e2e/macos-vibrancy.spec.ts`).
