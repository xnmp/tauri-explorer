# #1294 Tiles Folder Peek: seamless selected tab, grid-sized panel tiles

- An open folder's tile is its panel's tab. `TilePanelsView` marks it
  `tab-below` (below or stacked: a stacked ribbon leaves from the tile's
  bottom) or `tab-above`. On that side its selection and focus chrome stay
  open, as the outline does: square corners, no selected underline, and the
  focus ring drawn as the 1px border plus a 1px inset shadow on the other three
  sides (an `outline` cannot omit a side). These rules must outrank
  TileSurface's selected edge and FileList's `.tile-item:focus-visible` ring.
- A gradient background on a tile repeats into its transparent 3px bottom
  border unless it is anchored to the border box (`... border-box`), which
  draws a thin tinted line across the very mouth the fade was meant to open.
- Panel tiles are the grid's own tiles: `panelTileLayout(metrics)` gives a track
  of one grid cell plus the tile gap and the grid's row height, and the panel
  renders with the grid's `TileLayout` (so folder previews follow the grid at
  large/xlarge). A segment narrower than one track plus padding (a one-column
  grid) narrows that panel's track (`TilePanelSpec.track`); geometry readers
  (navigation, ghosts, the grid template) use the spec's track, not a global one.
- Bigger panels move fixture geometry: e2e probes that sample fixed offsets
  near panels (the spring ribbon corridor, the outline fill below a panel's last
  row) must bound or scroll their samples by the measured panel rather than
  assume the old sizes.
