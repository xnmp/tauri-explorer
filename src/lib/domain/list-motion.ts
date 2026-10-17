/**
 * List open/close motion (#1240, spec §8.4) as a pure plan over two column-flow
 * layouts. Items that stay in their column slide (FLIP); items that change column
 * travel the column path like a conveyor: a snapshot leaves through the old
 * column's bottom while the live item enters through the new column's top, both
 * covering the same distance, empty slots included. Cards grow from / shrink to 0.
 */
import { LIST_SLOT_HEIGHT, type ListFlowModel } from "./list-column-flow";

export const LIST_MOTION_MS = 200;
/** An opened folder's listing may arrive after its toggle; its changes still animate this long. */
export const LIST_MOTION_ARM_MS = 1500;
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
}
export interface GhostMotion {
  /** The snapshot's own (old) column and row; it is clipped by that column. */
  readonly column: number;
  readonly row: number;
  /** Vertical travel (px) from 0 at t=0 to this at t=1. */
  readonly to: number;
  readonly rowsFrom: number | null;
  readonly rowsTo: number;
  /** Only the former card's body (and box) shows: its live header stays in
   * place, visible and focusable, above the shrinking snapshot. */
  readonly bodyOnly: boolean;
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
        // Closing in place: the live header never moves or hides (it may hold
        // focus); a snapshot of the card's body and box shrinks around it.
        steps.push({ key, live: null,
          ghost: { column: a.column, row: a.row, to: (b.row - a.row) * slot, rowsFrom: a.visibleRows, rowsTo: 0, bodyOnly: true } });
        continue;
      }
      const from = (a.row - b.row) * slot;
      const grows = b.card && rowsFrom !== b.visibleRows;
      if (from === 0 && !grows) continue;
      steps.push({ key, ghost: null,
        live: { from, clipColumn: null, rowsFrom: b.card ? rowsFrom : null, rowsTo: b.visibleRows } });
      continue;
    }
    const distance = ((b.column - a.column) * R + b.row - a.row) * slot;
    const live: LiveMotion | null = showLive
      ? { from: -distance, clipColumn: b.column, rowsFrom: b.card ? rowsFrom : null, rowsTo: b.visibleRows }
      : null;
    const ghost: GhostMotion | null = showGhost
      ? { column: a.column, row: a.row, to: distance, rowsFrom: a.card ? a.visibleRows : null, rowsTo: b.card ? b.visibleRows : 0, bodyOnly: false }
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

/**
 * Which layout changes animate and which card is revealed (#1240). A user
 * toggle (a new `peekChange` serial) arms motion for its folder until that
 * folder's listing leaves "loading" (the settling change is the last animated
 * one) or LIST_MOTION_ARM_MS passes. Revealing is independent of motion: the
 * toggled folder's card (or the top-level card containing it) is revealed after
 * every layout change until its listing settles, however long that takes, and
 * a reveal an interrupted motion still owed (`carried`) is kept.
 */
export interface MotionArm {
  /** The last `peekChange` serial already handled. */
  readonly seen: number | null;
  readonly armed: { readonly path: string; readonly until: number } | null;
  /** The toggled folder whose card is revealed until its listing settles. */
  readonly reveal: string | null;
}
export interface MotionArmInput {
  /** `reveal: false` animates the change without revealing its card (a
   * spring-loaded peek, #1242: scrolling would move it out from under the drag). */
  readonly change: { readonly path: string; readonly serial: number; readonly reveal?: boolean } | null;
  readonly now: number;
  readonly status: (path: string) => string | undefined;
  /** The top-level card that is `path` or contains it, or null. */
  readonly cardOf: (path: string) => string | null;
  /** A card whose reveal a now-interrupted motion was to make at its end. */
  readonly carried: string | null;
}
export interface MotionArmStep {
  readonly next: MotionArm;
  /** Plan motion for this layout change. */
  readonly animate: boolean;
  /** Reveal this card after the change (after its motion, if one runs). */
  readonly reveal: string | null;
}

export const motionArmAt = (serial: number | null): MotionArm => ({ seen: serial, armed: null, reveal: null });

export function stepMotionArm(state: MotionArm, input: MotionArmInput): MotionArmStep {
  const { change, now } = input;
  const user = change !== null && change.serial !== state.seen;
  let armed = user ? { path: change.path, until: now + LIST_MOTION_ARM_MS } : state.armed;
  let pending = user ? (change.reveal === false ? null : change.path) : state.reveal;
  if (armed && now > armed.until) armed = null;
  const animate = armed !== null;
  const loading = (path: string) => input.status(path) === "loading";
  if (armed && !loading(armed.path)) armed = null;
  const target = pending !== null ? input.cardOf(pending) : null;
  const owed = input.carried !== null ? input.cardOf(input.carried) : null;
  if (pending !== null && !loading(pending)) pending = null;
  return { next: { seen: change?.serial ?? state.seen, armed, reveal: pending }, animate, reveal: target ?? owed };
}
