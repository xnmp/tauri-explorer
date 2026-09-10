import { describe, expect, it } from "vitest";
import { leaf, paneInDirection, type PaneNode } from "$lib/domain/pane-layout";
import { paneGeometry, revealPane, splitRatioFromKey } from "$lib/domain/pane-viewport";

function split(first: PaneNode, second: PaneNode, ratio = 0.5, direction: "row" | "column" = "row"): PaneNode {
  return { type: "split", id: `${first.id}-${second.id}`, first, second, ratio, direction };
}

describe("pane workspace geometry", () => {
  it("includes every nested divider while keeping all dense leaves usable", () => {
    const root = split(leaf("a"), split(leaf("b"), leaf("c")), 0.9);
    const geometry = paneGeometry(root, { width: 300, height: 100 }, 8);
    expect(geometry.width).toBe(736);
    expect(geometry.height).toBe(200);
    for (const [index, rect] of [...geometry.panes.values()].entries()) {
      expect(rect.x).toBeCloseTo(index * 248);
      expect(rect.y).toBe(0);
      expect(rect.w).toBeCloseTo(240);
      expect(rect.h).toBe(200);
    }
  });

  it("constrains only presentation, recovering saved preferences when space returns", () => {
    const root = split(leaf("a"), leaf("b"), 0.1);
    const saved = structuredClone(root);
    const constrained = paneGeometry(root, { width: 1000, height: 400 });
    expect(constrained.panes.get("a")!.w).toBe(240);
    const wide = paneGeometry(root, { width: 3000, height: 400 });
    expect(wide.panes.get("a")!.w).toBeCloseTo(299.4);
    expect(root).toEqual(saved);
    expect(constrained.splits.get(root.id)!.min).toBeCloseTo(240 / 994);
    expect(constrained.splits.get(root.id)!.max).toBeCloseTo(1 - 240 / 994);
  });

  it("shares exact rectangles with directional focus including stacked subtree constraints", () => {
    const root = split(split(leaf("a"), leaf("b"), 0.1, "column"), split(leaf("c"), leaf("d"), 0.9, "column"));
    const geometry = paneGeometry(root, { width: 800, height: 300 });
    expect(paneInDirection(geometry.panes, "b", "right")).toBe("d");
    expect(paneInDirection(geometry.panes, "c", "left")).toBe("a");
    expect(paneInDirection(geometry.panes, "a", "up")).toBeNull();
    for (const rect of geometry.panes.values()) {
      expect(rect.h).toBe(200);
      expect(rect.x + rect.w).toBeLessThanOrEqual(geometry.width);
      expect(rect.y + rect.h).toBeLessThanOrEqual(geometry.height);
    }
  });

  it("grows linearly for a deeply unbalanced layout with extreme saved ratios", () => {
    let root: PaneNode = leaf("0");
    for (let i = 1; i < 256; i++) root = split(root, leaf(String(i)), 0.1);
    const geometry = paneGeometry(root, { width: 0, height: 0 });
    expect(geometry.width).toBe(256 * 240 + 255 * 6);
    expect(geometry.panes.size).toBe(256);
    for (const rect of geometry.panes.values()) expect(rect.w).toBeCloseTo(240);
  });

  it("normalizes unavailable viewport measurements without invalid rectangles", () => {
    for (const value of [0, -1, NaN, Infinity]) {
      const geometry = paneGeometry(leaf("only"), { width: value, height: value });
      expect(geometry.panes.get("only")).toEqual({ x: 0, y: 0, w: 240, h: 200 });
    }
  });
});

describe("active pane reveal", () => {
  it("reveals file content after inline panels when the active pane exceeds the viewport", () => {
    const viewport = { width: 560, height: 500 };
    const geometry = paneGeometry(split(leaf("a"), leaf("b")), viewport, 6, new Map([["b", 480]]));
    const pane = geometry.panes.get("b")!;
    const scroll = revealPane({ left: 126, top: 0 }, viewport, pane, 480);
    const fileStart = pane.x + 480;
    expect(fileStart).toBeGreaterThanOrEqual(scroll.left);
    expect(pane.x + pane.w).toBeLessThanOrEqual(scroll.left + viewport.width);
    expect(scroll).toEqual({ left: 406, top: 0 });
  });
  it("keeps the whole pane visible when its panels fit and preserves vertical reveal", () => {
    expect(revealPane({ left: 126, top: 0 }, { width: 1000, height: 300 },
      { x: 246, y: 500, w: 720, h: 200 }, 480))
      .toEqual({ left: 126, top: 400 });
  });
  it("reveals the start of file content when even its minimum cannot fit", () => {
    expect(revealPane({ left: 0, top: 0 }, { width: 200, height: 100 },
      { x: 246, y: 130, w: 720, h: 200 }, 480))
      .toEqual({ left: 726, top: 130 });
  });
  it("scrolls only enough to show a distant pane in both axes", () => {
    expect(revealPane({ left: 0, top: 0 }, { width: 500, height: 300 }, { x: 800, y: 500, w: 240, h: 200 }))
      .toEqual({ left: 540, top: 400 });
  });
  it("retains scroll for a visible pane and reveals the start of an oversized one", () => {
    expect(revealPane({ left: 200, top: 100 }, { width: 500, height: 300 }, { x: 220, y: 130, w: 240, h: 200 }))
      .toEqual({ left: 200, top: 100 });
    expect(revealPane({ left: 200, top: 100 }, { width: 100, height: 80 }, { x: 220, y: 130, w: 240, h: 200 }))
      .toEqual({ left: 220, top: 130 });
  });
});


it("keyboard resizing starts at the constrained divider and honors its orientation and bounds", () => {
  const root = split(leaf("a"), leaf("b"), 0.1);
  const geometry = paneGeometry(root, { width: 1000, height: 400 }).splits.get(root.id)!;
  expect(splitRatioFromKey("row", "ArrowRight", geometry)).toBeCloseTo(240 / 994 + 0.05);
  expect(splitRatioFromKey("row", "ArrowLeft", geometry)).toBe(geometry.min);
  expect(splitRatioFromKey("row", "Home", geometry)).toBe(geometry.min);
  expect(splitRatioFromKey("row", "End", geometry)).toBe(geometry.max);
  expect(splitRatioFromKey("row", "ArrowUp", geometry)).toBeUndefined();
  expect(splitRatioFromKey("column", "ArrowRight", geometry)).toBeUndefined();
  expect(splitRatioFromKey("column", "ArrowDown", geometry)).toBeCloseTo(geometry.ratio + 0.05);
});
