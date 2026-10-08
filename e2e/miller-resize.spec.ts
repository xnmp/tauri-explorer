/**
 * E2E test: miller columns are resizable.
 * Issue: feat/miller-resize
 */
import { test, expect } from "./fixtures";
import { HOME_URL, applySettingsAndReload, waitForEntries } from "./helpers";

test.describe("Miller columns resize", () => {
  test("miller columns have a resize handle", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await page.waitForSelector(".entry-item", { timeout: 5000 });

    await applySettingsAndReload(page, { millerLayers: 1 });
    await page.waitForSelector(".entry-item", { timeout: 5000 });

    // Resize handle should exist
    await expect(page.locator(".miller-columns .resize-handle")).toBeVisible();
  });
});
