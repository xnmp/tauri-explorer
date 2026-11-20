/**
 * The marketing site's desktop (screenshots/design/website-rehaul/overhaul/desk-move.js): the geometry every window
 * on the Workshop page moves and resizes by.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

type Bounds = { x: number; y: number; w: number; h: number };
type Edges = { left: number; top: number; right: number; bottom: number };
interface TXMove {
  MIN: { w: number; h: number };
  KEEP: { x: number; bar: number };
  isBounds(b: unknown): boolean;
  fit(b: Bounds, area: Edges, reach?: Partial<Edges>): Bounds;
  clampPosition(b: Bounds, area: Edges, reach?: Partial<Edges>): Bounds;
  resize(start: Bounds, edge: string, dx: number, dy: number, area: Edges): Bounds;
  snapZone(p: { x: number; y: number } | null, area: Edges): "left" | "right" | "max" | null;
  halfOf(zone: "left" | "right", work: Edges, gap?: number): Bounds;
  unsnapAt(p: { x: number; y: number }, cur: Bounds, size: { w: number; h: number }): Bounds;
  settle(t: number): number;
}

let M: TXMove;
beforeAll(() => {
  // run as the page runs it: a classic script that sets a global (its own context, so nothing leaks into the suite)
  const context: { TXMove?: TXMove } = {};
  runInNewContext(readFileSync(new URL("../screenshots/design/website-rehaul/overhaul/desk-move.js", import.meta.url), "utf8"), context);
  M = context.TXMove!;
});

// a 1440×900 page: the top bar's 60px above, the bench from x 1012, the dock line at 836
const AREA: Edges = { left: 0, top: 60, right: 1440, bottom: 900 };
const REACH = { right: 1004, bottom: 830 };
const win: Bounds = { x: 100, y: 120, w: 900, h: 600 };

describe("keeping a window on the desktop", () => {
  it("leaves a window that is already on the desktop where it is", () => {
    expect(M.fit(win, AREA, REACH)).toEqual(win);
  });

  it("never lets the title bar go under the top bar", () => {
    expect(M.fit({ ...win, y: -500 }, AREA, REACH).y).toBe(AREA.top);
  });

  it("keeps the title bar above the dock line", () => {
    expect(M.fit({ ...win, y: 5000 }, AREA, REACH).y).toBe(REACH.bottom - M.KEEP.bar);
  });

  it("lets a window slide under the bench but keeps a grabbable piece of its title bar left of it", () => {
    const b = M.fit({ ...win, x: 3000 }, AREA, REACH);
    expect(b.x).toBe(REACH.right - M.KEEP.x);
    expect(b.x + b.w).toBeGreaterThan(REACH.right);   // the rest is beneath the bench
  });

  it("keeps a grabbable piece on screen at the left edge", () => {
    expect(M.fit({ ...win, x: -5000 }, AREA, REACH).x + win.w).toBe(M.KEEP.x);
  });

  it("shrinks a window larger than the desktop, and grows one below the minimum", () => {
    expect(M.fit({ x: 0, y: 60, w: 5000, h: 5000 }, AREA, REACH)).toMatchObject({ w: 1440, h: 840 });
    expect(M.fit({ ...win, w: 10, h: 10 }, AREA, REACH)).toMatchObject({ w: M.MIN.w, h: M.MIN.h });
  });

  it("on a desktop smaller than the minimum, fills it rather than overflowing", () => {
    const tiny = { left: 0, top: 60, right: 400, bottom: 300 };
    expect(M.fit({ x: 0, y: 60, w: 900, h: 600 }, tiny)).toMatchObject({ w: 400, h: 240 });
  });

  it("rejects malformed bounds (stored state from an older visit)", () => {
    for (const bad of [null, undefined, {}, { x: 1, y: 2, w: 3 }, { x: Number.NaN, y: 0, w: 1, h: 1 }, { x: "1", y: 0, w: 1, h: 1 }]) {
      expect(M.isBounds(bad)).toBe(false);
    }
    expect(M.isBounds(win)).toBe(true);
  });
});

describe("resizing from an edge", () => {
  it("moves only the dragged edges; the opposite ones stay put", () => {
    expect(M.resize(win, "se", 50, 40, AREA)).toEqual({ x: 100, y: 120, w: 950, h: 640 });
    expect(M.resize(win, "nw", -50, -40, AREA)).toEqual({ x: 50, y: 80, w: 950, h: 640 });
    expect(M.resize(win, "e", 30, 999, AREA)).toEqual({ ...win, w: 930 });
    expect(M.resize(win, "n", 999, 20, AREA)).toEqual({ ...win, y: 140, h: 580 });
  });

  it("stops at the minimum size without moving the opposite edge", () => {
    const b = M.resize(win, "nw", 2000, 2000, AREA);
    expect(b).toMatchObject({ w: M.MIN.w, h: M.MIN.h });
    expect(b.x + b.w).toBe(win.x + win.w);
    expect(b.y + b.h).toBe(win.y + win.h);
    expect(M.resize(win, "se", -2000, -2000, AREA)).toEqual({ ...win, w: M.MIN.w, h: M.MIN.h });
  });

  it("stops at the desktop's edges, the top edge at the top bar", () => {
    expect(M.resize(win, "n", 0, -1000, AREA).y).toBe(AREA.top);
    expect(M.resize(win, "w", -1000, 0, AREA).x).toBe(AREA.left);
    expect(M.resize(win, "se", 5000, 5000, AREA)).toMatchObject({ w: AREA.right - win.x, h: AREA.bottom - win.y });
  });
});

describe("snapping", () => {
  it("arms maximise at the top bar and the halves at the screen's side edges", () => {
    expect(M.snapZone({ x: 700, y: 30 }, AREA)).toBe("max");
    expect(M.snapZone({ x: 2, y: 400 }, AREA)).toBe("left");
    expect(M.snapZone({ x: 1439, y: 400 }, AREA)).toBe("right");
    expect(M.snapZone({ x: 700, y: 400 }, AREA)).toBeNull();
    expect(M.snapZone({ x: 700, y: 75 }, AREA)).toBeNull();   // a title bar resting at the top is not a snap
    expect(M.snapZone(null, AREA)).toBeNull();
    expect(M.snapZone({ x: Number.NaN, y: 0 }, AREA)).toBeNull();
  });

  it("splits the room beside the bench in two halves with a gap", () => {
    const work = { left: 24, top: 78, right: 1376, bottom: 824 };
    const l = M.halfOf("left", work, 16), r = M.halfOf("right", work, 16);
    expect(l).toEqual({ x: 24, y: 78, w: 668, h: 746 });
    expect(r.x + r.w).toBe(work.right);
    expect(r.x - (l.x + l.w)).toBe(16);
  });

  it("never makes a half narrower than the app's minimum: on a narrow desktop the halves overlap", () => {
    const work = { left: 24, top: 78, right: 1000, bottom: 824 };
    expect(M.halfOf("left", work).w).toBe(M.MIN.w);
    expect(M.halfOf("right", work).x).toBe(1000 - M.MIN.w);
  });

  it("a window pulled off a snap takes its old size with the pointer at the same place along its title bar", () => {
    const max = { x: 12, y: 70, w: 1300, h: 760 };
    const p = { x: 12 + 1300 * 0.75, y: 90 };
    const b = M.unsnapAt(p, max, { w: 800, h: 500 });
    expect(b).toMatchObject({ w: 800, h: 500, y: 70 });
    expect((p.x - b.x) / b.w).toBeCloseTo(0.75, 2);
  });

  it("eases from 0 to 1 without overshoot, clamped outside", () => {
    expect(M.settle(0)).toBe(0);
    expect(M.settle(1)).toBe(1);
    expect(M.settle(2)).toBe(1);
    expect(M.settle(-1)).toBe(0);
    for (let t = 0; t <= 1; t += 0.05) expect(M.settle(t)).toBeLessThanOrEqual(1);
  });
});
