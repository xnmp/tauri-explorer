/**
 * Variable-height virtual list layout math.
 * Pure functions — no framework deps. Used by VirtualList.svelte's
 * variable-height mode (and benchmarked in tests/perf).
 */

/** A row of items in a virtualized grid (List/Tiles views). */
export interface VirtualRow<T> {
  /** The (up to `columns`) items on this row, in sequence order. */
  items: T[];
  /** Global index of `items[0]` in the flat entry list. */
  startIndex: number;
}

/**
 * Row-major chunking: split a flat, already-sorted item list into rows of at
 * most `columns` items, filling left→right then top→down. This is what lets
 * List and Tiles views virtualize by row while keeping the DOM in sequence
 * order (so the on-screen reading order stays name-sorted).
 *
 * `columns` is clamped to at least 1 and floored, so 0, NaN, negative, or
 * fractional inputs degrade to a single column instead of looping forever.
 */
export function chunkIntoRows<T>(items: readonly T[], columns: number): VirtualRow<T>[] {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const rows: VirtualRow<T>[] = [];
  for (let i = 0; i < items.length; i += cols) {
    rows.push({ items: items.slice(i, i + cols), startIndex: i });
  }
  return rows;
}

/** Number of rows a flat list of `total` items occupies at `columns` per row. */
export function rowCount(total: number, columns: number): number {
  const cols = Math.max(1, Math.floor(columns) || 1);
  return Math.ceil(Math.max(0, total) / cols);
}

/**
 * How many columns CSS `repeat(auto-fill, minmax(minColWidth, 1fr))` would
 * produce for a given content width and gap. We replicate the browser's math
 * explicitly because a virtualized grid renders each row as its own fixed
 * column-count grid rather than one big auto-fill grid.
 *
 * n columns fit when: n*minColWidth + (n-1)*gap <= availableWidth
 * → n <= (availableWidth + gap) / (minColWidth + gap)
 */
export function autoFillColumns(availableWidth: number, minColWidth: number, gap: number): number {
  if (availableWidth <= 0 || minColWidth <= 0) return 1;
  const cols = Math.floor((availableWidth + gap) / (minColWidth + Math.max(0, gap)));
  return Math.max(1, cols);
}

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
