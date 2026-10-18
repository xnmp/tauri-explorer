import { describe, expect, it } from "vitest";
import { accentFade, groupOutlines, outlinePath, ribbonGeometry } from "$lib/domain/tile-panel-outline";
import { RIBBON_HALF, STACKED_LABEL_HEIGHT, tabX } from "$lib/domain/tile-panels";
import { P, modelFor } from "./tile-panels-fixture";

type Command = { op: string; args: number[] };
function parse(d: string): Command[] {
  const commands: Command[] = [];
  for (const match of d.matchAll(/([MLACQZ])([^MLACQZ]*)/g)) {
    commands.push({ op: match[1], args: match[2].trim() ? match[2].trim().split(/[\s,]+/).map(Number) : [] });
  }
  return commands;
}
/** End points of every command (arcs: their last two numbers). */
function points(d: string): { x: number; y: number }[] {
  return parse(d).filter(c => c.op !== "Z").map(c => ({ x: c.args.at(-2)!, y: c.args.at(-1)! }));
}
function bbox(d: string) {
  const ps = points(d);
  return { x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)), y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)) };
}
const arcRadii = (d: string) => parse(d).filter(c => c.op === "A").map(c => c.args[0]);
const finite = (d: string) => parse(d).every(c => c.args.every(Number.isFinite));

describe("tab-and-page outline (§9.3)", () => {
  const panel = { x0: 30, x1: 534, yp: 141, yf: 353, d: 1 as const };

  it("wraps the parent tab and the panel in one closed contour", () => {
    const d = outlinePath({ ...panel, tab: { tx0: 228, tx1: 336, ty: 0 } });
    expect(d.trim().endsWith("Z")).toBe(true);
    expect(bbox(d)).toEqual({ x0: 30, x1: 534, y0: 0, y1: 353 });
    // Tab corners r 8, panel corners r 10, and a concave r 6 fillet on each side of the tab.
    expect(arcRadii(d).sort()).toEqual([10, 10, 10, 10, 6, 6, 8, 8].sort());
    // The tab's far edge runs between its corner arcs, at the tab's far end.
    const top = points(d).filter(p => p.y === 0).map(p => p.x).sort((a, b) => a - b);
    expect(top).toEqual([236, 328]);
  });

  it("snaps the tab flush with a panel side within r_panel + r_fillet", () => {
    const flushLeft = outlinePath({ ...panel, tab: { tx0: 40, tx1: 148, ty: 0 } });
    expect(arcRadii(flushLeft).filter(r => r === 6)).toHaveLength(1);
    // The panel's left side continues straight up into the tab.
    expect(points(flushLeft)[0]).toEqual({ x: 30, y: 141 });
    expect(bbox(flushLeft).x0).toBe(30);
    const flushBoth = outlinePath({ ...panel, x1: 150, tab: { tx0: 35, tx1: 140, ty: 0 } });
    expect(arcRadii(flushBoth).filter(r => r === 6)).toHaveLength(0);
  });

  it("mirrors for a panel above its parent", () => {
    const d = outlinePath({ x0: 30, x1: 534, yp: 300, yf: 88, d: -1, tab: { tx0: 228, tx1: 336, ty: 441 } });
    expect(bbox(d)).toEqual({ x0: 30, x1: 534, y0: 88, y1: 441 });
  });

  it("stays finite for collapsed panels mid-motion", () => {
    expect(finite(outlinePath({ ...panel, yf: panel.yp, tab: { tx0: 228, tx1: 336, ty: 0 } }))).toBe(true);
    expect(finite(outlinePath({ ...panel, x1: panel.x0, tab: { tx0: 30, tx1: 30, ty: 141 } }))).toBe(true);
  });

  it("fades the accent over min(64px, 60% of the panel height)", () => {
    expect(accentFade(212)).toBe(64);
    expect(accentFade(100)).toBe(60);
    expect(accentFade(-5)).toBe(0);
  });
});

