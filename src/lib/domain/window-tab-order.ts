/**
 * Tab-strip index arithmetic for the window tabs manager (#1372): where a
 * new tab goes, which tab Ctrl+Tab lands on, and drag reordering.
 */

/** Insertion index for a new tab: `requested` clamped to the strip, else
 *  just after the active tab, else the end. */
export function tabInsertIndex(count: number, activeIndex: number, requested?: number): number {
  if (requested !== undefined) return Math.max(0, Math.min(requested, count));
  return activeIndex >= 0 ? activeIndex + 1 : count;
}

/** Index `delta` steps from `current`, wrapping around a strip of `count`. */
export function cycledTabIndex(current: number, delta: number, count: number): number {
  return (current + delta + count) % count;
}

/** `items` with the item at `from` moved to `to`, or null when either index
 *  is out of range or they are equal (nothing to reorder). */
export function movedItem<T>(items: readonly T[], from: number, to: number): T[] | null {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return null;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
