# #1920 — Thematic scrollbars

- Scrollbar colours are theme tokens (`--scrollbar-thumb`, `-active`, `-hover`,
  `--scrollbar-radius`, `--scrollbar-thumb-shadow(-hover)`, `--scrollbar-track`),
  read by the single global `::-webkit-scrollbar` rule in `+page.svelte`. Don't add
  per-component or per-layout thumb colours; Soft Cards had its own
  `:root ::-webkit-scrollbar-thumb` that outranked the global rule for every
  theme.
- `scrollbar-width` / `scrollbar-color` on a scroller make Chromium 121+
  (WebView2 on Windows) ignore every `::-webkit-scrollbar` rule for it, so it
  falls back to the native bar; recent WebKit (Safari 18.2+) may do the same.
  ListCard and TilePanel had `scrollbar-width: thin` and so stayed unthemed at
  least on Windows; the global 8px rule already makes them thin. Only `scrollbar-width: none` (hiding a bar) is safe.
- The thumb grows by shrinking its transparent `border-width` inside a fixed
  8px gutter. Changing the gutter width moves every pane's content box and the
  measurements built on it (#975, #680 graph header, marquee bases).
- The tokens are written as one `background` layer with `padding-box` appended
  in the rule, so a token can be a colour or a gradient. A plain
  `background:` shorthand with no clip would paint under the transparent
  border and erase the inset. Shadows must be inset: the scrollbar clips
  outset paint.
- Gradients run top-to-bottom, i.e. along a vertical thumb but across a
  horizontal one's thickness. Keep signatures direction-agnostic enough to
  read either way; a track rail drawn `to right` would be wrong on
  horizontal bars.
- Chromium does not restyle a scrollbar when its scroller gains or loses
  `:hover`: `:hover::-webkit-scrollbar-thumb` showed only after an unrelated
  restyle of the element (reproduced in Playwright Chromium with classic
  scrollbars). Changing a computed value on the scroller's own `:hover` fixes
  it; `+page.svelte` uses `shape-margin`, inert without `shape-outside`.
  Don't use a custom property for this hook: Chromium restyles the whole
  subtree for a custom-property change, registered `inherits: false` or not.
  A `:hover { --x: 1 }` hook restyled ~500-680 elements per pointer move
  between window, sidebar and pane, against ~17 for `shape-margin` and ~2.5
  with no hook (sum of `UpdateLayoutTree` `elementCount` in a CDP trace).
  `e2e/themed-scrollbars.spec.ts` fails without the hook.
- WebKit was not checked locally (Playwright WebKit needs system libraries
  this host lacks). If WebKit also misses the repaint, scrollbars fall back
  to idle and thumb-hover there.
- `:hover` matches every ancestor, so nested scrollers light up together.
