import { describe, expect, it } from "vitest";
import {
  cropPixelPoint,
  cropForIconCanvas,
  croppedImageSize,
  fullImageCrop,
  setCropEdge,
  validImageCrop,
  validImageSize,
  type CropEdge,
} from "$lib/domain/image-crop";

const size = { width: 4000, height: 3000 };
describe("full-resolution image crop", () => {
  it("starts with the entire image and independently trims all four edges", () => {
    const original = fullImageCrop(size);
    const crop = setCropEdge(
      setCropEdge(
        setCropEdge(
          setCropEdge(original, "left", 400, size),
          "right",
          3500,
          size,
        ),
        "top",
        300,
        size,
      ),
      "bottom",
      2500,
      size,
    );
    expect(original).toEqual({ left: 0, top: 0, right: 4000, bottom: 3000 });
    expect(crop).toEqual({ left: 400, top: 300, right: 3500, bottom: 2500 });
    expect(croppedImageSize(crop)).toEqual({ width: 3100, height: 2200 });
  });
  it.each([
    null,
    {},
    { width: 0, height: 3000 },
    { width: -1, height: 2 },
    { width: Infinity, height: 2 },
    { width: 1.5, height: 2 },
    { width: 2 ** 32, height: 2 },
  ])("rejects malformed image dimensions %j", (value) => {
    expect(validImageSize(value)).toBe(false);
  });
  it.each([
    null,
    {},
    { left: 0, top: 0, right: 0, bottom: 20 },
    { left: 1, top: 0, right: 2, bottom: 0 },
    { left: -1, top: 0, right: 20, bottom: 20 },
    { left: 0, top: 0, right: 4001, bottom: 20 },
    { left: 0, top: 0, right: 20, bottom: 3001 },
    { left: 0.5, top: 0, right: 20, bottom: 20 },
  ])("rejects empty, fractional or out-of-bounds saved regions %j", (value) => {
    expect(validImageCrop(value, size)).toBe(false);
  });
  it("clamps crossing edges to a one-pixel result and never changes another edge", () => {
    const rect = { left: 100, top: 200, right: 500, bottom: 800 };
    expect(setCropEdge(rect, "left", 9999, size)).toEqual({
      ...rect,
      left: 499,
    });
    expect(setCropEdge(rect, "right", -10, size)).toEqual({
      ...rect,
      right: 101,
    });
    expect(setCropEdge(rect, "top", 9999, size)).toEqual({ ...rect, top: 799 });
    expect(setCropEdge(rect, "bottom", -10, size)).toEqual({
      ...rect,
      bottom: 201,
    });
    expect(setCropEdge(rect, "left", NaN, size)).toEqual(rect);
    expect(setCropEdge(rect, "__proto__" as CropEdge, 200, size)).toEqual(rect);
  });
  it.each([1, 1.5, 4])(
    "maps the same content point at measured scale %s, including translated pan",
    (scale) => {
      const rect = {
        left: -50,
        top: 100,
        width: 800 * scale,
        height: 600 * scale,
      };
      expect(
        cropPixelPoint(
          { x: -50 + 80 * scale, y: 100 + 120 * scale },
          rect,
          size,
        ),
      ).toEqual({ x: 400, y: 600 });
    },
  );
  it("clamps pointers beyond image edges and rejects unmeasurable geometry", () => {
    const rect = { left: 40, top: 20, width: 800, height: 600 };
    expect(cropPixelPoint({ x: -1, y: 1000 }, rect, size)).toEqual({
      x: 0,
      y: 3000,
    });
    expect(
      cropPixelPoint({ x: 20, y: 20 }, { ...rect, width: 0 }, size),
    ).toBeNull();
    expect(cropPixelPoint({ x: NaN, y: 20 }, rect, size)).toBeNull();
  });

  it("retains fractional positions when measured coordinates are extremely large", () => {
    expect(
      cropPixelPoint(
        { x: 5e307, y: 5e307 },
        { left: 0, top: 0, width: 1e308, height: 1e308 },
        size,
      ),
    ).toEqual({ x: 2000, y: 1500 });
  });
});

describe("ICNS transparent padding policy", () => {
  const source = { width: 1024, height: 1024 };
  const rect = { left: 256, top: 128, right: 768, bottom: 640 };

  it("retains each fixed icon canvas and centers its corresponding crop without resampling", () => {
    expect(cropForIconCanvas(rect, source, { width: 32, height: 32 })).toEqual({
      region: { left: 8, top: 4, right: 24, bottom: 20 },
      canvas: { width: 32, height: 32 },
      offset: { x: 8, y: 8 },
    });
    expect(cropForIconCanvas(rect, source, { width: 64, height: 64 })).toEqual({
      region: { left: 16, top: 8, right: 48, bottom: 40 },
      canvas: { width: 64, height: 64 },
      offset: { x: 16, y: 16 },
    });
  });

  it("supports the legacy rectangular representation and rounds outwards at its edges", () => {
    expect(cropForIconCanvas(rect, source, { width: 16, height: 12 })).toEqual({
      region: { left: 4, top: 1, right: 12, bottom: 8 },
      canvas: { width: 16, height: 12 },
      offset: { x: 4, y: 2 },
    });
  });

  it("retains at least one pixel for a narrow selection at the smallest canvas", () => {
    expect(
      cropForIconCanvas(
        { left: 1023, top: 1023, right: 1024, bottom: 1024 },
        source,
        { width: 16, height: 16 },
      ),
    ).toEqual({
      region: { left: 15, top: 15, right: 16, bottom: 16 },
      canvas: { width: 16, height: 16 },
      offset: { x: 7, y: 7 },
    });
  });

  it("leaves a full-image crop unchanged and rejects invalid crop/canvas inputs", () => {
    expect(
      cropForIconCanvas(fullImageCrop(source), source, {
        width: 32,
        height: 32,
      }),
    ).toEqual({
      region: { left: 0, top: 0, right: 32, bottom: 32 },
      canvas: { width: 32, height: 32 },
      offset: { x: 0, y: 0 },
    });
    expect(
      cropForIconCanvas({ ...rect, right: 2048 }, source, {
        width: 32,
        height: 32,
      }),
    ).toBeNull();
    expect(
      cropForIconCanvas(rect, source, { width: 0, height: 32 }),
    ).toBeNull();
  });
});
