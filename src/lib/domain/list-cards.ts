/**
 * List cards (#1240): an open top-level folder in the column flow is a card of
 * one header slot plus its visible descendant rows. Pure layout, clamp, grip,
 * scroll-edge and reveal policies shared by rendering, keyboard and motion.
 */
import type { PeekRows } from "./folder-peek";
import { columnFlow, LIST_SLOT_HEIGHT, type ListFlowModel, type ListTopItem } from "./list-column-flow";

export const LIST_CARD_DEFAULT_ROWS = 6;
/** Scroll-edge fade mask height (CSS px). */
export const LIST_CARD_FADE = 28;
/** Card heights remembered per pane, like the expanded set's cap. */
export const LIST_CARD_ROWS_CAP = 500;

const wholeRows = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/** A card never takes more than 70% of a column (so it always fits one). */
export const cardMaxRows = (R: number): number => Math.max(1, Math.floor(0.7 * (Number.isFinite(R) ? R : 4)));

/** Visible rows = min(content, preferred) with preferred clamped to 1..floor(0.7R);
 * 0 only while the folder has produced no row yet (a header-only card). */
export function cardVisibleRows(content: number, preferred: number, R: number): number {
  const rows = wholeRows(content);
  const wanted = Number.isFinite(preferred) ? Math.round(preferred) : LIST_CARD_DEFAULT_ROWS;
  return Math.min(rows, Math.max(1, Math.min(wanted, cardMaxRows(R))));
}

/**
 * Top-level items in row order: the creation row, every depth-0 entry and, for an
 * expanded one, a card over its depth-0 group's rows (nested entries and Loading/
 * Empty/Error rows). Any entry row outside a card is a plain top-level item, so
 * every entry always has a slot owner.
 */
export function buildListModel(rows: PeekRows, R: number, preferredOf: (path: string) => number | undefined): ListFlowModel {
  const entryCount = rows.entryToRow.length;
  const entryItem = new Int32Array(entryCount).fill(-1);
  const entryOffset = new Int32Array(entryCount).fill(-1);
  const groups = new Map(rows.groups.filter(group => group.depth === 0).map(group => [group.path, group]));
  const items: ListTopItem[] = [];
  for (let i = 0; i < rows.rows.length;) {
    const row = rows.rows[i];
    if (row.kind === "create") { items.push({ key: row.key, entryIndex: null, card: null }); i++; continue; }
    if (row.kind !== "entry") { i++; continue; }
    const itemIndex = items.length;
    entryItem[row.entryIndex] = itemIndex;
    const group = row.depth === 0 && row.expanded ? groups.get(row.entry.path) : undefined;
    if (!group || group.startRow !== i + 1) { items.push({ key: row.key, entryIndex: row.entryIndex, card: null }); i++; continue; }
    const start = group.startRow, end = Math.max(start, Math.min(rows.rows.length, group.endRow));
    for (let j = start; j < end; j++) {
      const entry = rows.rowToEntry[j];
      if (entry !== null && entry !== undefined) { entryItem[entry] = itemIndex; entryOffset[entry] = j - start; }
    }
    const visibleRows = cardVisibleRows(end - start, preferredOf(row.entry.path) ?? LIST_CARD_DEFAULT_ROWS, R);
    items.push({ key: row.key, entryIndex: row.entryIndex, card: { path: row.entry.path, start, end, visibleRows } });
    i = end;
  }
  const layout = columnFlow(items, R, item => item.card ? { slots: 1 + item.card.visibleRows, card: true } : { slots: 1, card: false });
  return { layout, items, rowEntry: rows.rowToEntry, entryItem, entryOffset };
}

/** Grip drag: the start height plus the pointer travel, snapped to whole rows. */
export function gripRows(startRows: number, deltaCss: number, content: number, R: number): number {
  return cardVisibleRows(content, startRows + (Number.isFinite(deltaCss) ? deltaCss : 0) / LIST_SLOT_HEIGHT, R);
}

