/**
 * FLIP planning for file entries whose positions change in one reflow (#1718).
 * Entries are keyed by path, not DOM identity: a virtualized grid rechunks its
 * rows when its column count changes, so most moved entries are new elements.
 * Pure: the DOM adapter (state/entry-reflow-motion.ts) measures and animates.
 */

export interface EntryPosition {
  readonly x: number;
  readonly y: number;
}

/** Painted at `after - (dx, dy)` before the reflow: glide from there. */
export interface EntryReflowStep {
  readonly key: string;
  readonly dx: number;
  readonly dy: number;
}

/** Sub-pixel offsets are layout noise, not motion. */
const STILL_PX = 0.5;

export function planEntryReflow(
  before: ReadonlyMap<string, EntryPosition>,
  after: ReadonlyMap<string, EntryPosition>,
): EntryReflowStep[] {
  const steps: EntryReflowStep[] = [];
  for (const [key, to] of after) {
    const from = before.get(key);
    // Newly mounted entries appear in place. A pane that keeps its scroll
    // offset can mount an entirely new range; fading those in from nothing
    // would blank the reveal's first frame.
    if (!from) continue;
    const dx = from.x - to.x, dy = from.y - to.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    if (Math.abs(dx) < STILL_PX && Math.abs(dy) < STILL_PX) continue;
    steps.push({ key, dx, dy });
  }
  return steps;
}
