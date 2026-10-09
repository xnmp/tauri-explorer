/**
 * Tile geometry shared by the Tiles view and the plugin SDK's file tiles.
 */
import { describe, expect, it } from "vitest";
import { gridFocusStep, isThumbnailSize, paneTileSize, THUMBNAIL_SIZE_CONFIG, tileLayout, type ThumbnailSize } from "$lib/domain/tile-layout";

describe("tileLayout", () => {
  it("sizes rows to padding, icon, name, selection border and gap", () => {
    expect(tileLayout("small")).toMatchObject({ gap: 2, padding: "6px 4px 6px", rowHeight: 12 + 48 + 4 + 37 + 2 + 2 });
    expect(tileLayout("medium")).toMatchObject({ gap: 6, padding: "12px 8px 10px", rowHeight: 22 + 64 + 4 + 37 + 2 + 6 });
    expect(tileLayout("xlarge").rowHeight).toBe(22 + 128 + 4 + 37 + 2 + 6);
  });

  it("carries the size's thumbnail settings and icon scale", () => {
    for (const size of Object.keys(THUMBNAIL_SIZE_CONFIG) as ThumbnailSize[]) {
      const layout = tileLayout(size);
      expect(layout).toMatchObject(THUMBNAIL_SIZE_CONFIG[size]);
      expect(layout.iconScale).toBe(THUMBNAIL_SIZE_CONFIG[size].displaySize / 64);
    }
  });

  it("shows folder previews only at large sizes", () => {
    expect(["small", "medium", "large", "xlarge"].map((size) => tileLayout(size as ThumbnailSize).showFolderThumbnails))
      .toEqual([false, false, true, true]);
  });

  it("falls back to medium for an unknown size", () => {
    for (const bad of ["huge", "", "constructor", "__proto__", undefined, null]) {
      expect(tileLayout(bad as unknown as ThumbnailSize)).toEqual(tileLayout("medium"));
    }
  });
});

describe("paneTileSize (plugin SDK FileViewPane.tileSize)", () => {
  it("gives each preset's thumbnail edge in CSS px", () => {
    expect((["small", "medium", "large", "xlarge"] as const).map((preset) => paneTileSize(preset)))
      .toEqual([
        { preset: "small", imagePx: 48 },
        { preset: "medium", imagePx: 64 },
        { preset: "large", imagePx: 96 },
        { preset: "xlarge", imagePx: 128 },
      ]);
  });

  it("falls back to medium for an unknown preset, like tileLayout", () => {
    for (const bad of ["huge", "", "constructor", "__proto__", "toString", undefined, null]) {
      expect(paneTileSize(bad as unknown as ThumbnailSize)).toEqual({ preset: "medium", imagePx: 64 });
    }
  });

  it("is immutable, so a plugin cannot change it for other readers", () => {
    const value = paneTileSize("large");
    expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (value as { imagePx: number }).imagePx = 1; }).toThrow();
    expect(paneTileSize("large").imagePx).toBe(96);
  });
});

describe("isThumbnailSize", () => {
  it("accepts exactly the presets", () => {
    expect(["small", "medium", "large", "xlarge"].every(isThumbnailSize)).toBe(true);
    for (const bad of ["Small", "huge", "", "constructor", "hasOwnProperty", 64, null, undefined, {}]) {
      expect(isThumbnailSize(bad), String(bad)).toBe(false);
    }
  });
});

describe("gridFocusStep", () => {
  // 7 items, 3 columns:  0 1 2 / 3 4 5 / 6
  it("moves along rows and columns", () => {
    expect(gridFocusStep(4, 7, 3, "ArrowLeft")).toBe(3);
    expect(gridFocusStep(4, 7, 3, "ArrowRight")).toBe(5);
    expect(gridFocusStep(4, 7, 3, "ArrowUp")).toBe(1);
    expect(gridFocusStep(3, 7, 3, "ArrowDown")).toBe(6);
    expect(gridFocusStep(2, 7, 3, "ArrowRight")).toBe(3);
    expect(gridFocusStep(4, 7, 3, "Home")).toBe(0);
    expect(gridFocusStep(4, 7, 3, "End")).toBe(6);
  });

  it("stays put at the edges, including below a short last row", () => {
    expect(gridFocusStep(0, 7, 3, "ArrowLeft")).toBe(0);
    expect(gridFocusStep(6, 7, 3, "ArrowRight")).toBe(6);
    expect(gridFocusStep(1, 7, 3, "ArrowUp")).toBe(1);
    expect(gridFocusStep(4, 7, 3, "ArrowDown")).toBe(4);
  });

  it("ignores other keys and empty grids", () => {
    expect(gridFocusStep(0, 7, 3, "Enter")).toBeNull();
    expect(gridFocusStep(0, 0, 3, "ArrowRight")).toBeNull();
  });

  it("tolerates malformed columns and indices", () => {
    expect(gridFocusStep(1, 5, 0, "ArrowDown")).toBe(2);
    expect(gridFocusStep(1, 5, Number.NaN, "ArrowUp")).toBe(0);
    expect(gridFocusStep(99, 5, 2, "ArrowLeft")).toBe(3);
    expect(gridFocusStep(-4, 5, 2, "ArrowRight")).toBe(1);
    expect(gridFocusStep(0, 1e9, 1e6, "ArrowDown")).toBe(1e6);
  });
});
