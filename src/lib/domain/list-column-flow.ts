import type { FileEntry } from "./file";
import type { FileListKey, FileListMove } from "./file-list-navigation";

/** Slot height in CSS px: 30, or 62 with row thumbnails (#1465). A live
 *  binding read at call time, so the flow geometry stays one parameter-free
 *  family: ListColumnsView sets it as it mounts, and FileList remounts that
 *  view when the height changes, so one mount never mixes two heights. */
export let LIST_SLOT_HEIGHT = 30;
export function setListSlotHeight(height: number): void {
  LIST_SLOT_HEIGHT = height;
}
export const LIST_COLUMN_WIDTH = 260;
export const LIST_COLUMN_GAP = 16;
export const LIST_COLUMN_STRIDE = LIST_COLUMN_WIDTH + LIST_COLUMN_GAP;
export const LIST_PADDING_X = 8;
export const LIST_PADDING_Y = 6;

/** `fit`: an item that keeps its place whenever at least `fit` slots are left in
 * its column, a card shrinking to them if it is taller; with fewer left it
 * starts the next column even when it would fit, so the choice does not change
 * as its listing loads. Every open folder's header uses it, whether it heads a
 * card or a spilled/full-flow group, so changing its stage never moves it
 * (#1365). `alone`: an item that `fit` moved to the next column ends that column
 * too, so the rows below it stay empty. Spring-loaded peeks (#1242) use both so
 * the row a drag holds stays under the pointer (`springCardFits`). */
export type SlotSpec = Readonly<{ slots: number; card: boolean; fit?: number; alone?: boolean }>;
export type ListPlacement = Readonly<{ index: number; column: number; row: number; slots: number }>;
export interface ColumnFlowLayout {
  readonly rows: number;
  readonly columns: readonly (readonly ListPlacement[])[];
  readonly byIndex: readonly ListPlacement[];
  readonly atSlot: (column: number, row: number) => ListPlacement | undefined;
}

// Pane minima and preview allocation stay unchanged. Shorter scrollports retain
// four slots and allow vertical scrolling as a degenerate fallback.
export const listRows = (height: number): number => Math.max(4, Math.floor(Number.isFinite(height) ? height / LIST_SLOT_HEIGHT : 0));
export const listPageColumns = (width: number): number => Math.max(1, Math.floor((Math.max(0, Number.isFinite(width) ? width : 0) + LIST_COLUMN_GAP) / LIST_COLUMN_STRIDE));
export const listExtent = (columns: number): number => LIST_PADDING_X * 2 + columns * LIST_COLUMN_WIDTH + Math.max(0, columns - 1) * LIST_COLUMN_GAP;

export function listColumnRange(count: number, left: number, width: number): Readonly<{ start: number; end: number }> {
  if (!count) return { start: 0, end: 0 };
  const clamped = Math.max(0, Math.min(left, Math.max(0, listExtent(count) - width - LIST_PADDING_X * 2)));
  return {
    start: Math.max(0, Math.floor(clamped / LIST_COLUMN_STRIDE) - 2),
    end: Math.min(count, Math.ceil((clamped + width) / LIST_COLUMN_STRIDE) + 2),
  };
}

export interface WheelStep { readonly consume: boolean; readonly apply: number; readonly carry: number }
const PASS: WheelStep = { consume: false, apply: 0, carry: 0 };

/**
 * Maps vertical wheel input to horizontal scrolling in whole pixels. Browsers
 * round scrollLeft writes per direction, so sub-pixel deltas are accumulated in
 * `carry` and applied symmetrically. Horizontal-dominant gestures, Ctrl-wheel
 * and input that cannot move the viewport are left to the browser (native
 * momentum, zoom, scroll chaining).
 */
export function listWheelStep(
  event: { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean },
  width: number,
  carry: number,
  position: { scrollLeft: number; max: number },
): WheelStep {
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return PASS;
  const delta = event.deltaY * (event.deltaMode === 1 ? LIST_SLOT_HEIGHT : event.deltaMode === 2 ? width : 1);
  if (!Number.isFinite(delta) || delta === 0) return PASS;
  if ((delta < 0 && position.scrollLeft <= 0) || (delta > 0 && position.scrollLeft >= position.max)) return PASS;
  const total = (carry * delta < 0 ? 0 : carry) + delta;
  const apply = Math.trunc(total) || 0; // normalises -0
  return { consume: true, apply, carry: total - apply };
}

/** One column-slot owner: an entry, a status/creation row, or a compact card. */
export interface ListTopItem {
  /** Stable identity across layouts (the row-model key). */
  readonly key: string;
  /** The entry's index; null for status and creation rows. */
  readonly entryIndex: number | null;
  /** Peek row identity for a full-flow status slot (no selectable entry). */
  readonly rowIndex?: number;
  /** Present for an open top-level folder. */
  readonly card: ListCardSpec | null;
  /** The last slot of a spilled folder (#1365): `count` of its rows are hidden
   * until "+N more" moves the folder to full flow. */
  readonly more?: ListSpillMore;
}
export interface ListSpillMore {
  readonly path: string;
  readonly count: number;
  /** Peek row of the first hidden row (the one that takes this slot in full flow). */
  readonly rowIndex: number;
}
export interface ListCardSpec {
  readonly path: string;
  /** Its descendant rows are `rows[start, end)` of the peek row model. */
  readonly start: number;
  readonly end: number;
  readonly visibleRows: number;
}
/** Column flow over top-level items plus the entry -> slot owner maps that
 * rendering, reveal and keyboard moves share (built by `buildListModel`). */
