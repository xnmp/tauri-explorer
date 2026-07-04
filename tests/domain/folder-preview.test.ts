/**
 * Tests for the FolderPreview selection rules (issue #146).
 * These rules are the spec the Rust backend mirrors — behavior here defines
 * which images a folder tile shows and in what order.
 */

import { describe, it, expect } from "vitest";
import {
  selectPreviewImages,
  isPreviewImageName,
  MAX_PREVIEW_IMAGES,
} from "$lib/domain/folder-preview";

describe("selectPreviewImages", () => {
  it("picks only image files, in deterministic byte order", () => {
    const names = ["zebra.png", "notes.txt", "apple.jpg", "video.mp4", "beta.webp"];
    expect(selectPreviewImages(names)).toEqual(["apple.jpg", "beta.webp", "zebra.png"]);
  });

  it("is order-insensitive: shuffled input yields the same selection", () => {
    const a = selectPreviewImages(["c.png", "a.png", "b.png"]);
    const b = selectPreviewImages(["b.png", "c.png", "a.png"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["a.png", "b.png", "c.png"]);
  });

  it(`caps at MAX_PREVIEW_IMAGES (${MAX_PREVIEW_IMAGES}) by default`, () => {
    const names = Array.from({ length: 10 }, (_, i) => `img${i}.png`);
    expect(selectPreviewImages(names)).toHaveLength(MAX_PREVIEW_IMAGES);
  });

  it("respects an explicit max and returns [] for max <= 0", () => {
    const names = ["a.png", "b.png", "c.png"];
    expect(selectPreviewImages(names, 2)).toEqual(["a.png", "b.png"]);
    expect(selectPreviewImages(names, 0)).toEqual([]);
    expect(selectPreviewImages(names, -1)).toEqual([]);
  });

  it("skips hidden and temp files", () => {
    const names = [".hidden.png", "~$temp.jpg", "visible.png"];
    expect(selectPreviewImages(names)).toEqual(["visible.png"]);
  });

  it("returns [] for folders with no images", () => {
    expect(selectPreviewImages(["doc.pdf", "notes.txt"])).toEqual([]);
    expect(selectPreviewImages([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const names = ["c.png", "a.png"];
    selectPreviewImages(names);
    expect(names).toEqual(["c.png", "a.png"]);
  });
});

describe("isPreviewImageName", () => {
  it("accepts raster image extensions case-insensitively", () => {
    expect(isPreviewImageName("photo.JPG")).toBe(true);
    expect(isPreviewImageName("shot.PnG")).toBe(true);
  });

  it("rejects SVG (raster thumbnailer cannot decode it)", () => {
    expect(isPreviewImageName("logo.svg")).toBe(false);
  });

  it("rejects malformed names: no extension, dot-only, trailing dot", () => {
    expect(isPreviewImageName("README")).toBe(false);
    expect(isPreviewImageName(".png")).toBe(false); // hidden, and no stem
    expect(isPreviewImageName("file.")).toBe(false);
    expect(isPreviewImageName("")).toBe(false);
  });
});
