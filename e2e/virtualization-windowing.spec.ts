/**
 * Regression: every file-list mode must keep huge directories DOM-virtualized.
 *
 * This asserts a browser layout outcome, not a component implementation detail:
 * the visible DOM remains bounded and VirtualList owns vertical scrolling. A
 * missing `min-height: 0` on any view wrapper makes that wrapper expand to the
 * list's full content height, which causes VirtualList to render every row.
 */
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES } from "./helpers";

const HUGE = "/perf/huge";

test.skip(({ browserName }) => browserName !== "chromium", "layout outcome; chromium is the calibrated engine");

for (const mode of ALL_VIEW_MODES) {
  test(`${mode} view windows a huge directory and its viewport scrolls (#479)`, async ({ page }) => {
    await page.goto(`/?path=${HUGE}&viewMode=${mode}`);

    const viewport = page.locator(`.${mode}-view .virtual-viewport`);
    await viewport.waitFor({ timeout: 10000 });
    await viewport.locator(".virtual-item").first().waitFor({ timeout: 10000 });

    const stats = await viewport.evaluate((element) => ({
      renderedRows: element.querySelectorAll(".virtual-item").length,
      viewportIsScroller: element.scrollHeight > element.clientHeight + 2,
    }));

    // `/perf/huge` contains 5,000 entries. A generous cap proves browser-level
    // windowing without tying the assertion to a specific viewport height.
    expect(stats.renderedRows).toBeGreaterThan(0);
    expect(stats.renderedRows).toBeLessThan(200);
    expect(stats.viewportIsScroller).toBe(true);
  });
}
