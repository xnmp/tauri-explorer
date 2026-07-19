/**
 * Regression: Details view must DOM-virtualize (window) large directories.
 *
 * #469 — `.details-view` was missing `min-height: 0`, so the flex child grew to
 * full content height, `.content` (overflow:auto) became the vertical scroller,
 * and VirtualList's `clientHeight` binding read the whole list height — rendering
 * EVERY row. On a 5000-entry directory that put 5000 live `FileItem` components in
 * the DOM, which is the residual scroll jank this issue chased. ListView/TilesView
 * already set `min-height: 0` and were unaffected, which is why only Details janked.
 *
 * This is a CSS flexbox layout outcome (no layout engine in jsdom), so it can only
 * be caught in a real browser. Asserts the observable outcome: a windowed subset of
 * rows is in the DOM, and the `.virtual-viewport` (not `.content`) is the scroller.
 */
import { test, expect } from "./fixtures";

const HUGE = "/perf/huge"; // synthetic 5000-entry dir served by mock-invoke

test.skip(({ browserName }) => browserName !== "chromium", "layout outcome; chromium is the calibrated engine");

test("Details view windows a large directory instead of rendering every row (#469)", async ({ page }) => {
  await page.goto(`/?path=${HUGE}&viewMode=details`);
  await page.locator(".details-view .virtual-viewport").waitFor({ timeout: 10000 });
  await page.locator(".entry-item").first().waitFor({ timeout: 10000 });

  const stats = await page.evaluate(() => {
    const vv = document.querySelector(".virtual-viewport") as HTMLElement;
    return {
      renderedRows: document.querySelectorAll(".virtual-item").length,
      viewportIsScroller: vv.scrollHeight > vv.clientHeight + 2,
    };
  });

  // 5000 entries exist, but only a windowed slice (~one viewport + buffer) may
  // render. Pre-fix this was 5000; a generous cap of 200 proves windowing without
  // being brittle to viewport size.
  expect(stats.renderedRows).toBeGreaterThan(0);
  expect(stats.renderedRows).toBeLessThan(200);
  // The VirtualList viewport must own the vertical scroll (the whole app's scroll
  // math, marquee, and scrollToIndex assume this).
  expect(stats.viewportIsScroller).toBe(true);

  // Windowing must track scrolling: after a deep jump the rendered slice changes
  // but stays small (not the whole list).
  await page.evaluate(() => {
    (document.querySelector(".virtual-viewport") as HTMLElement).scrollTop = 80000;
  });
  await page.waitForTimeout(200);
  const afterScroll = await page.locator(".virtual-item").count();
  expect(afterScroll).toBeLessThan(200);
});