/** Grip keys (separator pattern): one row per arrow, Home/End = min/max. */
export function gripKeyRows(key: string, rows: number, content: number, R: number): number | null {
  const max = Math.max(1, Math.min(wholeRows(content), cardMaxRows(R)));
  if (key === "ArrowUp") return cardVisibleRows(content, rows - 1, R);
  if (key === "ArrowDown") return cardVisibleRows(content, rows + 1, R);
  if (key === "Home") return cardVisibleRows(content, 1, R);
  if (key === "End") return cardVisibleRows(content, max, R);
  return null;
}

function scrollRange(content: number, visible: number, scrollTop: number) {
  const max = Math.max(0, (wholeRows(content) - wholeRows(visible)) * LIST_SLOT_HEIGHT);
  return { max, top: Math.max(0, Math.min(max, Number.isFinite(scrollTop) ? scrollTop : 0)) };
}

/** "+N more": content rows whose centre lies below the visible area. */
export function cardMoreCount(content: number, visible: number, scrollTop: number): number {
  const rows = wholeRows(content);
  const { max, top } = scrollRange(rows, visible, scrollTop);
  if (max - top <= 1) return 0;
  const bottom = top + wholeRows(visible) * LIST_SLOT_HEIGHT;
  const firstBelow = Math.floor(bottom / LIST_SLOT_HEIGHT - 0.5) + 1;
  return Math.max(0, rows - firstBelow);
}

/** Which edges have content scrolled out of view (and so show the fade mask). */
export function cardFades(content: number, visible: number, scrollTop: number): Readonly<{ top: boolean; bottom: boolean }> {
  const { max, top } = scrollRange(content, visible, scrollTop);
  return { top: top > 1, bottom: max - top > 1 };
}

/** The card scroll position that shows content row `offset`, moving minimally. */
export function cardRevealTop(offset: number, visible: number, scrollTop: number): number {
  const top = wholeRows(offset) * LIST_SLOT_HEIGHT;
  const view = wholeRows(visible) * LIST_SLOT_HEIGHT;
  const current = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  if (top < current) return top;
  if (top + LIST_SLOT_HEIGHT > current + view) return Math.max(0, top + LIST_SLOT_HEIGHT - view);
  return current;
}

/** Content rows to mount: those intersecting the visible area plus overscan. */
export function cardWindow(content: number, visible: number, scrollTop: number, overscan = 2): Readonly<{ start: number; end: number }> {
  const rows = wholeRows(content);
  const { top } = scrollRange(rows, visible, scrollTop);
  const start = Math.max(0, Math.floor(top / LIST_SLOT_HEIGHT) - overscan);
  const end = Math.min(rows, Math.ceil((top + wholeRows(visible) * LIST_SLOT_HEIGHT) / LIST_SLOT_HEIGHT) + overscan);
  return { start, end: Math.max(start, end) };
}

/** A vertical wheel over a card scrolls the card until its range end; then
 * (and for Ctrl or horizontal-dominant input) the outer List handles it. */
export function cardWheelConsumes(event: { deltaX: number; deltaY: number; ctrlKey: boolean }, scrollTop: number, maxScroll: number): boolean {
  if (event.ctrlKey || !Number.isFinite(event.deltaY) || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return false;
  return event.deltaY < 0 ? scrollTop > 0.5 : maxScroll - scrollTop > 0.5;
}

/** Session card heights, most recently set last, bounded like the expanded set. */
export function rememberCardRows(heights: ReadonlyMap<string, number>, path: string, rows: number, cap = LIST_CARD_ROWS_CAP): Map<string, number> {
  const next = new Map(heights);
  next.delete(path);
  if (!Number.isFinite(rows) || rows < 1) return next;
  next.set(path, Math.round(rows));
  while (next.size > Math.max(0, cap)) next.delete(next.keys().next().value!);
  return next;
}
