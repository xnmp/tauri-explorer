/**
 * E2E test: miller columns are resizable.
 * Issue: feat/miller-resize
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Miller columns resize", () => {
  test("miller columns have a resize handle", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await page.waitForSelector(".entry-item", { timeout: 5000 });

    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 1;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForSelector(".entry-item", { timeout: 5000 });
    await page.waitForTimeout(500);

    // Resize handle should exist
    await expect(page.locator(".miller-columns .resize-handle")).toBeVisible();
  });
});
