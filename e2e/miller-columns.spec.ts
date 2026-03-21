/**
 * E2E test: Miller columns panel alongside any view mode (directories only).
 * Issue: feat/miller-view
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Miller columns panel", () => {
  test("miller columns appear when millerLayers > 0", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Enable 1 miller layer
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 1;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForTimeout(1000);
    await waitForEntries(page);

    // Navigate to a subdirectory so ancestor columns appear
    await page.locator(".entry-item").first().dblclick();
    await page.waitForTimeout(500);

    // Miller columns should be visible
    await expect(page.locator(".miller-columns")).toBeVisible();
    const cols = page.locator(".miller-col");
    expect(await cols.count()).toBeGreaterThanOrEqual(1);
  });

  test("miller columns hidden when millerLayers = 0", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Disable miller columns
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
      s.millerLayers = 0;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
      location.reload();
    });
    await page.waitForTimeout(1000);

    // Miller columns should not be visible
    await expect(page.locator(".miller-columns")).toHaveCount(0);
  });
});
