import { test, expect } from "./fixtures";
import { seedSettings } from "./helpers";

test("selecting and moving through Details keeps the scrolled Resolution column visible", async ({ page }) => {
  await seedSettings(page, { showPreviewPane: true });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/?path=/home/user/Pictures&viewMode=details");
  const first = page.locator('.file-item[data-path="/home/user/Pictures/photo1.jpg"]');
  const next = page.locator('.file-item[data-path="/home/user/Pictures/photo2.jpg"]');
  await expect(first.locator(".resolution-cell")).toHaveText("1920 × 1080 px");
  const scroller = page.locator(".file-list .content");
  const scrollLeft = await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth - element.clientWidth;
    return element.scrollLeft;
  });
  expect(scrollLeft).toBeGreaterThan(0);
  await expect(first.locator(".resolution-cell")).toBeInViewport();
  await first.locator(".resolution-cell").click();
  await expect(first).toBeFocused();
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
  await expect(first.locator(".resolution-cell")).toBeInViewport();
  await page.keyboard.press("ArrowDown");
  await expect(next).toBeFocused();
  await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(scrollLeft);
  await expect(next.locator(".resolution-cell")).toBeInViewport();
});
