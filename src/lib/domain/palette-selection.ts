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
