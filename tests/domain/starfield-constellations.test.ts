/**
 * Constellation precomputation (issue #137): star positions are static, so
 * the O(N²) neighbour pass runs once at init instead of per frame. The
 * precomputed lines must match what the per-frame loop used to draw:
 * distance-gated, seeded-selection-stable, alpha falling off with distance.
 */
import { describe, it, expect } from "vitest";
import { computeConstellations } from "$lib/background-animations/starfield";

describe("computeConstellations", () => {
  it("links only pairs within the max distance", () => {
    const stars = [
      { x: 0, y: 0 },
      { x: 50, y: 0 }, // 50 from star 0 — in range
      { x: 500, y: 0 }, // far from both
    ];
    const lines = computeConstellations(stars, 100, 1); // chance=1: no seed filter
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ a: 0, b: 1 });
  });

  it("alpha falls off linearly with distance", () => {
    const near = computeConstellations([{ x: 0, y: 0 }, { x: 10, y: 0 }], 100, 1)[0];
    const far = computeConstellations([{ x: 0, y: 0 }, { x: 90, y: 0 }], 100, 1)[0];
    expect(near.alpha).toBeCloseTo((1 - 10 / 100) * 0.08);
    expect(far.alpha).toBeCloseTo((1 - 90 / 100) * 0.08);
    expect(near.alpha).toBeGreaterThan(far.alpha);
  });

  it("applies the index-seeded selection so patterns are stable, not random", () => {
    // Ten coincident stars: every pair is in range; only pairs whose seed
    // (i*7 + j*13) % 100 falls under the chance survive. Two runs must agree.
    const stars = Array.from({ length: 10 }, () => ({ x: 0, y: 0 }));
    const first = computeConstellations(stars, 100, 0.3);
    const second = computeConstellations(stars, 100, 0.3);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(45); // seed filter must drop some of the 45 pairs
    for (const { a, b } of first) {
      expect((a * 7 + b * 13) % 100).toBeLessThan(30);
    }
  });

  it("handles empty and single-star inputs", () => {
    expect(computeConstellations([], 100, 1)).toEqual([]);
    expect(computeConstellations([{ x: 0, y: 0 }], 100, 1)).toEqual([]);
  });
});