export interface ListFlowModel {
  readonly layout: ColumnFlowLayout;
  readonly items: readonly ListTopItem[];
  /** Entry index of each row-model row (null for pseudo and creation rows). */
  readonly rowEntry: readonly (number | null)[];
  /** Entry index -> top-level item index, or -1 for a row a spill hides. */
  readonly entryItem: Int32Array;
  /** Entry index -> offset within its compact card, or -1 for an ordinary slot. */
  readonly entryOffset: Int32Array;
}

/** The same placement snapshot is used by rendering, reveal, and keyboard navigation. */
export interface ListNavigationSnapshot {
  readonly entries: readonly FileEntry[];
  readonly directory: string;
  readonly model: ListFlowModel;
  readonly usableWidth: number;
  /** Current scroll offset (CSS px) of an open card's content. */
  readonly cardScrollTop: (path: string) => number;
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0);
const clampIndex = (value: number, max: number) => Math.max(0, Math.min(max, value));

/** The on-screen row of an entry: card content rows sit where the card's
 * scroll currently shows them (clamped to its visible area). */
function visualRow(model: ListFlowModel, entry: number, scrollTopOf: (path: string) => number): number {
  const itemIndex = model.entryItem[entry];
  const placement = model.layout.byIndex[itemIndex];
  const card = model.items[itemIndex].card;
  const offset = model.entryOffset[entry];
  if (!card || offset < 0) return placement.row;
  const slot = Math.floor((offset * LIST_SLOT_HEIGHT - finite(scrollTopOf(card.path)) + LIST_SLOT_HEIGHT / 2) / LIST_SLOT_HEIGHT);
  return placement.row + 1 + clampIndex(slot, Math.max(0, card.visibleRows - 1));
}

/** The entry drawn at (column, row): a card slot maps through the card's scroll
 * to its nearest entry row; rows past a shorter column clamp to its end. */
function entryAtSlot(model: ListFlowModel, column: number, row: number, scrollTopOf: (path: string) => number): number | null {
  const spans = model.layout.columns[column];
  if (!spans?.length) return null;
  const last = spans[spans.length - 1];
  const clamped = Math.min(row, last.row + last.slots - 1);
  const owner = model.layout.atSlot(column, clamped) ?? last;
  const item = model.items[owner.index];
  if (item.entryIndex === null) {
    // Creation/status rows hold a slot but cannot be selected. Choose the
    // nearest entry in this column rather than jumping to its first entry.
    const nearest = spans.filter(span => model.items[span.index].entryIndex !== null)
      .reduce<ListPlacement | undefined>((best, span) => !best || Math.abs(span.row - clamped) < Math.abs(best.row - clamped) ? span : best, undefined);
    return nearest ? model.items[nearest.index].entryIndex : null;
  }
  const card = item.card;
  if (!card || clamped === owner.row || card.visibleRows <= 0) return item.entryIndex;
  const content = card.end - card.start;
  const k = clampIndex(Math.floor(((clamped - owner.row - 1) * LIST_SLOT_HEIGHT + LIST_SLOT_HEIGHT / 2 + finite(scrollTopOf(card.path))) / LIST_SLOT_HEIGHT), content - 1);
  for (let d = 0; d < content; d++) {
    for (const candidate of d ? [k - d, k + d] : [k]) {
      const entry = candidate >= 0 && candidate < content ? model.rowEntry[card.start + candidate] : null;
      if (entry !== null && entry !== undefined) return entry;
    }
  }
  return item.entryIndex;
}

/**
 * List keys keep their visual meaning. Up/Down step through the column's entries,
 * including a card's descendants, and stop at its ends; Left/Right/Page keys move
 * to the same on-screen row of another column; Home/End select the first/last entry.
 */
export function resolveListMove(event: FileListKey, model: ListFlowModel, cursorIndex: number, width: number,
  scrollTopOf: (path: string) => number = () => 0): FileListMove | null {
  const count = model.entryItem.length;
  if (event.altKey || !Number.isSafeInteger(cursorIndex) || cursorIndex < -1 || cursorIndex >= count) return null;
  const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
  const endpoint = event.key === "Home" || event.key === "End";
  if (!arrow && !endpoint && !["PageUp", "PageDown"].includes(event.key)) return null;
  if (count <= 0) return { kind: "handled" };
  const columnOf = (entry: number) => model.layout.byIndex[model.entryItem[entry]]?.column;
  let target: number;
  if (event.key === "Home") target = 0;
  else if (event.key === "End") {
    // A spill can hide the last entries; End selects the last one shown.
    target = count - 1;
    while (target > 0 && model.entryItem[target] < 0) target--;
  }
  else if (cursorIndex < 0) target = 0;
  else {
    const column = columnOf(cursorIndex);
    if (column === undefined) {
      // A cursor a spill hid (#1365) resumes on the nearest row shown before it.
      let shown = cursorIndex;
      while (shown > 0 && model.entryItem[shown] < 0) shown--;
      return model.entryItem[shown] < 0 ? null
        : { kind: "focus", index: shown, selection: event.shiftKey ? "extend" : "replace" };
    }
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "PageDown";
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      target = cursorIndex + (forward ? 1 : -1);
      if (target < 0 || target >= count || columnOf(target) !== column) return { kind: "handled" };
    } else {
      const distance = arrow ? 1 : listPageColumns(width);
      const next = Math.max(0, Math.min(model.layout.columns.length - 1, column + (forward ? distance : -distance)));
      if (next === column) return { kind: "handled" };
      target = entryAtSlot(model, next, visualRow(model, cursorIndex, scrollTopOf), scrollTopOf) ?? cursorIndex;
    }
  }
  // Home/End still select and reveal an already-focused endpoint.
  if (!endpoint && target === cursorIndex) return { kind: "handled" };
  return { kind: "focus", index: target, selection: event.shiftKey ? "extend" : (event.ctrlKey || event.metaKey) && arrow ? "preserve" : "replace" };
}
