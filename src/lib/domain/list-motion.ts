/**
 * List open/close motion (#1240, spec §8.4) as a pure plan over two column-flow
 * layouts. Items that stay in their column slide (FLIP); items that change column
 * travel the column path like a conveyor: a snapshot leaves through the old
 * column's bottom while the live item enters through the new column's top, both
 * covering the same distance, empty slots included. Cards grow from / shrink to 0.
 */
import { LIST_SLOT_HEIGHT, type ListFlowModel } from "./list-column-flow";

export const LIST_MOTION_MS = 200;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

export interface MotionItem {
  readonly column: number;
  readonly row: number;
  readonly slots: number;
  readonly card: boolean;
  readonly visibleRows: number;
}
export interface MotionSnapshot {
  readonly R: number;
  readonly items: ReadonlyMap<string, MotionItem>;
}

export interface LiveMotion {
  /** Vertical offset (px) at t=0, easing to 0. */
  readonly from: number;
  /** Clip to this column while travelling (conveyor entry). */
  readonly clipColumn: number | null;
  /** Card content height in rows, interpolated (null = not a card). */
  readonly rowsFrom: number | null;
  readonly rowsTo: number;
  /** Hidden for the whole motion, under a shrinking ghost of its former card. */
  readonly hidden: boolean;
}
export interface GhostMotion {
  /** The snapshot's own (old) column and row; it is clipped by that column. */
  readonly column: number;
  readonly row: number;
  /** Vertical travel (px) from 0 at t=0 to this at t=1. */
  readonly to: number;
  readonly rowsFrom: number | null;
  readonly rowsTo: number;
}
export interface MotionStep {
  readonly key: string;
  readonly live: LiveMotion | null;
  readonly ghost: GhostMotion | null;
}

export function listMotionSnapshot(model: ListFlowModel): MotionSnapshot {
  const items = new Map<string, MotionItem>();
  model.items.forEach((item, index) => {
    const placement = model.layout.byIndex[index];
    items.set(item.key, { column: placement.column, row: placement.row, slots: placement.slots, card: !!item.card, visibleRows: item.card?.visibleRows ?? 0 });
  });
  return { R: model.layout.rows, items };
}

/**
 * The steps that turn `prev` into `next`. Only columns for which `visible` holds
 * animate: a live item by its new column, a ghost by its old one; everything else
 * snaps. A change of rows per column (or no previous layout) is instant: null.
 */
export function planListMotion(prev: MotionSnapshot | null, next: MotionSnapshot, visible: (column: number) => boolean,
  slot = LIST_SLOT_HEIGHT): MotionStep[] | null {
  if (!prev || prev.R !== next.R) return null;
  const R = next.R;
  const steps: MotionStep[] = [];
  for (const [key, b] of next.items) {
    const a = prev.items.get(key);
    if (!a) continue;
    const showLive = visible(b.column), showGhost = visible(a.column);
    const rowsFrom = a.card ? a.visibleRows : 0;
    if (a.column === b.column) {
      if (!showLive) continue;
      if (a.card && !b.card) {
        // The final plain row waits, hidden, under a shrinking copy of its card.
        steps.push({ key, live: { from: 0, clipColumn: null, rowsFrom: null, rowsTo: 0, hidden: true },
          ghost: { column: a.column, row: a.row, to: (b.row - a.row) * slot, rowsFrom: a.visibleRows, rowsTo: 0 } });
        continue;
      }
      const from = (a.row - b.row) * slot;
      const grows = b.card && rowsFrom !== b.visibleRows;
      if (from === 0 && !grows) continue;
      steps.push({ key, ghost: null,
        live: { from, clipColumn: null, rowsFrom: b.card ? rowsFrom : null, rowsTo: b.visibleRows, hidden: false } });
      continue;
    }
    const distance = ((b.column - a.column) * R + b.row - a.row) * slot;
    const live: LiveMotion | null = showLive
      ? { from: -distance, clipColumn: b.column, rowsFrom: b.card ? rowsFrom : null, rowsTo: b.visibleRows, hidden: false }
      : null;
    const ghost: GhostMotion | null = showGhost
      ? { column: a.column, row: a.row, to: distance, rowsFrom: a.card ? a.visibleRows : null, rowsTo: b.card ? b.visibleRows : 0 }
      : null;
    if (live || ghost) steps.push({ key, live, ghost });
  }
  return steps.length ? steps : null;
}

/** Card content height at eased time `e`. */
export const motionRows = (from: number | null, to: number, e: number): number =>
  from === null ? to : from + (to - from) * e;

/** Inset (px, element-local) that keeps a travelling element inside its column
 * [0, columnHeight] while it is offset by `y` from its laid-out `top`. */
export function columnClip(top: number, y: number, height: number, columnHeight: number): Readonly<{ top: number; bottom: number }> {
  const start = top + y;
  return { top: Math.max(0, -start), bottom: Math.max(0, start + height - columnHeight) };
}
