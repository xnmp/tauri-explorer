/**
 * List cards (#1240): an open top-level folder in the column flow is a card of
 * one header slot plus its visible descendant rows. Pure layout, clamp, grip,
 * scroll-edge and reveal policies shared by rendering, keyboard and motion.
 */
import type { PeekRows } from "./folder-peek";
import { columnFlow, LIST_COLUMN_GAP, LIST_COLUMN_STRIDE, LIST_COLUMN_WIDTH, LIST_SLOT_HEIGHT, type ListCardSpec, type ListFlowModel, type ListTopItem, type ListPlacement } from "./list-column-flow";

export const LIST_CARD_DEFAULT_ROWS = 6;
/** Scroll-edge fade mask height (CSS px). */
export const LIST_CARD_FADE = 28;
/** Card heights remembered per pane, like the expanded set's cap. */
export const LIST_CARD_ROWS_CAP = 500;

const wholeRows = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/** A compact, grip-sized card takes at most 70% of a column. */
export const cardMaxRows = (R: number): number => Math.max(1, Math.floor(0.7 * (Number.isFinite(R) ? R : 4)));

/** Visible rows = min(content, preferred) with preferred clamped to 1..floor(0.7R);
 * 0 only while the folder has produced no row yet (a header-only card). */
export function cardVisibleRows(content: number, preferred: number, R: number): number {
  const rows = wholeRows(content);
  const wanted = Number.isFinite(preferred) ? Math.round(preferred) : LIST_CARD_DEFAULT_ROWS;
  return Math.min(rows, Math.max(1, Math.min(wanted, cardMaxRows(R))));
}

/** More first fills one column when the descendants would overflow it. A
 * second More releases the group into the ordinary multi-column flow. */
export function listMoreExpansion(content: number, R: number, column: boolean): "column" | "full" {
  return !column && wholeRows(content) > columnCardRows(R) ? "column" : "full";
}

const columnCardRows = (R: number): number => Math.max(1, (Number.isFinite(R) ? Math.floor(R) : 4) - 1);

