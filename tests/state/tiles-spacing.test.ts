/**
 * Regression test: small tiles must use tighter spacing than medium/large.
 * Issue: fix/small-tiles-spacing
 *
 * The CSS custom properties --tile-gap and --tile-padding are driven by
 * the effectiveThumbnailSize. This test verifies the config values that
 * make small tiles visually denser.
 */
import { describe, it, expect } from "vitest";
import { THUMBNAIL_SIZE_CONFIG } from "$lib/state/settings.svelte";

describe("Tiles spacing config", () => {
  it("small tiles have the smallest gridMinWidth", () => {
    expect(THUMBNAIL_SIZE_CONFIG.small.gridMinWidth).toBeLessThan(
      THUMBNAIL_SIZE_CONFIG.medium.gridMinWidth
    );
    expect(THUMBNAIL_SIZE_CONFIG.medium.gridMinWidth).toBeLessThan(
      THUMBNAIL_SIZE_CONFIG.large.gridMinWidth
    );
  });

  it("small tiles have the smallest displaySize", () => {
    expect(THUMBNAIL_SIZE_CONFIG.small.displaySize).toBeLessThan(
      THUMBNAIL_SIZE_CONFIG.medium.displaySize
    );
  });

  it("all tile sizes have positive grid dimensions", () => {
    for (const [, config] of Object.entries(THUMBNAIL_SIZE_CONFIG)) {
      expect(config.gridMinWidth).toBeGreaterThan(0);
      expect(config.displaySize).toBeGreaterThan(0);
    }
  });
});
