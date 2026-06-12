/**
 * Variable-height virtual list layout math (src/lib/domain/virtual-layout.ts).
 * These are the offsets VirtualList.svelte uses to position and window rows.
 */

import { describe, it, expect } from "vitest";
import {
  computeOffsets,
  firstVisibleIndex,
  lastVisibleIndexExclusive,
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
