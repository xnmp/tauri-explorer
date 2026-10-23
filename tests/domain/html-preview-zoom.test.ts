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
    const frame = htmlPreviewFrame("fit", { width: 400, height: 600 });
    expect(frame.width).toBeCloseTo(HTML_FIT_LAYOUT_WIDTH);
    expect(frame.width * frame.scale).toBeCloseTo(400);
    expect(frame.height * frame.scale).toBeCloseTo(600);
  });

  it("never magnifies when the pane is wider than the fit layout", () => {
    expect(htmlPreviewFrame("fit", { width: 1600, height: 900 })).toEqual({ scale: 1, width: 1600, height: 900 });
  });

  it("fits narrow docked panes below the smallest explicit stop, down to a floor", () => {
    expect(htmlPreviewScale("fit", 280)).toBeCloseTo(280 / HTML_FIT_LAYOUT_WIDTH);
    const frame = htmlPreviewFrame("fit", { width: 50, height: 200 });
    expect(frame.scale).toBe(HTML_FIT_MIN_SCALE);
    expect(frame.width * frame.scale).toBeCloseTo(50);
  });

  it("renders unmeasured or malformed panes at actual size without a degenerate frame", () => {
    for (const pane of [{ width: 0, height: 0 }, { width: Number.NaN, height: -5 }, { width: Infinity, height: 10 }]) {
      const frame = htmlPreviewFrame("fit", pane);
      expect(frame.scale).toBe(1);
      expect(Number.isFinite(frame.width) && Number.isFinite(frame.height)).toBe(true);
    }
  });
});

describe("HTML preview explicit zoom", () => {
  it("covers the pane at every zoom so the document scrolls inside the frame", () => {
    for (const zoom of HTML_ZOOM_LEVELS) {
      const frame = htmlPreviewFrame(zoom, { width: 500, height: 300 });
      expect(frame.width * frame.scale).toBeCloseTo(500);
      expect(frame.height * frame.scale).toBeCloseTo(300);
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

