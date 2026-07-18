/**
 * Pure helpers for the preview pane dock position (#460).
 */
import { describe, it, expect } from "vitest";
import {
  normalizePreviewPanePosition,
  cyclePreviewPanePosition,
  PREVIEW_PANE_POSITIONS,
} from "$lib/domain/preview-pane-position";

describe("normalizePreviewPanePosition", () => {
  it("passes through the three valid positions", () => {
    expect(normalizePreviewPanePosition("right")).toBe("right");
    expect(normalizePreviewPanePosition("bottom")).toBe("bottom");
    expect(normalizePreviewPanePosition("top")).toBe("top");
  });

  it("falls back to 'right' for unrecognized or malformed input", () => {
    for (const bad of [undefined, null, "", "left", "RIGHT", "  right  ", 42, {}, [], NaN]) {
      expect(normalizePreviewPanePosition(bad as unknown)).toBe("right");
    }
  });
});

describe("cyclePreviewPanePosition", () => {
  it("cycles right -> bottom -> top -> right", () => {
    expect(cyclePreviewPanePosition("right")).toBe("bottom");
    expect(cyclePreviewPanePosition("bottom")).toBe("top");
    expect(cyclePreviewPanePosition("top")).toBe("right");
  });

  it("returns to the start after three cycles", () => {
    let pos = "right";
    for (let i = 0; i < 3; i++) pos = cyclePreviewPanePosition(pos);
    expect(pos).toBe("right");
  });

  it("visits every position exactly once per full cycle", () => {
    const visited = new Set<string>();
    let pos = "right";
    for (let i = 0; i < PREVIEW_PANE_POSITIONS.length; i++) {
      visited.add(pos);
      pos = cyclePreviewPanePosition(pos);
    }
    expect([...visited].sort()).toEqual([...PREVIEW_PANE_POSITIONS].sort());
  });

  it("normalizes malformed input before cycling (treated as 'right')", () => {
    expect(cyclePreviewPanePosition("garbage")).toBe("bottom");
    expect(cyclePreviewPanePosition(undefined)).toBe("bottom");
  });
});
