import { describe, expect, it } from "vitest";
import {
  HTML_FIT_LAYOUT_WIDTH,
  HTML_FIT_MIN_SCALE,
  HTML_ZOOM_LEVELS,
  htmlPreviewFrame,
  htmlPreviewScale,
  htmlZoomLabel,
  stepHtmlZoom,
} from "$lib/domain/html-preview-zoom";

describe("HTML preview fit", () => {
  it("shows a desktop-width layout in full inside a narrower pane", () => {
    const frame = htmlPreviewFrame("fit", 400);
    expect(frame.width).toBeCloseTo(HTML_FIT_LAYOUT_WIDTH);
    expect(frame.paintedWidth).toBeCloseTo(400);
  });

  it("never magnifies when the pane is wider than the fit layout", () => {
    expect(htmlPreviewFrame("fit", 1600)).toEqual({ scale: 1, width: 1600, paintedWidth: 1600 });
  });

  it("fits narrow docked panes below the smallest explicit stop, down to a floor", () => {
    expect(htmlPreviewScale("fit", 280)).toBeCloseTo(280 / HTML_FIT_LAYOUT_WIDTH);
    const frame = htmlPreviewFrame("fit", 50);
    expect(frame.scale).toBe(HTML_FIT_MIN_SCALE);
    // Below the floor the desktop page no longer fits and scrolls horizontally.
    expect(frame.paintedWidth).toBeCloseTo(HTML_FIT_LAYOUT_WIDTH * HTML_FIT_MIN_SCALE);
  });

  it("renders unmeasured or malformed panes at actual size without a degenerate frame", () => {
    for (const width of [0, Number.NaN, -5, Infinity]) {
      const frame = htmlPreviewFrame("fit", width);
      expect(frame.scale).toBe(1);
      expect(frame).toEqual({ scale: 1, width: 0, paintedWidth: 0 });
    }
  });
});

describe("HTML preview explicit zoom", () => {
  it("magnifies the same desktop layout instead of reflowing it (#1361)", () => {
    const layouts = [0.5, 0.75, 1, 2].map(zoom => htmlPreviewFrame(zoom, 460).width);
    expect(new Set(layouts)).toEqual(new Set([HTML_FIT_LAYOUT_WIDTH]));
  });

  it("keeps a wide pane's Fit layout when zooming in, so breakpoints never switch", () => {
    const layouts = [1, 1.1, 1.25, 2, 3].map(zoom => htmlPreviewFrame(zoom, 1600).width);
    expect(new Set(layouts)).toEqual(new Set([1600]));
    expect(htmlPreviewFrame(2, 1600).paintedWidth).toBe(3200);
  });

  it("reveals more of the page as it zooms out and scrolls horizontally when magnified", () => {
    const painted = [2, 1, 0.75, 0.5].map(zoom => htmlPreviewFrame(zoom, 460).paintedWidth);
    expect(painted).toEqual([2560, 1280, 960, 640]);
  });

  it("widens the layout to fill the pane when zoomed out past Fit", () => {
    const frame = htmlPreviewFrame(0.25, 460);
    expect(frame.width).toBeCloseTo(460 / 0.25);
    expect(frame.paintedWidth).toBeCloseTo(460);
  });

  it("always paints at least as wide as the pane", () => {
    for (const zoom of [...HTML_ZOOM_LEVELS, "fit" as const]) {
      expect(htmlPreviewFrame(zoom, 500).paintedWidth).toBeGreaterThanOrEqual(500 - 1e-9);
    }
  });

  it("clamps out-of-range and invalid zoom values", () => {
    expect(htmlPreviewScale(100, 500)).toBe(HTML_ZOOM_LEVELS.at(-1));
    expect(htmlPreviewScale(0.01, 500)).toBe(HTML_ZOOM_LEVELS[0]);
    expect(htmlPreviewScale(Number.NaN, 500)).toBe(1);
    expect(htmlPreviewScale(-2, 500)).toBe(1);
  });
});

describe("HTML preview zoom steps", () => {
  it("steps from an in-between fit scale to the neighbouring stops", () => {
    // 400 / 1280 = 31.25%: between the 25% and 33% stops.
    expect(stepHtmlZoom("fit", 400, 1)).toBe(0.33);
    expect(stepHtmlZoom("fit", 400, -1)).toBe(0.25);
  });

  it("moves exactly one stop from a stop", () => {
    expect(stepHtmlZoom(1, 400, 1)).toBe(1.1);
    expect(stepHtmlZoom(1, 400, -1)).toBe(0.9);
  });

  it("zooms in from a fit below every stop, with nothing further out", () => {
    expect(stepHtmlZoom("fit", 280, 1)).toBe(0.25);
    expect(stepHtmlZoom("fit", 280, -1)).toBeNull();
  });

  it("reports the limits as unavailable", () => {
    expect(stepHtmlZoom(HTML_ZOOM_LEVELS.at(-1)!, 400, 1)).toBeNull();
    expect(stepHtmlZoom(HTML_ZOOM_LEVELS[0], 400, -1)).toBeNull();
  });

  it("labels the painted scale", () => {
    expect(htmlZoomLabel("fit", 400)).toBe("31%");
    expect(htmlZoomLabel("fit", 2000)).toBe("100%");
    expect(htmlZoomLabel(1.5, 400)).toBe("150%");
  });
});

