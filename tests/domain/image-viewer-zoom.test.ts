/**
 * Fullscreen image preview zoom/pan math (#219, #236, #1033): shared by file
 * images and plugin Preview targets.
 */
import { describe, expect, it } from "vitest";
import {
  BASE_VIEW,
  KEY_PAN_STEP,
  KEY_ZOOM_STEP,
  MAX_ZOOM,
  MIN_ZOOM,
  WHEEL_ZOOM_STEP,
  centerOffset,
  clampZoom,
  exceedsDragSlop,
  fullscreenKeyAction,
  panBy,
  wheelZoom,
  withZoom,
  zoomAround,
  zoomTransform,
} from "$lib/domain/image-viewer-zoom";

describe("clampZoom", () => {
  it("keeps zoom within the viewer's range", () => {
    expect(clampZoom(0.5)).toBe(MIN_ZOOM);
    expect(clampZoom(3)).toBe(3);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
  });

  it("falls back to the base zoom for non-finite input", () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(MIN_ZOOM);
  });
});

describe("withZoom", () => {
  it("keeps the pan while zoomed", () => {
    expect(withZoom({ zoom: 2, panX: 10, panY: -5 }, 3)).toEqual({ zoom: 3, panX: 10, panY: -5 });
  });

  it("recentres when the zoom returns to the base", () => {
    expect(withZoom({ zoom: 2, panX: 10, panY: -5 }, 0.2)).toEqual(BASE_VIEW);
  });

  it("caps at the maximum zoom", () => {
    expect(withZoom(BASE_VIEW, MAX_ZOOM * 4).zoom).toBe(MAX_ZOOM);
  });

  it("does not mutate the input view", () => {
    const view = Object.freeze({ zoom: 2, panX: 1, panY: 2 });
    withZoom(view, 4);
    expect(view).toEqual({ zoom: 2, panX: 1, panY: 2 });
  });
});

