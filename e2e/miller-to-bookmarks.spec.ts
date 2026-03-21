/**
 * E2E test: miller column entries are draggable.
 * Issue: feat/miller-to-bookmarks
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Miller columns drag to bookmarks", () => {
  test("miller column entries have draggable attribute", async ({ page }) => {
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

    const entry = page.locator(".col-entry").first();
    await expect(entry).toHaveAttribute("draggable", "true");
  });
});
