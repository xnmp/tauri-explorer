/**
 * Tests for the pane layout tree domain logic (#228).
 */

import { describe, it, expect } from "vitest";
import {
  leaf,
  leafIds,
  hasLeaf,
  countLeaves,
  splitLeaf,
  removeLeaf,
  updateRatio,
  leafRects,
  dwindlePlacement,
  type PaneNode,
} from "$lib/domain/pane-layout";

describe("splitLeaf", () => {
  it("splits a leaf right into a row with the new leaf second", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect(tree).toEqual({
      type: "split",
      id: "s1",
      direction: "row",
      ratio: 0.5,
      first: leaf("a"),
      second: leaf("b"),
    });
  });

  it("splits a leaf left placing the new leaf first", () => {
    const tree = splitLeaf(leaf("a"), "a", "left", "b", "s1");
    expect(leafIds(tree)).toEqual(["b", "a"]);
    expect((tree as any).direction).toBe("row");
  });

  it("splits up/down into a column", () => {
    const up = splitLeaf(leaf("a"), "a", "up", "b", "s1");
    expect((up as any).direction).toBe("column");
    expect(leafIds(up)).toEqual(["b", "a"]);

    const down = splitLeaf(leaf("a"), "a", "down", "b", "s1");
    expect(leafIds(down)).toEqual(["a", "b"]);
  });

  it("splits a nested target, leaving siblings untouched", () => {
    const tree = splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "b", "down", "c", "s2");
    expect(leafIds(tree)).toEqual(["a", "b", "c"]);
    expect(countLeaves(tree)).toBe(3);
    expect(hasLeaf(tree, "c")).toBe(true);
  });

  it("returns the tree unchanged when the target leaf is missing", () => {
    const tree = leaf("a");
    expect(splitLeaf(tree, "nope", "right", "b", "s1")).toBe(tree);
  });
});

describe("removeLeaf", () => {
  it("returns null when removing the only leaf", () => {
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("promotes the sibling when removing one of two leaves", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect(removeLeaf(tree, "b")).toEqual(leaf("a"));
    expect(removeLeaf(tree, "a")).toEqual(leaf("b"));
  });

  it("promotes a subtree sibling in a nested layout", () => {
    // a | (b / c)
    const tree = splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "b", "down", "c", "s2");
    const removed = removeLeaf(tree, "a")!;
    expect(leafIds(removed)).toEqual(["b", "c"]);

    const removedInner = removeLeaf(tree, "c")!;
    expect(leafIds(removedInner)).toEqual(["a", "b"]);
  });

  it("returns the tree unchanged when the leaf is missing", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect(removeLeaf(tree, "zzz")).toEqual(tree);
  });
});

describe("updateRatio", () => {
  it("updates the named split and clamps to [0.1, 0.9]", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect((updateRatio(tree, "s1", 0.7) as any).ratio).toBe(0.7);
    expect((updateRatio(tree, "s1", 0.01) as any).ratio).toBe(0.1);
    expect((updateRatio(tree, "s1", 5) as any).ratio).toBe(0.9);
  });

  it("only touches the matching split in a nested tree", () => {
    const tree = splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "b", "down", "c", "s2");
    const updated = updateRatio(tree, "s2", 0.8) as any;
    expect(updated.ratio).toBe(0.5); // s1 untouched
    expect(updated.second.ratio).toBe(0.8);
  });
});

describe("leafRects", () => {
  it("gives the sole leaf the full area", () => {
    expect(leafRects(leaf("a")).get("a")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("splits a row by ratio", () => {
    const tree = updateRatio(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "s1", 0.25);
    const rects = leafRects(tree);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
    expect(rects.get("b")).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
  });

  it("computes nested fractions", () => {
    // a | (b / c) — right half stacked
    const tree = splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "b", "down", "c", "s2");
    const rects = leafRects(tree);
    expect(rects.get("b")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(rects.get("c")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe("dwindlePlacement", () => {
  it("splits a single (wide) pane to the right", () => {
    expect(dwindlePlacement(leaf("a"), "a", 16 / 9)).toBe("right");
  });

  it("splits a half-width pane downward (taller than wide)", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect(dwindlePlacement(tree, "b", 1)).toBe("down");
  });

  it("alternates directions as panes shrink (spiral)", () => {
    // Square window: full pane → right; half pane → down; quarter → right again.
    let tree: PaneNode = leaf("a");
    expect(dwindlePlacement(tree, "a", 1)).toBe("right");
    tree = splitLeaf(tree, "a", "right", "b", "s1");
    expect(dwindlePlacement(tree, "b", 1)).toBe("down");
    tree = splitLeaf(tree, "b", "down", "c", "s2");
    expect(dwindlePlacement(tree, "c", 1)).toBe("right");
  });

  it("falls back to right for an unknown leaf", () => {
    expect(dwindlePlacement(leaf("a"), "missing", 1)).toBe("right");
  });
});
