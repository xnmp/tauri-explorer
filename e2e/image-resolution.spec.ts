import { test, expect } from "./fixtures";
import { seedSettings } from "./helpers";

test("Details shows source resolution, unavailable cells and a persistent column toggle", async ({ page }) => {
  await seedSettings(page, { columnVisibility: { date: true, type: true, size: true } }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/home/user/Pictures&viewMode=details");
  await expect(page.locator(".column-header.resolution-column")).toBeVisible();
  const photo = page.locator('.file-item[data-path="/home/user/Pictures/photo1.jpg"]');
  await expect(photo.locator(".resolution-cell")).toHaveText("1920 × 1080 px");
  await page.screenshot({ path: "evidence/ac-1-source-resolution.png" });
  await expect(page.locator('.file-item[data-path="/home/user/Pictures/vacation"] .resolution-cell')).toHaveText("—");
  await page.goto("/?path=/home/user/Pictures/vacation&viewMode=details");
  await expect(page.locator('.file-item[data-path$="itinerary.txt"] .resolution-cell')).toHaveText("—");
  await page.screenshot({ path: "evidence/ac-2-unavailable-resolution.png" });
  await page.locator(".column-headers").click({ button: "right" });
  await page.locator(".column-menu-item").filter({ hasText: "Resolution" }).click();
  await page.reload();
  await expect(page.locator(".file-item").first()).toBeVisible();
  await expect(page.locator(".resolution-cell")).toHaveCount(0);
  await expect(page.locator(".column-header.resolution-column")).toHaveCount(0);
  await page.locator(".column-headers").click({ button: "right" });
  await expect(page.locator(".column-menu-item").filter({ hasText: "Resolution" }).locator(".column-menu-check")).toHaveText("");
  await page.screenshot({ path: "evidence/ac-3-persisted-visibility.png" });
  await page.locator(".column-menu-item").filter({ hasText: "Resolution" }).click();
  await expect(page.locator(".column-header.resolution-column")).toBeVisible();
});
