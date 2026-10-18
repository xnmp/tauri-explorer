/**
 * Tiles keyboard navigation with open panels (#1241, spec §6): arrows move
 * spatially over the laid-out rectangles (grid tiles plus the visible items of
 * panels), computed from the domain layout rather than the DOM. Inside a panel
 * the arrows walk its grid (scrolling it as needed); at its edge they leave it
 * for the nearest item in that direction. With no panel open, the classic grid
 * resolver applies (FileList only provides this snapshot while panels exist).
 */
import type { FileEntry } from "./file";
import { PAGE_LINES, type FileListKey, type FileListMove } from "./file-list-navigation";
import {
  cellX, groupOffsets, PANEL_PAD_FAR, PANEL_PAD_NEAR, PANEL_PAD_X, panelPadTop,
  type EntryLocation, type GroupGeometry, type PanelBox, type TilePanelModel, type TilePanelSpec,
} from "./tile-panels";

/** What FileList hands ExplorerPane's key handler while panels are open. */
export interface TileNavigationSnapshot {
  readonly entries: readonly FileEntry[];
  readonly directory: string;
  resolve(event: FileListKey, cursorIndex: number): FileListMove | null;
}

export interface TileNavigationState {
  readonly model: TilePanelModel;
  /** The settled geometry (the model's: a running motion ends within 150ms). */
  readonly geometry: readonly GroupGeometry[];
  /** A panel's scroll offset (CSS px). */
  readonly panelScrollTop: (path: string) => number;
}

export interface TileRect { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }
const centre = (r: TileRect) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** Top padding of a panel's grid: the grip side of an above panel is its top. */
const padTop = (box: PanelBox) => panelPadTop(box.side);

/** Where a panel's content row `row` starts, relative to its scroll area's content. */
export const panelRowTop = (box: PanelBox, rowHeight: number, row: number): number => padTop(box) + row * rowHeight;

/** A panel item's rectangle in scroll-content coordinates (scrolled within its panel). */
export function panelItemRect(state: TileNavigationState, spec: TilePanelSpec, box: PanelBox, groupTop: number, offset: number): TileRect {
  const { rowHeight } = state.model.tile;
  const row = Math.floor(offset / spec.cols), col = offset % spec.cols;
  const inset = Math.max(0, (box.width - PANEL_PAD_X - spec.cols * spec.track) / 2);
  const x0 = box.x0 + PANEL_PAD_NEAR + inset + col * spec.track;
  const y0 = groupTop + box.top + panelRowTop(box, rowHeight, row) - state.panelScrollTop(spec.path);
  return { x0, x1: x0 + spec.track, y0, y1: y0 + rowHeight };
}

function gridRect(state: TileNavigationState, group: number, col: number, groupTop: number): TileRect {
  const { x0, x1 } = cellX(col, state.model.metrics);
  const y0 = groupTop + state.geometry[group].rowTop;
  return { x0, x1, y0, y1: y0 + state.model.metrics.tileHeight };
}

interface Candidate { entry: number; rect: TileRect }

/** Grid tiles and visible panel items of groups g-1..g+1 (never `exclude`'s items). */
function candidates(state: TileNavigationState, offsets: readonly number[], group: number, exclude: string | null): Candidate[] {
  const { model } = state;
  const out: Candidate[] = [];
  for (let g = Math.max(0, group - 1); g <= Math.min(model.groups.length - 1, group + 1); g++) {
    const top = offsets[g];
    const { start, end } = model.groups[g];
    for (let item = start; item < end; item++) {
      const entry = model.items[item].entryIndex;
      if (entry !== null) out.push({ entry, rect: gridRect(state, g, item - start, top) });
    }
    for (const box of state.geometry[g].boxes) {
      const spec = model.panels.get(box.path);
      if (!spec || box.path === exclude) continue;
      const viewTop = top + box.top, viewBottom = viewTop + box.height;
      spec.entries.forEach((entry, offset) => {
        const rect = panelItemRect(state, spec, box, top, offset);
        const mid = (rect.y0 + rect.y1) / 2;
        if (mid >= viewTop && mid <= viewBottom) out.push({ entry, rect });
      });
    }
  }
  return out;
}

type Arrow = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/** The nearest candidate whose centre lies in the arrow's direction, preferring
 * candidates that overlap the cursor's extent across the direction of travel
 * (`overlapOnly` admits nothing else). */
export function nearestInDirection(from: TileRect, pool: readonly Candidate[], key: Arrow, overlapOnly = false): number | null {
  const c = centre(from);
  const vertical = key === "ArrowUp" || key === "ArrowDown";
  const sign = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
  let best: { entry: number; overlap: boolean; along: number; cross: number; distance: number } | null = null;
  for (const candidate of pool) {
    const p = centre(candidate.rect);
    const along = sign * (vertical ? p.y - c.y : p.x - c.x);
    if (along <= 0.5) continue;
    const cross = Math.abs(vertical ? p.x - c.x : p.y - c.y);
    const overlap = vertical
      ? Math.min(from.x1, candidate.rect.x1) - Math.max(from.x0, candidate.rect.x0) > 0
      : Math.min(from.y1, candidate.rect.y1) - Math.max(from.y0, candidate.rect.y0) > 0;
    if (overlapOnly && !overlap) continue;
    const next = { entry: candidate.entry, overlap, along, cross, distance: Math.hypot(along, cross) };
    if (!best || better(next, best)) best = next;
  }
  return best?.entry ?? null;
}

