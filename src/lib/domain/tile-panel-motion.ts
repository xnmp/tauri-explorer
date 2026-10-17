/**
 * Tiles panel motion (#1241, spec §9.5): user toggles interpolate the row
 * groups' heights and margins and every panel's left, width and height over
 * ~150ms (ease-out cubic); an opening panel grows from its row and fades in, a
 * closing one shrinks back and fades out. Outlines and ribbons are redrawn from
 * each mixed frame. Pure: the composable owns timing, ghosts and scrolling.
 */
import { easeOutCubic } from "./list-motion";
import type { GroupGeometry, PanelBox, TilePanelModel } from "./tile-panels";

export const TILE_MOTION_MS = 150;
export { easeOutCubic };

/** Motion only connects layouts of the same grid; anything else is instant. */
export function canAnimate(from: TilePanelModel | null, to: TilePanelModel): boolean {
  return !!from && from.metrics.columns === to.metrics.columns && Math.abs(from.metrics.width - to.metrics.width) < 0.5
    && from.metrics.gap === to.metrics.gap && from.metrics.tileHeight === to.metrics.tileHeight
    && from.groups.length === to.groups.length && from.items.length === to.items.length
    && from.items.every((item, i) => item.key === to.items[i].key);
}

const mix = (a: number, b: number, e: number) => a + (b - a) * e;

/** A box collapsed against its row: where it starts (opening) or ends (closing). */
function collapsed(box: PanelBox, rowShift: number): PanelBox {
  const top = box.top + rowShift + (box.side === "above" ? box.height : 0);
  return { ...box, top, height: 0, labelHeight: 0, opacity: 0 };
}

function mixBox(a: PanelBox, b: PanelBox, e: number): PanelBox {
  return {
    path: b.path, side: b.side, col: b.col,
    x0: mix(a.x0, b.x0, e), width: mix(a.width, b.width, e),
    top: mix(a.top, b.top, e), height: mix(a.height, b.height, e),
    label: b.label && a.label ? { x0: mix(a.label.x0, b.label.x0, e), width: mix(a.label.width, b.label.width, e) } : b.label ?? a.label,
    labelHeight: mix(a.labelHeight, b.labelHeight, e),
    opacity: mix(a.opacity, b.opacity, e),
  };
}

/**
 * Geometry at progress e (0..1) from `from` to `to` (index-aligned groups).
 * Boxes in both mix; a box only in `to` opens from collapsed, one only in
 * `from` (a closing panel's ghost) collapses, keeping its place relative to its
 * moving row. Boxes keep the target's render order, ghosts after them.
 */
export function mixGeometry(from: readonly GroupGeometry[], to: readonly GroupGeometry[], e: number): GroupGeometry[] {
  const t = Math.max(0, Math.min(1, Number.isFinite(e) ? e : 1));
  return to.map((target, i) => {
    const source = from[i] ?? target;
    const before = new Map(source.boxes.map(box => [box.path, box]));
    const after = new Set(target.boxes.map(box => box.path));
    const shift = target.rowTop - source.rowTop;
    const boxes = target.boxes.map(box => {
      const start = before.get(box.path) ?? collapsed(box, -shift);
      return mixBox(start, box, t);
    });
    for (const box of source.boxes) if (!after.has(box.path)) boxes.push(mixBox(box, collapsed(box, shift), t));
    return { height: mix(source.height, target.height, t), rowTop: mix(source.rowTop, target.rowTop, t), boxes };
  });
}

/** A row kept at its screen position across a geometry change: its canvas top and the scroll offset then. */
export interface ScrollAnchor { readonly top: number; readonly scrollTop: number }

/**
 * The outer scroll offset for an anchored row now at canvas top `rowTop` (spec
 * §14). The scroll follows the row, keeping it where it was on screen, unless
 * that would put the top of `revealTop` (an opening panel above the row) above
 * the viewport's top: the scroll then stops with that top at the viewport's top,
 * and the row moves down by exactly the shortfall. Applied to every motion
 * frame, the row's descent stays inside the open motion; there is nothing left
 * for a reveal to scroll afterwards.
 */
export function anchoredScrollTop(anchor: ScrollAnchor, rowTop: number, revealTop: number | null): number {
  const kept = anchor.scrollTop + rowTop - anchor.top;
  return revealTop === null || !Number.isFinite(revealTop) ? kept : Math.min(kept, revealTop);
}

/** Paths whose boxes are only in `from` (they leave during this motion). */
export function leavingPaths(from: readonly GroupGeometry[], to: readonly GroupGeometry[]): Set<string> {
  const after = new Set(to.flatMap(group => group.boxes.map(box => box.path)));
  return new Set(from.flatMap(group => group.boxes.map(box => box.path)).filter(path => !after.has(path)));
}

/** Whether anything moves between two geometries (nothing to animate otherwise). */
export function geometryChanged(from: readonly GroupGeometry[], to: readonly GroupGeometry[]): boolean {
  if (from.length !== to.length) return true;
  return to.some((group, i) => {
    const other = from[i];
    if (Math.abs(other.height - group.height) > 0.01 || Math.abs(other.rowTop - group.rowTop) > 0.01 || other.boxes.length !== group.boxes.length) return true;
    return group.boxes.some((box, j) => {
      const b = other.boxes[j];
      return b.path !== box.path || Math.abs(b.x0 - box.x0) > 0.01 || Math.abs(b.width - box.width) > 0.01
        || Math.abs(b.top - box.top) > 0.01 || Math.abs(b.height - box.height) > 0.01 || b.opacity !== box.opacity;
    });
  });
}
