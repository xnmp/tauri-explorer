/**
 * Tile geometry shared by every tile grid: the virtualized Tiles view and the
 * plugin SDK's file-tiles component. One source for sizes, spacing and the
 * fixed row height keeps the two from drifting apart. Pure, no framework deps.
 */

export type ThumbnailSize = "small" | "medium" | "large" | "xlarge";

export interface ThumbnailSizeConfig {
  displaySize: number;
  genSize: number;
  quality: number;
  gridMinWidth: number;
}

export const THUMBNAIL_SIZE_CONFIG: Record<ThumbnailSize, ThumbnailSizeConfig> = {
  small:  { displaySize: 48,  genSize: 96,  quality: 75, gridMinWidth: 84  },
  medium: { displaySize: 64,  genSize: 128, quality: 80, gridMinWidth: 108 },
  large:  { displaySize: 96,  genSize: 192, quality: 85, gridMinWidth: 140 },
  xlarge: { displaySize: 128, genSize: 256, quality: 90, gridMinWidth: 172 },
};

/** Whether a value is one of the tile-size presets (an own key, so
 *  `"constructor"` and the like are not). */
export function isThumbnailSize(value: unknown): value is ThumbnailSize {
  return typeof value === "string" && Object.hasOwn(THUMBNAIL_SIZE_CONFIG, value);
}

/** The plugin SDK's name for a tile-size preset. */
export type TileSizePreset = ThumbnailSize;

/** Tile-grid allocation in CSS px, available from `ui/file-tile`.
 * Columns stretch: use `repeat(auto-fill, minmax(cellWidth + 'px', 1fr))`.
 * The built-in virtualizer advances rows by `cellHeight + gap`.
 */
export interface TileGridMetrics {
  /** Minimum cell width; actual columns share the available width equally. */
  readonly cellWidth: number;
  /** Allocated cell height, excluding the inter-row gap. */
  readonly cellHeight: number;
  /** Inter-cell gap on both axes. */
  readonly gap: number;
  /** Padding on each edge of the built-in grid. */
  readonly gridPadding: number;
}

/** Pure metrics lookup; omitted/unknown presets use medium. */
export function tileGridMetrics(size: TileSizePreset = "medium"): TileGridMetrics {
  const layout = tileLayout(size);
  return Object.freeze({
    cellWidth: layout.gridMinWidth,
    cellHeight: layout.rowHeight - layout.gap,
    gap: layout.gap,
    gridPadding: TILE_GRID_PAD_X / 2,
  });
}

/**
 * A pane's tile size as the plugin SDK exposes it (`FileViewPane.tileSize`):
 * the preset and its thumbnail image edge in CSS px.
 */
export interface PaneTileSize {
  readonly preset: TileSizePreset;
  /** Thumbnail image edge in CSS px for that preset (48 / 64 / 96 / 128). */
  readonly imagePx: number;
}

// One frozen value per preset: repeated reads of an unchanged size return the
// same object, so a plugin derivation over it does not re-run.
const PANE_TILE_SIZES = Object.freeze(Object.fromEntries(
  (Object.keys(THUMBNAIL_SIZE_CONFIG) as ThumbnailSize[]).map((preset) =>
    [preset, Object.freeze({ preset, imagePx: THUMBNAIL_SIZE_CONFIG[preset].displaySize })]),
) as Record<ThumbnailSize, PaneTileSize>);

/** The SDK tile size for a preset; an unknown preset falls back to medium,
 *  like `tileLayout`. */
export function paneTileSize(size: ThumbnailSize): PaneTileSize {
  return PANE_TILE_SIZES[isThumbnailSize(size) ? size : "medium"];
}

/** Reserved fixed name height: two lines at line-height 1.4 * 13px font. */
export const TILE_NAME_HEIGHT = 37;

/** Horizontal padding (8px each side) a tile grid reserves around its tiles. */
export const TILE_GRID_PAD_X = 16;

export interface TileLayout extends ThumbnailSizeConfig {
  size: ThumbnailSize;
  /** Gap between tiles, both axes. */
  gap: number;
  /** CSS padding of one tile. */
  padding: string;
  /** Its top padding: the icon block's offset inside the tile. */
  paddingTop: number;
  /** padding-top + padding-bottom of one tile. */
  paddingY: number;
  /** Reserved two-line name height. */
  nameHeight: number;
  /** Fixed row height: paddings + icon + icon→name gap (4) + reserved name
   *  + selection border (2) + the inter-row gap. */
  rowHeight: number;
  /** Scale applied to 64px icon SVGs so they fill the tile. */
  iconScale: number;
  /** Folder previews only render at large/xlarge sizes (smaller tiles keep
   *  the plain folder icon, like Windows Explorer). */
  showFolderThumbnails: boolean;
}

/** Layout for a tile size; an unknown size (e.g. a stale stored value) falls
 *  back to medium rather than breaking the grid. */
export function tileLayout(size: ThumbnailSize): TileLayout {
  const resolved: ThumbnailSize = isThumbnailSize(size) ? size : "medium";
  const config = THUMBNAIL_SIZE_CONFIG[resolved];
  const small = resolved === "small";
  const gap = small ? 2 : 6;
  const paddingY = small ? 12 : 22;
  const paddingTop = small ? 6 : 12;
  return {
    ...config,
    size: resolved,
    gap,
    padding: small ? `${paddingTop}px 4px 6px` : `${paddingTop}px 8px 10px`,
    paddingTop,
    paddingY,
    nameHeight: TILE_NAME_HEIGHT,
    rowHeight: paddingY + config.displaySize + 4 + TILE_NAME_HEIGHT + 2 + gap,
    iconScale: config.displaySize / 64,
    showFolderThumbnails: resolved === "large" || resolved === "xlarge",
  };
}

export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

/**
 * Where keyboard focus moves in a row-major grid of `total` items laid out
 * `columns` wide. Returns null for keys the grid does not handle or an empty
 * grid; otherwise an index clamped to the grid (edges stay put).
 */
export function gridFocusStep(index: number, total: number, columns: number, key: string): number | null {
  if (total <= 0) return null;
  const cols = Math.max(1, Math.floor(columns) || 1);
  const from = Math.min(Math.max(0, Math.floor(index) || 0), total - 1);
  const clamp = (next: number) => Math.min(Math.max(0, next), total - 1);
  switch (key) {
    case "ArrowLeft": return clamp(from - 1);
    case "ArrowRight": return clamp(from + 1);
    case "ArrowUp": return from - cols >= 0 ? from - cols : from;
    case "ArrowDown": return from + cols < total ? from + cols : from;
    case "Home": return 0;
    case "End": return total - 1;
    default: return null;
  }
}
