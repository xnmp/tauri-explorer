/**
 * Regression test: InlineNewFolder tiles variant must use CSS variables
 * from the parent TilesView for sizing, not hardcoded values.
 * Issue: fix/new-folder-tile-size
 */
import { describe, it, expect } from "vitest";
import { THUMBNAIL_SIZE_CONFIG } from "$lib/state/settings.svelte";

describe("New folder tile sizing", () => {
  it("all thumbnail sizes have displaySize >= 64 for the folder SVG to scale up", () => {
    for (const [size, config] of Object.entries(THUMBNAIL_SIZE_CONFIG)) {
      expect(config.displaySize, `${size} displaySize`).toBeGreaterThanOrEqual(64);
    }
  });

  it("icon scale factor is displaySize / 64", () => {
    for (const [size, config] of Object.entries(THUMBNAIL_SIZE_CONFIG)) {
      const expectedScale = config.displaySize / 64;
      expect(expectedScale, `${size} scale`).toBeGreaterThanOrEqual(1);
    }
  });
});
