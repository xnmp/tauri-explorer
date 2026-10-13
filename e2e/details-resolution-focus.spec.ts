import { test, expect } from "./fixtures";
import { focusBeforeFileList, seedSettings } from "./helpers";

test("tabbing into wide Details rows keeps the file name and icon in view", async ({ page }) => {
  await seedSettings(page, { theme: "dark", zoomLevel: 150 });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?path=/home/user/Pictures&viewMode=details");
  const selected = page.locator('.file-item[data-path="/home/user/Pictures/photo1.jpg"]');
  await expect(selected.locator(".resolution-cell")).toHaveText("1920 × 1080 px");
  await selected.click();
  await focusBeforeFileList(page);
  await page.keyboard.press("Tab");
  await expect(selected).toBeFocused();
  await expect(selected.locator(".name-cell .icon")).toBeInViewport();
  await expect(selected.locator(".name-text")).toBeInViewport();
  await expect(selected).toHaveClass(/selected/);
});
