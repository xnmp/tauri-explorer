# #1920 — Thematic scrollbars

- Scrollbar colours are theme tokens (`--scrollbar-thumb`, `-active`, `-hover`,
  `--scrollbar-radius`, `--scrollbar-thumb-shadow(-hover)`, `--scrollbar-track`),
  read by the single global `::-webkit-scrollbar` rule in `+page.svelte`. Don't add
  per-component or per-layout thumb colours; Soft Cards had its own
  `:root ::-webkit-scrollbar-thumb` that outranked the global rule for every
  theme.
- `scrollbar-width` / `scrollbar-color` on a scroller make Chromium 121+
  (WebView2 on Windows) ignore every `::-webkit-scrollbar` rule for it, so it
  falls back to the native bar. ListCard and TilePanel had `scrollbar-width: thin`
  and therefore stayed unthemed on Windows only; the global 8px rule already
  makes them thin. Only `scrollbar-width: none` (hiding a bar) is safe.
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
  scrollbars). A rule keyed on the element's own `:hover` fixes it; the one in
  `+page.svelte` sets a registered, non-inheriting custom property so a hover
  change restyles only that element. `e2e/themed-scrollbars.spec.ts` fails
  without it. WebKit was not checked locally (Playwright WebKit needs system
  libraries this host lacks); if WebKit also misses the repaint, the bar falls
  back to idle and thumb-hover states only.
