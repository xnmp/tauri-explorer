/**
 * The marketing site's newcomer guide (screenshots/design/website-rehaul/overhaul/guide-core.js): which events tick
 * the "Try this" steps, how stored progress is read, where a hint may sit, and how the phone's sheet settles.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

type Rect = { x: number; y: number; w: number; h: number };
type Room = { left: number; top: number; right: number; bottom: number };
type Progress = { v: 1; done: string[]; welcomed: boolean; open: boolean; dismissed: boolean; firstFs: string | null };
interface Step { id: string; core: boolean; title: string; tour: string; line?: string }
interface TXGuideCore {
  STEPS: Step[];
  CORE: string[];
  TOUR: string[];
  FRESH: Progress;
  readProgress(raw: unknown): Progress;
  coreCount(p: Progress): number;
  allCore(p: Progress): boolean;
  nextCore(p: Progress): string | null;
  completes(e: unknown): string[];
  observe(p: Progress, e: unknown): Progress;
  shouldWelcome(p: Progress, o?: { sharedSetup?: boolean; arriving?: boolean; midStory?: boolean }): boolean;
  placeHint(target: Rect, size: { w: number; h: number }, view: Room, o?: { gap?: number; order?: string[]; avoid?: Rect[] }): { x: number; y: number; side: string; arrow: number } | null;
  settleDetent(detents: number[], height: number, velocity?: number): number;
  nextDetent(count: number, at: number): number;
  rubber(height: number, min: number, max: number, limit?: number): number;
}

let G: TXGuideCore;
beforeAll(() => {
  const context: { TXGuideCore?: TXGuideCore } = {};
  runInNewContext(readFileSync(new URL("../screenshots/design/website-rehaul/overhaul/guide-core.js", import.meta.url), "utf8"), context);
  G = context.TXGuideCore!;
});

const fresh = () => G.readProgress(null);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the steps", () => {
  it("has five checklist steps, all of them in the phone tour, in the same order", () => {
    expect(G.CORE).toHaveLength(5);
    expect(G.TOUR.filter((id) => G.CORE.includes(id))).toEqual(G.CORE);
  });
  it("keeps the copy short, in sentence case, without exclamation marks", () => {
    for (const s of G.STEPS) {
      for (const text of [s.title, s.tour, s.line ?? ""]) {
        expect(text).not.toMatch(/!/);
        expect(text.length).toBeLessThan(110);
      }
      expect(s.title[0]).toBe(s.title[0].toUpperCase());
      expect(s.title.split(" ").slice(1).every((w) => w === w.toLowerCase())).toBe(true);
    }
  });
});

describe("stored progress", () => {
  it("reads a well-formed record, dropping unknown and repeated steps", () => {
    const p = G.readProgress(JSON.stringify({ v: 1, done: ["goto", "goto", "nope", 3], welcomed: true, open: true, dismissed: false, firstFs: "count" }));
    expect(p.done).toEqual(["goto"]);
    expect(p.welcomed).toBe(true);
    expect(p.firstFs).toBe("count");
  });
  it.each([
    ["nothing", null],
    ["broken JSON", "{not json"],
    ["an array", "[1,2]"],
    ["another version", JSON.stringify({ v: 2, done: ["goto"], welcomed: true })],
    ["a number", 42],
  ])("treats %s as a fresh visit", (_label, raw) => {
    const p = G.readProgress(raw);
    expect(p.done).toEqual([]);
    expect(p.welcomed).toBe(false);
  });
  it("refuses odd machine ids and non-boolean flags", () => {
    const p = G.readProgress({ v: 1, done: "goto", welcomed: "yes", firstFs: "../../etc" + "x".repeat(60) });
    expect(p).toMatchObject({ done: [], welcomed: false, firstFs: null });
  });
  it("survives a very large record", () => {
    const done = Array.from({ length: 100_000 }, (_, i) => (i % 2 ? "theme" : `junk-${i}`));
    expect(G.readProgress({ v: 1, done }).done).toEqual(["theme"]);
  });
});

describe("what completes a step", () => {
  it("ticks Jump to a file only for Quick Open, not the palette", () => {
    expect(G.completes({ type: "overlay", kind: "quick-open" })).toEqual(["goto"]);
    expect(G.completes({ type: "overlay", kind: "command-palette" })).toEqual([]);
    expect(G.completes({ type: "overlay", kind: null })).toEqual([]);
  });
  it("ticks a panel when the visitor turns one on or off, but not when the page fits a setup", () => {
    const before = { sidebar: true, preview: false }, after = { sidebar: true, preview: true };
    expect(G.completes({ type: "panels", before, after })).toEqual(["panel"]);
    expect(G.completes({ type: "panels", before, after, cause: "page" })).toEqual([]);
    expect(G.completes({ type: "panels", before, after: { ...before } })).toEqual([]);
  });
  it("ticks the theme for a real change, custom colours included", () => {
    expect(G.completes({ type: "theme", before: "light", after: "nord" })).toEqual(["theme"]);
    expect(G.completes({ type: "theme", before: { v: ["#000"] }, after: { v: ["#111"] } })).toEqual(["theme"]);
    expect(G.completes({ type: "theme", before: "nord", after: "nord" })).toEqual([]);
    expect(G.completes({ type: "theme", before: "light", after: "nord", cause: "page" })).toEqual([]);
  });
  it("ticks a setup only when the window wears one, and a machine only once it differs from the first", () => {
    expect(G.completes({ type: "setup", id: "darkroom" })).toEqual(["setup"]);
    expect(G.completes({ type: "setup", id: null })).toEqual([]);
    expect(G.completes({ type: "machine", here: "count", first: "default" })).toEqual(["machine"]);
    expect(G.completes({ type: "machine", here: "default", first: "default" })).toEqual([]);
  });
  it.each([null, undefined, 7, "overlay", [], { type: "unknown" }, { type: "panels" }])("ignores malformed input %j", (e) => {
    expect(G.completes(e)).toEqual([]);
  });
  it("observing all five finishes the list, without mutating the earlier progress", () => {
    const start = fresh();
    const events = [
      { type: "overlay", kind: "quick-open" },
      { type: "theme", before: "light", after: "dark" },
      { type: "panels", before: { preview: false }, after: { preview: true } },
      { type: "setup", id: "git" },
      { type: "machine", here: "count", first: "default" },
    ];
    let p = start;
    for (const e of events) p = G.observe(p, e);
    expect(G.allCore(p)).toBe(true);
    expect(G.nextCore(p)).toBeNull();
    expect(start.done).toEqual([]);
    expect(G.observe(p, events[0])).toBe(p); // already done: the same record
  });
  it("names the next step in checklist order", () => {
    const p = G.observe(fresh(), { type: "overlay", kind: "quick-open" });
    expect(G.coreCount(p)).toBe(1);
    expect(G.nextCore(p)).toBe(G.CORE[1]);
  });
});

describe("who is welcomed", () => {
  it("greets a first visit only", () => {
    expect(G.shouldWelcome(fresh())).toBe(true);
    expect(G.shouldWelcome({ ...fresh(), welcomed: true })).toBe(false);
    expect(G.shouldWelcome(fresh(), { sharedSetup: true })).toBe(false);
    expect(G.shouldWelcome(fresh(), { arriving: true })).toBe(false);
    expect(G.shouldWelcome(fresh(), { midStory: true })).toBe(false);
  });
});

describe("placing a hint", () => {
  const room: Room = { left: 0, top: 0, right: 800, bottom: 600 };
  const size = { w: 220, h: 60 };
  it("sits below its target, clear of it, with the arrow at the target's centre", () => {
    const target = { x: 100, y: 100, w: 80, h: 30 };
    const r = G.placeHint(target, size, room)!;
    expect(r.side).toBe("below");
    expect(overlaps({ ...r, ...size }, target)).toBe(false);
    expect(r.x + r.arrow).toBe(140);
  });
  it("goes above when there is no room below, and never covers the target", () => {
    const target = { x: 300, y: 560, w: 100, h: 30 };
    const r = G.placeHint(target, size, room)!;
    expect(r.side).toBe("above");
    expect(overlaps({ ...r, ...size }, target)).toBe(false);
  });
  it("stays inside the room near an edge", () => {
    const r = G.placeHint({ x: 780, y: 100, w: 20, h: 20 }, size, room)!;
    expect(r.x + size.w).toBeLessThanOrEqual(800);
    expect(r.x).toBeGreaterThanOrEqual(0);
  });
  it("keeps clear of rects to avoid (the window being moved), or shows nothing", () => {
    const target = { x: 300, y: 300, w: 100, h: 30 };
    const avoid = [{ x: 0, y: 0, w: 800, h: 600 }];
    expect(G.placeHint(target, size, room, { avoid })).toBeNull();
    const below = { x: 0, y: 330, w: 800, h: 270 };
    const r = G.placeHint(target, size, room, { avoid: [below] })!;
    expect(r.side).toBe("above");
  });
  it("never overlaps its target across a sweep of positions", () => {
    for (let x = 0; x <= 780; x += 60) for (let y = 0; y <= 580; y += 40) {
      const target = { x, y, w: 20, h: 20 };
      const r = G.placeHint(target, size, room);
      if (r) expect(overlaps({ ...r, ...size }, target)).toBe(false);
    }
  });
  it.each([
    ["no target", null],
    ["a NaN target", { x: NaN, y: 0, w: 10, h: 10 }],
    ["a negative size target", { x: 0, y: 0, w: -1, h: 10 }],
  ])("returns null for %s", (_l, target) => {
    expect(G.placeHint(target as Rect, size, room)).toBeNull();
  });
  it("returns null when the hint is bigger than the room", () => {
    expect(G.placeHint({ x: 10, y: 10, w: 10, h: 10 }, { w: 2000, h: 60 }, room)).toBeNull();
    expect(G.placeHint({ x: 10, y: 10, w: 10, h: 10 }, { w: 0, h: 60 }, room)).toBeNull();
  });
});

describe("the phone's sheet", () => {
  const D = [130, 450, 780];
  it("settles on the nearest detent when let go slowly", () => {
    expect(G.settleDetent(D, 140, 0)).toBe(0);
    expect(G.settleDetent(D, 420, 0)).toBe(1);
    expect(G.settleDetent(D, 700, 0)).toBe(2);
  });
  it("carries on with the throw's speed", () => {
    expect(G.settleDetent(D, 300, 1.5)).toBe(1);   // 300 + 270 = 570: nearer the middle
    expect(G.settleDetent(D, 300, 3)).toBe(2);     // 300 + 540 = 840: the top
    expect(G.settleDetent(D, 300, -1.5)).toBe(0);
  });
  it("moves at least one detent for a quick flick from rest at a detent", () => {
    expect(G.settleDetent(D, 450, 0.5)).toBe(2);
    expect(G.settleDetent(D, 450, -0.5)).toBe(0);
    expect(G.settleDetent(D, 780, 3)).toBe(2);       // already at the top
  });
  it("accepts unsorted or dirty detents and odd numbers", () => {
    expect(G.settleDetent([780, NaN, 130, 450] as number[], 460)).toBe(1);
    expect(G.settleDetent([], 460)).toBe(0);
    expect(G.settleDetent(null as unknown as number[], 460)).toBe(0);
    expect(G.settleDetent(D, NaN, NaN)).toBe(0);
    expect(G.settleDetent(D, 1e12, 1e9)).toBe(2);
  });
  it("taps the handle up through the detents and back down to the peek", () => {
    expect([0, 1, 2].map((at) => G.nextDetent(3, at))).toEqual([1, 2, 0]);
    expect(G.nextDetent(3, NaN)).toBe(1);
    expect(G.nextDetent(0, 2)).toBe(0);
  });
  it("resists a drag past either end, by half, up to a limit", () => {
    expect(G.rubber(300, 130, 780)).toBe(300);
    expect(G.rubber(100, 130, 780)).toBe(115);
    expect(G.rubber(-1000, 130, 780)).toBe(90);
    expect(G.rubber(800, 130, 780)).toBe(790);
    expect(G.rubber(5000, 130, 780, 40)).toBe(820);
  });
});
