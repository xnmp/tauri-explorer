import { describe, expect, it } from "vitest";
import {
  TAB_FILLET, TAB_LIGHT, islandAt, stripShadePath, tabContour, tabEdgePath, tabHoleFor, tabKeyShadow, tabSilhouettePath,
} from "$lib/domain/tab-seam";

/** Endpoints of every segment (M/L/A/H/V/Z) plus each arc's radius. */
function walk(d: string) {
  const points: { x: number; y: number }[] = [];
  const arcs: number[] = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  for (const [, cmd, args] of d.matchAll(/([MLAHVZ])([^MLAHVZ]*)/g)) {
    const v = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "M") { x = sx = v[0]; y = sy = v[1]; }
    else if (cmd === "L") { x = v[0]; y = v[1]; }
    else if (cmd === "H") x = v[0];
    else if (cmd === "V") y = v[0];
    else if (cmd === "A") { arcs.push(v[0]); x = v[5]; y = v[6]; }
    else { x = sx; y = sy; }
    points.push({ x, y });
  }
  for (const p of points) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true); }
  return { points, arcs, first: points[0], last: points[points.length - 1] };
}

const box = { left: 100, width: 200, top: 8, base: 38 };

describe("tabHoleFor", () => {
  it("claims the tab plus both fillet flares", () => {
    expect(tabHoleFor(box, TAB_FILLET)).toEqual({ left: 86, right: 314 });
  });

  it("keeps a zero-width hole for a tab starting its slide-in, so the mark never drops", () => {
    expect(tabHoleFor({ left: 120, width: 0 }, TAB_FILLET)).toEqual({ left: 120, right: 120 });
    expect(tabHoleFor({ left: 120, width: -5 }, TAB_FILLET)).toEqual({ left: 120, right: 120 });
    expect(tabHoleFor({ left: 120, width: Number.NaN }, TAB_FILLET)).toEqual({ left: 120, right: 120 });
  });

  it("has no hole without a tab or a usable position", () => {
    expect(tabHoleFor(null, TAB_FILLET)).toBeNull();
    expect(tabHoleFor(undefined, TAB_FILLET)).toBeNull();
    expect(tabHoleFor({ left: Number.POSITIVE_INFINITY, width: 10 }, TAB_FILLET)).toBeNull();
  });

  it("treats an unresolved fillet as no flare", () => {
    expect(tabHoleFor(box, Number.NaN)).toEqual({ left: 100, right: 300 });
  });
});

describe("tabContour", () => {
  it("narrows the corner radius to half of a tab narrower than two radii", () => {
    expect(tabContour({ ...box, width: 10 }, 14, 14).radius).toBe(5);
    expect(tabContour({ ...box, width: 0 }, 14, 14).radius).toBe(0);
  });

  it("keeps fillet and corner inside the tab height", () => {
    const short = tabContour({ left: 0, width: 200, top: 30, base: 38 }, 14, 14);
    expect(short.fillet).toBe(8);
    expect(short.radius).toBe(0);
    expect(short.fillet + short.radius).toBeLessThanOrEqual(8);
  });

  it("survives malformed input", () => {
    const c = tabContour({ left: Number.NaN, width: Number.NaN, top: Number.NaN, base: 38 }, -3, Number.NaN);
    expect(c).toEqual({ left: 0, right: 0, top: 38, base: 38, radius: 0, fillet: 0 });
    expect(() => tabSilhouettePath(c)).not.toThrow();
  });
});

describe("tab silhouette", () => {
  const c = tabContour(box, 14, 14);

  it("runs from the left fillet foot over the tab to the right foot and closes below the base", () => {
    const { points, arcs, first } = walk(tabSilhouettePath(c));
    expect(first).toEqual({ x: 86, y: 38 });
    expect(points).toContainEqual({ x: 314, y: 38 });
    expect(Math.min(...points.map(p => p.y))).toBe(8);
    expect(Math.max(...points.map(p => p.y))).toBe(39);
    // Fillets are true quarter circles of the fillet radius; corners of the tab radius.
    expect(arcs).toEqual([14, 14, 14, 14]);
  });

  it("grows and shrinks along its normal", () => {
    const inner = walk(tabSilhouettePath(c, -0.5));
    // A shrunk fill: sides move in, the concave fillet circle grows, the foot drops.
    expect(inner.points).toContainEqual({ x: 100.5, y: 24 });
    expect(inner.first).toEqual({ x: 86, y: 38.5 });
    expect(inner.arcs).toEqual([14.5, 13.5, 13.5, 14.5]);
  });

  it("degrades to a point-width tab without inverted geometry at fractional zoom", () => {
    const thin = tabContour({ left: 50.375, width: 0.4, top: 8.8, base: 38.4 }, 14, 0.2);
    const { points } = walk(tabSilhouettePath(thin, -0.5));
    const xs = points.map(p => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
  });

  it("the strip shade is the whole bar minus the shrunken tab", () => {
    expect(stripShadePath(800, 38, null)).toBe("M0 0H800V38H0Z");
    const d = stripShadePath(800, 38, c);
    expect(d.startsWith("M0 0H800V38H0Z")).toBe(true);
    expect(d.slice("M0 0H800V38H0Z".length)).toBe(tabSilhouettePath(c, -0.5));
    expect(stripShadePath(Number.NaN, -1, null)).toBe("M0 0H0V0H0Z");
  });
});

describe("tabEdgePath", () => {
  const c = tabContour(box, 14, 14);

  it("continues the island's inside border and fades through its rounded corners", () => {
    const island = { left: 6, right: 900, radius: 14 };
    const edge = tabEdgePath(c, { left: island, right: island });
    const { first, last, points, arcs } = walk(edge.d);
    expect(first).toEqual({ x: 6.5, y: 52 });
    expect(last).toEqual({ x: 899.5, y: 52 });
    // The run sits on the island border's centre line, half a pixel below the base.
    expect(points).toContainEqual({ x: 86, y: 38.5 });
    expect(points).toContainEqual({ x: 886, y: 38.5 });
    expect(arcs[0]).toBe(13.5);
    expect(edge).toMatchObject({ from: 6, to: 900, fadeIn: 14, fadeOut: 14 });
  });

  it("runs a short, fading reach where no island meets a foot", () => {
    const edge = tabEdgePath(c);
    expect(edge.from).toBe(86 - 28);
    expect(edge.to).toBe(314 + 28);
    expect(edge.fadeIn).toBe(28);
  });

  it("ignores islands that do not extend beyond the feet", () => {
    const edge = tabEdgePath(c, { left: { left: 90, right: 500, radius: 14 }, right: { left: 0, right: 310, radius: 14 } });
    expect(edge.from).toBe(58);
    expect(edge.to).toBe(342);
  });

  it("finds the island under a foot", () => {
    const islands = [{ left: 6, right: 246, radius: 14 }, { left: 254, right: 900, radius: 14 }];
    expect(islandAt(islands, 250)).toBeNull();
    expect(islandAt(islands, 300)).toBe(islands[1]);
  });
});

describe("tabKeyShadow", () => {
  it("falls away from the top-left light, shaped like the tab", () => {
    const c = tabContour(box, 14, 14);
    const shadow = tabKeyShadow(c);
    expect(shadow.dx).toBeGreaterThan(0);
    expect(shadow.dy).toBeGreaterThan(0);
    expect(shadow.silhouette).toBe(tabSilhouettePath(c, 0));
    expect(shadow.liftBlur).toBe(TAB_LIGHT.liftBlur);
  });
});
