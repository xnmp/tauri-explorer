# Plugin-owned tile grids

Detect `sdk.capabilities.includes("fileTile")`, then load
`sdk.modules["ui/file-tile"]`. Its default export is a Svelte component;
its named `tileGridMetrics(size?)` export is a pure preset lookup. The complete
types are `FileTileProps`, `FileTileModule` and `TileGridMetrics` in
`src/lib/plugins/api.ts` (metrics types are re-exported from the domain layer).
Older hosts can use the plugin's fallback tile. No version check is needed.

`FileTile` renders one `role="gridcell"` root. The plugin must provide
`role="grid"` and `role="row"` ancestors, label its grid, and own keyboard
navigation, layout, virtualization and selection. `focused` chooses the
roving tab stop; it does not call `.focus()`. Optional `column` supplies the
one-based ARIA column index. `onfocus` and `onkeydown` forward DOM events.

Pass `entry`, boolean `selected`, and `onselect(entry, MouseEvent)`,
`onopen(entry)` (double-click), `onmenu(entry, MouseEvent)`. The context-menu
event is already default-prevented. Selection remains path-based and controlled
by the plugin; forward modifiers to `pane.select` (including Meta as Ctrl).
Keyboard activation belongs to the plugin. Neither `file-tile` nor the existing
`file-tiles` exposes host drag/drop callbacks or initiates native drags.

Pass `size: pane.tileSize?.preset` to follow the folder's setting. Without a
valid explicit preset, both tile components read the enclosing plugin view's
folder size, then the global setting. `pane.tileSize` retains its existing
`{ preset, imagePx }` shape. Standalone metrics lookup without a valid preset
uses medium; pass the same resolved preset to the component and lookup.

The chrome and icon/thumbnail/name content come from `TileSurface` and
`TileVisual`, also used by the built-in Tiles view. Clipboard cut/copied state,
dotfiles, manually hidden entries and empty-folder appearance are reactive
host state. Inside a pane, an already active host rename session renders the
same `EntryName` editor; the tile does not initiate rename or change the host's
plugin-view command eligibility. Outside a pane, it displays the name only.
Optional `videoUnavailable` / `onvideounavailable(entry)` let a plugin retain
failed-video icon fallback across virtualized cell remounts.

## Grid metrics

All numbers are CSS pixels before host zoom:

| Preset | Minimum cell width | Allocated cell height | Gap | Padding per edge |
| --- | ---: | ---: | ---: | ---: |
| small | 84 | 103 | 2 | 8 |
| medium | 108 | 129 | 6 | 8 |
| large | 140 | 161 | 6 | 8 |
| xlarge | 172 | 193 | 6 | 8 |

`cellWidth` is a minimum: the host divides remaining row width equally between
columns, as `repeat(auto-fill, minmax(cellWidth + 'px', 1fr))` does. With
available width excluding padding, column count is
`max(1, floor((width + gap) / (cellWidth + gap)))`.

`cellHeight` is the built-in virtualizer's allocation excluding the gap, and
row origins advance by `cellHeight + gap`. It is not a measurement of the
intrinsic cell border box. The existing host row-height formula budgets two
border pixels while the current CSS theme uses a one-pixel top border plus a
three-pixel bottom selection edge; intrinsic cells are therefore two pixels
taller. This seam preserves that existing allocation and rendering. A plugin
matching the host's virtualized row positions should use the allocated stride,
rather than inferring it from an intrinsic cell's height.

The built-in Tiles view retains row virtualization, drag/drop, selection,
rename, lazy thumbnail observers, and its existing row/column calculations.
`file-tiles` remains a non-virtualized convenience grid and delegates each
cell to `FileTile`.
