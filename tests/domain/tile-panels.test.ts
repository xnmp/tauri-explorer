import { describe, expect, it } from "vitest";
import {
  bandHeight, buildTilePanelModel, cellX, chooseSide, clampPreferredHeight, computeBands, defaultPanelHeight,
  gripKeyHeight, groupOffsets, panelFades, panelGridColumns, panelHeightBounds, panelMoreCount, panelTileLayout, panelX, placePanels,
  placementSides, ribbonChannel, segmentX, splitColumns, stackedLabelX, tabX,
  BAND_GAP, DETOUR_BELOW_MARGIN, DETOUR_STACKED_MARGIN, MIN_PANEL_COLUMNS, PANEL_PAD_X, PANEL_PAD_Y, STACKED_MARGIN,
  type BandSide, type ColumnSegment, type PanelPlacement, type PanelRequest, type RowMetrics,
} from "$lib/domain/tile-panels";
import { tileLayout } from "$lib/domain/tile-layout";
import { D, F, KIDS, MEDIUM, P, ROOT, modelFor, rowsFor, sides, widthFor } from "./tile-panels-fixture";

/** The mock's search (docs/execution-plans/folder-peek-mock.html), ported as an
 * independent oracle: candidates by distance from the midpoint, backtracking. */
function mockSplit(parents: number[], C: number, minW: number): ColumnSegment[] | null {
  const k = parents.length;
  if (k === 0) return [];
  const starts = [0];
  const solve = (i: number): boolean => {
    if (i === k - 1) return C - starts[i] >= minW;
    const lo = Math.max(parents[i] + 1, starts[i] + minW);
    const hi = Math.min(parents[i + 1], C - minW * (k - 1 - i));
    const mid = Math.floor((parents[i] + parents[i + 1]) / 2) + 1;
    const cands: number[] = [];
    for (let s = lo; s <= hi; s++) cands.push(s);
    cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    for (const s of cands) {
      starts[i + 1] = s;
      if (solve(i + 1)) return true;
    }
    starts.length = i + 1;
    return false;
  };
  if (!solve(0)) return null;
  return starts.map((s, i) => ({ start: s, end: i + 1 < k ? starts[i + 1] - 1 : C - 1 }));
}

