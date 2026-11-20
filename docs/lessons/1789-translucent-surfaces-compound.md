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
  (0.72). Each surface now paints one colour, its opaque stack (fill over the
  window base) composited at `--material-surface-coverage`, and nothing
  under it: the window is its opaque self, faded uniformly.
- **Compositing a translucent colour over an opaque one needs its alpha as a
  number**, which `color-mix` percentages cannot take. Relative colour syntax
  can read it: `color-mix(P' 99.9%, B)` with P' = P's colour at alpha
  `a / (999 (1 - a))` weighs P by `a` and B by `1 - a` exactly (premultiplied
  interpolation); force the result opaque. Guard it with `@supports`.
- **Paint-time workarounds leak.** A first version faded `::after` tiles: an
  element's `overflow: hidden` clipped its tile to the padding box, so its
  1px border became a slit of bare material (0.06 coverage, even at 100%),
  and an inactive split pane's `opacity: 0.7` faded the tile with it. Scan
  whole rows and columns of pixels, not a few probe points.
- **Two layers at the island's alpha compound** (a base layer under a
  translucent card: 1 - (1 - a)(1 - a x card alpha)), so dark islands hid
  0.64 instead of 0.545 and light ones went near opaque. One layer each.
- **Dark islands mixed the base toward white**, which turned every dark
  palette grey; a dark island is now the theme's card over its base, one
  composited colour. Light themes' translucent island cards are their design
  and stay as they were.
- **A shipped slider keeps its meaning.** Saved values (and the #1757
  migration's 81 for a 65% Windows backdrop) render through the curve; it
  stays v0.29's below 100%, and only 100% changed (now solid).
- **The 100% end did not reach opaque** for light flat layouts (window tint
  max 0.4) or for the islands' body, so "most solid" still showed wallpaper.
- **Site demo:** the page's frost behind the iframe was raw saturated
  wallpaper rather than an approximation of the OS material. (Host themes'
  opaque cards need no translucent stand-in once surfaces fade their opaque
  colour; a translucent `--background-card` made popups see-through. Popups
  paint the card over the theme base.)
- **"It shows my desktop wallpaper, not the page's"** was the page's own
  wallpaper: the host's `.frost` `backdrop-filter` is the only thing behind
  the transparent frame (the app paints no image of its own), so it is the
  page wallpaper at the window's position by construction. A 34px blur under
  a large window that hid the picture's subject (the Aurora sky) made it read
  as some other image, and the Aurora theme's starfield canvas added sharp
  specks on top. Prove alignment rather than eyeballing it: screenshot the
  frost alone and the bare wallpaper, blur the latter by the same radius, and
  correlate at offset zero against shifted offsets.

Measure surfaces by screenshotting over a black and a white backdrop: alpha
`= 1 - (white - black) / 255`, colour `= black / alpha`
(`e2e/material-pixels.ts`, used by `e2e/macos-vibrancy.spec.ts` and
`e2e/translucency-opacity.spec.ts`). A computed custom property is not
evidence: it restates the formula, not what was painted. Three traps, all
seen on the WebKit project: screenshot at `scale: "css"` (WebKit runs at 2x,
so CSS-px coordinates read the wrong pixels); require the page to be the same
in both shots (black, white, black again until the blacks agree; a pane still
loading reads as a hole, even at 100%); and hide text and icons before
scanning for slits, since glyph antialiasing does not blend linearly.
