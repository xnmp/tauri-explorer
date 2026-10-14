/**
 * Marquee rubber band geometry as compositor-only transforms (#1051).
 *
 * Resizing the band element's width/height every pointer frame forced
 * WebKitGTK to reallocate and repaint its layer, which lagged visibly over
 * folders of image tiles. The band therefore carries its geometry purely in
 * `transform` (translate + scale of fixed-size layers), which the compositor
 * applies without layout or paint.
 */
import { describe, expect, it } from "vitest";
import { marqueeLayerTransforms } from "$lib/domain/marquee-rect";

const base = { width: 1000, height: 500 };

describe("marqueeLayerTransforms", () => {
  it("scales the container-sized fill layer down to the band", () => {
    const layers = marqueeLayerTransforms({ left: 12.5, top: 40, width: 300, height: 120 }, base);
    expect(layers.fill).toBe("translate(12.5px, 40px) scale(0.3, 0.24)");
  });

  it("lays 1px edge layers along each side, scaling only their length", () => {
    const layers = marqueeLayerTransforms({ left: 10, top: 20, width: 300, height: 120 }, base);
    expect(layers.top).toBe("translate(10px, 20px) scale(0.3, 1)");
    expect(layers.bottom).toBe("translate(10px, 139px) scale(0.3, 1)");
    expect(layers.left).toBe("translate(10px, 20px) scale(1, 0.24)");
    expect(layers.right).toBe("translate(309px, 20px) scale(1, 0.24)");
  });

  it("never scales a layer beyond its base when the band fills the container", () => {
    const layers = marqueeLayerTransforms({ left: 0, top: 0, width: 1000, height: 500 }, base);
    expect(layers.fill).toBe("translate(0px, 0px) scale(1, 1)");
    expect(layers.top).toBe("translate(0px, 0px) scale(1, 1)");
    expect(layers.right).toBe("translate(999px, 0px) scale(1, 1)");
  });

  it("collapses to a zero-area fill when the pointer has not left the anchor", () => {
    const layers = marqueeLayerTransforms({ left: 50, top: 60, width: 0, height: 0 }, base);
    expect(layers.fill).toBe("translate(50px, 60px) scale(0, 0)");
    // Edges never scale below their own thickness, so a degenerate band still
    // marks the anchor instead of inverting.
    expect(layers.top).toBe("translate(50px, 60px) scale(0.001, 1)");
    expect(layers.right).toBe("translate(50px, 60px) scale(1, 0.002)");
  });

  it("hides every layer until the container has a measured size", () => {
    const layers = marqueeLayerTransforms({ left: 5, top: 5, width: 40, height: 30 }, { width: 0, height: 0 });
    expect(layers.fill).toBe("translate(5px, 5px) scale(0, 0)");
    expect(layers.top).toBe("translate(5px, 5px) scale(0, 1)");
    expect(layers.left).toBe("translate(5px, 5px) scale(1, 0)");
  });

  it("only ever emits translate and scale, never a layout-affecting size", () => {
    const layers = marqueeLayerTransforms({ left: 3, top: 4, width: 55.25, height: 7 }, base);
    for (const transform of Object.values(layers)) {
      expect(transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+, [\d.]+\)$/);
    }
  });
});