describe("zoomAround", () => {
  it("keeps the image point under the cursor fixed", () => {
    const view = { zoom: 2, panX: 30, panY: -20 };
    const cursor = { x: 100, y: 50 };
    const next = zoomAround(view, 4, cursor);
    // The image point under the cursor, in unscaled image coordinates.
    const before = { x: (cursor.x - view.panX) / view.zoom, y: (cursor.y - view.panY) / view.zoom };
    const after = { x: (cursor.x - next.panX) / next.zoom, y: (cursor.y - next.panY) / next.zoom };
    expect(next.zoom).toBe(4);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("zooming in from the base at an off-centre cursor pans toward it", () => {
    const next = zoomAround(BASE_VIEW, 2, { x: 100, y: -40 });
    expect(next).toEqual({ zoom: 2, panX: -100, panY: 40 });
  });

  it("zooming at the centre leaves the pan alone", () => {
    expect(zoomAround({ zoom: 2, panX: 0, panY: 0 }, 3, { x: 0, y: 0 })).toEqual({ zoom: 3, panX: 0, panY: 0 });
  });

  it("returning to the base zoom recentres regardless of the cursor", () => {
    expect(zoomAround({ zoom: 1.1, panX: 50, panY: 50 }, 0.5, { x: 300, y: 300 })).toEqual(BASE_VIEW);
  });

  it("an unchanged (clamped) zoom keeps the pan", () => {
    const view = { zoom: MAX_ZOOM, panX: 12, panY: 34 };
    expect(zoomAround(view, MAX_ZOOM * 2, { x: 500, y: 500 })).toEqual(view);
  });

  it("without a container offset, zooms and keeps the pan", () => {
    expect(zoomAround({ zoom: 2, panX: 5, panY: 6 }, 3, null)).toEqual({ zoom: 3, panX: 5, panY: 6 });
  });
});

describe("panBy", () => {
  it("adds the delta to the pan and keeps the zoom", () => {
    expect(panBy({ zoom: 3, panX: 1, panY: 2 }, 10, -20)).toEqual({ zoom: 3, panX: 11, panY: -18 });
  });
});

describe("wheelZoom", () => {
  it("scrolling up zooms in, down zooms out", () => {
    expect(wheelZoom(2, -100)).toBeCloseTo(2 * WHEEL_ZOOM_STEP);
    expect(wheelZoom(2, 100)).toBeCloseTo(2 / WHEEL_ZOOM_STEP);
  });
});

describe("centerOffset", () => {
  it("measures a client point from the rect's centre", () => {
    expect(centerOffset({ left: 100, top: 50, width: 200, height: 100 }, 250, 80)).toEqual({ x: 50, y: -20 });
  });
});

describe("exceedsDragSlop", () => {
  it("treats tiny jitter as a click and larger travel as a drag", () => {
    expect(exceedsDragSlop(1, 1)).toBe(false);
    expect(exceedsDragSlop(-2, 0)).toBe(false);
    expect(exceedsDragSlop(2, -1)).toBe(true);
  });
});

describe("zoomTransform", () => {
  it("is empty outside fullscreen, even when a zoom is left over", () => {
    expect(zoomTransform(false, { zoom: 3, panX: 1, panY: 2 })).toBe("");
  });

  it("is the identity at the base zoom", () => {
    expect(zoomTransform(true, BASE_VIEW)).toBe("scale(1)");
  });

  it("translates then scales when zoomed", () => {
    expect(zoomTransform(true, { zoom: 2.5, panX: -10, panY: 20 })).toBe("translate(-10px, 20px) scale(2.5)");
  });
});

describe("fullscreenKeyAction", () => {
  it("maps the zoom and exit keys", () => {
    expect(fullscreenKeyAction("Escape", 1)).toEqual({ kind: "exit" });
    expect(fullscreenKeyAction("+", 1)).toEqual({ kind: "zoom", factor: KEY_ZOOM_STEP });
    expect(fullscreenKeyAction("=", 1)).toEqual({ kind: "zoom", factor: KEY_ZOOM_STEP });
    expect(fullscreenKeyAction("-", 2)).toEqual({ kind: "zoom", factor: 1 / KEY_ZOOM_STEP });
    expect(fullscreenKeyAction("_", 2)).toEqual({ kind: "zoom", factor: 1 / KEY_ZOOM_STEP });
    expect(fullscreenKeyAction("0", 2)).toEqual({ kind: "reset" });
  });

  it("steps between siblings with Left/Right at the base zoom", () => {
    expect(fullscreenKeyAction("ArrowLeft", 1)).toEqual({ kind: "step", delta: -1 });
    expect(fullscreenKeyAction("ArrowRight", 1)).toEqual({ kind: "step", delta: 1 });
  });

  it("pans with the arrows while zoomed, moving the image opposite the key", () => {
    expect(fullscreenKeyAction("ArrowLeft", 2)).toEqual({ kind: "pan", dx: KEY_PAN_STEP, dy: 0 });
    expect(fullscreenKeyAction("ArrowRight", 2)).toEqual({ kind: "pan", dx: -KEY_PAN_STEP, dy: 0 });
    expect(fullscreenKeyAction("ArrowUp", 2)).toEqual({ kind: "pan", dx: 0, dy: KEY_PAN_STEP });
    expect(fullscreenKeyAction("ArrowDown", 2)).toEqual({ kind: "pan", dx: 0, dy: -KEY_PAN_STEP });
  });

  it("leaves Up/Down and unrelated keys alone", () => {
    expect(fullscreenKeyAction("ArrowUp", 1)).toBeNull();
    expect(fullscreenKeyAction("ArrowDown", 1)).toBeNull();
    expect(fullscreenKeyAction("a", 2)).toBeNull();
    expect(fullscreenKeyAction("", 2)).toBeNull();
    expect(fullscreenKeyAction("Enter", 1)).toBeNull();
  });
});
