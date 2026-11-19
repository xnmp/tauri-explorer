/**
 * Live drag-reorder geometry for the window tab strip (#1749).
 *
 * While a tab is dragged, the strip resolves an insertion index from the
 * pointer and the tabs' resting slots (captured once at drag start, in the
 * scroller's content coordinates), then moves the tabs between the dragged
 * tab's slot and that index aside by the dragged tab's width. The dragged tab
 * itself stands at the insertion position as a placeholder. The slots never
 * follow the displacement, so a pointer resting on a moving tab cannot make
 * the target oscillate.
 */

/** A tab's resting box along the strip (CSS px, content coordinates). */
export interface TabSlot {
  readonly left: number;
  readonly width: number;
}

/**
 * The index the dragged tab moves to (`movedItem(tabs, from, index)`): the
 * slot under the pointer, the nearer neighbour in a gap, and the strip's
 * first or last index beyond its ends.
 */
export function reorderTargetIndex(slots: readonly TabSlot[], from: number, x: number): number {
  if (slots.length === 0 || from < 0 || from >= slots.length || !Number.isFinite(x)) return from;
  for (let i = 0; i < slots.length; i++) {
    const { left, width } = slots[i];
    if (x < left) {
      if (i === 0) return 0;
      const previous = slots[i - 1];
      return x - (previous.left + previous.width) < left - x ? i - 1 : i;
    }
    if (x < left + width) return i;
  }
  return slots.length - 1;
}

/**
 * Each tab's horizontal displacement (CSS px) while the tab at `from` is
 * shown at `to`: the tabs it passed close up by its width plus `gap`, and the
 * dragged tab moves into the room they leave.
 */
export function reorderShifts(slots: readonly TabSlot[], from: number, to: number, gap = 0): number[] {
  const shifts = slots.map(() => 0);
  if (from < 0 || from >= slots.length || to < 0 || to >= slots.length || from === to) return shifts;
  const step = slots[from].width + gap;
  let travelled = 0;
  if (to > from) {
    for (let i = from + 1; i <= to; i++) { shifts[i] = -step; travelled += slots[i].width + gap; }
    shifts[from] = travelled;
  } else {
    for (let i = to; i < from; i++) { shifts[i] = step; travelled += slots[i].width + gap; }
    shifts[from] = -travelled;
  }
  return shifts;
}
