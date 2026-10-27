/**
 * Command-palette highlight identity (#1236).
 *
 * The palette's result list is live: dynamic command sources (Git Graph
 * targets, late plugin commands) can insert or remove rows while the query is
 * unchanged. A highlight stored as a row index would silently move to a
 * different command on such an update, so Enter could run something other
 * than what the user chose. The highlight is therefore a command id; `null`
 * means "follow the top result" (the state after opening or typing).
 */

/** Row index of the highlighted command, or 0 when it follows the top
 *  result or its command is no longer listed. */
export function paletteSelectionIndex(
  ids: readonly string[],
  selectedId: string | null,
): number {
  if (selectedId === null) return 0;
  const index = ids.indexOf(selectedId);
  return index < 0 ? 0 : index;
}

/** Id to highlight after moving `delta` rows (wrapping) from the current
 *  highlight; `null` for an empty list. */
export function stepPaletteSelection(
  ids: readonly string[],
  selectedId: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) return null;
  const from = paletteSelectionIndex(ids, selectedId);
  const to = (((from + delta) % ids.length) + ids.length) % ids.length;
  return ids[to];
}

/** Rows a PgUp/PgDn press moves the highlight in Quick Open and the palette. */
export const PALETTE_PAGE_SIZE = 10;

/** Row index after moving `delta` rows, clamped to the list ends (no wrap, so
 *  PgDn on the last row stays there). Returns 0 for an empty list. Arrow keys
 *  wrap; page keys deliberately do not. */
export function clampedStep(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

/** Page-key delta for a keydown (`PALETTE_PAGE_SIZE` rows), or `null` when the
 *  key is not a plain PageUp/PageDown. Modified presses stay with the platform. */
export function pageKeyDelta(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "PageDown") return PALETTE_PAGE_SIZE;
  if (event.key === "PageUp") return -PALETTE_PAGE_SIZE;
  return null;
}