/** The column stage includes its folder header in the column's height. */
export function listCardVisibleRows(content: number, preferred: number, R: number, column: boolean): number {
  return column ? Math.min(wholeRows(content), columnCardRows(R)) : cardVisibleRows(content, preferred, R);
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
 * every entry always has a slot owner. Explicit full-flow groups emit their
 * descendants, with depth and status identities intact, as ordinary slots.
 */
export function buildListStructure(rows: PeekRows, fullFlowPaths: ReadonlySet<string> = new Set()): ListStructure {
  const entryCount = rows.entryToRow.length;
  const entryItem = new Int32Array(entryCount).fill(-1);
  const entryOffset = new Int32Array(entryCount).fill(-1);
  const groups = new Map(rows.groups.filter(group => group.depth === 0).map(group => [group.path, group]));
  const items: ListStructureItem[] = [];
  const cards: number[] = [];
  // Open full-flow groups by end row: a group's run is followed by its Less
  // control, so the scrollable column stays reachable from the run's far end
  // after its header has scrolled away (#1329).
  const lessAt = new Map<number, Readonly<{ path: string; entryIndex: number }>>();
  for (let i = 0; i < rows.rows.length;) {
    const less = lessAt.get(i);
    if (less !== undefined) { lessAt.delete(i); items.push({ key: `less:${less.path}`, entryIndex: null, lessFor: less, card: null }); }
    const row = rows.rows[i];
    if (row.kind === "create") { items.push({ key: row.key, entryIndex: null, card: null }); i++; continue; }
    if (row.kind === "peek-state") {
      items.push({ key: row.key, entryIndex: null, rowIndex: i, card: null }); i++; continue;
    }
    const itemIndex = items.length;
    entryItem[row.entryIndex] = itemIndex;
    const top = row.depth === 0 && row.expanded ? groups.get(row.entry.path) : undefined;
    const group = top && top.startRow === i + 1 ? top : undefined;
    if (group && fullFlowPaths.has(row.entry.path)) {
      if (group.endRow > group.startRow) lessAt.set(Math.min(rows.rows.length, group.endRow), { path: row.entry.path, entryIndex: row.entryIndex });
      items.push({ key: row.key, entryIndex: row.entryIndex, card: null }); i++; continue;
    }
    if (!group) { items.push({ key: row.key, entryIndex: row.entryIndex, card: null }); i++; continue; }
    const start = group.startRow, end = Math.max(start, Math.min(rows.rows.length, group.endRow));
    for (let j = start; j < end; j++) {
      const entry = rows.rowToEntry[j];
      if (entry !== null && entry !== undefined) { entryItem[entry] = itemIndex; entryOffset[entry] = j - start; }
    }
    cards.push(itemIndex);
    items.push({ key: row.key, entryIndex: row.entryIndex, card: { path: row.entry.path, start, end } });
    i = end;
  }
  for (const less of lessAt.values()) items.push({ key: `less:${less.path}`, entryIndex: null, lessFor: less, card: null });
  return { items, cards, rowEntry: rows.rowToEntry, entryItem, entryOffset };
}

/** A List lineage guide's x offset within its column (CSS px): centred under
 * its folder's caret, or with carets off its folder icon, 16px per level. */
export const listGuideLeft = (depth: number, carets: boolean): number => (carets ? 17.25 : 18.25) + Math.max(0, depth) * 16;

/** Lineage guides in full flow (a top-level group's and every nested one's,
 * as in Details, #1330) span ordinary items and split at each column. */
export interface ListFlowGuideSpan {
  readonly path: string;
  readonly depth: number;
  readonly first: ListPlacement;
  readonly last: ListPlacement;
}
export interface ListFlowGuide {
  readonly path: string;
  readonly depth: number;
  readonly column: number;
  readonly top: number;
  readonly height: number;
}

/** Build once per model, never during a horizontal scroll. Compact descendants
 * have no own slot and therefore cannot acquire a second guide here; a compact
 * card draws its own (ListCard). */
export function fullFlowGuideSpans(rows: PeekRows, model: ListFlowModel): readonly ListFlowGuideSpan[] {
  const rowItem = new Int32Array(rows.rows.length).fill(-1);
  model.items.forEach((item, index) => {
    const row = item.entryIndex === null ? item.rowIndex : rows.entryToRow[item.entryIndex];
    if (row !== undefined) rowItem[row] = index;
  });
  return rows.groups.flatMap(group => {
    if (group.endRow <= group.startRow) return [];
    const first = rowItem[group.startRow], last = rowItem[group.endRow - 1];
    if (first < 0 || last < 0) return [];
    return [{ path: group.path, depth: group.depth, first: model.layout.byIndex[first], last: model.layout.byIndex[last] }];
  });
}

/** Only mounted columns get guide DOM, including pinned editor columns. */
export function fullFlowGuideSegments(spans: readonly ListFlowGuideSpan[], columns: readonly number[], R: number): readonly ListFlowGuide[] {
  return spans.flatMap(span => columns.flatMap(column => {
    if (column < span.first.column || column > span.last.column) return [];
    const start = column === span.first.column ? span.first.row : 0;
    const end = column === span.last.column ? span.last.row + span.last.slots : R;
    return [{ path: span.path, depth: span.depth, column, top: start * LIST_SLOT_HEIGHT - 3, height: (end - start) * LIST_SLOT_HEIGHT - 5 }];
  }));
}

/** A card's `fit` and `alone` (`SlotSpec`). */
export type ListCardFit = Readonly<{ fit: number; alone?: boolean }>;

/** Sizes a structure's cards for R rows per column and flows it. Plain items are
 * reused as they are (they have no size), so with no open card nothing per item
 * is allocated beyond the flow's placements. `fitOf` gives a card a `fit`
 * (`SlotSpec`): it keeps its place while that many slots are left in its column,
 * shrinking to the rows left there (`springCardFits`). */
export function sizeListModel(structure: ListStructure, R: number, preferredOf: (path: string) => number | undefined, fitOf?: (path: string) => ListCardFit | undefined, columnPaths: ReadonlySet<string> = new Set()): ListFlowModel {
  let items: readonly ListTopItem[];
  if (!structure.cards.length) items = structure.items as readonly ListTopItem[]; // every card is null
  else {
    const sized = structure.items.slice() as ListTopItem[];
    for (const index of structure.cards) {
      const item = structure.items[index], span = item.card!;
      sized[index] = { ...item, card: { ...span, visibleRows: listCardVisibleRows(span.end - span.start, preferredOf(span.path) ?? LIST_CARD_DEFAULT_ROWS, R, columnPaths.has(span.path)) } };
    }
    items = sized;
  }
  const fits = fitOf && structure.cards.length ? new Map(structure.cards.flatMap(index => {
    const fit = fitOf(items[index].card!.path);
    return fit === undefined ? [] : [[index, fit] as const];
  })) : null;
  const layout = columnFlow(items, R, (item, index) => item.card
    ? { slots: 1 + item.card.visibleRows, card: true, ...fits?.get(index) }
    : { slots: 1, card: false });
  if (fits?.size) {
    // A shrunk card shows only the rows its placement holds.
    const shrunk = [...fits.keys()].filter(index => layout.byIndex[index].slots !== 1 + items[index].card!.visibleRows);
    if (shrunk.length) {
      const sized = items.slice() as ListTopItem[];
      for (const index of shrunk) sized[index] = { ...items[index], card: { ...items[index].card!, visibleRows: layout.byIndex[index].slots - 1 } };
      items = sized;
    }
  }
  return { layout, items, rowEntry: structure.rowEntry, entryItem: structure.entryItem, entryOffset: structure.entryOffset };
}

/** Slots a drag's own temporary card needs left in its column to open in place:
 * its header and two rows. */
export const SPRING_CARD_FIT = 3;

/**
 * Spring-loaded peeks (#1242) never move the row a drag holds. A top-level card
 * holding a temporary peek below its header keeps the column it had without it:
 * its `fit` is the slots it took then, so it wraps exactly when it wrapped, and
 * in place it shrinks to the rows left in its column. A temporary card opens in
 * place too, unless fewer than two of its rows would show there: then it starts
 * the next column as a user card would (`SPRING_CARD_FIT`) and ends it
 * (`alone`), bridged from the slot it left over empty space only
 * (`springWrapBridges`). Undefined while no temporary peek is open in a card.
 */
export function springCardFits(structure: ListStructure, rows: PeekRows, temporary: readonly string[], R: number,
  preferredOf: (path: string) => number | undefined, columnPaths: ReadonlySet<string> = new Set()): ((path: string) => ListCardFit | undefined) | undefined {
  if (!temporary.length || !structure.cards.length) return undefined;
  const open = new Set(temporary);
  // Temporary subtrees, outer first; nested ones lie inside an earlier span.
  const spans = rows.groups.filter(group => open.has(group.path)).sort((a, b) => a.startRow - b.startRow);
  const fits = new Map<string, ListCardFit>();
  for (const index of structure.cards) {
    const card = structure.items[index].card!;
    if (open.has(card.path)) { fits.set(card.path, { fit: SPRING_CARD_FIT, alone: true }); continue; }
    let held = false, hidden = 0, end = card.start;
    for (const span of spans) {
      // A span starts the row after its folder's, which must lie in the card.
      if (span.startRow <= card.start || span.startRow > card.end || span.startRow < end) continue;
      held = true;
      end = Math.min(span.endRow, card.end);
      hidden += end - span.startRow;
    }
    if (held) fits.set(card.path, { fit: 1 + listCardVisibleRows(card.end - card.start - hidden, preferredOf(card.path) ?? LIST_CARD_DEFAULT_ROWS, R, columnPaths.has(card.path)) });
  }
  return fits.size ? path => fits.get(path) : undefined;
}

/** A transparent canvas region (CSS px) that counts as inside a temporary peek. */
export interface ListSpringBridge { readonly path: string; readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/**
 * Bridges for temporary cards that started the next column. The folder's
 * vacated rows and the column gap beside them, the rows below the card in its
 * new column, and the gap channel up to the card count as inside the peek, so
 * the wrap does not close it under a pointer still on the folder's old slot.
 * The band spans both columns, so revealing the card (the least sideways scroll
 * that shows its column) leaves the pointer inside it or on the card.
 */
export function springWrapBridges(model: ListFlowModel, temporary: readonly string[]): readonly ListSpringBridge[] {
  if (!temporary.length) return [];
  const R = model.layout.rows;
  const bridges: ListSpringBridge[] = [];
  model.items.forEach((item, index) => {
    if (!item.card || index === 0 || !temporary.includes(item.card.path)) return;
    const placement = model.layout.byIndex[index], previous = model.layout.byIndex[index - 1];
    const vacated = previous.row + previous.slots;
    if (placement.row !== 0 || previous.column !== placement.column - 1 || vacated >= R) return;
    const path = item.card.path, column = previous.column, below = Math.max(vacated, placement.slots);
    const x = column * LIST_COLUMN_STRIDE;
    bridges.push({ path, left: x, top: vacated * LIST_SLOT_HEIGHT, width: LIST_COLUMN_STRIDE, height: (R - vacated) * LIST_SLOT_HEIGHT });
    if (below < R) bridges.push({ path, left: x + LIST_COLUMN_STRIDE, top: below * LIST_SLOT_HEIGHT, width: LIST_COLUMN_WIDTH, height: (R - below) * LIST_SLOT_HEIGHT });
    bridges.push({ path, left: x + LIST_COLUMN_WIDTH, top: 0, width: LIST_COLUMN_GAP, height: vacated * LIST_SLOT_HEIGHT });
  });
  return bridges;
}

/** Whether temporary card `path` started the next column (and is revealed). */
export const springCardWrapped = (bridges: readonly ListSpringBridge[], path: string): boolean => bridges.some(bridge => bridge.path === path);

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
