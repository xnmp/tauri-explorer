/**
 * List cards (#1240): an open top-level folder in the column flow is a card of
 * one header slot plus its visible descendant rows. Pure layout, clamp, grip,
 * scroll-edge and reveal policies shared by rendering, keyboard and motion.
 */
import type { PeekRows } from "./folder-peek";
import { LIST_COLUMN_GAP, LIST_COLUMN_STRIDE, LIST_COLUMN_WIDTH, LIST_SLOT_HEIGHT, type ColumnFlowLayout, type ListCardSpec, type ListFlowModel, type ListTopItem, type ListPlacement, type SlotSpec } from "./list-column-flow";

// The column flow lives with its only production caller, outside the startup
// graph (list-column-flow.ts is eager through keyboard navigation).
/** An incremental column flow: `place` appends one item and returns its
 * placement at once, so a caller can decide what follows from where an item
 * landed (a List spill's cap, #1365) in the same single pass. */
export interface ColumnFlowCursor {
  place(spec: SlotSpec): ListPlacement;
  layout(): ColumnFlowLayout;
}

export function columnFlowCursor(R: number): ColumnFlowCursor {
  if (!Number.isSafeInteger(R) || R < 4) throw new RangeError("Rows per column must be an integer >= 4");
  const columns: ListPlacement[][] = [];
  const byIndex: ListPlacement[] = [];
  let column = 0, row = 0;
  return {
    place(spec) {
      if (!spec || !Number.isSafeInteger(spec.slots) || spec.slots < 1 || spec.slots > R || (!spec.card && spec.slots !== 1)) {
        throw new RangeError("Entries must fit one column; plain items use one slot");
      }
      let slots = spec.slots, alone = false;
      const fit = spec.fit !== undefined && Number.isSafeInteger(spec.fit) && spec.fit >= 1 ? spec.fit : null;
      if (fit !== null) {
        if (row > 0 && R - row < fit) { column++; row = 0; alone = spec.alone === true; }
        slots = Math.min(slots, R - row);
      } else if (row + slots > R) { column++; row = 0; }
      const placement = { index: byIndex.length, column, row, slots };
      (columns[column] ??= []).push(placement);
      byIndex.push(placement);
      row += slots;
      if (row === R || alone) { column++; row = 0; }
      return placement;
    },
    layout: () => ({
      rows: R, columns, byIndex,
      atSlot: (column, row) => {
        if (!Number.isSafeInteger(column) || !Number.isSafeInteger(row) || row < 0 || row >= R) return undefined;
        const spans = columns[column];
        if (!spans) return undefined;
        let low = 0, high = spans.length;
        while (low < high) {
          const mid = Math.floor((low + high) / 2);
          if (spans[mid].row + spans[mid].slots <= row) low = mid + 1;
          else high = mid;
        }
        const span = spans[low];
        return span && span.row <= row ? span : undefined;
      },
    }),
  };
}

/** Stateless prefix scan. Storage follows entries, never the number of available slots. */
export function columnFlow<T>(items: readonly T[], R: number, slotsOf: (item: T, index: number) => SlotSpec): ColumnFlowLayout {
  const cursor = columnFlowCursor(R);
  items.forEach((item, index) => cursor.place(slotsOf(item, index)));
  return cursor.layout();
}

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

/** Where "+N more" leads (#1365): the compact card spills its rows into the
 * column flow below its header; the spill's own "+N more" slot (and the legacy
 * scrollable column's) releases every row into full flow. */
export function listMoreExpansion(stage: "card" | "column" | "spill" | "full"): "spill" | "full" {
  return stage === "card" ? "spill" : "full";
}

/** Slots a spilled folder's rows may take (#1365), its "+N more" slot included:
 * the rest of its header's column plus the whole next column, or only the next
 * column for a header on the last row. Wholly derived from R and the header's
 * row, so it must be computed while flowing, never in `buildListStructure`. */
export function listSpillCap(R: number, headerRow: number): number {
  return 2 * R - 1 - Math.max(0, Math.min(R - 1, headerRow | 0));
}

/** How a spilled group of `content` rows is cut at `cap` slots: the rows shown,
 * and the rows a final "+N more" slot stands for (0: everything fits, no slot). */
export function listSpillCut(content: number, cap: number): Readonly<{ shown: number; hidden: number }> {
  const rows = wholeRows(content), slots = Math.max(1, wholeRows(cap));
  return rows <= slots ? { shown: rows, hidden: 0 } : { shown: slots - 1, hidden: rows - (slots - 1) };
}

const columnCardRows = (R: number): number => Math.max(1, (Number.isFinite(R) ? Math.floor(R) : 4) - 1);

/** The column stage includes its folder header in the column's height. */
export function listCardVisibleRows(content: number, preferred: number, R: number, column: boolean): number {
  return column ? Math.min(wholeRows(content), columnCardRows(R)) : cardVisibleRows(content, preferred, R);
}

/** A top-level item before sizing: a card's span without its visible rows. */
export type ListStructureItem = Omit<ListTopItem, "card"> & { readonly card: Omit<ListCardSpec, "visibleRows"> | null };

