/**
 * Preview rendition sizing (#1054): the requested edge follows the surface's
 * device-pixel size in a few buckets, and fullscreen/zoom need the original.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDITION_EDGE,
  RENDITION_EDGE_BUCKETS,
  needsFullResolution,
  renditionMaxEdge,
} from "$lib/domain/preview-rendition";

describe("renditionMaxEdge", () => {
  it("picks the smallest bucket covering the surface's longest edge", () => {
    expect(renditionMaxEdge({ width: 400, height: 900 })).toBe(1024);
    expect(renditionMaxEdge({ width: 1024, height: 600 })).toBe(1024);
    expect(renditionMaxEdge({ width: 1025, height: 600 })).toBe(2048);
    expect(renditionMaxEdge({ width: 2500, height: 1400 })).toBe(3072);
  });

  it("counts device pixels: the device pixel ratio and app zoom both scale the surface", () => {
    expect(renditionMaxEdge({ width: 800, height: 600, devicePixelRatio: 2 })).toBe(2048);
    expect(renditionMaxEdge({ width: 800, height: 600, zoom: 1.5 })).toBe(2048);
    expect(renditionMaxEdge({ width: 800, height: 600, devicePixelRatio: 2, zoom: 1.5 })).toBe(3072);
  });

  it("small resizes stay within one bucket, so they reuse one cached rendition", () => {
    const edges = [1100, 1300, 1600, 2000].map((width) => renditionMaxEdge({ width, height: 500 }));
    expect(new Set(edges)).toEqual(new Set([2048]));
  });

  it("caps very large surfaces at the largest bucket", () => {
    const largest = RENDITION_EDGE_BUCKETS[RENDITION_EDGE_BUCKETS.length - 1];
    expect(renditionMaxEdge({ width: 7680, height: 4320, devicePixelRatio: 2 })).toBe(largest);
    expect(renditionMaxEdge({ width: Number.MAX_VALUE, height: Number.MAX_VALUE, devicePixelRatio: 3 })).toBe(largest);
  });

  it("falls back to the default before layout or for nonsense sizes", () => {
    for (const [width, height] of [[0, 0], [-100, -5], [NaN, NaN], [Infinity, -Infinity]]) {
      expect(renditionMaxEdge({ width, height })).toBe(DEFAULT_RENDITION_EDGE);
    }
  });

  it("ignores one nonsense edge when the other is a real size", () => {
    expect(renditionMaxEdge({ width: NaN, height: 300 })).toBe(1024);
    expect(renditionMaxEdge({ width: Infinity, height: 1500 })).toBe(2048);
  });

  it("treats a missing or invalid device pixel ratio or zoom as 1", () => {
    for (const ratio of [undefined, 0, -2, NaN, Infinity]) {
      expect(renditionMaxEdge({ width: 900, height: 500, devicePixelRatio: ratio, zoom: ratio })).toBe(1024);
    }
  });
});

describe("needsFullResolution", () => {
  it("is needed in fullscreen or when zoomed in, not at fit size in the pane", () => {
    expect(needsFullResolution({ fullscreen: false, zoom: 1 })).toBe(false);
    expect(needsFullResolution({ fullscreen: true, zoom: 1 })).toBe(true);
    expect(needsFullResolution({ fullscreen: false, zoom: 1.25 })).toBe(true);
  });
});
