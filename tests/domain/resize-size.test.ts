import { expect, it } from "vitest";
import { clampResizeSize, draggedResizeSize, resizeSizeFromKey } from "$lib/domain/resize-size";

const options = { min: 160, max: 600, default: 280, zeroIsDefault: true };

it("decodes only the explicit zero source sentinel as the default", () => {
  expect(clampResizeSize(0, options)).toBe(280);
  expect(clampResizeSize(0, { ...options, zeroIsDefault: false })).toBe(160);
  expect(clampResizeSize(-1, options)).toBe(160);
  for (const input of [null, undefined, NaN, Infinity, "280"]) expect(clampResizeSize(input, options)).toBe(280);
  expect(clampResizeSize(Number.MAX_VALUE, options)).toBe(600);
});
it("calculated pointer values at and beyond zero clamp to the minimum instead of decoding a sentinel", () => {
  expect(draggedResizeSize(280, -280, 1, options)).toBe(160);
  expect(draggedResizeSize(280, -1000, 1, options)).toBe(160);
  expect(draggedResizeSize(280, 60, 1.5, options)).toBe(320);
});
it("keyboard candidates use ordinary bounds even when a source can be a sentinel", () => {
  expect(resizeSizeFromKey(160, "ArrowLeft", options)).toBe(160);
  expect(resizeSizeFromKey(280, "Home", options)).toBe(160);
  expect(resizeSizeFromKey(280, "End", options)).toBe(600);
  expect(resizeSizeFromKey(10, "ArrowLeft", { min: 10, max: 600, default: 280, zeroIsDefault: true })).toBe(10);
});