describe("ribbon (§9.4)", () => {
  it("runs straight down a free channel under the parent", () => {
    const g = ribbonGeometry({ sx: 396, sy: 129, ex: 396, ey: 500, channel: 396, obstacles: [] });
    expect(g.path).toBe("M396 129 L396 500");
  });

  it("bends into a channel with parallel edges at the ribbon half-width", () => {
    const g = ribbonGeometry({ sx: 430, sy: 129, ex: 453, ey: 600, channel: 453, obstacles: [{ x0: 0, x1: 441, y0: 205, y1: 513 }] });
    const centre = points(g.path);
    expect(centre[0]).toEqual({ x: 430, y: 129 });
    expect(centre.at(-1)).toEqual({ x: 453, y: 600 });
    // The horizontal run happens in the gap above the first obstacle.
    expect(Math.max(...parse(g.path).filter(c => c.op === "C").flatMap(c => [c.args[1], c.args[3], c.args[5]]))).toBeLessThanOrEqual(205);
    for (const edge of [g.left, g.right]) {
      expect(edge).toHaveLength(g.left.length);
      for (const sample of edge) expect(Number.isFinite(sample.x) && Number.isFinite(sample.y)).toBe(true);
    }
    // Straight runs: each edge sample is RIBBON_HALF from the centre line's sample.
    const [l, r] = [g.left[0], g.right[0]];
    expect(Math.hypot(l.x - r.x, l.y - r.y)).toBeCloseTo(2 * RIBBON_HALF, 5);
  });

  it("uses large-radius bends for long horizontal runs and shrinks them mid-motion", () => {
    const route = { sx: 100, sy: 0, ex: 600, ey: 400, channel: 600, obstacles: [{ x0: 0, x1: 580, y0: 80, y1: 300 }] };
    expect(ribbonGeometry(route).path).toContain(" C");
    const compact = ribbonGeometry({ ...route, obstacles: [{ x0: 0, x1: 580, y0: 10, y1: 300 }] }, true);
    const ys = points(compact.path).map(p => p.y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(finite(compact.path)).toBe(true);
  });
});

describe("groupOutlines", () => {
  const { model } = modelFor(["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]);
  const group = model.geometry[0];
  const outlines = groupOutlines(group, model.metrics);

  it("draws one outline per panel, with a ribbon only for the stacked panel", () => {
    expect(outlines.map(o => o.path)).toEqual(group.boxes.map(b => b.path));
    expect(outlines.filter(o => o.ribbon).map(o => o.path)).toEqual([P("Codex")]);
    for (const o of outlines) expect(finite(o.d)).toBe(true);
  });

  it("links the parent tile's bottom to the label's top", () => {
    const codex = outlines.find(o => o.path === P("Codex"))!;
    const box = group.boxes.find(b => b.path === P("Codex"))!;
    const centre = points(codex.ribbon!);
    expect(centre[0].y).toBe(group.rowTop + model.metrics.tileHeight);
    expect(centre.at(-1)!.y).toBe(box.top - STACKED_LABEL_HEIGHT);
    // The joined contour covers the parent highlight, the ribbon and the panel.
    const b = bbox(codex.d);
    expect(b.y0).toBe(group.rowTop);
    expect(b.y1).toBe(box.top + box.height);
  });

  it("points each accent at its parent and keeps gradient stops ordered", () => {
    for (const [i, o] of outlines.entries()) {
      const box = group.boxes[i];
      const offsets = o.accent.stops.map(s => s.offset);
      expect(offsets.every((v, j) => v >= 0 && v <= 1 && (j === 0 || v >= offsets[j - 1]))).toBe(true);
      if (box.side === "below") expect(o.accent).toMatchObject({ y1: box.top, y2: box.top + accentFade(box.height) });
      if (box.side === "above") expect(o.accent).toMatchObject({ y1: box.top + box.height, y2: box.top + box.height - accentFade(box.height) });
    }
  });

  it("bridges each attached panel's band gap under its parent's tab, and nothing else (#1242)", () => {
    for (const [i, o] of outlines.entries()) {
      const box = group.boxes[i];
      if (box.side === "stacked") { expect(o.bridge).toBeNull(); continue; }
      const tab = tabX(box.col, model.metrics);
      const rowBottom = group.rowTop + model.metrics.tileHeight;
      // The gap between the row and the band, at the tab's x-range: never the
      // tile itself, never the panel itself.
      expect(o.bridge).toEqual(box.side === "below"
        ? { x: tab.x0, y: rowBottom, width: tab.x1 - tab.x0, height: box.top - rowBottom }
        : { x: tab.x0, y: box.top + box.height, width: tab.x1 - tab.x0, height: group.rowTop - box.top - box.height });
      expect(o.bridge!.height).toBeGreaterThan(0);
    }
    expect(outlines.some(o => o.bridge)).toBe(true);
  });

  it("is empty for a group without panels", () => {
    expect(groupOutlines(model.geometry[1], model.metrics)).toEqual([]);
  });
});
