import { describe, expect, it } from "vitest";
import { cutPath, islandClipPolygon, islandCut, paintedWidth, snapX, snapY, type DeviceGrid } from "$lib/domain/island-outline";

const island = { left: 6, right: 900, top: 38, radius: 14, border: 1 };
const notch = { left: 86, right: 314 };
const rounded = { left: "round", right: "round" } as const;

describe("device-pixel snapping", () => {
  it("snaps a CSS edge to the device pixel layout paints it on (WebKit: one device pixel)", () => {
    const grid: DeviceGrid = { scale: 1.25, x: 0, y: 0 };
    // 38 * 1.25 = 47.5 device px rounds up to 48 = 38.4 CSS px.
    expect(snapY(grid, 38)).toBeCloseTo(38.4, 9);
    expect(snapX(grid, 8)).toBe(8);
    expect(snapX(grid, 10)).toBeCloseTo(10.4, 9);
  });

  it("snaps to whole zoomed CSS pixels in Chromium (unit = the device pixel ratio)", () => {
    // 125% zoom on a 2x display: 47.5 visual px is 95 device px; Chromium paints at 96, WebKit at 95.
    const chromium: DeviceGrid = { scale: 2.5, x: 0, y: 0, unit: 2 };
    const webkit: DeviceGrid = { scale: 2.5, x: 0, y: 0 };
    expect(snapY(chromium, 38) * 2.5).toBe(96);
    expect(snapY(webkit, 38) * 2.5).toBe(95);
  });

  it("measures from the grid's origin", () => {
    const grid: DeviceGrid = { scale: 1, x: 0.4, y: 0.6 };
    expect(snapX(grid, 10)).toBeCloseTo(9.6, 9);
    expect(snapY(grid, 10)).toBeCloseTo(10.4, 9);
  });

  it("treats a malformed grid as identity and malformed input as zero", () => {
    const grid: DeviceGrid = { scale: Number.NaN, x: Number.NaN, y: Infinity, unit: -1 };
    expect(snapX(grid, 3.4)).toBe(3);
    expect(snapY(grid, Number.NaN)).toBe(0);
  });

  it("paints a border width in whole units, never thinner than one", () => {
    expect(paintedWidth({ scale: 1.25, x: 0, y: 0 }, 1)).toBeCloseTo(0.8, 9);
    expect(paintedWidth({ scale: 2.5, x: 0, y: 0, unit: 2 }, 1)).toBeCloseTo(0.8, 9);
    expect(paintedWidth({ scale: 2, x: 0, y: 0 }, 1)).toBe(1);
    expect(paintedWidth({ scale: 1, x: 0, y: 0 }, 0.2)).toBe(1);
    expect(paintedWidth({ scale: 1, x: 0, y: 0 }, Number.NaN)).toBe(1);
  });
});

describe("islandCut", () => {
  const grid: DeviceGrid = { scale: 1, x: 0, y: 0 };

  it("cuts the top border row between the rounded corners' tangents, open at the notch", () => {
    const cut = islandCut(island, grid, notch, rounded);
    expect(cut.outline).toEqual([[86, 38], [20, 38], [20, 39], [886, 39], [886, 38], [314, 38]]);
    expect(cut.notch).toEqual(notch);
    // The stroke takes over where each corner's arc becomes the straight edge.
    expect(cut.handover).toEqual({ left: [20, 38], right: [886, 38] });
  });

  it("keeps the corners on whole device pixels past the arc at fractional zoom", () => {
    const cut = islandCut(island, { scale: 1.25, x: 0, y: 0 }, notch, rounded);
    // X0 = 7.5 -> 8, R = 17.5: the tangent is the first whole pixel past 25.5 (26 = 20.8 CSS).
    expect(cut.handover.left[0]).toBeCloseTo(20.8, 9);
    expect(cut.handover.right[0]).toBeCloseTo(885.6, 9);
    for (const [x, y] of cut.outline) {
      expect(Number.isInteger(Math.round(x * 1.25 * 1e6) / 1e6)).toBe(true);
      expect(Number.isInteger(Math.round(y * 1.25 * 1e6) / 1e6)).toBe(true);
    }
  });

  it("turns a squared corner (a foot beside it) down to the bottom of the border row", () => {
    const cut = islandCut(island, grid, notch, { left: "square", right: "round" });
    expect(cut.outline[1]).toEqual([6, 38]);
    expect(cut.handover.left).toEqual([6, 39]);
  });

  it("cuts to the island's edge where a corner lies under the tab", () => {
    const cut = islandCut(island, grid, { left: 0, right: 314 }, { left: null, right: "round" });
    expect(cut.outline[0]).toEqual([6, 38]);
    expect(cut.notch.left).toBe(6);
  });

  it("clamps a notch reaching past the corners to the cut", () => {
    const cut = islandCut(island, grid, { left: -50, right: 2000 }, rounded);
    expect(cut.notch).toEqual({ left: 20, right: 886 });
  });

  it("follows a thicker painted border", () => {
    const cut = islandCut({ ...island, border: 2 }, grid, notch, rounded);
    expect(cut.outline).toContainEqual([20, 40]);
  });

  it("stays well formed for a tiny island and an inverted notch", () => {
    const cut = islandCut({ left: 10, right: 12, top: 38, radius: 14, border: 1 }, grid, { left: 30, right: 5 }, rounded);
    for (const [x, y] of cut.outline) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
    expect(cut.notch.right).toBeGreaterThanOrEqual(cut.notch.left);
  });

  it("survives malformed geometry", () => {
    const cut = islandCut({ left: Number.NaN, right: Number.NaN, top: Number.NaN, radius: Number.NaN, border: Number.NaN }, grid, { left: Number.NaN, right: Number.NaN }, rounded);
    for (const [x, y] of cut.outline) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });
});

describe("cutPath and islandClipPolygon", () => {
  const cut = islandCut(island, { scale: 1, x: 0, y: 0 }, notch, rounded);

  it("closes the cut along the island's top edge", () => {
    expect(cutPath(cut)).toBe("M86 38L20 38L20 39L886 39L886 38L314 38Z");
  });

  it("draws nothing for a degenerate cut", () => {
    expect(cutPath({ ...cut, outline: [[0, 0], [1, 0]] })).toBe("");
  });

  it("removes the cut and everything above the notch, in the island's own coordinates", () => {
    const polygon = islandClipPolygon({ left: 6, top: 38 }, cut);
    expect(polygon).toBe(
      "polygon(-100vw -100vh, 80px -100vh, 80px 0px, 14px 0px, 14px 1px, 880px 1px, 880px 0px, 308px 0px, 308px -100vh, "
      + "calc(100% + 100vw) -100vh, calc(100% + 100vw) calc(100% + 100vh), -100vw calc(100% + 100vh))",
    );
  });
});
