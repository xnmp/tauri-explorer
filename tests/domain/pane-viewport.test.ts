import { describe, expect, it } from "vitest";
import { leaf, paneInDirection, type PaneNode } from "$lib/domain/pane-layout";
import { paneGeometry, paneMinima, preferredSplitRatio, revealPane, splitRatioFromKey, type PaneSize } from "$lib/domain/pane-viewport";

const paneMinimum = (root: PaneNode, divider?: number, inline?: ReadonlyMap<string, number>): PaneSize =>
  paneMinima(root, divider, inline).get(root.id)!;

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
      expect(geometry.panes.get("only")).toEqual({ x: 0, y: 0, w: 240, h: 0 });
    }
  });

  it("never forces a lone pane taller than a short viewport", () => {
    const geometry = paneGeometry(leaf("only"), { width: 800, height: 120 });
    expect(geometry.height).toBe(120);
    expect(geometry.panes.get("only")?.h).toBe(120);
  });

  it("still enforces the minimum height for split panes", () => {
    const root = { type: "split", id: "s", direction: "column", ratio: 0.5, first: leaf("a"), second: leaf("b") } as never;
    expect(paneGeometry(root, { width: 800, height: 120 }).height).toBeGreaterThanOrEqual(400);
  });
});

// The canvas is sized in CSS as "fill the viewport, at least this minimum", so
// it follows the viewport in the same layout pass (#1061). The measured canvas
// must agree: the minimum below a small viewport, the viewport above it.
describe("pane workspace minimum", () => {
  // Divider 8; inline panels widen "a" by 120 and "only" by 200.
  const inline = new Map([["a", 120], ["only", 200]]);
  const cases: { name: string; root: PaneNode; minimum: PaneSize }[] = [
    { name: "lone pane", root: leaf("only"), minimum: { width: 440, height: 0 } },
    // a (360) | 8 | b over c (240 wide, 200 + 8 + 200 tall)
    { name: "nested row and column splits", root: split(leaf("a"), split(leaf("b"), leaf("c"), 0.3, "column"), 0.9),
      minimum: { width: 608, height: 408 } },
    // a (360) | 8 | b (240) above c | 8 | d; the wider row sets the width
    { name: "column of rows", root: split(split(leaf("a"), leaf("b")), split(leaf("c"), leaf("d")), 0.5, "column"),
      minimum: { width: 608, height: 408 } },
  ];
  for (const { name, root, minimum } of cases) {
    it(`is the measured canvas below it and the viewport above it: ${name}`, () => {
      expect(paneMinimum(root, 8, inline)).toEqual(minimum);
      const small = paneGeometry(root, { width: 300, height: 100 }, 8, inline);
      expect({ width: small.width, height: small.height }).toEqual({ width: minimum.width, height: Math.max(100, minimum.height) });
      const large = paneGeometry(root, { width: 4000, height: 3000 }, 8, inline);
      expect({ width: large.width, height: large.height }).toEqual({ width: 4000, height: 3000 });
    });
  }

  it("lets a lone pane shrink to any height but keeps its width usable with inline panels", () => {
    expect(paneMinimum(leaf("only"))).toEqual({ width: 240, height: 0 });
    expect(paneMinimum(leaf("only"), 6, new Map([["only", 480]]))).toEqual({ width: 720, height: 0 });
  });

  it("adds every nested divider along a split and the larger branch across it", () => {
    const root = split(leaf("a"), split(leaf("b"), leaf("c"), 0.5, "column"));
    expect(paneMinimum(root, 8)).toEqual({ width: 240 + 8 + 240, height: 200 + 8 + 200 });
  });

  it("ignores saved ratios, so constrained presentation never feeds back into it", () => {
    expect(paneMinimum(split(leaf("a"), leaf("b"), 0.01))).toEqual(paneMinimum(split(leaf("a"), leaf("b"), 0.99)));
    expect(paneMinimum(split(leaf("a"), leaf("b"), NaN))).toEqual({ width: 486, height: 200 });
  });

  it("treats malformed dividers and inline widths as zero", () => {
    const root = split(leaf("a"), leaf("b"));
    for (const divider of [-4, NaN, Infinity]) expect(paneMinimum(root, divider)).toEqual({ width: 480, height: 200 });
    for (const width of [-50, NaN, Infinity]) expect(paneMinimum(root, 6, new Map([["a", width]])).width).toBe(486);
  });

  it("gives every split child the minimum that its rendered extent must keep", () => {
    const root = split(leaf("a"), split(leaf("b"), leaf("c"), 0.3, "column"), 0.9);
    const minima = paneMinima(root, 6, new Map([["c", 300]]));
    expect(minima.get("a")).toEqual({ width: 240, height: 200 });
    expect(minima.get("b-c")).toEqual({ width: 540, height: 406 });
    // CSS resolves the saved ratio against these minima. That equals the
    // measured clamp: whenever a minimum binds, the child is exactly at it.
    for (const width of [786, 900, 1600]) {
      const geometry = paneGeometry(root, { width, height: 600 }, 6, new Map([["c", 300]]));
      const second = geometry.panes.get("b")!;
      expect(second.w).toBeGreaterThanOrEqual(540 - 1e-9);
      const extent = geometry.width - 6;
      const css = Math.max(240, Math.min(extent - 540, extent * preferredSplitRatio(root.type === "split" ? root.ratio : 0)));
      expect(geometry.panes.get("a")!.w).toBeCloseTo(css);
    }
  });

  it("renders saved preferences within 0..1 and falls back to an even split", () => {
    expect(preferredSplitRatio(0.3)).toBe(0.3);
    expect(preferredSplitRatio(-1)).toBe(0);
    expect(preferredSplitRatio(7)).toBe(1);
    for (const value of [NaN, Infinity, -Infinity]) expect(preferredSplitRatio(value)).toBe(0.5);
  });

  it("stays linear for a deeply unbalanced layout", () => {
    let root: PaneNode = leaf("0");
    for (let i = 1; i < 4096; i++) root = split(root, leaf(String(i)), 0.1);
    expect(paneMinimum(root)).toEqual({ width: 4096 * 240 + 4095 * 6, height: 200 });
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
