/**
 * E2E test: integrated title bar setting.
 * Issue: feat/integrated-title-bar
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Integrated title bar", () => {
  test("tab bar is always visible when integratedTitleBar is enabled", async ({ page }) => {
    // Pre-set the setting via localStorage before navigation
    await page.goto(HOME_URL);
    await page.evaluate(() => {
      const stored = localStorage.getItem("explorer-settings");
      const settings = stored ? JSON.parse(stored) : {};
      settings.integratedTitleBar = true;
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
    });
    await page.reload();
    await waitForEntries(page);

    // With integratedTitleBar enabled, tab-area should be visible even with one tab
    const tabArea = page.locator(".tab-area");
    await expect(tabArea).toBeVisible();
  });

  test("tab bar is hidden with single tab when integratedTitleBar is disabled", async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => {
      const stored = localStorage.getItem("explorer-settings");
      const settings = stored ? JSON.parse(stored) : {};
      settings.integratedTitleBar = false;
      settings.showWindowControls = false;
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
    });
    await page.reload();
    await waitForEntries(page);

    // With both disabled and single tab, tab-area should not be visible
    const tabArea = page.locator(".tab-area");
    await expect(tabArea).not.toBeVisible();
  });
});
