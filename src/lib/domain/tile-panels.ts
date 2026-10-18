/**
 * Tiles panels (#1241, spec §9): an open top-level folder in Tiles shows its
 * contents in a compact panel, in a band above or below its grid row, or
 * stacked under the row as a last resort. Pure placement, sizing and row-group
 * layout, shared by rendering, keyboard navigation and motion.
 *
 * Every length is CSS px. x is measured from the tile row's left edge and y
 * from the top of the row's group (the row plus its bands), which is one
 * variable-height VirtualList item.
 */
import type { PeekRows } from "./folder-peek";
import { THUMBNAIL_SIZE_CONFIG, type TileLayout } from "./tile-layout";

/** A band member's column segment is at least this many columns wide. */
export const MIN_PANEL_COLUMNS = 3;
export type BandSide = "above" | "below" | "stacked";

/** Panel and tab corner radii, and the concave fillet where they meet. */
export const R_PANEL = 10;
export const R_TAB = 8;
export const R_FILLET = 6;
/** A tab this close to a panel side snaps flush with it. */
export const TAB_SNAP = R_PANEL + R_FILLET;
/** Inset of a segment edge at a boundary between two panels (24px between them). */
export const PANEL_INSET = 12;
/** Whitespace between a band and its row, and after a band. */
export const BAND_GAP = 12;
/** A stacked panel's label tab, and the whitespace above it. */
export const STACKED_LABEL_HEIGHT = 30;
export const STACKED_MARGIN = STACKED_LABEL_HEIGHT + 16;
/** Room for a ribbon's horizontal run: two 18px bends plus clearance. */
export const DETOUR_BELOW_MARGIN = 76;
export const DETOUR_STACKED_MARGIN = 106;
/** A stacked label is at least this wide (or its panel's width). */
export const STACKED_LABEL_MIN_WIDTH = 240;
/** Panel padding: 8px each side plus an 8px scrollbar; 8px on the parent side, 12px on the grip side. */
export const PANEL_PAD_X = 24;
export const PANEL_PAD_NEAR = 8;
export const PANEL_PAD_FAR = 12;
export const PANEL_PAD_Y = PANEL_PAD_NEAR + PANEL_PAD_FAR;
/** Default preferred height, in tile rows (plus padding). */
export const PANEL_DEFAULT_ROWS = 3.5;

// ---------------------------------------------------------------------------
// Placement (§9.1)

export interface ColumnSegment { readonly start: number; readonly end: number }

const wholeColumns = (value: number): number => (Number.isFinite(value) ? Math.floor(value) : 0);

/**
 * Partition columns 0..C-1 into one contiguous segment per parent column, in
 * column order, each containing its parent and at least `minWidth` wide.
 * Each boundary is the midpoint split between its two parents when that still
 * leaves a feasible remainder, else the nearest boundary that does. Returns the
 * segments in ascending parent order, or null when no such split exists (or a
 * parent column is out of range, fractional or repeated).
 */
export function splitColumns(parents: readonly number[], columns: number, minWidth = MIN_PANEL_COLUMNS): ColumnSegment[] | null {
  if (!parents.length) return [];
  const C = wholeColumns(columns);
  const min = Math.max(1, wholeColumns(minWidth) || 1);
  const p = [...parents].sort((a, b) => a - b);
  if (C < 1 || p.some((col, i) => !Number.isInteger(col) || col < 0 || col >= C || (i > 0 && col === p[i - 1]))) return null;
  const k = p.length;
  // latest[i]: the largest start of segment i from which segments i..k-1 still
  // fit. Every smaller start fits too, so the forward pass never backtracks.
  const latest = new Array<number>(k);
  latest[k - 1] = Math.min(p[k - 1], C - min);
  for (let i = k - 2; i >= 0; i--) latest[i] = latest[i + 1] >= p[i] + 1 ? Math.min(p[i], latest[i + 1] - min) : -1;
  if (latest[0] < 0) return null;
  const starts = [0];
  for (let i = 0; i < k - 1; i++) {
    const lo = Math.max(p[i] + 1, starts[i] + min);
    const mid = Math.floor((p[i] + p[i + 1]) / 2) + 1;
    starts.push(Math.min(latest[i + 1], Math.max(lo, mid)));
  }
  return starts.map((start, i) => ({ start, end: i + 1 < k ? starts[i + 1] - 1 : C - 1 }));
}