/** An open top-level folder whose rows are ordinary slots: items
 * `[start, end)` follow its plain `header` item. A `spill` group is cut to
 * `listSpillCap` slots while flowing (#1365); a full-flow group never is. */
export interface ListFlowGroup {
  readonly path: string;
  readonly header: number;
  readonly start: number;
  readonly end: number;
  /** Peek row of item `start`: each item of the group owns one row, in order. */
  readonly startRow: number;
  readonly spill: boolean;
}

/** The rows-per-column-independent part of the List model, so a resize that
 * changes R re-sizes cards and re-flows, but never rebuilds every item. */
export interface ListStructure {
  readonly items: readonly ListStructureItem[];
  /** Indices of card items (empty while nothing is open). */
  readonly cards: readonly number[];
  /** Spilled and full-flow groups, in item order. */
  readonly flows: readonly ListFlowGroup[];
  readonly rowEntry: ListFlowModel["rowEntry"];
  readonly entryItem: Int32Array;
  readonly entryOffset: Int32Array;
}

/**
 * Top-level items in row order: the creation row, every depth-0 entry and, for an
 * expanded one, a card over its depth-0 group's rows (nested entries and Loading/
 * Empty/Error rows). Any entry row outside a card is a plain top-level item, so
 * every entry always has a slot owner. Full-flow and spilled groups emit their
 * descendants, with depth and status identities intact, as ordinary slots.
 */
export function buildListStructure(rows: PeekRows, fullFlowPaths: ReadonlySet<string> = new Set(), spillPaths: ReadonlySet<string> = new Set()): ListStructure {
  const entryCount = rows.entryToRow.length;
  const entryItem = new Int32Array(entryCount).fill(-1);
  const entryOffset = new Int32Array(entryCount).fill(-1);
  const groups = new Map(rows.groups.filter(group => group.depth === 0).map(group => [group.path, group]));
  const items: ListStructureItem[] = [];
  const cards: number[] = [];
  const flows: ListFlowGroup[] = [];
  let flow: { path: string; header: number; startRow: number; endRow: number; spill: boolean } | null = null;
  const closeFlow = () => {
    if (flow) flows.push({ path: flow.path, header: flow.header, start: flow.header + 1, end: items.length, startRow: flow.startRow, spill: flow.spill });
    flow = null;
  };
  for (let i = 0; i < rows.rows.length;) {
    const row = rows.rows[i];
    if (flow && (i >= flow.endRow || (row.kind === "entry" && row.depth === 0))) closeFlow();
    if (row.kind === "create") { items.push({ key: row.key, entryIndex: null, card: null }); i++; continue; }
    if (row.kind === "peek-state") {
      items.push({ key: row.key, entryIndex: null, rowIndex: i, card: null }); i++; continue;
    }
    const itemIndex = items.length;
    entryItem[row.entryIndex] = itemIndex;
    const group = row.depth === 0 && row.expanded ? groups.get(row.entry.path) : undefined;
    const flowing = fullFlowPaths.has(row.entry.path) || spillPaths.has(row.entry.path);
    if (!group || group.startRow !== i + 1 || flowing) {
      items.push({ key: row.key, entryIndex: row.entryIndex, card: null });
      if (group && group.startRow === i + 1 && flowing) {
        flow = { path: row.entry.path, header: itemIndex, startRow: i + 1, endRow: Math.min(rows.rows.length, group.endRow), spill: spillPaths.has(row.entry.path) && !fullFlowPaths.has(row.entry.path) };
      }
      i++; continue;
    }
    const start = group.startRow, end = Math.max(start, Math.min(rows.rows.length, group.endRow));
    for (let j = start; j < end; j++) {
      const entry = rows.rowToEntry[j];
      if (entry !== null && entry !== undefined) { entryItem[entry] = itemIndex; entryOffset[entry] = j - start; }
    }
    cards.push(itemIndex);
    items.push({ key: row.key, entryIndex: row.entryIndex, card: { path: row.entry.path, start, end } });
    i = end;
  }
  closeFlow();
  return { items, cards, flows, rowEntry: rows.rowToEntry, entryItem, entryOffset };
}

/** Nested guides in full flow span ordinary items and split at each column. */
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
 * have no own slot and therefore cannot acquire a second guide here. */
