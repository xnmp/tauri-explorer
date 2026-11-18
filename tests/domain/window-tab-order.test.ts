import { describe, expect, it } from "vitest";
import { activationAfterClose, cycledTabIndex, movedItem, tabInsertIndex, tabsToClose } from "$lib/domain/window-tab-order";

describe("tabInsertIndex", () => {
  it("inserts after the active tab by default, or at the end with none active", () => {
    expect(tabInsertIndex(4, 1)).toBe(2);
    expect(tabInsertIndex(4, 3)).toBe(4);
    expect(tabInsertIndex(4, -1)).toBe(4);
    expect(tabInsertIndex(0, -1)).toBe(0);
  });

  it("clamps a requested index to the strip", () => {
    expect(tabInsertIndex(4, 1, 0)).toBe(0);
    expect(tabInsertIndex(4, 1, 99)).toBe(4);
    expect(tabInsertIndex(4, 1, -3)).toBe(0);
  });
});

describe("cycledTabIndex", () => {
  it("wraps in both directions", () => {
    expect(cycledTabIndex(2, 1, 3)).toBe(0);
    expect(cycledTabIndex(0, -1, 3)).toBe(2);
    expect(cycledTabIndex(1, 1, 3)).toBe(2);
  });
});

describe("movedItem", () => {
  it("moves an item and leaves the input untouched", () => {
    const items = ["a", "b", "c", "d"];
    expect(movedItem(items, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(movedItem(items, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(items).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects no-op and out-of-range moves", () => {
    const items = ["a", "b"];
    expect(movedItem(items, 1, 1)).toBeNull();
    expect(movedItem(items, -1, 0)).toBeNull();
    expect(movedItem(items, 0, 2)).toBeNull();
    expect(movedItem([], 0, 0)).toBeNull();
  });
});

describe("activationAfterClose (#1749)", () => {
  it("activates the right neighbour of a closed middle tab", () => {
    // [a, B, c, d] closing B (index 1) leaves [a, c, d]: c, at index 1.
    expect(activationAfterClose(4, 1)).toBe(1);
    expect(activationAfterClose(4, 0)).toBe(0);
  });

  it("falls back to the left neighbour when the last tab closes", () => {
    expect(activationAfterClose(4, 3)).toBe(2);
    expect(activationAfterClose(2, 1)).toBe(0);
  });

  it("has nothing to activate when no tab remains or the index is unknown", () => {
    expect(activationAfterClose(1, 0)).toBe(-1);
    expect(activationAfterClose(3, 5)).toBe(-1);
  });
});

describe("tabsToClose (#1749)", () => {
  const ids = ["a", "b", "c", "d"];
  it("closes every other tab", () => {
    expect(tabsToClose(ids, "b", "others")).toEqual(["a", "c", "d"]);
  });
  it("closes the tabs to the right", () => {
    expect(tabsToClose(ids, "b", "right")).toEqual(["c", "d"]);
    expect(tabsToClose(ids, "d", "right")).toEqual([]);
  });
  it("closes nothing for an unknown tab", () => {
    expect(tabsToClose(ids, "x", "others")).toEqual([]);
  });
});