export interface PanelPlacement {
  readonly path: string;
  readonly row: number;
  readonly col: number;
  readonly side: BandSide;
}

function sideFeasible(placed: readonly PanelPlacement[], row: number, side: BandSide, col: number, C: number): boolean {
  if (side === "stacked") return true;
  const cols = placed.filter(p => p.row === row && p.side === side).map(p => p.col);
  return splitColumns([...cols, col], C) !== null;
}

/** Where a newly opened folder at (row, col) goes: below, else above, else stacked. */
export function chooseSide(placed: readonly PanelPlacement[], row: number, col: number, columns: number): BandSide {
  const C = wholeColumns(columns);
  for (const side of ["below", "above"] as const) if (sideFeasible(placed, row, side, col, C)) return side;
  return "stacked";
}

/** An open top-level folder and its position among the grid's items. */
export interface PanelRequest { readonly path: string; readonly index: number }

/**
 * Places every open folder, in opening order. A folder keeps its remembered
 * side while that band stays feasible with the folders kept before it (stacked
 * always stays stacked); a new folder, or one whose band no longer fits after a
 * column-count change, takes `chooseSide`. Removing a band member never makes
 * the band infeasible, so opening never moves an existing panel and closing
 * only re-splits the remaining members.
 */
export function placePanels(open: readonly PanelRequest[], columns: number, remembered: ReadonlyMap<string, BandSide> = new Map()): PanelPlacement[] {
  const C = wholeColumns(columns);
  if (C < 1) return [];
  const placed: PanelPlacement[] = [];
  const seen = new Set<string>();
  for (const { path, index } of open) {
    if (seen.has(path) || !Number.isSafeInteger(index) || index < 0) continue;
    seen.add(path);
    const row = Math.floor(index / C), col = index % C;
    const kept = remembered.get(path);
    const side = kept && sideFeasible(placed, row, kept, col, C) ? kept : chooseSide(placed, row, col, C);
    placed.push({ path, row, col, side });
  }
  return placed;
}

/** Each placement's side, for the next `placePanels` call. */
export const placementSides = (placements: readonly PanelPlacement[]): Map<string, BandSide> =>
  new Map(placements.map(p => [p.path, p.side]));

export interface Band {
  readonly key: string;
  readonly row: number;
  readonly side: BandSide;
  /** Above/below: by column. Stacked: the band's one panel. */
  readonly members: readonly PanelPlacement[];
  readonly segments: readonly ColumnSegment[];
}

/**
 * Bands per row in vertical order: [above] [row] [below] [stacked, in opening
 * order]. Expects `placePanels` output; a member set that cannot be split (any
 * other input) falls back to one stacked band per member.
 */
