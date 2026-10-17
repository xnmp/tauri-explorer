/**
 * List cards (#1240): an open top-level folder in the column flow is a card of
 * one header slot plus its visible descendant rows. Pure layout, clamp, grip,
 * scroll-edge and reveal policies shared by rendering, keyboard and motion.
 */
import type { PeekRows } from "./folder-peek";
import { columnFlow, LIST_SLOT_HEIGHT, type ListCardSpec, type ListFlowModel, type ListTopItem } from "./list-column-flow";

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

/** A top-level item before sizing: a card's span without its visible rows. */
export type ListStructureItem = Omit<ListTopItem, "card"> & { readonly card: Omit<ListCardSpec, "visibleRows"> | null };

/** The rows-per-column-independent part of the List model, so a resize that
 * changes R re-sizes cards and re-flows, but never rebuilds every item. */
export interface ListStructure {
  readonly items: readonly ListStructureItem[];
  /** Indices of card items (empty while nothing is open). */
  readonly cards: readonly number[];
  readonly rowEntry: ListFlowModel["rowEntry"];
  readonly entryItem: Int32Array;
  readonly entryOffset: Int32Array;
}

/**
 * Top-level items in row order: the creation row, every depth-0 entry and, for an
 * expanded one, a card over its depth-0 group's rows (nested entries and Loading/
 * Empty/Error rows). Any entry row outside a card is a plain top-level item, so
 * every entry always has a slot owner.
 */
export function buildListStructure(rows: PeekRows): ListStructure {
  const entryCount = rows.entryToRow.length;
  const entryItem = new Int32Array(entryCount).fill(-1);
  const entryOffset = new Int32Array(entryCount).fill(-1);
  const groups = new Map(rows.groups.filter(group => group.depth === 0).map(group => [group.path, group]));
  const items: ListStructureItem[] = [];
  const cards: number[] = [];
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
    cards.push(itemIndex);
    items.push({ key: row.key, entryIndex: row.entryIndex, card: { path: row.entry.path, start, end } });
    i = end;
  }
  return { items, cards, rowEntry: rows.rowToEntry, entryItem, entryOffset };
}

/** Sizes a structure's cards for R rows per column and flows it. Plain items are
 * reused as they are (they have no size), so with no open card nothing per item
 * is allocated beyond the flow's placements. A card for which `fitsInPlace`
 * holds (a spring-loaded peek, #1242) shrinks to the rows left in its column,
 * down to its header alone, rather than moving its header to the next column. */
export function sizeListModel(structure: ListStructure, R: number, preferredOf: (path: string) => number | undefined, fitsInPlace?: (path: string) => boolean): ListFlowModel {
  let items: readonly ListTopItem[];
  if (!structure.cards.length) items = structure.items as readonly ListTopItem[]; // every card is null
  else {
    const sized = structure.items.slice() as ListTopItem[];
    for (const index of structure.cards) {
      const item = structure.items[index], span = item.card!;
      sized[index] = { ...item, card: { ...span, visibleRows: cardVisibleRows(span.end - span.start, preferredOf(span.path) ?? LIST_CARD_DEFAULT_ROWS, R) } };
    }
    items = sized;
  }
  const fitting = fitsInPlace && structure.cards.length ? new Set(structure.cards.filter(index => fitsInPlace(items[index].card!.path))) : null;
  const layout = columnFlow(items, R, (item, index) => item.card
    ? { slots: 1 + item.card.visibleRows, card: true, ...(fitting?.has(index) ? { min: 1 } : {}) }
    : { slots: 1, card: false });
  if (fitting?.size) {
    // A shrunk card shows only the rows its placement holds.
    const shrunk = [...fitting].filter(index => layout.byIndex[index].slots !== 1 + items[index].card!.visibleRows);
    if (shrunk.length) {
      const sized = items.slice() as ListTopItem[];
      for (const index of shrunk) sized[index] = { ...items[index], card: { ...items[index].card!, visibleRows: layout.byIndex[index].slots - 1 } };
      items = sized;
    }
  }
  return { layout, items, rowEntry: structure.rowEntry, entryItem: structure.entryItem, entryOffset: structure.entryOffset };
}

export function buildListModel(rows: PeekRows, R: number, preferredOf: (path: string) => number | undefined): ListFlowModel {
  return sizeListModel(buildListStructure(rows), R, preferredOf);
}

/** Grip drag: the start height plus the pointer travel, snapped to whole rows. */
export function gripRows(startRows: number, deltaCss: number, content: number, R: number, limit = Infinity): number {
  return withinLimit(cardVisibleRows(content, startRows + (Number.isFinite(deltaCss) ? deltaCss : 0) / LIST_SLOT_HEIGHT, R), limit);
}

/** Grip keys (separator pattern): one row per arrow, Home/End = min/max. */
export function gripKeyRows(key: string, rows: number, content: number, R: number, limit = Infinity): number | null {
  const max = withinLimit(Math.max(1, Math.min(wholeRows(content), cardMaxRows(R))), limit);
  if (key === "ArrowUp") return withinLimit(cardVisibleRows(content, rows - 1, R), limit);
  if (key === "ArrowDown") return withinLimit(cardVisibleRows(content, rows + 1, R), limit);
  if (key === "Home") return cardVisibleRows(content, 1, R);
  if (key === "End") return withinLimit(cardVisibleRows(content, max, R), limit);
  return null;
}

/** `limit`: the rows left below the card's header in its column, so a grip
 * resize never pushes the card into the next column. */
const withinLimit = (rows: number, limit: number) => Number.isFinite(limit) ? Math.min(rows, Math.max(1, Math.floor(limit))) : rows;

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
