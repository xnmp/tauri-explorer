/**
 * Pure helpers for the preview pane dock position (#460, auto mode #467).
 */
import { describe, it, expect } from "vitest";
import {
  normalizePreviewPanePosition,
  cyclePreviewPanePosition,
  PREVIEW_PANE_POSITIONS,
  normalizePreviewPanePositionMode,
  cyclePreviewPanePositionMode,
  PREVIEW_PANE_POSITION_MODES,
  resolveAutoDockPosition,
  resolveEffectivePreviewPanePosition,
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

describe("normalizePreviewPanePositionMode", () => {
  it("passes through the three concrete positions plus 'auto'", () => {
    expect(normalizePreviewPanePositionMode("right")).toBe("right");
    expect(normalizePreviewPanePositionMode("bottom")).toBe("bottom");
    expect(normalizePreviewPanePositionMode("top")).toBe("top");
    expect(normalizePreviewPanePositionMode("auto")).toBe("auto");
  });

  it("falls back to 'right' for unrecognized or malformed input", () => {
    for (const bad of [undefined, null, "", "left", "AUTO", "  auto  ", 42, {}, [], NaN]) {
      expect(normalizePreviewPanePositionMode(bad as unknown)).toBe("right");
    }
  });
});

describe("cyclePreviewPanePositionMode", () => {
  it("cycles right -> bottom -> top -> auto -> right", () => {
    expect(cyclePreviewPanePositionMode("right")).toBe("bottom");
    expect(cyclePreviewPanePositionMode("bottom")).toBe("top");
    expect(cyclePreviewPanePositionMode("top")).toBe("auto");
    expect(cyclePreviewPanePositionMode("auto")).toBe("right");
  });

  it("returns to the start after four cycles", () => {
    let mode: unknown = "right";
    for (let i = 0; i < 4; i++) mode = cyclePreviewPanePositionMode(mode);
    expect(mode).toBe("right");
  });

  it("visits every mode exactly once per full cycle", () => {
    const visited = new Set<string>();
    let mode: unknown = "right";
    for (let i = 0; i < PREVIEW_PANE_POSITION_MODES.length; i++) {
      visited.add(mode as string);
      mode = cyclePreviewPanePositionMode(mode);
    }
    expect([...visited].sort()).toEqual([...PREVIEW_PANE_POSITION_MODES].sort());
  });

  it("normalizes malformed input before cycling (treated as 'right')", () => {
    expect(cyclePreviewPanePositionMode("garbage")).toBe("bottom");
    expect(cyclePreviewPanePositionMode(undefined)).toBe("bottom");
  });
});

describe("resolveAutoDockPosition", () => {
  it("docks right for wide/landscape windows", () => {
    expect(resolveAutoDockPosition(1920, 1080)).toBe("right"); // 16:9
    expect(resolveAutoDockPosition(1280, 800)).toBe("right"); // 16:10
    expect(resolveAutoDockPosition(2560, 720)).toBe("right"); // ultrawide-ish
  });

  it("docks top for tall/narrow (portrait-ish) windows", () => {
    expect(resolveAutoDockPosition(400, 1200)).toBe("top"); // aspect 0.333
    expect(resolveAutoDockPosition(1, 100000)).toBe("top"); // extreme
  });

  it("docks bottom for merely-narrow (near-square) windows", () => {
    expect(resolveAutoDockPosition(700, 1000)).toBe("bottom"); // aspect 0.7
  });

  it("docks bottom for an exactly square window", () => {
    expect(resolveAutoDockPosition(800, 800)).toBe("bottom");
    expect(resolveAutoDockPosition(1, 1)).toBe("bottom");
  });

  it("is inclusive at the wide-threshold boundary (1.3)", () => {
    expect(resolveAutoDockPosition(1300, 1000)).toBe("right"); // aspect exactly 1.3
    expect(resolveAutoDockPosition(1299, 1000)).toBe("bottom"); // just under
  });

  it("is inclusive at the tall-threshold boundary (0.6)", () => {
    expect(resolveAutoDockPosition(600, 1000)).toBe("top"); // aspect exactly 0.6
    expect(resolveAutoDockPosition(601, 1000)).toBe("bottom"); // just over
  });

  it("falls back to 'right' for degenerate/tiny-before-layout geometry", () => {
    expect(resolveAutoDockPosition(0, 800)).toBe("right");
    expect(resolveAutoDockPosition(800, 0)).toBe("right");
    expect(resolveAutoDockPosition(0, 0)).toBe("right");
    expect(resolveAutoDockPosition(-100, 800)).toBe("right");
    expect(resolveAutoDockPosition(800, -100)).toBe("right");
    expect(resolveAutoDockPosition(NaN, 800)).toBe("right");
    expect(resolveAutoDockPosition(800, NaN)).toBe("right");
  });

  it("still resolves a real position for a tiny but valid window", () => {
    expect(resolveAutoDockPosition(1, 1)).toBe("bottom");
    expect(resolveAutoDockPosition(50, 20)).toBe("right"); // aspect 2.5
  });
});

describe("resolveEffectivePreviewPanePosition", () => {
  it("resolves 'auto' via window geometry", () => {
    expect(resolveEffectivePreviewPanePosition("auto", 1920, 1080)).toBe("right");
    expect(resolveEffectivePreviewPanePosition("auto", 400, 1200)).toBe("top");
    expect(resolveEffectivePreviewPanePosition("auto", 800, 800)).toBe("bottom");
  });

  it("passes concrete positions through unchanged regardless of geometry", () => {
    expect(resolveEffectivePreviewPanePosition("right", 400, 1200)).toBe("right");
    expect(resolveEffectivePreviewPanePosition("bottom", 1920, 1080)).toBe("bottom");
    expect(resolveEffectivePreviewPanePosition("top", 1920, 1080)).toBe("top");
  });
});
