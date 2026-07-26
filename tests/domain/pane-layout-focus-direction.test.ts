/**
 * Directional neighbour lookup over the pane split tree (#501).
 *
 * Kept out of pane-layout.test.ts so the split/remove/ratio suite stays
 * untouched: this is the geometry `Alt+L/'/P/;` resolve focus through.
 */

import { describe, it, expect } from "vitest";
import { leaf, splitLeaf, updateRatio, leafInDirection } from "$lib/domain/pane-layout";

describe("leafInDirection (#501)", () => {
  /** a | b — side by side. */
  const row = splitLeaf(leaf("a"), "a", "right", "b", "s1");
  /** a / b — stacked. */
  const column = splitLeaf(leaf("a"), "a", "down", "b", "s1");
  /**
   * 2x2 grid: (a / c) | (b / d)
   *   a b
   *   c d
   */
  const grid = splitLeaf(
    splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "a", "down", "c", "s2"),
    "b",
    "down",
    "d",
    "s3",
  );

  it("finds the pane across a horizontal split", () => {
    expect(leafInDirection(row, "b", "left")).toBe("a");
    expect(leafInDirection(row, "a", "right")).toBe("b");
  });

  it("finds the pane across a vertical split", () => {
    expect(leafInDirection(column, "b", "up")).toBe("a");
    expect(leafInDirection(column, "a", "down")).toBe("b");
  });

  it("returns null at the layout edge", () => {
    expect(leafInDirection(row, "a", "left")).toBeNull();
    expect(leafInDirection(row, "b", "right")).toBeNull();
    // A horizontal split has no vertical neighbours at all.
    expect(leafInDirection(row, "a", "up")).toBeNull();
    expect(leafInDirection(row, "a", "down")).toBeNull();
  });

  it("returns null for a single-pane layout and for an unknown pane", () => {
    for (const dir of ["left", "right", "up", "down"] as const) {
      expect(leafInDirection(leaf("a"), "a", dir)).toBeNull();
    }
    expect(leafInDirection(row, "nope", "left")).toBeNull();
  });

  it("ignores panes that only touch diagonally across a corner", () => {
    // From `a` (top-left), `d` (bottom-right) lies beyond the right edge but
    // shares no vertical span with it — only `b` is a real right neighbour.
    expect(leafInDirection(grid, "a", "right")).toBe("b");
    expect(leafInDirection(grid, "a", "down")).toBe("c");
    expect(leafInDirection(grid, "d", "left")).toBe("c");
    expect(leafInDirection(grid, "d", "up")).toBe("b");
    expect(leafInDirection(grid, "c", "right")).toBe("d");
    expect(leafInDirection(grid, "b", "left")).toBe("a");
  });

  it("crosses a nested split to the neighbour sharing the longest edge", () => {
    // a | (b / c) with the right column split 75/25, so `b` shares three times
    // as much of `a`'s edge as `c` does.
    const lShape = updateRatio(
      splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "b", "down", "c", "s2"),
      "s2",
      0.75,
    );
    expect(leafInDirection(lShape, "a", "right")).toBe("b");
    // Both right-hand panes fall back onto the single tall pane.
    expect(leafInDirection(lShape, "b", "left")).toBe("a");
    expect(leafInDirection(lShape, "c", "left")).toBe("a");
    // Vertical movement stays inside the right column.
    expect(leafInDirection(lShape, "b", "down")).toBe("c");
    expect(leafInDirection(lShape, "c", "up")).toBe("b");
    expect(leafInDirection(lShape, "b", "up")).toBeNull();
  });

  it("resolves adjacency for lopsided ratios, not just even splits", () => {
    const lopsided = updateRatio(row, "s1", 0.15);
    expect(leafInDirection(lopsided, "b", "left")).toBe("a");
    expect(leafInDirection(lopsided, "a", "right")).toBe("b");
  });
});
