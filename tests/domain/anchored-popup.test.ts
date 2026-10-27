import { describe, expect, it } from "vitest";
import { measuredFixedOffset, popupAbove } from "$lib/domain/anchored-popup";

const viewport = { width: 800, height: 600 };
describe("anchored popup placement (#1425)", () => {
  it("centres the popup over its anchor with its bottom on the anchor's top", () => {
    expect(popupAbove({ left: 400, top: 500, width: 28, height: 28 }, { width: 36, height: 110 }, viewport))
      .toEqual({ x: 396, y: 390 });
  });

  it("stays inside the viewport near an edge or when there is no room above", () => {
    expect(popupAbove({ left: 780, top: 500, width: 28, height: 28 }, { width: 36, height: 110 }, viewport).x).toBe(760);
    expect(popupAbove({ left: 0, top: 40, width: 28, height: 28 }, { width: 36, height: 110 }, viewport)).toEqual({ x: 4, y: 4 });
  });

  it("solves fixed offsets from the measured response, whatever the zoom scaling", () => {
    // Unscaled: offset equals the rect distance from the origin.
    expect(measuredFixedOffset(250, 10, 110)).toBe(240);
    // Offsets rendered at 1.5x (root zoom) or 2.25x (doubly scaled legacy WebKit).
    expect(measuredFixedOffset(310, 10, 160)).toBeCloseTo(200);
    expect(measuredFixedOffset(235, 10, 235)).toBeCloseTo(100);
    // A containing block offset shifts the origin, not the scale.
    expect(measuredFixedOffset(300, 50, 150)).toBe(250);
  });

  it("falls back to the raw distance when the probe response is unusable", () => {
    for (const probe of [10, 5, NaN, Infinity]) expect(measuredFixedOffset(250, 10, probe)).toBe(240);
  });
});
