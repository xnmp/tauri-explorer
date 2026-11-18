import { describe, expect, it } from "vitest";
import { paintedWidth, snapX, snapY, type DeviceGrid } from "$lib/domain/device-grid";

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