export function computeBands(placements: readonly PanelPlacement[], columns: number): Band[] {
  const C = Math.max(1, wholeColumns(columns));
  const bands: Band[] = [];
  const stacked = (p: PanelPlacement): Band => ({ key: `${p.row}-stacked-${p.path}`, row: p.row, side: "stacked", members: [p], segments: [{ start: 0, end: C - 1 }] });
  const rows = [...new Set(placements.map(p => p.row))].sort((a, b) => a - b);
  for (const row of rows) {
    const extra: PanelPlacement[] = [];
    for (const side of ["above", "below"] as const) {
      const members = placements.filter(p => p.row === row && p.side === side).sort((a, b) => a.col - b.col);
      if (!members.length) continue;
      const segments = splitColumns(members.map(m => m.col), C);
      if (segments) bands.push({ key: `${row}-${side}`, row, side, members, segments });
      else extra.push(...members);
    }
    for (const p of placements) if (p.row === row && p.side === "stacked") bands.push(stacked(p));
    for (const p of extra) bands.push(stacked(p));
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Sizing (§9.2)

/** Panel tiles are the grid's own tiles: a track holds a tile as wide as a grid
 * cell plus the tile gap (half on each side), and rows advance as the grid's do. */
export interface PanelTileLayout {
  /** One panel grid track: a grid cell's width plus the tile gap. */
  readonly track: number;
  /** One row: the tile plus the tile gap. */
  readonly rowHeight: number;
}

export function panelTileLayout(m: RowMetrics): PanelTileLayout {
  const { x0, x1 } = cellX(0, m);
  return { track: x1 - x0 + m.gap, rowHeight: m.tileHeight + m.gap };
}

/** Grid columns for n items within `maxWidth`: rows = max(1, round(sqrt(n/2.5))),
 * cols = min(fits, max(2, ceil(n/rows))). 6 -> 3x2, 9 -> 5x2, 11 -> 6x2, 14 -> 7x2. */
export function panelGridColumns(count: number, maxWidth: number, track: number): number {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const room = Number.isFinite(maxWidth) ? maxWidth : 0;
  const step = Number.isFinite(track) && track > 0 ? track : THUMBNAIL_SIZE_CONFIG.medium.gridMinWidth;
  const rows = Math.max(1, Math.round(Math.sqrt(n / 2.5)));
  const fits = Math.max(1, Math.floor((room - PANEL_PAD_X) / step));
  return Math.min(fits, Math.max(2, Math.ceil(n / rows)));
}

/** Content rows: at least one (a Loading/Empty/Error label, or a listing yet to arrive). */
export const panelContentRows = (count: number, cols: number): number =>
  Math.max(1, Math.ceil((Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0) / Math.max(1, Math.floor(cols) || 1)));

export interface PanelHeightBounds { readonly min: number; readonly max: number }
/** One tile row up to 70% of the scrollport (never below one row). */
export function panelHeightBounds(tile: PanelTileLayout, viewportHeight: number): PanelHeightBounds {
  const min = tile.rowHeight + PANEL_PAD_Y;
  const viewport = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return { min, max: Math.max(min, Math.round(0.7 * viewport)) };
}

/** Default preferred height: min(panel width, 3.5 tile rows + padding). */
export const defaultPanelHeight = (width: number, tile: PanelTileLayout): number =>
  Math.min(Number.isFinite(width) ? width : Infinity, PANEL_DEFAULT_ROWS * tile.rowHeight + PANEL_PAD_Y);

/** Band height = max over members of min(preferred, content), clamped to the bounds.
 * Capping each member first keeps a short member's preference from enlarging a
 * taller sibling whose own preference is smaller. */
export function bandHeight(members: readonly { preferred: number; content: number }[], bounds: PanelHeightBounds): number {
  const wanted = members.map(m => Math.min(Number.isFinite(m.preferred) ? m.preferred : bounds.min, m.content));
  return Math.min(bounds.max, Math.max(bounds.min, ...wanted));
}

/** The preferred height a grip drag or key sets: clamped to the bounds and the
 * band's largest content, so a remembered height is always one it can show. */
export function clampPreferredHeight(height: number, maxContent: number, bounds: PanelHeightBounds): number {
  const top = Math.max(bounds.min, Math.min(bounds.max, maxContent));
  return Math.round(Math.min(top, Math.max(bounds.min, Number.isNaN(height) ? bounds.min : height)));
}

/** Grip keys (separator pattern): arrows move the edge one tile row (the edge
 * moves away from the parent to grow), Home/End set the minimum/maximum. */
export function gripKeyHeight(key: string, side: BandSide, height: number, maxContent: number, tile: PanelTileLayout, bounds: PanelHeightBounds): number | null {
  const grow = side === "above" ? "ArrowUp" : "ArrowDown";
  const shrink = side === "above" ? "ArrowDown" : "ArrowUp";
  if (key === grow) return clampPreferredHeight(height + tile.rowHeight, maxContent, bounds);
  if (key === shrink) return clampPreferredHeight(height - tile.rowHeight, maxContent, bounds);
  if (key === "Home") return clampPreferredHeight(bounds.min, maxContent, bounds);
  if (key === "End") return clampPreferredHeight(Infinity, maxContent, bounds);
  return null;
}

/** Grid padding at a panel's parent-facing (near) edge and far edge. */
export const panelPadTop = (side: BandSide): number => side === "above" ? PANEL_PAD_FAR : PANEL_PAD_NEAR;

function panelScrollRange(contentHeight: number, height: number, scrollTop: number) {
  const max = Math.max(0, (Number.isFinite(contentHeight) ? contentHeight : 0) - Math.max(0, Number.isFinite(height) ? height : 0));
  return { max, top: Math.max(0, Math.min(max, Number.isFinite(scrollTop) ? scrollTop : 0)) };
}

/** Which edges have content scrolled out of view (and so show the fade mask). */
export function panelFades(contentHeight: number, height: number, scrollTop: number): Readonly<{ top: boolean; bottom: boolean }> {
  const { max, top } = panelScrollRange(contentHeight, height, scrollTop);
  return { top: top > 1, bottom: max - top > 1 };
}

/** "+N more": items in content rows whose centre lies below the visible area. */
export function panelMoreCount(spec: Pick<TilePanelSpec, "side" | "entries" | "cols" | "contentHeight">, height: number, rowHeight: number, scrollTop: number): number {
  const { max, top } = panelScrollRange(spec.contentHeight, height, scrollTop);
  if (max - top <= 1 || !(rowHeight > 0)) return 0;
  const bottom = top + Math.max(0, height) - panelPadTop(spec.side);
  const firstBelow = Math.max(0, Math.floor(bottom / rowHeight - 0.5) + 1);
  return Math.max(0, spec.entries.length - firstBelow * Math.max(1, spec.cols));
}

// ---------------------------------------------------------------------------
// Row geometry

export interface RowMetrics {
  readonly columns: number;
  /** The tile row's width: the grid's content box. */
  readonly width: number;
  readonly gap: number;
  /** Tile box height (the row height less the inter-row gap). */
  readonly tileHeight: number;
}

/** A grid cell's x extent: `repeat(C, minmax(0, 1fr))` with the tile gap. */
export function cellX(col: number, m: RowMetrics): { x0: number; x1: number } {
  const C = Math.max(1, m.columns);
  const w = Math.max(0, (m.width - (C - 1) * m.gap) / C);
  const x0 = col * (w + m.gap);
  return { x0, x1: x0 + w };
}

/** Tabs are inset so neighbouring tabs keep at least 4px of whitespace. */
export const tabInset = (gap: number): number => Math.max(0, (4 - gap) / 2);

/** A parent tile's tab: its cell, inset. */
export function tabX(col: number, m: RowMetrics): { x0: number; x1: number } {
  const { x0, x1 } = cellX(col, m);
  const inset = tabInset(m.gap);
  return { x0: x0 + inset, x1: x1 - inset };
}

/** A member's usable x range: outer edges and edges beside its own parent align
 * with tabs; boundaries between panels are inset 12px from the gap midpoint. */
export function segmentX(segment: ColumnSegment, col: number, m: RowMetrics): { x0: number; x1: number } {
  const C = Math.max(1, m.columns);
  const inset = tabInset(m.gap);
  const first = cellX(segment.start, m), last = cellX(segment.end, m);
  const x0 = segment.start === 0 || col === segment.start ? first.x0 + inset : first.x0 - m.gap / 2 + PANEL_INSET;
  const x1 = segment.end === C - 1 || col === segment.end ? last.x1 - inset : last.x1 + m.gap / 2 - PANEL_INSET;
  return { x0, x1: Math.max(x0, x1) };
}

/** Panel x: sized for its grid (at least its tab's width), centred under its tab,
 * clamped to the segment, and flush with a tab side it comes within 16px of.
 * A segment too narrow for one whole track (a one-column grid) narrows the track. */
export function panelX(count: number, segment: { x0: number; x1: number }, tab: { x0: number; x1: number }, tile: PanelTileLayout): { x0: number; width: number; cols: number; track: number } {
  const maxWidth = Math.max(0, segment.x1 - segment.x0);
  const track = Math.max(1, Math.min(tile.track, maxWidth - PANEL_PAD_X));
  const cols = panelGridColumns(count, maxWidth, track);
  const width = Math.min(maxWidth, Math.max(cols * track + PANEL_PAD_X, tab.x1 - tab.x0));
  const clamp = (x: number) => Math.min(segment.x1 - width, Math.max(segment.x0, x));
  let x0 = clamp((tab.x0 + tab.x1 - width) / 2);
  if (tab.x0 - x0 < TAB_SNAP) x0 = tab.x0;
  else if (x0 + width - tab.x1 < TAB_SNAP) x0 = tab.x1 - width;
  return { x0: clamp(x0), width, cols, track };
}

/** A stacked label: at least its parent tab's width (or 240px), within the panel,
 * aligned to the parent's column and flush with a panel side within 16px. */
export function stackedLabelX(panel: { x0: number; width: number }, tab: { x0: number; x1: number }): { x0: number; width: number } {
  const width = Math.min(panel.width, Math.max(tab.x1 - tab.x0, STACKED_LABEL_MIN_WIDTH));
  let left = Math.min(panel.width - width, Math.max(0, tab.x0 - panel.x0));
  if (left < TAB_SNAP) left = 0;
  else if (panel.width - left - width < TAB_SNAP) left = panel.width - width;
  return { x0: panel.x0 + left, width };
}

// ---------------------------------------------------------------------------
// Ribbon routing (§9.4), x only: the y layout depends on whether a route bends.

/** A rectangle in group-local coordinates. */
export interface Rect { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
/** Clearance from panels and labels (7px + the ribbon half-width + its stroke),
 * so the 24px gap between neighbouring panels always qualifies as a channel. */
export const RIBBON_CLEARANCE = 12;
export const RIBBON_HALF = 4.5;

export interface RibbonChannel {
  /** The vertical channel's x. */
  readonly channel: number;
  /** Where the ribbon leaves the parent tab, and enters the label. */
  readonly sx: number;
  readonly ex: number;
}

/** The scroller's 8px padding beside the row: the channel of last resort. */
export const RIBBON_OUTER = 4;

/**
 * The free vertical channel nearest the parent's centre, avoiding every
 * intervening panel and label (by `RIBBON_CLEARANCE`); the scroller padding
 * beside the row when none is free. The ribbon leaves the tab and enters the
 * label as close to the channel as their own 20px margins allow.
 */
export function ribbonChannel(tab: { x0: number; x1: number }, label: { x0: number; x1: number }, obstacles: readonly { x0: number; x1: number }[], width: number): RibbonChannel {
  const centre = (tab.x0 + tab.x1) / 2;
  let free: [number, number][] = [[0, width]];
  for (const o of obstacles) {
    const l = o.x0 - RIBBON_CLEARANCE, r = o.x1 + RIBBON_CLEARANCE;
    free = free.flatMap(([a, b]) => r < a || l > b ? [[a, b] as [number, number]]
      : ([[a, Math.min(b, l)], [Math.max(a, r), b]] as [number, number][]).filter(([x, y]) => y >= x));
  }
  const candidates = free.map(([a, b]) => Math.max(a, Math.min(b, centre)));
  const channel = candidates.length ? candidates.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre))[0]
    : centre < width / 2 ? -RIBBON_OUTER : width + RIBBON_OUTER;
  const safe = (x: number, a: number, b: number) => Math.max(a + 20, Math.min(b - 20, x));
  return { channel, sx: safe(channel, tab.x0, tab.x1), ex: safe(channel, label.x0, label.x1) };
}

// ---------------------------------------------------------------------------
// Model

export interface TopItem {
  readonly key: string;
  /** null for the creation sentinel. */
  readonly entryIndex: number | null;
}

export interface TilePanelSpec {
  readonly path: string;
  readonly name: string;
  /** The folder's own entry index. */
  readonly entryIndex: number;
  readonly row: number;
  readonly col: number;
  readonly side: BandSide;
  readonly bandKey: string;
  /** Children (entry indices, display order). */
  readonly entries: readonly number[];
  /** A Loading/Empty/Error label shown instead of children, else null. */
  readonly message: string | null;
  readonly cols: number;
  /** Its grid track (`PanelTileLayout.track` unless the segment is narrower). */
  readonly track: number;
  readonly contentRows: number;
  /** Height that shows every content row. */
  readonly contentHeight: number;
}

/** Interpolable geometry of one panel (motion mixes these). */
export interface PanelBox {
  readonly path: string;
  readonly side: BandSide;
  /** Parent column. */
  readonly col: number;
  readonly x0: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
  /** Stacked label, x within the row; its tab rises `labelHeight` above the panel. */
  readonly label: { readonly x0: number; readonly width: number } | null;
  readonly labelHeight: number;
  readonly opacity: number;
}

export interface GroupGeometry {
  readonly height: number;
  readonly rowTop: number;
  /** Render order: above (by column), below (by column), stacked (opening order). */
  readonly boxes: readonly PanelBox[];
}

export interface TileGroup {
  /** The grid row. */
  readonly key: number;
  /** Top-level items [start, end). */
  readonly start: number;
  readonly end: number;
  readonly bands: readonly Band[];
}

export type EntryLocation =
  | { readonly kind: "grid"; readonly item: number; readonly group: number; readonly col: number }
  | { readonly kind: "panel"; readonly path: string; readonly group: number; readonly offset: number };

export interface TilePanelModel {
  readonly metrics: RowMetrics;
  readonly tile: PanelTileLayout;
  readonly bounds: PanelHeightBounds;
  readonly items: readonly TopItem[];
  readonly groups: readonly TileGroup[];
  readonly geometry: readonly GroupGeometry[];
  readonly panels: ReadonlyMap<string, TilePanelSpec>;
  readonly placements: readonly PanelPlacement[];
  /** Per entry index; undefined for an entry with no tile (none in practice). */
  readonly location: readonly (EntryLocation | undefined)[];
}

export interface TilePanelInput {
  readonly rows: PeekRows;
  /** Folder paths in opening order (the expanded set's insertion order). */
  readonly order: Iterable<string>;
  readonly columns: number;
  readonly width: number;
  readonly viewportHeight: number;
  readonly layout: Pick<TileLayout, "gap" | "rowHeight">;
  /** Remembered (or previewed) preferred height per folder. */
  readonly preferred: (path: string) => number | undefined;
  /** Sides from the previous placement, kept while feasible. */
  readonly remembered?: ReadonlyMap<string, BandSide>;
}

interface PanelSource { entryIndex: number; name: string; entries: number[]; message: string | null }

/** Top-level items and each open folder's children, from the peek rows. */
function readRows(rows: PeekRows): { items: TopItem[]; itemOf: Map<string, number>; sources: Map<string, PanelSource> } {
  const items: TopItem[] = [];
  const itemOf = new Map<string, number>();
  const sources = new Map<string, PanelSource>();
  const groups = new Map(rows.groups.filter(g => g.depth === 0).map(g => [g.path, g]));
  for (let i = 0; i < rows.rows.length;) {
    const row = rows.rows[i];
    if (row.kind === "create") { items.push({ key: row.key, entryIndex: null }); i++; continue; }
    if (row.kind !== "entry" || row.depth !== 0) { i++; continue; }
    itemOf.set(row.entry.path, items.length);
    items.push({ key: row.key, entryIndex: row.entryIndex });
    const group = row.expanded ? groups.get(row.entry.path) : undefined;
    if (!group || group.startRow !== i + 1) { i++; continue; }
    const end = Math.max(group.startRow, Math.min(rows.rows.length, group.endRow));
    const entries: number[] = [];
    let message: string | null = null;
    for (let j = group.startRow; j < end; j++) {
      const child = rows.rows[j];
      if (child.kind === "entry") entries.push(child.entryIndex);
      else if (child.kind === "peek-state") message = child.message;
    }
    sources.set(row.entry.path, { entryIndex: row.entryIndex, name: row.entry.name, entries, message: entries.length ? null : message });
    i = end;
  }
  return { items, itemOf, sources };
}

/**
 * The whole Tiles layout with Folder Peek on: grid rows of top-level items
 * (the creation sentinel, then depth-0 entries), placed panels, their x and y
 * geometry within each row group, and where every entry's tile is.
 */
export function buildTilePanelModel(input: TilePanelInput): TilePanelModel {
  const C = Math.max(1, wholeColumns(input.columns) || 1);
  const gap = Math.max(0, input.layout.gap);
  const rowHeight = Math.max(1, input.layout.rowHeight);
  const metrics: RowMetrics = { columns: C, width: Math.max(0, Number.isFinite(input.width) ? input.width : 0), gap, tileHeight: Math.max(0, rowHeight - gap) };
  const tile = panelTileLayout(metrics);
  const bounds = panelHeightBounds(tile, input.viewportHeight);
  const { items, itemOf, sources } = readRows(input.rows);
  const requests: PanelRequest[] = [];
  const queued = new Set<string>();
  for (const path of input.order) {
    const source = sources.get(path);
    if (!source || queued.has(path)) continue;
    queued.add(path);
    requests.push({ path, index: itemOf.get(path)! });
  }
  // A folder open in the rows but missing from the order still gets a panel, last.
  for (const path of sources.keys()) if (!queued.has(path)) requests.push({ path, index: itemOf.get(path)! });
  const placements = placePanels(requests, C, input.remembered);
  const bands = computeBands(placements, C);

  const panels = new Map<string, TilePanelSpec>();
  const xOf = new Map<string, { x0: number; width: number; label: { x0: number; width: number } | null }>();
  for (const band of bands) {
    band.members.forEach((member, i) => {
      const source = sources.get(member.path)!;
      const tab = tabX(member.col, metrics);
      const x = panelX(source.entries.length, segmentX(band.segments[i], member.col, metrics), tab, tile);
      const contentRows = panelContentRows(source.entries.length, x.cols);
      panels.set(member.path, {
        path: member.path, name: source.name, entryIndex: source.entryIndex,
        row: member.row, col: member.col, side: member.side, bandKey: band.key,
        entries: source.entries, message: source.message,
        cols: x.cols, track: x.track, contentRows, contentHeight: contentRows * tile.rowHeight + PANEL_PAD_Y,
      });
      xOf.set(member.path, { x0: x.x0, width: x.width, label: band.side === "stacked" ? stackedLabelX(x, tab) : null });
    });
  }

  const groupCount = Math.ceil(items.length / C);
  const groups: TileGroup[] = [];
  const geometry: GroupGeometry[] = [];
  const bandsByRow = new Map<number, Band[]>();
  for (const band of bands) bandsByRow.set(band.row, [...(bandsByRow.get(band.row) ?? []), band]);
  let previousTrailing = gap;
  for (let g = 0; g < groupCount; g++) {
    const rowBands = bandsByRow.get(g) ?? [];
    groups.push({ key: g, start: g * C, end: Math.min(items.length, (g + 1) * C), bands: rowBands });
    const layout = layoutGroup(rowBands, panels, xOf, metrics, tile, bounds, input.preferred, previousTrailing);
    geometry.push(layout.geometry);
    previousTrailing = layout.trailing;
  }

  const location: (EntryLocation | undefined)[] = [];
  items.forEach((item, index) => {
    if (item.entryIndex !== null) location[item.entryIndex] = { kind: "grid", item: index, group: Math.floor(index / C), col: index % C };
  });
  for (const panel of panels.values()) {
    panel.entries.forEach((entry, offset) => { location[entry] = { kind: "panel", path: panel.path, group: panel.row, offset }; });
  }
  return { metrics, tile, bounds, items, groups, geometry, panels, placements, location };
}

/** Vertical layout of one row group with collapsed margins; computed, never measured. */
function layoutGroup(
  bands: readonly Band[], panels: ReadonlyMap<string, TilePanelSpec>,
  xOf: ReadonlyMap<string, { x0: number; width: number; label: { x0: number; width: number } | null }>,
  m: RowMetrics, tile: PanelTileLayout, bounds: PanelHeightBounds, preferredOf: (path: string) => number | undefined, previousTrailing: number,
): { geometry: GroupGeometry; trailing: number } {
  const above = bands.find(b => b.side === "above");
  const below = bands.find(b => b.side === "below");
  const stacked = bands.filter(b => b.side === "stacked");
  // Ribbon detours need room for their horizontal runs: decided on x alone.
  const margin = new Map<Band, number>();
  stacked.forEach((band, i) => {
    const member = band.members[0];
    const label = xOf.get(member.path)!.label!;
    const intervening = [...(below ? [below] : []), ...stacked.slice(0, i)];
    const obstacles = intervening.flatMap(b => b.members.flatMap(p => {
      const x = xOf.get(p.path)!;
      return [{ x0: x.x0, x1: x.x0 + x.width }, ...(x.label ? [{ x0: x.label.x0, x1: x.label.x0 + x.label.width }] : [])];
    }));
    const route = ribbonChannel(tabX(member.col, m), { x0: label.x0, x1: label.x0 + label.width }, obstacles, m.width);
    if (route.sx !== route.channel && intervening.length) margin.set(intervening[0], intervening[0].side === "stacked" ? DETOUR_STACKED_MARGIN : DETOUR_BELOW_MARGIN);
    if (route.ex !== route.channel || (!intervening.length && route.sx !== route.channel)) margin.set(band, DETOUR_STACKED_MARGIN);
  });
  const heightOf = (band: Band) => bandHeight(band.members.map(p => ({
    preferred: preferredOf(p.path) ?? defaultPanelHeight(xOf.get(p.path)!.width, tile),
    content: panels.get(p.path)!.contentHeight,
  })), bounds);
  const boxes: PanelBox[] = [];
  const place = (band: Band, top: number, height: number) => {
    for (const p of band.members) {
      const spec = panels.get(p.path)!, x = xOf.get(p.path)!;
      const panelHeight = Math.min(height, spec.contentHeight);
      boxes.push({
        path: p.path, side: band.side, col: p.col, x0: x.x0, width: x.width,
        top: band.side === "above" ? top + height - panelHeight : top, height: panelHeight,
        label: x.label, labelHeight: x.label ? STACKED_LABEL_HEIGHT : 0, opacity: 1,
      });
    }
  };
  let trailing = previousTrailing;
  let rowTop: number;
  if (above) {
    const height = heightOf(above);
    const top = Math.max(0, BAND_GAP - trailing);
    place(above, top, height);
    rowTop = top + height + BAND_GAP;
  } else rowTop = 0;
  let y = rowTop + m.tileHeight;
  trailing = m.gap;
  for (const band of [...(below ? [below] : []), ...stacked]) {
    const height = heightOf(band);
    const top = y + Math.max(trailing, margin.get(band) ?? (band.side === "stacked" ? STACKED_MARGIN : BAND_GAP));
    place(band, top, height);
    y = top + height;
    trailing = BAND_GAP;
  }
  return { geometry: { height: y + trailing, rowTop, boxes }, trailing };
}

/** Each group's top within the scroll content (prefix sums of heights). */
export function groupOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) offsets[i + 1] = offsets[i] + Math.max(0, heights[i]);
  return offsets;
}