export function fullFlowGuideSpans(rows: PeekRows, model: ListFlowModel): readonly ListFlowGuideSpan[] {
  const rowItem = new Int32Array(rows.rows.length).fill(-1);
  model.items.forEach((item, index) => {
    const row = item.entryIndex === null ? item.rowIndex : rows.entryToRow[item.entryIndex];
    if (row !== undefined) rowItem[row] = index;
  });
  return rows.groups.flatMap(group => {
    if (group.depth === 0 || group.endRow <= group.startRow) return [];
    const first = rowItem[group.startRow];
    if (first < 0) return [];
    // A spill can cut a nested group (#1365): its guide closes at the last row
    // shown rather than reaching into hidden rows. A group the cut hides from
    // its first row has no guide at all.
    let lastRow = Math.min(rows.rows.length, group.endRow) - 1;
    while (lastRow > group.startRow && rowItem[lastRow] < 0) lastRow--;
    const last = rowItem[lastRow];
    if (last < 0) return [];
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

/** Slots an open folder needs left in its column to open in place (#1242,
 * #1365): its header and two rows. With fewer left it starts the next column;
 * in place it shrinks to the rows left there. */
export const SPRING_CARD_FIT = 3;

/** Every open folder's header keeps its place across stages and listing loads. */
const OPEN_FIT: ListCardFit = { fit: SPRING_CARD_FIT };

/** Sizes a structure's cards for R rows per column and flows it. Plain items are
 * reused as they are (they have no size), so with no open folder nothing per
 * item is allocated beyond the flow's placements. Every open folder's header —
 * a card's, or a spilled or full-flow group's — keeps its place while
 * `SPRING_CARD_FIT` slots are left in its column, a card shrinking to the rows
 * left there (#1365), except the legacy scrollable column, which still wraps
 * whole. `fitOf` overrides a card's fit (`springCardFits`). A
 * spilled group is cut to `listSpillCap` for the row its header lands on, with
 * a final "+N more" item for the rows it hides. */
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
  const headers = structure.flows.length ? new Set(structure.flows.map(flow => items[flow.header].key)) : null;
  // The legacy scrollable column (#1324) still fills a whole column: no fit.
  const specOf = (item: ListTopItem): SlotSpec => item.card
    ? { slots: 1 + item.card.visibleRows, card: true, ...(fitOf?.(item.card.path) ?? (columnPaths.has(item.card.path) ? null : OPEN_FIT)) }
    : headers?.has(item.key) ? { slots: 1, card: false, ...OPEN_FIT } : { slots: 1, card: false };
  let { entryItem } = structure, layout: ColumnFlowLayout;
  if (structure.flows.some(flow => flow.spill)) ({ items, entryItem, layout } = cutSpills(items, structure, R, specOf));
  else layout = columnFlow(items, R, specOf);
  if (structure.cards.length) {
    // A shrunk card shows only the rows its placement holds.
    let sized: ListTopItem[] | null = null;
    items.forEach((item, index) => {
      const slots = layout.byIndex[index].slots;
      if (!item.card || slots === 1 + item.card.visibleRows) return;
      sized ??= items.slice() as ListTopItem[];
      sized[index] = { ...item, card: { ...item.card, visibleRows: slots - 1 } };
    });
    if (sized) items = sized;
  }
  return { layout, items, rowEntry: structure.rowEntry, entryItem, entryOffset: structure.entryOffset };
}

/** Cuts each spilled group, in order, to the cap for the row its header lands
 * on, flowing as it goes: one pass, since a header's row depends only on the
 * (already cut) items before it. Hidden rows lose their slot owner (-1). */
function cutSpills(items: readonly ListTopItem[], structure: ListStructure, R: number, specOf: (item: ListTopItem) => SlotSpec) {
  const spills = new Map(structure.flows.filter(flow => flow.spill).map(flow => [flow.header, flow]));
  const out: ListTopItem[] = [];
  const moved = new Int32Array(items.length).fill(-1);
  const flow = columnFlowCursor(R);
  const push = (item: ListTopItem, from: number) => {
    if (from >= 0) moved[from] = out.length;
    out.push(item);
    return flow.place(specOf(item));
  };
  for (let index = 0; index < items.length;) {
    const spill = spills.get(index);
    const header = push(items[index], index);
    if (!spill) { index++; continue; }
    const { shown, hidden } = listSpillCut(spill.end - spill.start, listSpillCap(R, header.row));
    for (let child = spill.start; child < spill.start + shown; child++) push(items[child], child);
    if (hidden) push({ key: `more:${spill.path}`, entryIndex: null, card: null, more: { path: spill.path, count: hidden, rowIndex: spill.startRow + shown } }, -1);
    index = spill.end;
  }
  const entryItem = structure.entryItem.map(old => old < 0 ? -1 : moved[old]);
  return { items: out as readonly ListTopItem[], entryItem, layout: flow.layout() };
}

/**
 * Spring-loaded peeks (#1242) never move the row a drag holds. Every open
 * folder's header already keeps its place (`SPRING_CARD_FIT` in
 * `sizeListModel`), so a card holding a temporary peek below its header neither
 * wraps nor moves; it shrinks to the rows left in its column. A temporary card
 * that starts the next column also ends it (`alone`), bridged from the slot it
 * left over empty space only (`springWrapBridges`). Undefined while no
 * temporary card is open.
 */
export function springCardFits(structure: ListStructure, temporary: readonly string[]): ((path: string) => ListCardFit | undefined) | undefined {
  if (!temporary.length || !structure.cards.length) return undefined;
  const open = new Set(temporary);
  const fits = new Map<string, ListCardFit>();
  for (const index of structure.cards) {
    const card = structure.items[index].card!;
    if (open.has(card.path)) fits.set(card.path, { fit: SPRING_CARD_FIT, alone: true });
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
