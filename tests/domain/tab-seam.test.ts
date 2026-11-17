import { describe, expect, it } from "vitest";
import {
  TAB_FILLET, TAB_LIGHT, TAB_STRIP_PADDING, gutterRowsFor, islandAt, islandSquareFor, islandUnder, seamRowFor, tabFillPath, tabStripPadding, stripShadePath, tabContour, tabEdgePath, tabHoleFor, tabKeyShadow, tabSilhouettePath,
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

describe("seams and fill", () => {
  const c = tabContour(box, 14, 14);
  const hole = tabHoleFor(box, 14)!;

  it("opens only the island's straight top edge under the hole", () => {
    expect(seamRowFor(hole, { left: 6, right: 246, radius: 14 })).toEqual({ left: 86, right: 232 });
    expect(seamRowFor(hole, { left: 254, right: 900, radius: 14 })).toEqual({ left: 268, right: 314 });
    expect(seamRowFor(hole, { left: 310, right: 900, radius: 14 })).toBeNull();
    expect(seamRowFor({ left: 120, right: 120 }, { left: 0, right: 900, radius: 14 })).toBeNull();
  });

  it("wears the surface of the island under most of the tab", () => {
    const sidebar = { left: 6, right: 246, radius: 14 };
    const panes = { left: 254, right: 900, radius: 14 };
    expect(islandUnder([sidebar, panes], hole)).toBe(sidebar);
    expect(islandUnder([sidebar, panes], { left: 230, right: 470 })).toBe(panes);
    expect(islandUnder([sidebar], { left: 300, right: 400 })).toBeNull();
    expect(islandUnder([], hole)).toBeNull();
  });

  it("fills the silhouette down to the base and reaches into each seam row", () => {
    const d = tabFillPath(c, [{ left: 86, right: 232 }], 2);
    expect(d.startsWith(tabSilhouettePath(c, 0, 0))).toBe(true);
    const { points } = walk(d);
    expect(Math.max(...points.map(p => p.y))).toBe(40);
    expect(points).toContainEqual({ x: 232, y: 40 });
    expect(tabFillPath(c, [{ left: 86, right: 232 }], Number.NaN)).toBe(tabSilhouettePath(c, 0, 0));
  });
});

describe("the foot always stands on a straight top edge (#1734)", () => {
  const sidebar = { left: 6, right: 246, radius: 14 };
  const panes = { left: 254, right: 804, radius: 14 };
  const preview = { left: 812, right: 1094, radius: 14 };

  it("starts the strip over the content island, its first fillet past the island's corner", () => {
    // Strip padding box at x=0: the first tab starts at 254 + 14 + 14.
    const padding = tabStripPadding(panes, 0);
    expect(padding).toBe(254 + 14 + TAB_FILLET);
    const hole = tabHoleFor({ left: padding, width: 200 }, TAB_FILLET)!;
    expect(hole.left).toBe(panes.left + panes.radius);
    expect(islandSquareFor(hole, panes)).toEqual({ left: false, right: false });
    // The sidebar island lies wholly before the strip.
    expect(hole.left).toBeGreaterThan(sidebar.right);
  });

  it("keeps the default padding without a content island, and never goes below it", () => {
    expect(tabStripPadding(null, 0)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding({ left: 6, right: 900, radius: 14 }, 70)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding(panes, Number.NaN)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding({ left: Number.POSITIVE_INFINITY, right: 0, radius: 0 }, 0)).toBe(TAB_STRIP_PADDING);
    expect(tabStripPadding(panes, 0, -5)).toBe(254 + 28);
  });

  it("squares the corners a straddling foot reaches into, and only those", () => {
    const hole = { left: 678, right: 910 };
    expect(islandSquareFor(hole, panes)).toEqual({ left: false, right: true });
    expect(islandSquareFor(hole, preview)).toEqual({ left: true, right: false });
    expect(islandSquareFor(hole, sidebar)).toEqual({ left: false, right: false });
    // A foot ending exactly where the straight edge starts squares nothing.
    expect(islandSquareFor({ left: 268, right: 500 }, panes)).toEqual({ left: false, right: false });
    // Islands without corners are never squared.
    expect(islandSquareFor(hole, { ...panes, radius: 0 })).toEqual({ left: false, right: false });
  });

  it("opens squared corners as straight edge and bridges the gutter between them", () => {
    const hole = { left: 678, right: 910 };
    const square = (island: typeof panes) => ({ ...island, square: islandSquareFor(hole, island) });
    expect(seamRowFor(hole, panes, square(panes).square)).toEqual({ left: 678, right: 804 });
    expect(seamRowFor(hole, preview, square(preview).square)).toEqual({ left: 812, right: 910 });
    expect(gutterRowsFor(hole, [square(preview), square(panes)])).toEqual([{ left: 804, right: 812 }]);
    // No bridge unless both facing corners are squared under the foot.
    expect(gutterRowsFor({ left: 500, right: 790 }, [square(panes), { ...preview, square: { left: false, right: false } }])).toEqual([]);
    expect(gutterRowsFor(hole, [])).toEqual([]);
  });
});
