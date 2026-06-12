/**
 * Variable-height virtual list layout math.
 * Pure functions — no framework deps. Used by VirtualList.svelte's
 * variable-height mode (and benchmarked in tests/perf).
 */

export interface VirtualLayout {
  /** offsets[i] = y position of item i (prefix sums of heights). */
  offsets: number[];
  totalHeight: number;
}

/** Build prefix-sum offsets for items with per-index heights. */
export function computeOffsets<T>(
  items: readonly T[],
  getItemHeight: (item: T, index: number) => number,
): VirtualLayout {
  const offsets = new Array<number>(items.length);
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    offsets[i] = cumulative;
    cumulative += getItemHeight(items[i], i);
  }
  return { offsets, totalHeight: cumulative };
}

/**
 * Largest index whose offset is <= scrollTop (binary search), i.e. the
 * first item any part of which can be visible at this scroll position.
 * Returns 0 for an empty offsets array.
 */
export function firstVisibleIndex(offsets: readonly number[], scrollTop: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/**
 * One-past-the-last index whose top edge is above viewBottom — the
 * exclusive end of the visible range starting from `startIndex`.
 */
export function lastVisibleIndexExclusive(
  offsets: readonly number[],
  startIndex: number,
  viewBottom: number,
): number {
  let i = startIndex;
  while (i < offsets.length && offsets[i] < viewBottom) i++;
  return i;
}
