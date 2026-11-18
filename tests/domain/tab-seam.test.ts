import { describe, expect, it } from "vitest";
import {
  SURFACE_TAB_GAP, TAB_FILLET, TAB_LIGHT, TAB_STRIP_PADDING, stripShadePath, surfaceCorners, surfaceEdgePath, surfacePocketsPath,
  tabContour, tabHoleFor, tabKeyShadow, tabShownSpan, tabSilhouettePath, tabStripPadding,
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

  it("the strip shade is the whole bar minus the shrunken tab, opened only inside the viewport", () => {
    expect(stripShadePath(800, 38, null)).toBe("M0 0V38H800V0Z");
    const d = stripShadePath(800, 38, c, { left: 20, right: 600 });
    // Strip beside the viewport drawn twice, so the clockwise silhouette
    // (winding +1) cannot cancel it under nonzero filling; once inside it.
    expect(d).toBe(
      "M0 0V38H20V0ZM600 0V38H800V0Z".repeat(2) + "M20 0V38H600V0Z" + tabSilhouettePath(c, -0.5),
    );
    expect(stripShadePath(800, 38, c)).toBe("M0 0V38H800V0Z" + tabSilhouettePath(c, -0.5));
    expect(stripShadePath(Number.NaN, -1, null)).toBe("");
  });

  it("orients the silhouette opposite to the strip so it cuts a hole", () => {
    // Shoelace sign: the strip rectangle and the tab must wind in opposite directions.
    const area = (d: string) => {
      const { points } = walk(d);
      return points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + (p.x * q.y - q.x * p.y);
      }, 0);
    };
    expect(Math.sign(area("M0 0V38H800V0Z"))).toBe(-Math.sign(area(tabSilhouettePath(c, -0.5))));
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

describe("the tab's surface (#1785)", () => {
  const surface = { left: 0, right: 800, radius: 14 };
  const c = tabContour(box, 14, 14);
  const hole = tabHoleFor(box, TAB_FILLET)!;

  it("rounds both top corners fully while the tab's foot stays clear of them", () => {
    expect(surfaceCorners(surface, null)).toEqual({ left: 14, right: 14 });
    expect(surfaceCorners(surface, hole)).toEqual({ left: 14, right: 14 });
  });

  it("narrows a corner the foot reaches into, so it ends where the foot begins", () => {
    expect(surfaceCorners(surface, { left: 6, right: 240 })).toEqual({ left: 6, right: 14 });
    expect(surfaceCorners(surface, { left: 560, right: 795 })).toEqual({ left: 14, right: 5 });
    // A foot past the window's edge squares the corner; it never inverts.
    expect(surfaceCorners(surface, { left: -3, right: 900 })).toEqual({ left: 0, right: 0 });
  });

  it("never rounds a corner past half the surface, and survives malformed geometry", () => {
    expect(surfaceCorners({ left: 0, right: 20, radius: 14 }, null)).toEqual({ left: 10, right: 10 });
    const odd = surfaceCorners({ left: Number.NaN, right: Number.POSITIVE_INFINITY, radius: -4 }, { left: Number.NaN, right: 3 });
    expect(Number.isFinite(odd.left) && odd.left >= 0).toBe(true);
    expect(Number.isFinite(odd.right) && odd.right >= 0).toBe(true);
  });

  it("shades the pockets outside each rounded corner, running half a pixel under the outline", () => {
    const d = surfacePocketsPath(surface, 38, { left: 14, right: 14 });
    const [left, right] = d.split("Z").filter(Boolean).map((part) => walk(`${part}Z`));
    // Left pocket: the window's corner square, minus the quarter disc the surface keeps.
    expect(left.first).toEqual({ x: 0, y: 38 });
    expect(left.points).toContainEqual({ x: 14, y: 38.5 });
    expect(left.points).toContainEqual({ x: 0.5, y: 52 });
    expect(left.arcs).toEqual([13.5]);
    expect(right.first).toEqual({ x: 800, y: 38 });
    expect(right.points).toContainEqual({ x: 799.5, y: 52 });
    expect(right.points).toContainEqual({ x: 786, y: 38.5 });
    expect(right.arcs).toEqual([13.5]);
    // Everything stays below the base, in the corner squares.
    for (const p of [...left.points, ...right.points]) {
      expect(p.y).toBeGreaterThanOrEqual(38);
      expect(p.y).toBeLessThanOrEqual(52);
    }
  });

  it("leaves no pocket beside a squared corner", () => {
    expect(surfacePocketsPath(surface, 38, { left: 0, right: 0 })).toBe("");
    expect(surfacePocketsPath(surface, 38, { left: 0, right: 14 }).startsWith("M800 38")).toBe(true);
  });

  it("strokes one open outline: up the left corner, along the top edge, over the tab, down the right corner", () => {
    const d = surfaceEdgePath(c, 1, surface, 38, { left: 14, right: 14 });
    expect(d.match(/M/g)).toHaveLength(1);
    const { points, arcs, first, last } = walk(d);
    // From the window's left edge, half a stroke in, round the corner...
    expect(first).toEqual({ x: 0.5, y: 52 });
    expect(points[1]).toEqual({ x: 14, y: 38.5 });
    expect(arcs[0]).toBe(13.5);
    // ...along the top edge on the stroke's centre line to the tab's left foot...
    expect(points[2]).toEqual({ x: 86, y: 38.5 });
    // ...over the tab (half a stroke inside its top)...
    expect(Math.min(...points.map((p) => p.y))).toBe(8.5);
    // ...and round the right corner down to the window's right edge.
    expect(last).toEqual({ x: 799.5, y: 52 });
    expect(arcs[arcs.length - 1]).toBe(13.5);
    expect(points).toContainEqual({ x: 786, y: 38.5 });
  });

  it("runs the top edge straight between the corners with no shown tab", () => {
    expect(surfaceEdgePath(null, 1, surface, 38, { left: 14, right: 14 })).toBe(
      "M0.5 52A13.5 13.5 0 0 1 14 38.5L786 38.5A13.5 13.5 0 0 1 799.5 52",
    );
  });

  it("starts at the window's edge beside a squared corner, and survives a malformed stroke width", () => {
    const d = surfaceEdgePath(null, Number.NaN, surface, 38, { left: 0, right: 0 });
    expect(d).toBe("M0 38.5L800 38.5");
    expect(surfaceEdgePath(null, 2, surface, 38, { left: 14, right: 14 })).toBe(
      "M1 52A13 13 0 0 1 14 39L786 39A13 13 0 0 1 799 52",
    );
  });

  it("starts the strip so the first tab's whole curve lies past the surface's corner", () => {
    const padding = tabStripPadding(surface, 0);
    expect(padding).toBe(14 + SURFACE_TAB_GAP + TAB_FILLET);
    const first = tabHoleFor({ left: padding, width: 200 }, TAB_FILLET)!;
    expect(first.left).toBe(surface.radius + SURFACE_TAB_GAP);
    expect(surfaceCorners(surface, first)).toEqual({ left: 14, right: 14 });
  });

  it("keeps the floor where the strip already starts further right (macOS traffic lights)", () => {
    expect(tabStripPadding(surface, 70)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding(null, 0)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding(surface, Number.NaN)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding({ left: Number.POSITIVE_INFINITY, right: 0, radius: 0 }, 0)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding(surface, 0, -5)).toBe(30);
    expect(tabStripPadding(surface, 0, 40)).toBe(40);
  });
});

describe("the outline rises only out of a shown tab (#1734)", () => {
  const view = { left: 267, right: 371 };

  it("shows nothing of a tab scrolled past either end", () => {
    expect(tabShownSpan({ left: 414, right: 488 }, view)).toBeNull();
    expect(tabShownSpan({ left: 150, right: 267 }, view)).toBeNull();
  });

  it("clips a tab half under an edge to the edge", () => {
    expect(tabShownSpan({ left: 330, right: 404 }, view)).toEqual({ left: 330, right: 371 });
    expect(tabShownSpan({ left: 280, right: 354 }, view)).toEqual({ left: 280, right: 354 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("shows nothing for unmeasured geometry %s", (value) => {
    expect(tabShownSpan({ left: value, right: 400 }, view)).toBeNull();
  });
});
