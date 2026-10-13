import { describe, expect, it } from "vitest";
import { clickSelectionEffect, combinedSelection } from "$lib/domain/workspace-selection";
import { calculateSelection } from "$lib/state/selection";
import type { FileEntry } from "$lib/domain/file";

const entry = (path: string): FileEntry => ({ path, name: path, kind: "file", size: 0, modified: "" });

describe("pane click selection", () => {
  // Every Ctrl/Meta/Shift/Alt combination, on both panes, selected or unselected.
  for (let mask = 0; mask < 16; mask++) {
    const ctrlKey = !!(mask & 1), metaKey = !!(mask & 2), shiftKey = !!(mask & 4), altKey = !!(mask & 8);
    for (const other of [false, true]) for (const selected of [false, true]) {
      it(`mask=${mask}, other=${other}, selected=${selected}`, () => {
        const a = entry("a"), b = entry("b"), c = entry("c");
        const current = new Set(selected ? [a.path, c.path] : [a.path]);
        const effect = clickSelectionEffect({ ctrlKey, metaKey, shiftKey, altKey }, other ? "B" : "A", "A");
        const result = calculateSelection([a, b, c], c, current, a.path, effect.selectionModifiers);
        expect(effect.focusPane).toBe(!(other && (ctrlKey || metaKey) && !shiftKey));
        const expected = shiftKey ? ["a", "b", "c"] : ctrlKey || metaKey ? selected ? ["a"] : ["a", "c"] : ["c"];
        expect([...result.selectedPaths]).toEqual(expected);
        expect([...current]).toEqual(selected ? ["a", "c"] : ["a"]);
      });
    }
  }
  it("keeps context-menu focus behavior", () => {
    expect(clickSelectionEffect({ ctrlKey: true, button: 2 }, "B", "A").focusPane).toBe(true);
  });
  it("preserves selection when a clicked entry is no longer listed", () => {
    const current = new Set(["present"]);
    const effect = clickSelectionEffect({}, "B", "A");
    const result = calculateSelection([], entry("missing"), current, null, effect.selectionModifiers);
    expect([...result.selectedPaths]).toEqual(["present"]);
    expect(result.anchorPath).toBeNull();
  });
});

describe("combined selection", () => {
  it("keeps each pane's order, focused first then visual order, deduplicating by path", () => {
    const duplicate = entry("same");
    const focusedDuplicate = { ...duplicate, name: "focused copy" };
    const panes = [
      { id: "left", entries: [entry("l2"), duplicate, entry("l1")] },
      { id: "middle", entries: [entry("m")] },
      { id: "right", entries: [entry("r2"), focusedDuplicate, entry("r1"), entry("r2")] },
    ];
    const result = combinedSelection(panes, "right");
    expect(result.map((file) => file.path)).toEqual(["r2", "same", "r1", "l2", "l1", "m"]);
    expect(result[1]).toBe(focusedDuplicate);
    expect(panes[0].entries.map((file) => file.path)).toEqual(["l2", "same", "l1"]);
  });
  it("handles empty selections and unknown focused ids", () => {
    expect(combinedSelection([], "missing")).toEqual([]);
    expect(combinedSelection([{ id: "empty", entries: [] }], "empty")).toEqual([]);
    expect(combinedSelection([{ id: "a", entries: [entry("a")] }], "missing").map((file) => file.path)).toEqual(["a"]);
  });
  it("handles large overlapping selections without changing path spelling", () => {
    const entries = Array.from({ length: 20_000 }, (_, index) => entry(`/files/${index}`));
    const result = combinedSelection([{ id: "a", entries }, { id: "b", entries: [...entries, entry("/FILES/0")] }], "b");
    expect(result).toHaveLength(20_001);
    expect(result.at(-1)?.path).toBe("/FILES/0");
  });
});
