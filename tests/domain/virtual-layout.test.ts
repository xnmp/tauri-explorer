/**
 * Variable-height virtual list layout math (src/lib/domain/virtual-layout.ts).
 * These are the offsets VirtualList.svelte uses to position and window rows.
 */

import { describe, it, expect } from "vitest";
import {
  computeOffsets,
  firstVisibleIndex,
  lastVisibleIndexExclusive,
  chunkIntoRows,
  rowCount,
  autoFillColumns,
} from "../../src/lib/domain/virtual-layout";

// Heights alternate 54 (header) / 30 (row) like the content-search list.
const items = ["h", "r", "r", "h", "r"];
const height = (item: string) => (item === "h" ? 54 : 30);

describe("computeOffsets", () => {
  it("produces prefix sums and total height", () => {
    const { offsets, totalHeight } = computeOffsets(items, height);
    expect(offsets).toEqual([0, 54, 84, 114, 168]);
    expect(totalHeight).toBe(198);
  });

  it("handles empty input", () => {
    const { offsets, totalHeight } = computeOffsets([], height);
    expect(offsets).toEqual([]);
    expect(totalHeight).toBe(0);
  });

  it("passes the index to the height callback", () => {
    const seen: number[] = [];
    computeOffsets(["a", "b"], (_item, i) => {
      seen.push(i);
      return 10;
    });
    expect(seen).toEqual([0, 1]);
  });
});

describe("firstVisibleIndex", () => {
  const { offsets } = computeOffsets(items, height); // [0, 54, 84, 114, 168]

  it("returns the item whose span contains scrollTop", () => {
    expect(firstVisibleIndex(offsets, 0)).toBe(0);
    expect(firstVisibleIndex(offsets, 53)).toBe(0);
    expect(firstVisibleIndex(offsets, 54)).toBe(1);
    expect(firstVisibleIndex(offsets, 100)).toBe(2);
  });

  it("clamps past the end and on empty input", () => {
    expect(firstVisibleIndex(offsets, 10_000)).toBe(items.length - 1);
    expect(firstVisibleIndex([], 100)).toBe(0);
  });

  it("agrees with a linear scan for every scroll position", () => {
    for (let top = 0; top <= 198; top += 7) {
      let expected = 0;
      for (let i = 0; i < offsets.length; i++) {
        if (offsets[i] <= top) expected = i;
      }
      expect(firstVisibleIndex(offsets, top)).toBe(expected);
    }
  });
});

describe("lastVisibleIndexExclusive", () => {
  const { offsets } = computeOffsets(items, height); // [0, 54, 84, 114, 168]

  it("returns one past the last item starting above viewBottom", () => {
    // Viewport 0..100: items at 0, 54, 84 start inside it.
    expect(lastVisibleIndexExclusive(offsets, 0, 100)).toBe(3);
    // Tiny viewport shows only the first item.
    expect(lastVisibleIndexExclusive(offsets, 0, 1)).toBe(1);
  });

  it("never exceeds the item count", () => {
    expect(lastVisibleIndexExclusive(offsets, 0, 10_000)).toBe(items.length);
  });
});

describe("chunkIntoRows", () => {
  const entries = ["a", "b", "c", "d", "e"];

  it("fills rows left→right, top→down (row-major) preserving sequence order", () => {
    const rows = chunkIntoRows(entries, 2);
    expect(rows).toEqual([
      { items: ["a", "b"], startIndex: 0 },
      { items: ["c", "d"], startIndex: 2 },
      { items: ["e"], startIndex: 4 },
    ]);
    // Flattening rows must reproduce the original order (DOM stays name-sorted).
    expect(rows.flatMap((r) => r.items)).toEqual(entries);
  });

  it("startIndex maps every cell back to its global entry index", () => {
    const rows = chunkIntoRows(entries, 3);
    for (const row of rows) {
      row.items.forEach((item, col) => {
        expect(entries[row.startIndex + col]).toBe(item);
      });
    }
  });

  it("returns a single row when columns >= item count", () => {
    expect(chunkIntoRows(entries, 10)).toEqual([{ items: entries, startIndex: 0 }]);
  });

  it("degrades malformed column counts to a single column", () => {
    for (const bad of [0, -3, NaN, 0.4]) {
      const rows = chunkIntoRows(entries, bad);
      expect(rows).toHaveLength(entries.length);
      expect(rows.every((r) => r.items.length === 1)).toBe(true);
    }
  });

  it("handles an empty list", () => {
    expect(chunkIntoRows([], 3)).toEqual([]);
  });
});

describe("rowCount", () => {
  it("rounds up partial rows", () => {
    expect(rowCount(5, 2)).toBe(3);
    expect(rowCount(4, 2)).toBe(2);
    expect(rowCount(0, 4)).toBe(0);
    expect(rowCount(1, 6)).toBe(1);
  });

  it("agrees with chunkIntoRows for arbitrary inputs", () => {
    for (const total of [0, 1, 7, 50, 5001]) {
      for (const cols of [1, 3, 6]) {
        const items = Array.from({ length: total }, (_, i) => i);
        expect(rowCount(total, cols)).toBe(chunkIntoRows(items, cols).length);
      }
    }
  });

  it("degrades malformed column counts to a single column", () => {
    expect(rowCount(5, 0)).toBe(5);
    expect(rowCount(5, NaN)).toBe(5);
  });
});

describe("autoFillColumns", () => {
  it("matches CSS repeat(auto-fill, minmax(min, 1fr)) fitting math", () => {
    // width 800, min 108, gap 6: (800+6)/(108+6) = 7.07 -> 7 columns
    expect(autoFillColumns(800, 108, 6)).toBe(7);
    // Exactly enough room for 2 columns (2*100 + 1*10 = 210).
    expect(autoFillColumns(210, 100, 10)).toBe(2);
    // One pixel short of a 3rd column stays at 2.
    expect(autoFillColumns(319, 100, 10)).toBe(2);
    // Exactly enough for a 3rd (3*100 + 2*10 = 320).
    expect(autoFillColumns(320, 100, 10)).toBe(3);
  });

  it("never drops below one column, even for tiny or zero widths", () => {
    expect(autoFillColumns(0, 100, 6)).toBe(1);
    expect(autoFillColumns(50, 100, 6)).toBe(1);
    expect(autoFillColumns(-5, 100, 6)).toBe(1);
    expect(autoFillColumns(500, 0, 6)).toBe(1);
  });
});