function better(a: { overlap: boolean; along: number; cross: number; distance: number }, b: typeof a): boolean {
  if (a.overlap !== b.overlap) return a.overlap;
  if (a.overlap) return a.along !== b.along ? a.along < b.along : a.cross < b.cross;
  return a.distance < b.distance;
}

/** An arrow within a panel's grid, or null at the grid's edge in that
 * direction (Left/Right stop at the ends of the item's row). */
export function panelStep(spec: TilePanelSpec, offset: number, key: Arrow): number | null {
  const n = spec.entries.length, cols = Math.max(1, spec.cols);
  const row = Math.floor(offset / cols), col = offset % cols, lastRow = Math.floor((n - 1) / cols);
  switch (key) {
    case "ArrowLeft": return col > 0 ? offset - 1 : null;
    case "ArrowRight": return col < cols - 1 && offset + 1 < n ? offset + 1 : null;
    case "ArrowUp": return row > 0 ? offset - cols : null;
    // A shorter last row: Down from above its end lands on its last item.
    case "ArrowDown": return row < lastRow ? Math.min(n - 1, offset + cols) : null;
  }
}

const topLevelEntries = (model: TilePanelModel): number[] => model.items.flatMap(item => item.entryIndex === null ? [] : [item.entryIndex]);

/**
 * Resolves a navigation key with panels open. Up/Down: within the cursor's
 * panel, else the nearest item in that direction. Left/Right: within the panel
 * row, else the nearest item on the same visual line, else the next item in
 * reading order within the cursor's level (as the classic grid wraps).
 * Ctrl+Home/End: first/last top-level entry. PageUp/PageDown: ten rows
 * (of the level's own column count) within the cursor's level.
 */
export function resolveTileMove(state: TileNavigationState, event: FileListKey, cursorIndex: number): FileListMove | null {
  if (event.altKey) return null;
  const { model } = state;
  const modified = event.ctrlKey || event.metaKey;
  const arrow = (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const).find(key => key === event.key);
  const top = topLevelEntries(model);
  if (!top.length) return null;
  const focus = (index: number | null | undefined): FileListMove | null => index === null || index === undefined ? null
    : { kind: "focus", index, selection: event.shiftKey ? "extend" : modified && arrow ? "preserve" : "replace" };
  const at: EntryLocation | undefined = cursorIndex >= 0 ? model.location[cursorIndex] : undefined;
  if (modified && (event.key === "Home" || event.key === "End")) return focus(event.key === "Home" ? top[0] : top.at(-1));
  if (!arrow && (modified || (event.key !== "PageUp" && event.key !== "PageDown"))) return null;
  if (!at) return focus(top[0]);
  // The cursor's level: its panel's children, or the top-level entries.
  const level = at.kind === "panel" ? model.panels.get(at.path)!.entries : top;
  const position = at.kind === "panel" ? at.offset : top.indexOf(cursorIndex);
  if (!arrow) {
    const columns = at.kind === "panel" ? Math.max(1, model.panels.get(at.path)!.cols) : Math.max(1, model.metrics.columns);
    const page = PAGE_LINES * columns;
    return focus(level[Math.max(0, Math.min(level.length - 1, position + (event.key === "PageDown" ? page : -page)))]);
  }
  const offsets = groupOffsets(state.geometry.map(g => g.height));
  let from: TileRect;
  if (at.kind === "panel") {
    const spec = model.panels.get(at.path)!;
    const inside = panelStep(spec, at.offset, arrow);
    if (inside !== null) return focus(spec.entries[inside]);
    const box = state.geometry[at.group]?.boxes.find(b => b.path === at.path);
    if (!box) return null;
    from = panelItemRect(state, spec, box, offsets[at.group], at.offset);
  } else {
    from = gridRect(state, at.group, at.col, offsets[at.group]);
  }
  const pool = candidates(state, offsets, at.group, at.kind === "panel" ? at.path : null).filter(c => c.entry !== cursorIndex);
  const horizontal = arrow === "ArrowLeft" || arrow === "ArrowRight";
  const spatial = nearestInDirection(from, pool, arrow, horizontal);
  if (spatial !== null || !horizontal) return focus(spatial);
  const next = position + (arrow === "ArrowRight" ? 1 : -1);
  return next >= 0 && next < level.length ? focus(level[next]) : null;
}

/** The panel scroll offset that shows content row `row` (minimal movement). */
export function panelRevealTop(box: PanelBox, rowHeight: number, row: number, scrollTop: number, contentHeight: number): number {
  const rowTop = panelRowTop(box, rowHeight, row);
  const view = box.height;
  const max = Math.max(0, contentHeight - view);
  const current = Math.max(0, Math.min(max, Number.isFinite(scrollTop) ? scrollTop : 0));
  if (rowTop - padTop(box) < current) return Math.max(0, Math.min(max, rowTop - padTop(box)));
  if (rowTop + rowHeight > current + view) return Math.max(0, Math.min(max, rowTop + rowHeight - view + (box.side === "above" ? PANEL_PAD_NEAR : PANEL_PAD_FAR)));
  return current;
}
