import { test, expect } from "./fixtures";
import { seedSettings, waitForStableWidth } from "./helpers";

test("virtualized Details keyboard jumps preserve the horizontal column position", async ({ page }) => {
  await seedSettings(page, { showPreviewPane: true });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/?path=/perf/images-500&viewMode=details");
  const rows = page.locator(".details-view .file-item");
  await expect(rows.first().locator(".resolution-cell")).toHaveText("1920 × 1080 px");
  const firstPath = await rows.first().getAttribute("data-path");
  const first = page.locator(`.file-item[data-path="${firstPath}"]`);
  const scroller = page.locator(".file-list .content");
  await waitForStableWidth(scroller);
  const scrollLeft = await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    return element.scrollLeft;
  });
  expect(scrollLeft).toBeGreaterThan(0);
  await first.locator(".resolution-cell").click();
  await expect(first).toBeFocused();
  await page.keyboard.press("Control+End");
  await expect(first).toHaveCount(0);
  const endpoint = page.locator(".details-view .file-item.selected");
  await expect(endpoint).toBeFocused();
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
  await expect(endpoint.locator(".resolution-cell")).toBeInViewport();
  await page.keyboard.press("Control+Home");
  await expect(first).toBeFocused();
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
  await expect(first.locator(".resolution-cell")).toBeInViewport();
});
