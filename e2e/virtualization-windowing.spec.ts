/**
 * Regression: every file-list mode must keep huge directories DOM-virtualized.
 *
 * This asserts a browser layout outcome, not a component implementation detail:
 * the visible DOM remains bounded; List scrolls horizontally and the other views vertically. A
 * missing `min-height: 0` on any view wrapper makes that wrapper expand to the
 * list's full content height, which causes VirtualList to render every row.
 */
import { test, expect } from "./fixtures";
import { ALL_VIEW_VARIANTS, seedSettings } from "./helpers";

const HUGE = "/perf/huge";

test.skip(({ browserName }) => browserName !== "chromium", "layout outcome; chromium is the calibrated engine");

// "list-classic" is the row-major List used when Folder Peek is off.
for (const { name, viewMode: mode, classic } of ALL_VIEW_VARIANTS) {
  const sideways = mode === "list" && !classic;
  test(`${name} view windows a huge directory and its viewport scrolls (#479)`, async ({ page }) => {
    if (classic) await seedSettings(page, { folderPeek: false });
    await page.goto(`/?path=${HUGE}&viewMode=${mode}`);

    const viewport = page.locator(`.${mode}-view .virtual-viewport`);
    await viewport.waitFor({ timeout: 10000 });
    await viewport.locator(".entry-item").first().waitFor({ timeout: 10000 });

    const stats = await viewport.evaluate((element, sideways) => ({
      renderedRows: element.querySelectorAll(sideways ? ".entry-item" : ".virtual-item").length,
      viewportIsScroller: sideways ? element.scrollWidth > element.clientWidth + 2 && element.scrollTop === 0 : element.scrollHeight > element.clientHeight + 2,
    }), sideways);

    // `/perf/huge` contains 5,000 entries. A generous cap proves browser-level
    // windowing without tying the assertion to a specific viewport height.
    expect(stats.renderedRows).toBeGreaterThan(0);
    expect(stats.renderedRows).toBeLessThan(sideways ? 300 : 200);
    expect(stats.viewportIsScroller).toBe(true);
  });
}
