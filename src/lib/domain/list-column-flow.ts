import type { FileEntry } from "./file";
import type { FileListKey, FileListMove } from "./file-list-navigation";

export const LIST_SLOT_HEIGHT = 30;
export const LIST_COLUMN_WIDTH = 260;
export const LIST_COLUMN_GAP = 16;
export const LIST_COLUMN_STRIDE = LIST_COLUMN_WIDTH + LIST_COLUMN_GAP;
export const LIST_PADDING_X = 8;
export const LIST_PADDING_Y = 6;

export type SlotSpec = Readonly<{ slots: number; card: boolean }>;
export type ListPlacement = Readonly<{ index: number; column: number; row: number; slots: number }>;
export interface ColumnFlowLayout {
  readonly rows: number;
  readonly columns: readonly (readonly ListPlacement[])[];
  readonly byIndex: readonly ListPlacement[];
  readonly atSlot: (column: number, row: number) => ListPlacement | undefined;
}

/** Stateless prefix scan. Storage follows entries, never the number of available slots. */
export function columnFlow<T>(items: readonly T[], R: number, slotsOf: (item: T) => SlotSpec): ColumnFlowLayout {
  if (!Number.isSafeInteger(R) || R < 4) throw new RangeError("Rows per column must be an integer >= 4");
  const columns: ListPlacement[][] = [];
  const byIndex: ListPlacement[] = [];
  let column = 0, row = 0;
  items.forEach((item, index) => {
    const spec = slotsOf(item);
    if (!spec || !Number.isSafeInteger(spec.slots) || spec.slots < 1 || spec.slots > R || (!spec.card && spec.slots !== 1)) {
      throw new RangeError("Entries must fit one column; plain items use one slot");
    }
    if (row + spec.slots > R) { column++; row = 0; }
    const placement = { index, column, row, slots: spec.slots };
    (columns[column] ??= []).push(placement);
    byIndex.push(placement);
    row += spec.slots;
    if (row === R) { column++; row = 0; }
  });
  return {
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
  };
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

/** The same placement snapshot is used by rendering, reveal, and keyboard navigation. */
export interface ListNavigationSnapshot {
  readonly entries: readonly FileEntry[];
  readonly directory: string;
  readonly layout: ColumnFlowLayout;
  readonly sentinelOffset: number;
  readonly usableWidth: number;
}

export function resolveListMove(event: FileListKey, layout: ColumnFlowLayout, cursorIndex: number, width: number, offset = 0): FileListMove | null {
  const count = layout.byIndex.length - offset;
  if (event.altKey || !Number.isSafeInteger(cursorIndex) || cursorIndex < -1 || cursorIndex >= count) return null;
  const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
  const endpoint = event.key === "Home" || event.key === "End";
  if (!arrow && !endpoint && !["PageUp", "PageDown"].includes(event.key)) return null;
  if (count <= 0) return { kind: "handled" };
  let target: number;
  if (event.key === "Home") target = offset;
  else if (event.key === "End") target = layout.byIndex.length - 1;
  else if (cursorIndex < 0) target = offset;
  else {
    const current = layout.byIndex[cursorIndex + offset];
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "PageDown";
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      target = current.index + (forward ? 1 : -1);
      if (target < offset || layout.byIndex[target]?.column !== current.column) return { kind: "handled" };
    } else {
      const distance = arrow ? 1 : listPageColumns(width);
      const column = Math.max(0, Math.min(layout.columns.length - 1, current.column + (forward ? distance : -distance)));
      if (column === current.column) return { kind: "handled" };
      const candidates = layout.columns[column].filter(p => p.index >= offset);
      const owner = layout.atSlot(column, current.row);
      target = owner && owner.index >= offset ? owner.index
        : (current.row < (candidates[0]?.row ?? 0) ? candidates[0]?.index : candidates.at(-1)?.index) ?? current.index;
    }
  }
  // Home/End still select and reveal an already-focused endpoint.
  if (!endpoint && target === cursorIndex + offset) return { kind: "handled" };
  return { kind: "focus", index: target - offset, selection: event.shiftKey ? "extend" : (event.ctrlKey || event.metaKey) && arrow ? "preserve" : "replace" };
}
