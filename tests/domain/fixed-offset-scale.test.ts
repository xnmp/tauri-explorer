import { afterEach, describe, expect, it } from "vitest";
import { fixedMenuPosition, isSingleScaleFixedOffset, probeSingleScaleFixedOffset } from "../../src/lib/domain/zoom";

// A fixed overlay probed at left:0 then left:100px reports these rect lefts
// and widths. Each engine model below is what that probe measures.
const OFFSET_WIDTH = 170;
const models = {
  // Chromium and current WebKitGTK/Safari: viewport-space rect, one zoom factor.
  "single-scale (Chromium, current WebKit)": (zoom: number) => ({
    shift: 100 * zoom, width: OFFSET_WIDTH * zoom, single: true,
  }),
  // macOS WKWebView: viewport-space rect, offsets scale twice.
  "legacy double-scale, viewport-space rect": (zoom: number) => ({
    shift: 100 * zoom ** 2, width: OFFSET_WIDTH * zoom, single: false,
  }),
  // Older WebKitGTK: CSS-space rect (width unscaled), offsets scale twice.
  "legacy double-scale, CSS-space rect": (zoom: number) => ({
    shift: 100 * zoom, width: OFFSET_WIDTH, single: false,
  }),
};

describe("isSingleScaleFixedOffset", () => {
  for (const [name, measure] of Object.entries(models)) {
    for (const zoom of [0.8, 1.2, 1.3]) {
      it(`classifies ${name} at ${zoom * 100}%`, () => {
        const m = measure(zoom);
        expect(isSingleScaleFixedOffset(zoom, 10, 10 + m.shift, m.width, OFFSET_WIDTH)).toBe(m.single);
      });
    }
  }
});

describe("fixedMenuPosition with a caller padding", () => {
  it("keeps the requested on-screen margin from the right and bottom edges", () => {
    const zoom = 1.2;
    const viewport = { width: 1280, height: 720 };
    const menu = { width: 200, height: 300 };
    const position = fixedMenuPosition({ x: 1270, y: 710 }, viewport, menu, zoom, true, 12);
    expect(position.x * zoom + menu.width * zoom + 12).toBeCloseTo(viewport.width);
    expect(position.y * zoom + menu.height * zoom + 12).toBeCloseTo(viewport.height);
  });
});

describe("probeSingleScaleFixedOffset on a mounted overlay", () => {
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  // A stand-in overlay whose rect responds to its inline left like each engine.
  function overlay(zoom: number, model: ReturnType<(typeof models)[keyof typeof models]>) {
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { zoom: `${zoom * 100}%` } },
    };
    const style = { left: "37px" };
    return {
      style,
      offsetWidth: OFFSET_WIDTH,
      getBoundingClientRect: () => ({
        left: (parseFloat(style.left) / 100) * model.shift,
        width: model.width,
      }),
    } as unknown as HTMLElement;
  }

  for (const [name, measure] of Object.entries(models)) {
    it(`classifies ${name} and restores the overlay's left`, () => {
      const zoom = 1.2;
      const m = measure(zoom);
      const node = overlay(zoom, m);
      expect(probeSingleScaleFixedOffset(node)).toBe(m.single);
      expect(node.style.left).toBe("37px");
    });
  }
});