/** Brute-force feasibility: does any split into valid segments exist? */
function feasible(parents: number[], C: number, minW = MIN_PANEL_COLUMNS): boolean {
  const go = (i: number, start: number): boolean => {
    if (i === parents.length) return start === C;
    for (let end = start + minW - 1; end < C; end++) {
      if (parents[i] >= start && parents[i] <= end && (i + 1 === parents.length ? end === C - 1 : parents[i + 1] > end) && go(i + 1, end + 1)) return true;
    }
    return false;
  };
  return parents.length === 0 || go(0, 0);
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const seg = (segments: readonly ColumnSegment[] | null) => segments?.map(s => `${s.start}-${s.end}`).join("|") ?? null;

describe("splitColumns (§9.1 feasibility)", () => {
  it("prefers the midpoint split between consecutive parents", () => {
    expect(seg(splitColumns([1, 4], 7))).toBe("0-2|3-6");
    expect(seg(splitColumns([2, 5], 7))).toBe("0-3|4-6");
    expect(seg(splitColumns([1, 4, 7], 9))).toBe("0-2|3-5|6-8");
    expect(seg(splitColumns([0], 7))).toBe("0-6");
  });

  it("falls back to the nearest feasible boundary", () => {
    // Midpoint 5 would leave the last parent a 2-column segment.
    expect(seg(splitColumns([3, 5], 7))).toBe("0-3|4-6");
    // Midpoint 2 would leave the first parent only two columns.
    expect(seg(splitColumns([0, 3], 7))).toBe("0-2|3-6");
  });

  it("is infeasible when segments cannot each hold their parent and three columns", () => {
    expect(splitColumns([1, 2], 7)).toBeNull();
    expect(splitColumns([0, 1, 4], 7)).toBeNull();
    expect(splitColumns([0, 3, 6, 8], 11)).toBeNull();
  });

  it("C < 3 admits no band at all", () => {
    expect(splitColumns([0], 2)).toBeNull();
    expect(splitColumns([1], 1)).toBeNull();
    expect(seg(splitColumns([2], 3))).toBe("0-2");
  });

  it("splits many panels across one wide row", () => {
    expect(seg(splitColumns([0, 3, 6, 9], 12))).toBe("0-2|3-5|6-8|9-11");
    expect(seg(splitColumns([1, 5, 9, 13, 17], 20))).toBe("0-3|4-7|8-11|12-15|16-19");
    expect(splitColumns([0, 3, 6, 9, 11], 12)).toBeNull();
  });

  it("rejects malformed parents and column counts", () => {
    expect(splitColumns([], 7)).toEqual([]);
    expect(splitColumns([Number.NaN], 7)).toBeNull();
    expect(splitColumns([1.5], 7)).toBeNull();
    expect(splitColumns([-1], 7)).toBeNull();
    expect(splitColumns([7], 7)).toBeNull();
    expect(splitColumns([2, 2], 7)).toBeNull();
    expect(splitColumns([1], Number.NaN)).toBeNull();
    expect(splitColumns([1], Number.POSITIVE_INFINITY)).toBeNull();
    // Unsorted input is the same band; a fractional column count floors.
    expect(seg(splitColumns([4, 1], 7))).toBe("0-2|3-6");
    expect(seg(splitColumns([1, 4], 7.9))).toBe("0-2|3-6");
  });

  it("matches the mock's backtracking search and brute-force feasibility on random bands", () => {
    const random = seeded(1241);
    for (let trial = 0; trial < 4000; trial++) {
      const C = 1 + Math.floor(random() * 16);
      const k = 1 + Math.floor(random() * 5);
      const cols = [...new Set(Array.from({ length: k }, () => Math.floor(random() * C)))].sort((a, b) => a - b);
      const got = splitColumns(cols, C);
      expect(seg(got), `C=${C} parents=${cols}`).toBe(seg(mockSplit(cols, C, MIN_PANEL_COLUMNS)));
      expect(got !== null, `C=${C} parents=${cols}`).toBe(feasible(cols, C));
      for (const [i, s] of (got ?? []).entries()) {
        expect(s.end - s.start + 1).toBeGreaterThanOrEqual(MIN_PANEL_COLUMNS);
        expect(cols[i]).toBeGreaterThanOrEqual(s.start);
        expect(cols[i]).toBeLessThanOrEqual(s.end);
      }
    }
  });
});

describe("placement (§9.1)", () => {
  // The mock's own selfTest presets, in the mock's folder order at C = 7.
  const MOCK = ["Inbox", "Career", "Codex", "Personal", "Archive", "AI Draft Archive"];
  const ORDERS: Record<string, string[]> = {
    single: ["Career"], split: ["Career", "Archive"], above: ["Career", "Archive", "Inbox"],
    stacked: ["Career", "Archive", "Inbox", "AI Draft Archive", "Codex"],
  };
  const replay = (order: string[]) => placePanels(order.map(name => ({ path: name, index: MOCK.indexOf(name) })), 7);
  const label = (placements: PanelPlacement[]) => placements.map(p => `${p.path}:${p.side}`);
  const bands = (placements: PanelPlacement[]) => computeBands(placements, 7).map(b => `${b.key}[${seg(b.segments)}]`);

  it("reproduces the mock selfTest presets", () => {
    expect(label(replay(ORDERS.single))).toEqual(["Career:below"]);
    expect(label(replay(ORDERS.split))).toEqual(["Career:below", "Archive:below"]);
    expect(label(replay(ORDERS.above))).toEqual(["Career:below", "Archive:below", "Inbox:above"]);
    expect(label(replay(ORDERS.stacked))).toEqual(["Career:below", "Archive:below", "Inbox:above", "AI Draft Archive:above", "Codex:stacked"]);
    expect(bands(replay(ORDERS.stacked))).toEqual(["0-above[0-2|3-6]", "0-below[0-2|3-6]", "0-stacked-Codex[0-6]"]);
  });

  it("the app's name order reaches the same four presets", () => {
    expect(sides(modelFor(["Career"]).model)).toEqual(["Career:below"]);
    expect(sides(modelFor(["Career", "Personal"]).model)).toEqual(["Career:below", "Personal:below"]);
    expect(sides(modelFor(["Career", "Personal", "Inbox"]).model)).toEqual(["Career:below", "Personal:below", "Inbox:above"]);
    expect(sides(modelFor(["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]).model))
      .toEqual(["Career:below", "Personal:below", "Inbox:above", "AI Draft Archive:above", "Codex:stacked"]);
  });

  it("chooses below, then above, then stacked", () => {
    const placed: PanelPlacement[] = [{ path: "a", row: 0, col: 1, side: "below" }];
    expect(chooseSide(placed, 0, 5, 7)).toBe("below");
    expect(chooseSide(placed, 0, 2, 7)).toBe("above");
    expect(chooseSide([...placed, { path: "b", row: 0, col: 0, side: "above" }], 0, 2, 7)).toBe("stacked");
    // Other rows' bands never interfere.
    expect(chooseSide(placed, 1, 2, 7)).toBe("below");
  });

  it("stacks everything when C < 3", () => {
    const placed = placePanels([{ path: "a", index: 0 }, { path: "b", index: 3 }], 2);
    expect(placed.map(p => p.side)).toEqual(["stacked", "stacked"]);
    expect(computeBands(placed, 2).map(b => seg(b.segments))).toEqual(["0-1", "0-1"]);
  });

  it("fills a wide row: below, then above, then stacked panels in opening order", () => {
    const open: PanelRequest[] = [0, 3, 6, 9, 4, 1, 7, 10, 2].map(index => ({ path: `f${index}`, index }));
    const placed = placePanels(open, 12);
    expect(placed.map(p => `${p.path}:${p.side}`)).toEqual([
      "f0:below", "f3:below", "f6:below", "f9:below", "f4:above", "f1:above", "f7:above", "f10:above", "f2:stacked",
    ]);
    expect(computeBands(placed, 12).map(b => b.key)).toEqual(["0-above", "0-below", "0-stacked-f2"]);
  });

  it("opening never moves an existing panel; closing only re-splits", () => {
    const random = seeded(77);
    for (let trial = 0; trial < 300; trial++) {
      const C = 3 + Math.floor(random() * 8);
      const indices = [...new Set(Array.from({ length: 1 + Math.floor(random() * 2 * C) }, () => Math.floor(random() * 2 * C)))];
      let open: PanelRequest[] = [];
      let placed: PanelPlacement[] = [];
      for (const index of indices) {
        const before = placementSides(placed);
        open = [...open, { path: `f${index}`, index }];
        placed = placePanels(open, C, before);
        for (const [path, side] of before) expect(placed.find(p => p.path === path)?.side).toBe(side);
        for (const band of computeBands(placed, C)) expect(band.side === "stacked" || splitColumns(band.members.map(m => m.col), C) !== null).toBe(true);
      }
      while (open.length) {
        const gone = open[Math.floor(random() * open.length)];
        const before = placementSides(placed);
        open = open.filter(o => o !== gone);
        placed = placePanels(open, C, before);
        expect(placed.map(p => p.side)).toEqual(open.map(o => before.get(o.path)));
      }
    }
  });

  it("a column-count change keeps each side while feasible, re-placing the rest in opening order", () => {
    // At C = 5, P (index 3) is forced above by Q (index 4) below in the same row.
    const open: PanelRequest[] = [{ path: "Q", index: 4 }, { path: "P", index: 3 }];
    const at5 = placePanels(open, 5);
    expect(at5.map(p => p.side)).toEqual(["below", "above"]);
    // At C = 4, Q wraps to the next row: P's below band would now fit, but P keeps its side.
    expect(placePanels(open, 4, placementSides(at5)).map(p => p.side)).toEqual(["below", "above"]);
    // The mock re-places everything instead (a replay without memory).
    expect(placePanels(open, 4).map(p => p.side)).toEqual(["below", "below"]);
    // Infeasible after the change: the later member is re-placed.
    const three: PanelRequest[] = [1, 4, 7].map(index => ({ path: `f${index}`, index }));
    const at9 = placePanels(three, 9);
    expect(at9.map(p => p.side)).toEqual(["below", "below", "below"]);
    expect(placePanels(three, 8, placementSides(at9)).map(p => p.side)).toEqual(["below", "below", "above"]);
    // Stacked stays stacked, even when a band would fit again.
    expect(placePanels([{ path: "s", index: 0 }], 7, new Map<string, BandSide>([["s", "stacked"]]))[0].side).toBe("stacked");
  });

  it("ignores malformed requests", () => {
    expect(placePanels([{ path: "a", index: 1 }], Number.NaN)).toEqual([]);
    expect(placePanels([{ path: "a", index: 1 }], 0)).toEqual([]);
    const placed = placePanels([{ path: "a", index: 1 }, { path: "a", index: 2 }, { path: "b", index: -1 }, { path: "c", index: Number.NaN }, { path: "d", index: 1 }], 7);
    // A repeated path and impossible indices are skipped; a second folder claiming
    // the same cell can never join its band.
    expect(placed.map(p => `${p.path}:${p.side}`)).toEqual(["a:below", "d:above"]);
  });

  it("computeBands demotes members of an unsplittable band to stacked bands", () => {
    const bad: PanelPlacement[] = [{ path: "a", row: 0, col: 1, side: "below" }, { path: "b", row: 0, col: 2, side: "below" }];
    expect(computeBands(bad, 7).map(b => b.key)).toEqual(["0-stacked-a", "0-stacked-b"]);
  });
});

describe("panel sizing (§9.2)", () => {
  /** Medium tiles, seven 108px columns. */
  const m: RowMetrics = { columns: 7, width: widthFor(7), gap: MEDIUM.gap, tileHeight: MEDIUM.rowHeight - MEDIUM.gap };
  const tile = panelTileLayout(m);
  const min = tile.rowHeight + PANEL_PAD_Y;

  it("uses the grid's own tiles: a grid cell plus the gap per track, the grid's row height", () => {
    expect(tile).toEqual({ track: 108 + MEDIUM.gap, rowHeight: MEDIUM.rowHeight });
    // Cells stretched by a wider pane widen the panel's tiles with them.
    expect(panelTileLayout({ ...m, width: widthFor(7, 150) }).track).toBeCloseTo(150 + MEDIUM.gap);
    const xl = tileLayout("xlarge");
    expect(panelTileLayout({ columns: 4, width: widthFor(4, 172, xl.gap), gap: xl.gap, tileHeight: xl.rowHeight - xl.gap }))
      .toEqual({ track: 172 + xl.gap, rowHeight: xl.rowHeight });
  });

  it("sizes the grid: 6 -> 3x2, 9 -> 5x2, 11 -> 6x2, 14 -> 7x2, 48 -> as wide as fits", () => {
    const wide = 5000;
    expect([6, 9, 11, 14].map(n => panelGridColumns(n, wide, 96))).toEqual([3, 5, 6, 7]);
    expect(panelGridColumns(48, PANEL_PAD_X + 6 * 96, 96)).toBe(6);
    expect(panelGridColumns(48, PANEL_PAD_X + 6 * 96 + 95, 96)).toBe(6);
    expect(panelGridColumns(48, PANEL_PAD_X + 9 * 96, 96)).toBe(9);
    // Never fewer than two columns unless one is all that fits.
    expect([0, 1, 2].map(n => panelGridColumns(n, wide, 96))).toEqual([2, 2, 2]);
    expect(panelGridColumns(9, PANEL_PAD_X + 96, 96)).toBe(1);
  });

  it("tolerates malformed counts and widths", () => {
    expect(panelGridColumns(Number.NaN, 500, 96)).toBe(2);
    expect(panelGridColumns(-4, 500, 96)).toBe(2);
    expect(panelGridColumns(Number.POSITIVE_INFINITY, 500, 96)).toBe(2);
    expect(panelGridColumns(9, Number.NaN, 96)).toBe(1);
    expect(panelGridColumns(9, 5000, 0)).toBe(5);
    expect(panelGridColumns(1e9, 5000, 96)).toBe(Math.floor((5000 - PANEL_PAD_X) / 96));
  });

  it("is centred under its tab, clamped to its segment, and flush with a tab side within 16px", () => {
    const tab = { x0: 342, x1: 450 };
    expect(panelX(9, { x0: 0, x1: 792 }, tab, tile)).toEqual({ x0: 99, width: 5 * tile.track + PANEL_PAD_X, cols: 5, track: tile.track });
    // Clamped against the segment's left edge, then snapped flush with the tab.
    const left = panelX(9, { x0: 0, x1: 792 }, { x0: 0, x1: 108 }, tile);
    expect(left.x0).toBe(0);
    // Centring would leave the tab 12px from the panel side: snap flush instead.
    const near = panelX(2, { x0: 0, x1: 792 }, { x0: 300, x1: 300 + 2 * tile.track + PANEL_PAD_X - 2 * 12 }, tile);
    expect(near.x0).toBe(300);
    // A panel is never narrower than its tab.
    expect(panelX(1, { x0: 0, x1: 792 }, { x0: 100, x1: 400 }, tile).width).toBe(300);
    // A segment narrower than one track plus padding (a one-column grid) narrows
    // the track to what fits, so its tiles stay inside the panel.
    expect(panelX(48, { x0: 10, x1: 110 }, { x0: 10, x1: 60 }, tile)).toEqual({ x0: 10, width: 100, cols: 1, track: 100 - PANEL_PAD_X });
  });

  it("derives band and panel heights from preferred and content heights", () => {
    const bounds = panelHeightBounds(tile, 1000);
    expect(bounds).toEqual({ min, max: 700 });
    expect(defaultPanelHeight(5 * tile.track + PANEL_PAD_X, tile)).toBe(3.5 * tile.rowHeight + PANEL_PAD_Y);
    expect(defaultPanelHeight(216, tile)).toBe(216);
    expect(bandHeight([{ preferred: 356, content: 1000 }], bounds)).toBe(356);
    expect(bandHeight([{ preferred: 356, content: 212 }], bounds)).toBe(212);
    // A short member's preference never enlarges its taller sibling.
    expect(bandHeight([{ preferred: 600, content: 212 }, { preferred: 300, content: 1000 }], bounds)).toBe(300);
    expect(bandHeight([{ preferred: 10, content: 1000 }], bounds)).toBe(bounds.min);
    expect(bandHeight([{ preferred: 5000, content: 5000 }], bounds)).toBe(700);
    expect(bandHeight([{ preferred: Number.NaN, content: 5000 }], bounds)).toBe(bounds.min);
    // A tiny viewport still keeps one row.
    expect(panelHeightBounds(tile, 50)).toEqual({ min, max: min });
    expect(panelHeightBounds(tile, Number.NaN)).toEqual({ min, max: min });
  });

  it("clamps grip heights to one row, 70% of the viewport and the content", () => {
    const bounds = panelHeightBounds(tile, 1000);
    expect(clampPreferredHeight(50, 1000, bounds)).toBe(min);
    expect(clampPreferredHeight(900, 5000, bounds)).toBe(700);
    expect(clampPreferredHeight(600, 404, bounds)).toBe(404);
    expect(clampPreferredHeight(Number.NaN, 404, bounds)).toBe(min);
    expect(gripKeyHeight("ArrowDown", "below", 212, 1000, tile, bounds)).toBe(212 + tile.rowHeight);
    expect(gripKeyHeight("ArrowUp", "below", 212, 1000, tile, bounds)).toBe(min);
    expect(gripKeyHeight("ArrowUp", "above", 212, 1000, tile, bounds)).toBe(212 + tile.rowHeight);
    expect(gripKeyHeight("Home", "stacked", 400, 1000, tile, bounds)).toBe(min);
    expect(gripKeyHeight("End", "stacked", 200, 1000, tile, bounds)).toBe(700);
    expect(gripKeyHeight("End", "stacked", 200, 404, tile, bounds)).toBe(404);
    expect(gripKeyHeight("Enter", "below", 200, 404, tile, bounds)).toBeNull();
  });
});

describe("panel scroll edges", () => {
  const tile = panelTileLayout({ columns: 7, width: widthFor(7), gap: MEDIUM.gap, tileHeight: MEDIUM.rowHeight - MEDIUM.gap });
  const spec = (n: number, cols: number, side: BandSide = "below") => ({ side, entries: Array.from({ length: n }, (_, i) => i), cols, contentHeight: Math.ceil(n / cols) * tile.rowHeight + PANEL_PAD_Y });

  it("fades only the edges with content scrolled out of view", () => {
    const s = spec(30, 5);
    const height = 2 * tile.rowHeight + PANEL_PAD_Y;
    expect(panelFades(s.contentHeight, height, 0)).toEqual({ top: false, bottom: true });
    expect(panelFades(s.contentHeight, height, 100)).toEqual({ top: true, bottom: true });
    expect(panelFades(s.contentHeight, height, 1e9)).toEqual({ top: true, bottom: false });
    expect(panelFades(s.contentHeight, s.contentHeight, 0)).toEqual({ top: false, bottom: false });
    expect(panelFades(NaN, height, NaN)).toEqual({ top: false, bottom: false });
  });

  it("counts the items in rows whose centre lies below the visible area", () => {
    // 30 items in 5 columns: 6 rows, two whole rows visible -> 4 rows (20 items) below.
    const s = spec(30, 5);
    const height = 2 * tile.rowHeight + PANEL_PAD_Y;
    expect(panelMoreCount(s, height, tile.rowHeight, 0)).toBe(20);
    // Scrolled half a row: the third row's centre is now visible.
    expect(panelMoreCount(s, height, tile.rowHeight, tile.rowHeight / 2 + 1)).toBe(15);
    expect(panelMoreCount(s, height, tile.rowHeight, 1e9)).toBe(0);
    expect(panelMoreCount(s, s.contentHeight, tile.rowHeight, 0)).toBe(0);
    // A shorter last row counts only its own items.
    expect(panelMoreCount(spec(27, 5), height, tile.rowHeight, 0)).toBe(17);
    expect(panelMoreCount(s, height, 0, 0)).toBe(0);
  });
});

describe("row geometry", () => {
  const m: RowMetrics = { columns: 7, width: widthFor(7), gap: 6, tileHeight: 129 };

  it("matches CSS repeat(C, minmax(0, 1fr)) cells", () => {
    expect(cellX(0, m)).toEqual({ x0: 0, x1: 108 });
    expect(cellX(6, m)).toEqual({ x0: 684, x1: 792 });
    // Medium tiles leave 6px between tabs; small (2px gaps) insets each tab 1px.
    expect(tabX(2, m)).toEqual({ x0: 228, x1: 336 });
    expect(tabX(0, { ...m, gap: 2 })).toMatchObject({ x0: 1 });
  });

  it("aligns outer and parent edges with tabs and insets inner boundaries 12px", () => {
    expect(segmentX({ start: 0, end: 6 }, 2, m)).toEqual({ x0: 0, x1: 792 });
    // [0-3 | 4-6] with parents at 2 and 5: the boundary is the 3/4 gap midpoint.
    expect(segmentX({ start: 0, end: 3 }, 2, m)).toEqual({ x0: 0, x1: 453 - 12 });
    expect(segmentX({ start: 4, end: 6 }, 5, m)).toEqual({ x0: 453 + 12, x1: 792 });
    // A parent at its segment's edge keeps that edge flush with its own tab.
    expect(segmentX({ start: 3, end: 6 }, 3, m).x0).toBe(342);
  });

  it("aligns a stacked label to its parent, flush with a panel side within 16px", () => {
    expect(stackedLabelX({ x0: 0, width: 792 }, { x0: 342, x1: 450 })).toEqual({ x0: 342, width: 240 });
    expect(stackedLabelX({ x0: 0, width: 792 }, { x0: 10, x1: 118 })).toEqual({ x0: 0, width: 240 });
    expect(stackedLabelX({ x0: 0, width: 792 }, { x0: 684, x1: 792 })).toEqual({ x0: 552, width: 240 });
    expect(stackedLabelX({ x0: 0, width: 200 }, { x0: 0, x1: 108 })).toEqual({ x0: 0, width: 200 });
  });

  it("routes a ribbon down the free channel nearest the parent's centre", () => {
    const tab = { x0: 342, x1: 450 }, label = { x0: 342, x1: 582 };
    expect(ribbonChannel(tab, label, [], 792)).toEqual({ channel: 396, sx: 396, ex: 396 });
    // A panel under the parent: the channel runs 12px beside its nearer side.
    const blocked = ribbonChannel(tab, label, [{ x0: 300, x1: 420 }], 792);
    expect(blocked.channel).toBe(432);
    expect(blocked.sx).toBe(430);
    // The 24px gap between neighbouring panels qualifies.
    expect(ribbonChannel(tab, label, [{ x0: 0, x1: 388 }, { x0: 412, x1: 792 }], 792).channel).toBe(400);
    // No free channel: the outer padding on the parent's side.
    expect(ribbonChannel(tab, label, [{ x0: 0, x1: 792 }], 792).channel).toBe(792 + 4);
    expect(ribbonChannel({ x0: 0, x1: 108 }, { x0: 0, x1: 240 }, [{ x0: 0, x1: 792 }], 792).channel).toBe(-4);
  });
});

describe("buildTilePanelModel", () => {
  it("lays one below panel under its parent with a 12px gap", () => {
    const { model } = modelFor(["Career"]);
    const career = model.panels.get(P("Career"))!;
    // Nine grid-sized tiles: 5x2 on 114px tracks (a 108px cell plus the gap).
    expect(career).toMatchObject({ row: 0, col: 2, side: "below", cols: 5, track: 114, contentRows: 2, contentHeight: 2 * MEDIUM.rowHeight + PANEL_PAD_Y });
    expect(career.entries).toHaveLength(KIDS.Career.length);
    const [box] = model.geometry[0].boxes;
    // Centring under Career would cross the row's left edge: clamped to it.
    const height = 2 * MEDIUM.rowHeight + PANEL_PAD_Y;
    expect(box).toMatchObject({ x0: 0, width: 5 * 114 + PANEL_PAD_X, top: 129 + BAND_GAP, height });
    expect(model.geometry[0]).toMatchObject({ rowTop: 0, height: 129 + BAND_GAP + height + BAND_GAP });
    // Other rows keep the classic row height.
    expect(model.geometry.slice(1).every(g => g.height === MEDIUM.rowHeight && g.boxes.length === 0)).toBe(true);
    // With nothing open every row is classic.
    expect(modelFor([]).model.geometry.every(g => g.height === MEDIUM.rowHeight && g.rowTop === 0)).toBe(true);
  });

  it("splits a band and aligns every member's top", () => {
    const { model } = modelFor(["Career", "Personal"], { preferred: () => 5000 });
    const [career, personal] = model.geometry[0].boxes;
    expect(career.x0 + career.width).toBeLessThanOrEqual(453 - 12);
    expect(personal.x0).toBeGreaterThanOrEqual(453 + 12);
    expect(career.top).toBe(personal.top);
    // Career's 3-column grid needs 3 rows, less than Personal's band height.
    expect(model.panels.get(P("Career"))!.cols).toBe(3);
    expect(career.height).toBe(model.panels.get(P("Career"))!.contentHeight);
    expect(career.height).toBe(3 * MEDIUM.rowHeight + PANEL_PAD_Y);
    expect(personal.height).toBeGreaterThan(career.height);
  });

  it("puts above panels before the row, bottom-aligned, and stacked panels after the below band", () => {
    const { model } = modelFor(["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]);
    const group = model.geometry[0];
    const above = group.boxes.filter(b => b.side === "above");
    const below = group.boxes.filter(b => b.side === "below");
    const [stacked] = group.boxes.filter(b => b.side === "stacked");
    expect(group.boxes.map(b => b.path.slice(ROOT.length + 1))).toEqual(["AI Draft Archive", "Inbox", "Career", "Personal", "Codex"]);
    const bandBottom = Math.max(...above.map(b => b.top + b.height));
    expect(above.every(b => b.top + b.height === bandBottom)).toBe(true);
    expect(group.rowTop).toBe(bandBottom + BAND_GAP);
    // Codex's ribbon leaves its tab and bends into the channel between
    // Career's and Personal's panels: the below band makes room for the bend.
    expect(Math.min(...below.map(b => b.top))).toBe(group.rowTop + 129 + DETOUR_BELOW_MARGIN);
    const belowBottom = Math.max(...below.map(b => b.top + b.height));
    expect(stacked.top - belowBottom).toBe(STACKED_MARGIN);
    // Its band is full width; the panel is sized by its grid (14 wants 7x2, six
    // 114px tracks fit), centred under Codex (whose cell centre is x = 396).
    expect(stacked).toMatchObject({ x0: 396 - (6 * 114 + PANEL_PAD_X) / 2, width: 6 * 114 + PANEL_PAD_X, labelHeight: 30 });
    expect(stacked.label).toEqual({ x0: 342, width: 240 });
  });

  it("gives a detouring ribbon room for its bends", () => {
    // Personal's panel sits right under Codex: the ribbon must bend round it.
    const { model } = modelFor(["Personal", "Codex"], { remembered: new Map<string, BandSide>([[P("Codex"), "stacked"]]) });
    const [personal, codex] = model.geometry[0].boxes;
    expect(personal.side).toBe("below");
    expect(codex.side).toBe("stacked");
    expect(personal.top).toBeGreaterThan(model.geometry[0].rowTop + 129 + BAND_GAP);
    expect(codex.top - (personal.top + personal.height)).toBe(DETOUR_STACKED_MARGIN);
  });

  it("maps every entry to its tile: grid cells or panel offsets", () => {
    const { model, tree } = modelFor(["Career", "Inbox"]);
    tree.entries.forEach((entry, index) => {
      const at = model.location[index]!;
      if (at.kind === "grid") expect(model.items[at.item].entryIndex).toBe(index);
      else expect(model.panels.get(at.path)!.entries[at.offset]).toBe(index);
      expect(at.kind === "panel").toBe(entry.path.split("/").length > 3);
    });
  });

  it("keeps a creation sentinel in the first grid cell", () => {
    const { model } = modelFor(["Career"], { creating: true });
    expect(model.items[0]).toEqual({ key: "create", entryIndex: null });
    expect(model.panels.get(P("Career"))).toMatchObject({ row: 0, col: 3 });
  });

  it("shows one content row while a listing loads or fails", () => {
    const { model } = modelFor(["Career", "Codex"], { listing: path => path.endsWith("Codex") ? { status: "error", entries: [], error: "denied" } : { status: "loading", entries: [], showLoading: false } });
    expect(model.panels.get(P("Career"))).toMatchObject({ entries: [], message: null, contentRows: 1 });
    expect(model.panels.get(P("Codex"))).toMatchObject({ entries: [], message: "Can't open folder: denied", contentRows: 1 });
  });

  it("uses remembered heights, clamped to the bounds", () => {
    const tall = modelFor(["Archive"], { preferred: () => 5000, viewportHeight: 600 }).model;
    expect(tall.geometry[0].boxes[0].height).toBe(420);
    // Never above the content (Inbox: 3x2).
    const inbox = modelFor(["Inbox"], { preferred: () => 5000, viewportHeight: 600 }).model;
    expect(inbox.geometry[0].boxes[0].height).toBe(2 * MEDIUM.rowHeight + PANEL_PAD_Y);
    const short = modelFor(["Personal"], { preferred: () => 1 }).model;
    expect(short.geometry[0].boxes[0].height).toBe(MEDIUM.rowHeight + PANEL_PAD_Y);
  });

  it("degrades gracefully for malformed geometry", () => {
    const { model } = modelFor(["Career"], { columns: Number.NaN, width: Number.NaN, viewportHeight: Number.NaN });
    expect(model.metrics.columns).toBe(1);
    expect(model.placements.map(p => p.side)).toEqual(["stacked"]);
    expect(model.geometry.every(g => Number.isFinite(g.height))).toBe(true);
  });

  it("builds a 10,000-tile model with three 5,000-item panels quickly", () => {
    const top = Array.from({ length: 10_000 }, (_, i) => i < 3 ? D(`d${i}`) : F(`f${String(i).padStart(5, "0")}`));
    const children = (path: string) => Array.from({ length: 5000 }, (_, i) => F(`${path.slice(ROOT.length + 1)}/c${String(i).padStart(4, "0")}`));
    const listing = (path: string) => ({ status: "loaded" as const, entries: /\/d\d$/.test(path) ? children(path) : [] });
    const opened = rowsFor(["d0", "d1", "d2"], listing, top);
    const started = performance.now();
    const model = buildTilePanelModel({
      rows: opened.rows, order: ["d0", "d1", "d2"].map(P), columns: 7, width: widthFor(7), viewportHeight: 900, layout: MEDIUM, preferred: () => undefined,
    });
    expect(performance.now() - started).toBeLessThan(250);
    expect(model.groups).toHaveLength(Math.ceil(10_000 / 7));
    expect(sides({ ...model } as never)).toEqual(["d0:below", "d1:above", "d2:stacked"]);
    expect(model.panels.get(P("d2"))!.entries).toHaveLength(5000);
  });
});

describe("groupOffsets", () => {
  it("prefix-sums group heights", () => {
    expect(groupOffsets([135, 365, 135])).toEqual([0, 135, 500, 635]);
    expect(groupOffsets([])).toEqual([0]);
    expect(groupOffsets([-5, 10])).toEqual([0, 0, 10]);
  });
});
