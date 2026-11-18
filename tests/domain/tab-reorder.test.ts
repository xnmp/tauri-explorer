import { describe, expect, it } from "vitest";
import { reorderShifts, reorderTargetIndex, type TabSlot } from "$lib/domain/tab-reorder";
import { movedItem } from "$lib/domain/window-tab-order";

// Four tabs: an active 120px tab at index 1, the others 60px, 1px gaps.
const slots: TabSlot[] = [
  { left: 0, width: 60 },
  { left: 61, width: 120 },
  { left: 182, width: 60 },
  { left: 243, width: 60 },
];

describe("reorderTargetIndex", () => {
  it("targets the slot under the pointer", () => {
    expect(reorderTargetIndex(slots, 0, 30)).toBe(0);
    expect(reorderTargetIndex(slots, 0, 62)).toBe(1);
    expect(reorderTargetIndex(slots, 0, 200)).toBe(2);
    expect(reorderTargetIndex(slots, 3, 10)).toBe(0);
  });

  it("clamps beyond the strip's ends", () => {
    expect(reorderTargetIndex(slots, 2, -50)).toBe(0);
    expect(reorderTargetIndex(slots, 0, 9999)).toBe(3);
  });

  it("resolves a gap to the nearer neighbour", () => {
    const gappy: TabSlot[] = [{ left: 0, width: 50 }, { left: 60, width: 50 }];
    expect(reorderTargetIndex(gappy, 0, 52)).toBe(0);
    expect(reorderTargetIndex(gappy, 0, 58)).toBe(1);
  });

  it("keeps the source index for degenerate input", () => {
    expect(reorderTargetIndex([], 0, 10)).toBe(0);
    expect(reorderTargetIndex(slots, 1, Number.NaN)).toBe(1);
    expect(reorderTargetIndex(slots, 9, 10)).toBe(9);
  });
});

describe("reorderShifts", () => {
  /** Visual left of each tab after displacement. */
  const visual = (from: number, to: number) => reorderShifts(slots, from, to, 1).map((s, i) => slots[i].left + s);

  it("is all zeros with no move", () => {
    expect(reorderShifts(slots, 1, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(reorderShifts(slots, 1, 7, 1)).toEqual([0, 0, 0, 0]);
  });

  it("lays every tab out where the reorder will put it", () => {
    for (const [from, to] of [[0, 2], [1, 3], [3, 0], [2, 1], [0, 3]]) {
      const after = movedItem(slots, from, to)!;
      let left = 0;
      const expected = new Map<TabSlot, number>();
      for (const slot of after) { expected.set(slot, left); left += slot.width + 1; }
      const lefts = visual(from, to);
      slots.forEach((slot, i) => expect(lefts[i], `${from}→${to} tab ${i}`).toBe(expected.get(slot)));
    }
  });
});
