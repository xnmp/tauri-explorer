/**
 * The marquee rubber band must carry its geometry in `transform` alone (#1051).
 *
 * Rewriting the band element's width/height on every pointer frame resized a
 * composited layer, and WebKitGTK repainted it over every image tile beneath:
 * a drag in a large picture folder trailed the pointer. The band is now five
 * container-sized layers moved and scaled by the compositor. This spec drives
 * a real drag in each view mode and asserts (a) the layers' layout boxes never
 * change with the pointer, (b) their rendered boxes still frame the drag
 * exactly, and (c) the rasterised band reaches its far edges, so the
 * optimisation cannot regress into a resizing element, a band that no longer
 * tracks the pointer, or a layer that paints the wrong size under zoom.
 * The classic-scrollbar case lives in `marquee-compositor-only-scrollbar.spec.ts`.
 */
import { test } from "./fixtures";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";
import { dragAndVerifyBand } from "./marquee-band-verify";

test.use({ viewport: { width: 1600, height: 1000 } });

for (const viewMode of VIEW_MODES) {
  // 130% is a fractional zoom: engines rasterise layers at whole device
  // pixels, which is exactly where a scaled band can paint the wrong size.
  for (const zoom of [100, 130]) {
    test(`${viewMode} at ${zoom}%: marquee band is transform-only and frames the drag`, async ({ page }) => {
      await page.goto("/?path=/home/user/Downloads");
      await waitForEntries(page);
      if (viewMode !== "details") await switchViewMode(page, viewMode);
      for (let value = 100; value < zoom; value += 10) await pressShortcut(page, "=", { ctrlKey: true });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await dragAndVerifyBand(page, { bottomInset: 16 });
    });
  }
}
