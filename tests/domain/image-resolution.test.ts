import { expect, test } from "vitest";
import { formatImageResolution, supportsImageResolution } from "$lib/domain/image-resolution";

test("source pixels have an explicit width × height unit; unavailable metadata is quiet", () => {
  expect(formatImageResolution({ width: 4032, height: 3024 })).toBe("4032 × 3024 px");
  for (const value of [null, { width: 0, height: 20 }, { width: NaN, height: 2 }]) {
    expect(formatImageResolution(value)).toBe("—");
  }
});
test("only header-readable raster formats trigger metadata requests", () => {
  for (const name of ["photo.JPG", "a.jpeg", "b.png", "c.gif", "d.webp", "e.bmp"]) expect(supportsImageResolution(name)).toBe(true);
  for (const name of ["a.svg", "a.heic", "notes.txt", "folder"]) expect(supportsImageResolution(name)).toBe(false);
});
