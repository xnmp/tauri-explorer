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
  splitNode,
  hasNode,
  removeLeaf,
  updateRatio,
  leafRects,
  dwindlePlacement,
  leafSiblingContext,
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

describe("splitNode / hasNode (#229)", () => {
  it("hasNode finds leaves and split ids", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect(hasNode(tree, "a")).toBe(true);
    expect(hasNode(tree, "s1")).toBe(true);
    expect(hasNode(tree, "nope")).toBe(false);
  });

  it("wraps a whole split subtree in a new split", () => {
    // (a | b) then wrap the s1 subtree with c above it.
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    const wrapped = splitNode(tree, "s1", "up", "c", "s2");
    expect(leafIds(wrapped)).toEqual(["c", "a", "b"]);
    expect((wrapped as any).direction).toBe("column");
    expect((wrapped as any).first).toEqual(leaf("c"));
    expect((wrapped as any).second.id).toBe("s1");
  });

  it("returns the tree unchanged for a missing target", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    expect(splitNode(tree, "zzz", "left", "c", "s2")).toEqual(tree);
  });
});

describe("leafSiblingContext (#229)", () => {
  it("returns null for the root leaf (no sibling)", () => {
    expect(leafSiblingContext(leaf("a"), "a")).toBeNull();
  });

  it("captures sibling, placement, and ratio for a row split", () => {
    const tree = updateRatio(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "s1", 0.3);
    // a is first in a row → it sat to the LEFT of b.
    expect(leafSiblingContext(tree, "a")).toEqual({ siblingId: "b", placement: "left", ratio: 0.3 });
    expect(leafSiblingContext(tree, "b")).toEqual({ siblingId: "a", placement: "right", ratio: 0.3 });
  });

  it("captures up/down placements for a column split", () => {
    const tree = splitLeaf(leaf("a"), "a", "down", "b", "s1");
    expect(leafSiblingContext(tree, "a")?.placement).toBe("up");
    expect(leafSiblingContext(tree, "b")?.placement).toBe("down");
  });

  it("the sibling can be a whole subtree", () => {
    // ((a | b) over c): c's sibling is the s1 subtree.
    const inner = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    const tree = splitNode(inner, "s1", "down", "c", "s2");
    expect(leafSiblingContext(tree, "c")).toEqual({ siblingId: "s1", placement: "down", ratio: 0.5 });
  });

  it("round-trips: removeLeaf then splitNode with the context restores the layout shape", () => {
    const inner = splitLeaf(leaf("a"), "a", "right", "b", "s1");
    const tree = updateRatio(splitNode(inner, "s1", "down", "c", "s2"), "s2", 0.7);
    const ctx = leafSiblingContext(tree, "c")!;
    const removed = removeLeaf(tree, "c")!;
    const restored = updateRatio(
      splitNode(removed, ctx.siblingId, ctx.placement, "c2", "s3"),
      "s3",
      ctx.ratio,
    );
    expect(leafIds(restored)).toEqual(["a", "b", "c2"]);
    expect((restored as any).direction).toBe("column");
    expect((restored as any).ratio).toBe(0.7);
  });
});
