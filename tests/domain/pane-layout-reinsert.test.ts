/**
 * Closing and restoring panes (#229, #1372): focus after a close, and
 * re-inserting a closed pane at its recorded position.
 */

import { describe, expect, it } from "vitest";
import {
  focusAfterClosing,
  leaf,
  leafIds,
  leafSiblingContext,
  reinsertLeaf,
  removeLeaf,
  splitLeaf,
  type PaneNode,
} from "$lib/domain/pane-layout";

// a | (b / c)
const threePanes = (): PaneNode =>
  splitLeaf(splitLeaf(leaf("a"), "a", "right", "b", "s1"), "b", "down", "c", "s2");

describe("focusAfterClosing", () => {
  it("focuses the pane before the closed one in visual order", () => {
    const before = threePanes();
    expect(focusAfterClosing(before, removeLeaf(before, "c")!, "c")).toBe("b");
    expect(focusAfterClosing(before, removeLeaf(before, "b")!, "b")).toBe("a");
  });

  it("focuses the new first pane when the first pane closes", () => {
    const before = threePanes();
    expect(focusAfterClosing(before, removeLeaf(before, "a")!, "a")).toBe("b");
  });
});

describe("reinsertLeaf", () => {
  it("restores a closed pane to its exact position and ratio", () => {
    const before = { ...threePanes() } as PaneNode;
    const withRatio: PaneNode = before.type === "split"
      ? { ...before, second: before.second.type === "split" ? { ...before.second, ratio: 0.25 } : before.second }
      : before;
    const context = leafSiblingContext(withRatio, "c")!;
    const after = removeLeaf(withRatio, "c")!;
    const restored = reinsertLeaf(after, "a", context, "c2", "s9");
    expect(leafIds(restored)).toEqual(["a", "b", "c2"]);
    expect(leafSiblingContext(restored, "c2")).toEqual({ siblingId: "b", placement: "down", ratio: 0.25 });
  });

  it("splits the focused pane on the recorded side when the sibling is gone", () => {
    const layout = splitLeaf(leaf("a"), "a", "right", "d", "s1");
    const restored = reinsertLeaf(layout, "d", { siblingId: "gone", placement: "up", ratio: 0.7 }, "n", "s2");
    expect(leafIds(restored)).toEqual(["a", "n", "d"]);
    expect(leafSiblingContext(restored, "n")).toMatchObject({ siblingId: "d", placement: "up" });
  });
});
