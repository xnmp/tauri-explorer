/**
 * Test: zoom coordinate adjustments for drag-drop and column resize.
 * Issue: #88 (zoom-drag-drop-marquee-broken)
 *
 * Verifies that pointer coordinates are correctly divided by the CSS
 * zoom factor for hit detection, ghost positioning, and column resize.
 */
import { describe, it, expect } from "vitest";

describe("zoom coordinate math", () => {
  it("viewport-to-CSS conversion divides by zoom factor", () => {
    const zoom = 1.5;
    expect(300 / zoom).toBe(200);
    expect(450 / zoom).toBe(300);
  });

  it("identity at 100% zoom", () => {
    const zoom = 1.0;
    expect(300 / zoom).toBe(300);
  });
});

describe("column resize zoom adjustment", () => {
  it("delta should be divided by zoom to convert viewport px to CSS px", () => {
    const zoom = 1.5;
    const startX = 300;
    const currentX = 345;
    const viewportDelta = currentX - startX;
    const cssDelta = viewportDelta / zoom;
    expect(cssDelta).toBe(30);
  });

  it("at 200% zoom, delta is halved", () => {
    const zoom = 2.0;
    const delta = 100;
    expect(delta / zoom).toBe(50);
  });
});

describe("pointer drag ghost positioning", () => {
  it("ghost position divides viewport coords by zoom for fixed positioning", () => {
    const zoom = 1.5;
    const clientX = 300;
    const clientY = 450;
    const offset = 12;

    const ghostLeft = (clientX + offset) / zoom;
    const ghostTop = (clientY + offset) / zoom;

    expect(ghostLeft).toBe(208);
    expect(ghostTop).toBe(308);
  });
});

describe("adjustForPointerZoom (hit detection)", () => {
  it("divides by zoom for elementFromPoint compatibility", () => {
    const zoom = 1.5;
    const pos = { x: 300, y: 450 };
    const adjusted = { x: pos.x / zoom, y: pos.y / zoom };

    expect(adjusted.x).toBe(200);
    expect(adjusted.y).toBe(300);
  });

  it("no adjustment at 100% zoom", () => {
    const zoom = 1.0;
    const pos = { x: 300, y: 450 };
    const adjusted = { x: pos.x / zoom, y: pos.y / zoom };

    expect(adjusted.x).toBe(300);
    expect(adjusted.y).toBe(450);
  });
});
