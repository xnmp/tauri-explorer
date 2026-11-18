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

/** Index, in the strip without it, of the tab that becomes active when the
 *  active tab at `closedIndex` of a `count`-tab strip closes: its right
 *  neighbour, which slides into its place (Chrome, Safari, VS Code), or its
 *  left one when it was the last tab. -1 when nothing remains (#1749). */
export function activationAfterClose(count: number, closedIndex: number): number {
  const remaining = count - 1;
  if (remaining <= 0 || closedIndex < 0 || closedIndex >= count) return -1;
  return Math.min(closedIndex, remaining - 1);
}

/** Which tabs a strip close action removes, in strip order (#1749):
 *  every tab but `keepId` ("others"), or every tab after it ("right"). */
export function tabsToClose(ids: readonly string[], keepId: string, scope: "others" | "right"): string[] {
  const at = ids.indexOf(keepId);
  if (at < 0) return [];
  return scope === "others" ? ids.filter((id) => id !== keepId) : ids.slice(at + 1);
}
