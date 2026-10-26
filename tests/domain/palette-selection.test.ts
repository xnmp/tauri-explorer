/** #1236: the palette highlight follows a command, not a row position. */
import { describe, expect, it } from "vitest";
import {
  paletteSelectionIndex,
  stepPaletteSelection,
} from "$lib/domain/palette-selection";

describe("paletteSelectionIndex", () => {
  it("follows the top result until the user picks a command", () => {
    expect(paletteSelectionIndex(["a", "b"], null)).toBe(0);
    expect(paletteSelectionIndex([], null)).toBe(0);
  });

  it("keeps the chosen command highlighted when rows are inserted above it", () => {
    const before = ["toggle", "fetch"];
    const after = ["checkout-feature", "merge-feature", "toggle", "fetch"];
    expect(before[paletteSelectionIndex(before, "fetch")]).toBe("fetch");
    expect(after[paletteSelectionIndex(after, "fetch")]).toBe("fetch");
  });

  it("falls back to the top result when the chosen command disappears", () => {
    expect(paletteSelectionIndex(["toggle", "fetch"], "checkout-gone")).toBe(0);
    expect(paletteSelectionIndex([], "checkout-gone")).toBe(0);
  });
});

describe("stepPaletteSelection", () => {
  const ids = ["a", "b", "c"];

  it("moves from the top result when nothing was chosen", () => {
    expect(stepPaletteSelection(ids, null, 1)).toBe("b");
    expect(stepPaletteSelection(ids, null, -1)).toBe("c");
  });

  it("wraps in both directions", () => {
    expect(stepPaletteSelection(ids, "c", 1)).toBe("a");
    expect(stepPaletteSelection(ids, "a", -1)).toBe("c");
  });

  it("steps from the chosen command's current row after the list changed", () => {
    expect(stepPaletteSelection(["x", "a", "b", "c"], "b", 1)).toBe("c");
  });

  it("has nothing to select in an empty list", () => {
    expect(stepPaletteSelection([], "a", 1)).toBeNull();
  });
});
