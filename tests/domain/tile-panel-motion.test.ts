import { describe, expect, it } from "vitest";
import { anchoredScrollTop, canAnimate, easeOutCubic, geometryChanged, leavingPaths, mixGeometry, TILE_MOTION_MS } from "$lib/domain/tile-panel-motion";
import { BAND_GAP } from "$lib/domain/tile-panels";
import { P, modelFor } from "./tile-panels-fixture";

const boxOf = (geometry: ReturnType<typeof mixGeometry>, path: string) => geometry[0].boxes.find(b => b.path === P(path))!;

describe("Tiles panel motion (§9.5)", () => {
  it("lasts about 150ms with an ease-out cubic", () => {
    expect(TILE_MOTION_MS).toBe(150);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });

  it("only animates between layouts of the same grid", () => {
    const a = modelFor(["Career"]).model, b = modelFor(["Career", "Personal"]).model;
    expect(canAnimate(a, b)).toBe(true);
    expect(canAnimate(null, b)).toBe(false);
    expect(canAnimate(modelFor(["Career"], { columns: 6 }).model, b)).toBe(false);
    expect(canAnimate(modelFor(["Career"], { width: 700 }).model, b)).toBe(false);
    expect(canAnimate(modelFor(["Career"], { creating: true }).model, b)).toBe(false);
  });

  it("grows an opening panel from its row and fades it in", () => {
    const from = modelFor([]).model.geometry, to = modelFor(["Career"]).model.geometry;
    const start = mixGeometry(from, to, 0), end = mixGeometry(from, to, 1);
    expect(boxOf(start, "Career")).toMatchObject({ height: 0, opacity: 0 });
    expect(start[0].height).toBe(from[0].height);
    expect(end).toEqual(to);
    const half = mixGeometry(from, to, 0.5);
    expect(boxOf(half, "Career").height).toBeCloseTo(boxOf(end, "Career").height / 2);
    expect(boxOf(half, "Career").opacity).toBeCloseTo(0.5);
  });

  it("keeps an opening above panel attached to its moving row", () => {
    const from = modelFor(["Career", "Personal"]).model.geometry;
    const to = modelFor(["Career", "Personal", "Inbox"]).model.geometry;
    for (const e of [0, 0.2, 0.5, 0.9, 1]) {
      const frame = mixGeometry(from, to, e);
      const inbox = boxOf(frame, "Inbox");
      expect(inbox.top + inbox.height).toBeCloseTo(frame[0].rowTop - BAND_GAP);
      // Below-band members travel with the row.
      expect(boxOf(frame, "Career").top - frame[0].rowTop).toBeCloseTo(to[0].boxes.find(b => b.path === P("Career"))!.top - to[0].rowTop);
    }
  });

  describe("anchoring an opening above panel's row (§14)", () => {
    const from = modelFor(["Career", "Personal"]).model.geometry;
    const to = modelFor(["Career", "Personal", "Inbox"]).model.geometry;
    const frames = [0, 0.1, 0.3, 0.5, 0.8, 1].map(e => mixGeometry(from, to, e));
    /** The row's and the panel's screen tops (relative to the viewport's top) per frame. */
    const onScreen = (rowScreenTop: number) => {
      const anchor = { top: from[0].rowTop, scrollTop: from[0].rowTop - rowScreenTop };
      return frames.map(frame => {
        const scroll = anchoredScrollTop(anchor, frame[0].rowTop, boxOf(frame, "Inbox").top);
        return { row: frame[0].rowTop - scroll, panel: boxOf(frame, "Inbox").top - scroll };
      });
    };
    const inboxHeight = to[0].boxes.find(b => b.path === P("Inbox"))!.height;

    it("keeps the row fixed while the whole panel stays on screen", () => {
      const rowAt = inboxHeight + 100;
      for (const { row, panel } of onScreen(rowAt)) {
        expect(row).toBeCloseTo(rowAt);
        expect(panel).toBeGreaterThanOrEqual(0);
      }
    });

    it("stops at the panel's top near the top of the list, moving the row down only by the shortfall", () => {
      const rowAt = from[0].rowTop; // the list at its top
      const shown = onScreen(rowAt);
      for (const { panel } of shown) expect(panel).toBeGreaterThanOrEqual(-1e-9);
      for (let i = 1; i < shown.length; i++) expect(shown[i].row).toBeGreaterThanOrEqual(shown[i - 1].row - 1e-9);
      const end = shown.at(-1)!;
      expect(end.panel).toBeCloseTo(0);
      // Full compensation would leave the row at rowAt with the panel's top at
      // rowAt - (rowTop - panelTop); the row moves down by exactly that shortfall.
      const shortfall = to[0].rowTop - boxOf(frames.at(-1)!, "Inbox").top - rowAt;
      expect(shortfall).toBeGreaterThan(0);
      expect(end.row - rowAt).toBeCloseTo(shortfall);
    });

    it("follows the row alone without an above panel, and ignores a non-finite panel top", () => {
      const anchor = { top: 300, scrollTop: 120 };
      expect(anchoredScrollTop(anchor, 520, null)).toBe(340);
      expect(anchoredScrollTop(anchor, 520, Number.NaN)).toBe(340);
      expect(anchoredScrollTop(anchor, 520, 400)).toBe(340);
      expect(anchoredScrollTop(anchor, 520, 200)).toBe(200);
    });
  });

  it("shrinks a closing panel's ghost back to its row and re-splits the rest", () => {
    const from = modelFor(["Career", "Personal"]).model.geometry, to = modelFor(["Personal"]).model.geometry;
    expect([...leavingPaths(from, to)]).toEqual([P("Career")]);
    const end = mixGeometry(from, to, 1);
    expect(boxOf(end, "Career")).toMatchObject({ height: 0, opacity: 0 });
    expect(boxOf(end, "Personal")).toEqual(to[0].boxes[0]);
    const half = boxOf(mixGeometry(from, to, 0.5), "Personal");
    const a = from[0].boxes.find(b => b.path === P("Personal"))!, b = to[0].boxes[0];
    expect(half.x0).toBeCloseTo((a.x0 + b.x0) / 2);
    expect(half.width).toBeCloseTo((a.width + b.width) / 2);
  });

  // Members of one band may overlap sideways while they re-split (the opening
  // one is fading in, as in the mock); different bands never overlap.
  it("never lets bands overlap mid-motion", () => {
    const states = [[], ["Career"], ["Career", "Personal"], ["Career", "Personal", "Inbox"], ["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]];
    for (let i = 0; i < states.length; i++) {
      for (let j = 0; j < states.length; j++) {
        const from = modelFor(states[i]).model.geometry, to = modelFor(states[j]).model.geometry;
        for (const e of [0.1, 0.4, 0.7]) {
          const boxes = mixGeometry(from, to, e)[0].boxes.filter(b => b.opacity > 0 && b.height > 0);
          for (const a of boxes) for (const b of boxes) {
            if (a === b || (a.side === b.side && a.side !== "stacked") || a.x0 + a.width <= b.x0 || b.x0 + b.width <= a.x0) continue;
            expect(a.top + a.height <= b.top + 0.01 || b.top + b.height <= a.top + 0.01, `${states[i]} -> ${states[j]} @${e}`).toBe(true);
          }
        }
      }
    }
  });

  it("detects whether anything moves", () => {
    const a = modelFor(["Career"]).model.geometry;
    expect(geometryChanged(a, modelFor(["Career"]).model.geometry)).toBe(false);
    expect(geometryChanged(a, modelFor(["Career", "Personal"]).model.geometry)).toBe(true);
    expect(geometryChanged(a, a.slice(1))).toBe(true);
  });

  it("clamps malformed progress", () => {
    const from = modelFor([]).model.geometry, to = modelFor(["Career"]).model.geometry;
    expect(mixGeometry(from, to, Number.NaN)).toEqual(to);
    expect(mixGeometry(from, to, -1)[0].height).toBe(from[0].height);
  });
});
