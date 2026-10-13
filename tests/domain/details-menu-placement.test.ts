import { describe, expect, it } from "vitest";
import { fixedMenuPosition } from "../../src/lib/domain/zoom";

describe("Details menu viewport placement", () => {
  // Native legacy WebKit scales fixed offsets twice but rendered sizes once.
  // WKWebView reports visual rects; WebKitGTK reports CSS-space rects. Both
  // select double-offset placement after the component's geometry probe.
  for (const engine of ["Chromium/current WebKit", "legacy WKWebView", "legacy WebKitGTK"]) {
    for (const zoom of [0.8, 1, 1.3]) {
      const singleScale = engine === "Chromium/current WebKit";
      const offsetScale = singleScale ? zoom : zoom ** 2;
      const viewport = { width: 1000, height: 600 };
      const menu = { width: 170, height: 100 };

      it(`${engine} at ${zoom * 100}% keeps the right and bottom edges visible`, () => {
        const position = fixedMenuPosition({ x: 990, y: 590 }, viewport, menu, zoom, singleScale);
        const renderedRight = position.x * offsetScale + menu.width * zoom;
        const renderedBottom = position.y * offsetScale + menu.height * zoom;
        expect(renderedRight).toBeLessThanOrEqual(viewport.width);
        expect(renderedBottom).toBeLessThanOrEqual(viewport.height);
        expect(position.x * offsetScale).toBeGreaterThanOrEqual(0);
        expect(position.y * offsetScale).toBeGreaterThanOrEqual(0);
      });

      it(`${engine} at ${zoom * 100}% opens at an unclamped pointer`, () => {
        const position = fixedMenuPosition({ x: 300, y: 200 }, viewport, menu, zoom, singleScale);
        expect(position.x * offsetScale).toBeCloseTo(300);
        expect(position.y * offsetScale).toBeCloseTo(200);
      });
    }
  }
});
